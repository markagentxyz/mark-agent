import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import Stripe from 'stripe';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chat } from '../core/brain.js';
import { getPrices, getPricingHistory } from '../core/pricing.js';
import { getDb } from '../database/init.js';
import { extractTxSignature, verifyPayment } from '../core/credits.js';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3032;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const DOMAIN = process.env.DOMAIN || 'mark-agent.xyz';

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

// API: Public config
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
  try { res.json(getPrices()); }
  catch { res.status(500).json({ error: 'Could not fetch prices' }); }
});

// API: Pricing history
app.get('/api/pricing-history', (req, res) => {
  try { res.json(getPricingHistory(30)); }
  catch { res.status(500).json({ error: 'Could not fetch pricing history' }); }
});

// API: Stripe Checkout Session — all services payable in EUR or USD
app.post('/api/checkout/stripe', async (req, res) => {
  try {
    const { service, email, name, currency } = req.body;
    if (!service) return res.status(400).json({ error: 'Service required' });

    const db = getDb();
    let priceData;
    try {
      priceData = db.prepare('SELECT * FROM prices WHERE service = ?').get(service);
    } finally {
      db.close();
    }

    if (!priceData) return res.status(400).json({ error: 'Service not found' });

    // Convert SOL prices to EUR (approximate rate, updated periodically)
    let amountEur = priceData.price;
    let description = `Marketing service by MARK (mark-agent.xyz)`;
    if (priceData.currency === 'SOL') {
      const SOL_TO_EUR = 130; // Approximate SOL/EUR rate
      amountEur = Math.round(priceData.price * SOL_TO_EUR);
      description += ` — ${priceData.price} SOL equivalent`;
    }

    const stripeCurrency = (currency === 'usd') ? 'usd' : 'eur';
    const serviceName = service.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: stripeCurrency,
          product_data: {
            name: `MARK — ${serviceName}`,
            description,
          },
          unit_amount: Math.round(amountEur * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: email || undefined,
      metadata: { service, client_name: name || '', original_price: `${priceData.price} ${priceData.currency}` },
      success_url: `https://${DOMAIN}/#checkout-success`,
      cancel_url: `https://${DOMAIN}/#checkout-cancel`,
    });

    // Save as client inquiry
    const db2 = getDb();
    try {
      db2.prepare('INSERT INTO clients (name, contact, channel, project_brief, status, price, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name || 'Web Checkout', email || '', 'web', `Stripe checkout: ${serviceName}`, 'inquiry', priceData.price, 'EUR');
    } finally {
      db2.close();
    }

    res.json({ url: session.url });
  } catch (error) {
    console.error('[WEB] Stripe checkout error:', error.message);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// API: Verify SOL payment
app.post('/api/checkout/verify-sol', async (req, res) => {
  try {
    const { txSignature, service, email, name } = req.body;

    const sig = extractTxSignature(txSignature || '');
    if (!sig) return res.status(400).json({ error: 'Invalid transaction signature or URL' });

    const result = await verifyPayment(sig);
    if (!result.verified) {
      return res.json({ verified: false, error: result.error });
    }

    // Log payment in treasury
    const db = getDb();
    try {
      db.prepare("INSERT INTO treasury (type, amount, currency, description) VALUES ('income', ?, 'SOL', ?)")
        .run(result.amount, `Web payment: ${service || 'general'} from ${name || email || 'anonymous'}`);

      // Record in payments table
      db.prepare('INSERT OR IGNORE INTO payments (chat_id, user_id, tx_signature, amount_sol, credits_added, verified) VALUES (?, ?, ?, ?, 0, 1)')
        .run('web', email || 'web', sig, result.amount);

      // Save as client
      const serviceName = (service || 'general').replace(/_/g, ' ');
      db.prepare('INSERT INTO clients (name, contact, channel, project_brief, status, price, currency, paid) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run(name || 'Web Payment', email || '', 'web', `SOL payment: ${serviceName}`, 'active', result.amount, 'SOL');
    } finally {
      db.close();
    }

    res.json({ verified: true, amount: result.amount });
  } catch (error) {
    console.error('[WEB] SOL verify error:', error.message);
    res.status(500).json({ error: 'Verification failed' });
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
  } catch {
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
