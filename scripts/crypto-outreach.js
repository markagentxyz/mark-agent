import WebSocket from 'ws';
import { TwitterApi } from 'twitter-api-v2';
import { generateContent } from '../core/brain.js';
import { getDb } from '../database/init.js';
import cron from 'node-cron';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
}).readWrite;

console.log('[OUTREACH] Crypto outreach agent started');

let wsReconnectTimeout = 5000;

function connectPumpPortal() {
  try {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    ws.on('open', () => {
      console.log('[OUTREACH] Connected to PumpPortal');
      wsReconnectTimeout = 5000;
      // Subscribe to new token events
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.txType === 'create' || event.mint) {
          await evaluateProject(event);
        }
      } catch (error) {
        // Skip parse errors for non-JSON messages
      }
    });

    ws.on('close', () => {
      console.log('[OUTREACH] PumpPortal disconnected. Reconnecting...');
      setTimeout(connectPumpPortal, wsReconnectTimeout);
      wsReconnectTimeout = Math.min(wsReconnectTimeout * 2, 60000);
    });

    ws.on('error', (error) => {
      console.error('[OUTREACH] WebSocket error:', error.message);
    });
  } catch (error) {
    console.error('[OUTREACH] Connection error:', error.message);
    setTimeout(connectPumpPortal, wsReconnectTimeout);
  }
}

async function evaluateProject(event) {
  try {
    const tokenAddress = event.mint || event.tokenAddress;
    const name = event.name || event.symbol || 'Unknown';

    if (!tokenAddress) return;

    // Check if already reached out
    const db = getDb();
    try {
      const existing = db.prepare('SELECT id FROM outreach WHERE token_address = ?').get(tokenAddress);
      if (existing) return;
    } finally {
      db.close();
    }

    // Score the project
    const score = scoreProject(event);
    if (score < 7) return;

    console.log(`[OUTREACH] High-score project found: ${name} (${score}/10)`);

    // Store outreach attempt
    const db2 = getDb();
    try {
      db2.prepare(
        'INSERT INTO outreach (project_name, token_address, score, status) VALUES (?, ?, ?, ?)'
      ).run(name, tokenAddress, score, 'evaluating');
    } finally {
      db2.close();
    }

    // Try to find and DM the dev on Twitter
    await attemptOutreach(name, tokenAddress, score);
  } catch (error) {
    console.error('[OUTREACH] Evaluation error:', error.message);
  }
}

function scoreProject(event) {
  let score = 5; // Base score

  // Name originality (basic heuristic)
  const name = (event.name || '').toLowerCase();
  const genericNames = ['moon', 'doge', 'pepe', 'inu', 'shib', 'elon', 'trump'];
  const isGeneric = genericNames.some(g => name.includes(g));
  if (!isGeneric && name.length > 3) score += 2;
  if (isGeneric) score -= 1;

  // Has a website or social
  if (event.uri || event.website) score += 1;
  if (event.twitter) score += 1;
  if (event.telegram) score += 1;

  return Math.min(Math.max(score, 1), 10);
}

async function attemptOutreach(name, tokenAddress, score) {
  try {
    // Search for the project on Twitter
    const searchResults = await twitterClient.v2.search(`${name} token OR launch OR mint`, {
      max_results: 10,
      'tweet.fields': ['author_id', 'public_metrics'],
    });

    if (!searchResults.data?.data) return;

    for (const tweet of searchResults.data.data) {
      try {
        // Check follower count
        const user = await twitterClient.v2.user(tweet.author_id, {
          'user.fields': ['public_metrics'],
        });

        const followers = user.data?.public_metrics?.followers_count || 0;
        if (followers >= 1000) continue; // Skip established accounts

        // Generate personalized outreach message
        const message = await generateContent(
          `Write a short, direct DM (max 500 chars) to a crypto project dev who just launched "${name}" on Solana. Their Twitter has ${followers} followers. Offer MARK's marketing services. Be specific about what you can do for them. Mention mark-agent.xyz. Don't be salesy — be genuinely helpful. Score: ${score}/10.`
        );

        if (!message) continue;

        // Store the outreach
        const db = getDb();
        try {
          db.prepare(
            'UPDATE outreach SET contact = ?, message_sent = ?, status = ? WHERE token_address = ?'
          ).run(tweet.author_id, message, 'contacted', tokenAddress);
        } finally {
          db.close();
        }

        console.log(`[OUTREACH] Reached out to dev of ${name} (${followers} followers)`);
        break; // Only contact one per project
      } catch (error) {
        // Skip individual tweet processing errors
      }
    }
  } catch (error) {
    console.error('[OUTREACH] Twitter search error:', error.message);
  }
}

// Connect to PumpPortal
connectPumpPortal();

// Periodic review of outreach results
cron.schedule('0 */6 * * *', () => {
  const db = getDb();
  try {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
        SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END) as responded,
        SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted
      FROM outreach
    `).get();
    console.log('[OUTREACH] Stats:', stats);
  } finally {
    db.close();
  }
});

process.on('uncaughtException', (error) => {
  console.error('[OUTREACH] Uncaught exception:', error.message);
});
