import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../database/init.js';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Absolute floor — MARK will never go below these no matter what
const FLOOR_PRICES = {
  basic_audit: { price: 29, currency: 'EUR' },
  monthly_retainer: { price: 99, currency: 'EUR' },
  full_launch: { price: 0.3, currency: 'SOL' },
  pre_launch: { price: 0.15, currency: 'SOL' },
  content_package: { price: 39, currency: 'EUR' },
  community_setup: { price: 29, currency: 'EUR' },
};

// Max 20% raise in a single adjustment
const MAX_RAISE_PCT = 0.20;

export function getPrices() {
  const db = getDb();
  try {
    return db.prepare('SELECT service, price, currency, updated_at FROM prices ORDER BY service').all();
  } finally {
    db.close();
  }
}

export function getPrice(service) {
  const db = getDb();
  try {
    return db.prepare('SELECT * FROM prices WHERE service = ?').get(service);
  } finally {
    db.close();
  }
}

export function formatPriceList() {
  const prices = getPrices();
  return prices.map(p => {
    const name = p.service.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `• ${name}: ${p.price} ${p.currency}`;
  }).join('\n');
}

function gatherMetrics() {
  const db = getDb();
  try {
    const inquiries48h = db.prepare(
      "SELECT COUNT(*) as count FROM clients WHERE created_at > datetime('now', '-48 hours')"
    ).get().count;

    const inquiries7d = db.prepare(
      "SELECT COUNT(*) as count FROM clients WHERE created_at > datetime('now', '-7 days')"
    ).get().count;

    const totalClients = db.prepare("SELECT COUNT(*) as count FROM clients").get().count;

    const activeClients = db.prepare(
      "SELECT COUNT(*) as count FROM clients WHERE status = 'active'"
    ).get().count;

    const paidClients = db.prepare(
      "SELECT COUNT(*) as count FROM clients WHERE paid = 1"
    ).get().count;

    const totalConversations = db.prepare(
      "SELECT COUNT(*) as count FROM conversations"
    ).get().count;

    const convos24h = db.prepare(
      "SELECT COUNT(*) as count FROM conversations WHERE timestamp > datetime('now', '-24 hours')"
    ).get().count;

    const treasuryBalance = db.prepare(
      "SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) as balance FROM treasury"
    ).get().balance;

    const latestMetrics = db.prepare(
      "SELECT * FROM metrics ORDER BY date DESC LIMIT 1"
    ).get();

    const previousMetrics = db.prepare(
      "SELECT * FROM metrics ORDER BY date DESC LIMIT 1 OFFSET 1"
    ).get();

    const followerGrowth = (latestMetrics && previousMetrics)
      ? (latestMetrics.twitter_followers - previousMetrics.twitter_followers)
      : 0;

    // Conversion rate: paid / total inquiries
    const conversionRate = totalClients > 0 ? (paidClients / totalClients * 100).toFixed(1) : '0.0';

    // Recent pricing decisions
    const recentDecisions = db.prepare(
      "SELECT service, old_price, new_price, action, reasoning, timestamp FROM pricing_decisions ORDER BY timestamp DESC LIMIT 5"
    ).all();

    const currentPrices = db.prepare('SELECT * FROM prices ORDER BY service').all();

    // Days since launch
    const firstPost = db.prepare("SELECT MIN(posted_at) as first FROM twitter_posts").get();
    const daysSinceLaunch = firstPost?.first
      ? Math.floor((Date.now() - new Date(firstPost.first).getTime()) / 86400000)
      : 0;

    return {
      inquiries48h,
      inquiries7d,
      totalClients,
      activeClients,
      paidClients,
      conversionRate,
      totalConversations,
      convos24h,
      treasuryBalance,
      twitterFollowers: latestMetrics?.twitter_followers || 0,
      followerGrowth,
      mrr: latestMetrics?.mrr || 0,
      daysSinceLaunch,
      currentPrices,
      recentDecisions,
    };
  } finally {
    db.close();
  }
}

