import WebSocket from 'ws';
import { getDb } from '../database/init.js';
import cron from 'node-cron';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

console.log('[OUTREACH] Crypto outreach agent started (PumpPortal detection only, no X API)');

let wsReconnectTimeout = 5000;

function connectPumpPortal() {
  try {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    ws.on('open', () => {
      console.log('[OUTREACH] Connected to PumpPortal');
      wsReconnectTimeout = 5000;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.txType === 'create' || event.mint) {
          await evaluateProject(event);
        }
      } catch {
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

    // Check if already tracked
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

    // Store in database for review — no Twitter outreach, just detection
    const db2 = getDb();
    try {
      db2.prepare(
        'INSERT INTO outreach (project_name, token_address, score, status, contact) VALUES (?, ?, ?, ?, ?)'
      ).run(
        name,
        tokenAddress,
        score,
        'detected',
        event.twitter || event.website || ''
      );
    } finally {
      db2.close();
    }
  } catch (error) {
    console.error('[OUTREACH] Evaluation error:', error.message);
  }
}

function scoreProject(event) {
  let score = 5;

  const name = (event.name || '').toLowerCase();
  const genericNames = ['moon', 'doge', 'pepe', 'inu', 'shib', 'elon', 'trump'];
  const isGeneric = genericNames.some(g => name.includes(g));
  if (!isGeneric && name.length > 3) score += 2;
  if (isGeneric) score -= 1;

  if (event.uri || event.website) score += 1;
  if (event.twitter) score += 1;
  if (event.telegram) score += 1;

  return Math.min(Math.max(score, 1), 10);
}

// Connect to PumpPortal
connectPumpPortal();

// Periodic stats review
cron.schedule('0 */6 * * *', () => {
  const db = getDb();
  try {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN score >= 8 THEN 1 ELSE 0 END) as high_quality,
        SUM(CASE WHEN score >= 9 THEN 1 ELSE 0 END) as top_tier
      FROM outreach
      WHERE timestamp > datetime('now', '-24 hours')
    `).get();
    console.log('[OUTREACH] Last 24h:', stats);
  } finally {
    db.close();
  }
});

process.on('uncaughtException', (error) => {
  console.error('[OUTREACH] Uncaught exception:', error.message);
});
