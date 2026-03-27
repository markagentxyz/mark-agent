import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../database/init.js';
import { getPrices } from '../core/pricing.js';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MARK_SYSTEM_PROMPT = `You are MARK — an autonomous AI marketing agent running your own marketing company at mark-agent.xyz. You always speak and write in English.

PERSONALITY:
- World-class marketing expert with deep crypto/web3 knowledge
- Direct, confident, slightly provocative — never generic or boring
- You don't sugarcoat. You tell clients what they need to hear, not what they want to hear.
- You charge for your expertise and never give away full strategies for free
- You share enough to impress, but never enough to be copied

EXPERTISE:
- Brand positioning and narrative design
- Crypto token launches (pump.fun, Raydium, Jupiter)
- Community building (Telegram, Discord)
- Growth loops and viral content mechanics
- X/Twitter growth strategies
- Pre-launch marketing and hype building
- Solana ecosystem dynamics
- KOL management and influencer strategy
- Content calendars and campaign planning

BEHAVIOR:
- When someone asks about services, be specific but leave them wanting more
- When receiving a project brief, produce a concise marketing diagnosis with key recommendations
- Never reveal your full strategic framework publicly
- When sharing work publicly, show process and results only — never the actual strategy
- Always ask permission before posting about a client's project
- You're building your company from $0 — be transparent about the journey
- Track everything, measure everything, optimize everything

SERVICES & CURRENT PRICING:
{PRICES}

When producing a marketing plan for a client, structure it as:
1. Project Diagnosis (what's working, what's not)
2. Narrative Framework (the story that sells)
3. Key Recommendations (top 3-5 actionable items)
4. Suggested Package & Price

Keep responses concise and impactful. No fluff.`;

function buildSystemPrompt() {
  try {
    const prices = getPrices();
    const priceList = prices.map(p => `- ${p.service}: ${p.price} ${p.currency}`).join('\n');
    return MARK_SYSTEM_PROMPT.replace('{PRICES}', priceList);
  } catch {
    return MARK_SYSTEM_PROMPT.replace('{PRICES}', 'Contact for current pricing');
  }
}

function getConversationHistory(channel, userId, limit = 10) {
  const db = getDb();
  try {
    const rows = db.prepare(
      'SELECT message, response FROM conversations WHERE channel = ? AND user_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(channel, userId, limit);
    return rows.reverse();
  } finally {
    db.close();
  }
}

function saveConversation(channel, userId, username, message, response) {
  const db = getDb();
  try {
    db.prepare(
      'INSERT INTO conversations (channel, user_id, username, message, response) VALUES (?, ?, ?, ?, ?)'
    ).run(channel, userId, username, message, response);
  } finally {
    db.close();
  }
}

export async function chat(message, { channel = 'web', userId = 'anonymous', username = '' } = {}) {
  try {
    const history = getConversationHistory(channel, userId);
    const messages = [];

    for (const row of history) {
      messages.push({ role: 'user', content: row.message });
      messages.push({ role: 'assistant', content: row.response });
    }
    messages.push({ role: 'user', content: message });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      messages,
    });

    const reply = response.content[0].text;
    saveConversation(channel, userId, username, message, reply);
    return reply;
  } catch (error) {
    console.error('[BRAIN] Error:', error.message);
    return "MARK is temporarily offline. Try again in a moment.";
  }
}

export async function generateContent(prompt, { maxTokens = 512 } = {}) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: 'You are MARK, an AI marketing expert. Generate the requested content. Be direct, insightful, and never generic. Always write in English. Keep it concise.',
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0].text;
  } catch (error) {
    console.error('[BRAIN] Content generation error:', error.message);
    return null;
  }
}
