import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chat } from '../core/brain.js';
import { getPrices, getPricingHistory } from '../core/pricing.js';
import { getDb } from '../database/init.js';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3032;

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

// API: Public config (Stripe publishable key + SOL wallet — safe to expose)
app.get('/api/config', (req, res) => {
  res.json({
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    solanaAddress: process.env.TREASURY_WALLET_PUBLIC_KEY || '',
  });
});

// API: Chat
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    const response = await chat(message, {
      channel: 'web',
      userId: sessionId || req.ip,
      username: 'web_visitor',
    });
    res.json({ response });
  } catch (error) {
    console.error('[WEB] Chat error:', error.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// API: Prices
app.get('/api/prices', (req, res) => {
  try {
    res.json(getPrices());
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch prices' });
  }
});

// API: Pricing decision history
app.get('/api/pricing-history', (req, res) => {
  try {
    res.json(getPricingHistory(30));
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch pricing history' });
  }
});

// API: Submit brief
app.post('/api/brief', async (req, res) => {
  try {
    const { name, email, brief } = req.body;
    if (!brief) return res.status(400).json({ error: 'Brief required' });

    const db = getDb();
    try {
      db.prepare('INSERT INTO clients (name, contact, channel, project_brief, status) VALUES (?, ?, ?, ?, ?)')
        .run(name || 'Web Visitor', email || '', 'web', brief, 'inquiry');
    } finally {
      db.close();
    }

    const analysis = await chat(
      `New project brief submitted via website. Analyze:\n\nName: ${name}\nEmail: ${email}\n\n${brief}`,
      { channel: 'web', userId: email || req.ip, username: name || 'web_visitor' }
    );

    res.json({ analysis });
  } catch (error) {
    console.error('[WEB] Brief error:', error.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// API: Dashboard stats
app.get('/api/stats', (req, res) => {
  try {
    const db = getDb();
    try {
      const activeClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").get();
      const totalClients = db.prepare("SELECT COUNT(*) as count FROM clients").get();
      const treasuryBalance = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) as balance FROM treasury").get();
      const totalConversations = db.prepare("SELECT COUNT(*) as count FROM conversations").get();
      const latestMetrics = db.prepare("SELECT * FROM metrics ORDER BY date DESC LIMIT 1").get();

      res.json({
        activeClients: activeClients.count,
        totalClients: totalClients.count,
        treasuryBalance: treasuryBalance.balance,
        totalConversations: totalConversations.count,
        twitterFollowers: latestMetrics?.twitter_followers || 0,
        mrr: latestMetrics?.mrr || 0,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats' });
  }
});

// Serve all pages
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[WEBSITE] Running on port ${PORT}`);
});

process.on('uncaughtException', (error) => {
  console.error('[WEBSITE] Uncaught exception:', error.message);
});
