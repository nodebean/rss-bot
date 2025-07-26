import fs from 'fs';
import 'dotenv/config.js';
import irc from 'irc';
import Parser from 'rss-parser';
import mysql from 'mysql2/promise';

const {
  MYSQL_HOST,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,
} = process.env;

if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD || !MYSQL_DATABASE) {
  console.error("Missing required database environment variables");
  process.exit(1);
}

// Load bot config from file (mounted via ConfigMap in Kubernetes)
let bots;
try {
  const configRaw = fs.readFileSync('/app/config/bots.json', 'utf-8');
  bots = JSON.parse(configRaw);
} catch (err) {
  console.error("Failed to read or parse /app/config/bots.json:", err);
  process.exit(1);
}

const db = await mysql.createPool({
  host: MYSQL_HOST,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
});

const parser = new Parser();

for (const config of bots) {
  const channelNames = config.channels.map(c => c.name);
  const client = new irc.Client(config.server, config.nick, {
    channels: channelNames,
  });

  client.addListener('error', (err) => {
    console.error(`[IRC Error][${config.server}]`, err);
  });

  config.client = client; // attach client
}

async function pollFeeds() {
  try {
    for (const bot of bots) {
      for (const chan of bot.channels) {
        for (const feedUrl of chan.feeds) {
          try {
            const feed = await parser.parseURL(feedUrl);
            for (const item of feed.items) {
              const guid = item.guid || item.link;
              const [rows] = await db.query('SELECT id FROM posted_entries WHERE guid = ?', [guid]);
              if (rows.length === 0) {
                const msg = `[RSS] ${item.title} - ${item.link}`;
                bot.client.say(chan.name, msg);
                await db.query('INSERT INTO posted_entries (guid) VALUES (?)', [guid]);
                console.log(`[Posted][${bot.server}][${chan.name}] ${msg}`);
              }
            }
          } catch (err) {
            console.error(`[Feed Error][${chan.name}] ${feedUrl}:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Poll Error]', err);
  }
}

setInterval(pollFeeds, 60_000);