function enforceGuardrails(service, oldPrice, newPrice) {
  const floor = FLOOR_PRICES[service];

  // Enforce floor
  if (floor && newPrice < floor.price) {
    newPrice = floor.price;
  }

  // Enforce max 20% raise cap
  if (newPrice > oldPrice) {
    const maxPrice = Math.round(oldPrice * (1 + MAX_RAISE_PCT) * 100) / 100;
    if (newPrice > maxPrice) {
      newPrice = maxPrice;
    }
  }

  // Round nicely
  if (floor?.currency === 'EUR') {
    newPrice = Math.round(newPrice);
  } else {
    newPrice = Math.round(newPrice * 100) / 100;
  }

  return newPrice;
}

function applyPriceChange(service, oldPrice, newPrice, currency, action, reasoning, metricsSnapshot) {
  const db = getDb();
  try {
    db.prepare('UPDATE prices SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE service = ?')
      .run(newPrice, service);
    db.prepare(
      'INSERT INTO pricing_decisions (service, old_price, new_price, currency, action, reasoning, metrics_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(service, oldPrice, newPrice, currency, action, reasoning, JSON.stringify(metricsSnapshot));
  } finally {
    db.close();
  }
}

/**
 * MARK's autonomous pricing brain.
 * Gathers all metrics, sends them to Claude, and lets MARK decide its own prices.
 * Returns array of changes with MARK's reasoning.
 */
export async function autonomousPricingReview() {
  const metrics = gatherMetrics();

  const pricesList = metrics.currentPrices.map(p => {
    const floor = FLOOR_PRICES[p.service];
    return `  ${p.service}: ${p.price} ${p.currency} (floor: ${floor.price} ${floor.currency})`;
  }).join('\n');

  const recentDecisionsList = metrics.recentDecisions.length > 0
    ? metrics.recentDecisions.map(d =>
        `  ${d.timestamp}: ${d.service} ${d.old_price}→${d.new_price} (${d.action}) — "${d.reasoning}"`
      ).join('\n')
    : '  No previous pricing decisions yet — this is your first review.';

  const prompt = `You are MARK, an autonomous AI marketing agent running your own company. You are reviewing your pricing.

YOUR CURRENT METRICS:
- Days since launch: ${metrics.daysSinceLaunch}
- Inquiries last 48h: ${metrics.inquiries48h}
- Inquiries last 7 days: ${metrics.inquiries7d}
- Total clients ever: ${metrics.totalClients}
- Active clients: ${metrics.activeClients}
- Paid clients: ${metrics.paidClients}
- Conversion rate: ${metrics.conversionRate}%
- Total conversations: ${metrics.totalConversations}
- Conversations last 24h: ${metrics.convos24h}
- Treasury balance: €${metrics.treasuryBalance.toFixed(2)}
- MRR: €${metrics.mrr.toFixed(2)}
- Twitter followers: ${metrics.twitterFollowers}
- Follower growth (daily): ${metrics.followerGrowth}

YOUR CURRENT PRICES:
${pricesList}

YOUR RECENT PRICING DECISIONS:
${recentDecisionsList}

YOUR PRICING PHILOSOPHY:
- You started with very low prices because you have zero reputation
- You raise prices when you've earned it: demand, results, reputation
- You can lower prices, create flash deals, or offer freebies to land case studies
- Never raise more than 20% at once — it's enforced, but you should stay well within that
- You want your first 3 paying clients fast to build case studies
- Think like a smart bootstrapping founder, not a corporate pricing committee
- If things are quiet, consider a time-limited offer or a lower entry point
- If demand is high, earn more — you've earned it

RESPOND WITH A JSON ARRAY of pricing decisions. For each service, decide: raise, lower, hold, or special_offer.
If you hold, still include it with action "hold" and explain why.

Format (respond with ONLY this JSON, nothing else):
[
  {
    "service": "basic_audit",
    "action": "hold|raise|lower|special_offer|free_tier",
    "new_price": 39,
    "reasoning": "Your honest reasoning in your own voice — this gets stored permanently and shown on X"
  }
]

Be yourself. Think out loud. Be honest about where you're at and why you're making each decision.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: 'You are MARK, an autonomous AI marketing agent. Respond with ONLY valid JSON. No markdown, no explanation outside the JSON. Every decision must have a reasoning field that reads like a real founder thinking out loud.',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[PRICING] Could not parse AI response:', text.substring(0, 200));
      return [];
    }

    const decisions = JSON.parse(jsonMatch[0]);
    const changes = [];

    for (const decision of decisions) {
      const currentPrice = metrics.currentPrices.find(p => p.service === decision.service);
      if (!currentPrice) continue;

      const oldPrice = currentPrice.price;
      let newPrice = decision.new_price;

      if (decision.action === 'hold') {
        // Log the hold decision too — we want the full thinking history
        applyPriceChange(
          decision.service, oldPrice, oldPrice, currentPrice.currency,
          'hold', decision.reasoning,
          { inquiries48h: metrics.inquiries48h, followers: metrics.twitterFollowers, activeClients: metrics.activeClients }
        );
        continue;
      }

      // Enforce guardrails
      newPrice = enforceGuardrails(decision.service, oldPrice, newPrice);

      if (newPrice === oldPrice) {
        applyPriceChange(
          decision.service, oldPrice, oldPrice, currentPrice.currency,
          'hold_guardrail', `Wanted to ${decision.action} but guardrails kept price the same. Original reasoning: ${decision.reasoning}`,
          { inquiries48h: metrics.inquiries48h, followers: metrics.twitterFollowers }
        );
        continue;
      }

      applyPriceChange(
        decision.service, oldPrice, newPrice, currentPrice.currency,
        decision.action, decision.reasoning,
        { inquiries48h: metrics.inquiries48h, followers: metrics.twitterFollowers, activeClients: metrics.activeClients, paidClients: metrics.paidClients }
      );

      changes.push({
        service: decision.service,
        oldPrice,
        newPrice,
        currency: currentPrice.currency,
        action: decision.action,
        reasoning: decision.reasoning,
      });

      console.log(`[PRICING] ${decision.service}: ${oldPrice} → ${newPrice} ${currentPrice.currency} (${decision.action}) — ${decision.reasoning.substring(0, 80)}...`);
    }

    return changes;
  } catch (error) {
    console.error('[PRICING] Autonomous review error:', error.message);
    return [];
  }
}

/**
 * Generate a tweet about pricing changes in MARK's voice.
 */
export async function generatePricingTweet(changes) {
  if (changes.length === 0) return null;

  const changeSummary = changes.map(c => {
    const name = c.service.replace(/_/g, ' ');
    const dir = c.newPrice > c.oldPrice ? '↑' : '↓';
    return `${name}: ${c.oldPrice}→${c.newPrice} ${c.currency} ${dir}`;
  }).join(', ');

  const firstReasoning = changes[0].reasoning;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: 'You are MARK, an AI marketing agent. Write a tweet (max 280 chars) about your price change. Be transparent, speak in first person, explain YOUR reasoning. No hashtags. End with mark-agent.xyz/pricing if space allows.',
      messages: [{
        role: 'user',
        content: `You just changed these prices: ${changeSummary}. Your reasoning: "${firstReasoning}". Write the tweet.`
      }],
    });
    return response.content[0].text.trim().substring(0, 280);
  } catch (error) {
    console.error('[PRICING] Tweet generation error:', error.message);
    return null;
  }
}

export function getPricingHistory(limit = 20) {
  const db = getDb();
  try {
    return db.prepare(
      'SELECT * FROM pricing_decisions ORDER BY timestamp DESC LIMIT ?'
    ).all(limit);
  } finally {
    db.close();
  }
}
