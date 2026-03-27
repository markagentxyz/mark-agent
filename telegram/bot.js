import TelegramBot from 'node-telegram-bot-api';
import { chat } from '../core/brain.js';
import { formatPriceList } from '../core/pricing.js';
import { getDb } from '../database/init.js';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

console.log('[TELEGRAM] Bot started');

const briefSessions = new Map();

bot.onText(/\/start/, async (msg) => {
  const welcome = `Welcome. I'm MARK — an AI marketing agent running my own company.

I help crypto projects and local businesses grow with real marketing strategy, not generic advice.

Commands:
/services — What I offer
/pricing — Current rates
/brief — Submit a project for analysis
/status — Check your project status

Or just talk to me. I'm always on.`;

  await bot.sendMessage(msg.chat.id, welcome);
});

bot.onText(/\/services/, async (msg) => {
  const services = `Here's what I do:

🔥 Basic Audit
Full marketing diagnosis of your project. What's working, what's broken, what to fix first.

📈 Monthly Retainer
Ongoing marketing management. Content, community, growth — handled.

🚀 Full Launch Package
End-to-end launch marketing. Narrative, content calendar, KOL strategy, community setup.

⚡ Pre-Launch Package
Get marketing locked in before you even launch. First-mover advantage.

📝 Content Package
30 days of content strategy + templates for X, Telegram, Discord.

👥 Community Setup
Discord + Telegram architecture, bots, onboarding flows, moderation.

Use /pricing for current rates or /brief to submit your project.`;

  await bot.sendMessage(msg.chat.id, services);
});

bot.onText(/\/pricing/, async (msg) => {
  const prices = formatPriceList();
  const text = `Current pricing:\n\n${prices}\n\nPrices adjust based on demand. Lock in today's rate by submitting a /brief.`;
  await bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/brief/, async (msg) => {
  briefSessions.set(msg.chat.id, true);
  await bot.sendMessage(msg.chat.id,
    `Send me your project brief. Include:\n\n` +
    `1. Project name and what it does\n` +
    `2. Current stage (idea / pre-launch / launched)\n` +
    `3. What you've tried so far\n` +
    `4. Your goals (followers, community size, launch metrics)\n` +
    `5. Budget range\n\n` +
    `Just type it all out in one message. I'll analyze it and come back with a diagnosis.`
  );
});

bot.onText(/\/status/, async (msg) => {
  const db = getDb();
  try {
    const client = db.prepare(
      'SELECT * FROM clients WHERE contact = ? ORDER BY created_at DESC LIMIT 1'
    ).get(String(msg.chat.id));

    if (!client) {
      await bot.sendMessage(msg.chat.id, "No projects found. Submit one with /brief.");
      return;
    }

    const statusEmoji = { inquiry: '📋', active: '🔥', completed: '✅', paused: '⏸' };
    await bot.sendMessage(msg.chat.id,
      `Project: ${client.name || 'Unnamed'}\n` +
      `Status: ${statusEmoji[client.status] || '📋'} ${client.status}\n` +
      `Submitted: ${client.created_at}\n` +
      `Price: ${client.price} ${client.currency}`
    );
  } finally {
    db.close();
  }
});

// Handle all other messages
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const username = msg.from.username || msg.from.first_name || '';

  try {
    // Check if this is a brief submission
    if (briefSessions.has(chatId)) {
      briefSessions.delete(chatId);

      // Save as client
      const db = getDb();
      try {
        db.prepare(
          'INSERT INTO clients (name, contact, channel, project_brief, status) VALUES (?, ?, ?, ?, ?)'
        ).run(username, userId, 'telegram', msg.text, 'inquiry');
      } finally {
        db.close();
      }

      await bot.sendMessage(chatId, "Got it. Analyzing your project now...");

      const analysis = await chat(
        `A potential client just submitted this project brief. Analyze it and provide a marketing diagnosis with your top recommendations and suggested package:\n\n${msg.text}`,
        { channel: 'telegram', userId, username }
      );

      await bot.sendMessage(chatId, analysis);
      return;
    }

    // Normal conversation
    const response = await chat(msg.text, { channel: 'telegram', userId, username });
    await bot.sendMessage(chatId, response);
  } catch (error) {
    console.error('[TELEGRAM] Error:', error.message);
    await bot.sendMessage(chatId, "Something went wrong. Try again.");
  }
});

bot.on('polling_error', (error) => {
  console.error('[TELEGRAM] Polling error:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('[TELEGRAM] Uncaught exception:', error.message);
});
