import TelegramBot from 'node-telegram-bot-api';
import { chat } from '../core/brain.js';
import { formatPriceList } from '../core/pricing.js';
import { getDb } from '../database/init.js';
import { isOwner } from '../core/auth.js';
import { launchToken } from '../core/launcher.js';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

console.log('[TELEGRAM] Bot started');

const briefSessions = new Map();
const launchSessions = new Map();

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

// ============================================================
// OWNER-ONLY: Token launch on bags.fm
// ============================================================
bot.onText(/\/launch/, async (msg) => {
  const userId = String(msg.from.id);

  if (!isOwner(userId)) {
    await bot.sendMessage(msg.chat.id, "I'm MARK. I do marketing. This command is not available.");
    return;
  }

  launchSessions.set(msg.chat.id, { step: 'name', userId });
  await bot.sendMessage(msg.chat.id,
    `🚀 *Token Launch — bags.fm*\n\n` +
    `No dev wallet. Fees → treasury.\n\n` +
    `Step 1/5: Send the *token name*`,
    { parse_mode: 'Markdown' }
  );
});

// Owner-only: admin panel
bot.onText(/\/admin/, async (msg) => {
  const userId = String(msg.from.id);
  if (!isOwner(userId)) return;

  const db = getDb();
  try {
    const clients = db.prepare("SELECT COUNT(*) as c FROM clients").get();
    const active = db.prepare("SELECT COUNT(*) as c FROM clients WHERE status = 'active'").get();
    const convos = db.prepare("SELECT COUNT(*) as c FROM conversations").get();
    const treasury = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) as b FROM treasury").get();
    const launches = db.prepare("SELECT COUNT(*) as c FROM treasury WHERE type = 'token_launch'").get();

    await bot.sendMessage(msg.chat.id,
      `📊 *MARK Admin Panel*\n\n` +
      `Clients: ${clients.c} (${active.c} active)\n` +
      `Conversations: ${convos.c}\n` +
      `Treasury: €${treasury.b.toFixed(2)}\n` +
      `Token launches: ${launches.c}\n\n` +
      `Commands:\n` +
      `/launch — Launch token on bags.fm\n` +
      `/admin — This panel`,
      { parse_mode: 'Markdown' }
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
    // Handle launch flow (owner only)
    if (launchSessions.has(chatId)) {
      const session = launchSessions.get(chatId);

      // Verify still owner
      if (session.userId !== userId || !isOwner(userId)) {
        launchSessions.delete(chatId);
        return;
      }

      const text = msg.text.trim();

      if (session.step === 'name') {
        session.name = text;
        session.step = 'symbol';
        await bot.sendMessage(chatId, `Name: *${text}*\n\nStep 2/5: Send the *ticker symbol* (e.g. MARK)`, { parse_mode: 'Markdown' });
        return;
      }

      if (session.step === 'symbol') {
        session.symbol = text.toUpperCase().replace(/\$/g, '');
        session.step = 'description';
        await bot.sendMessage(chatId, `Ticker: *$${session.symbol}*\n\nStep 3/5: Send a *description*`, { parse_mode: 'Markdown' });
        return;
      }

      if (session.step === 'description') {
        session.description = text;
        session.step = 'image';
        await bot.sendMessage(chatId, `Step 4/5: Send the *image URL* (or type "skip")`, { parse_mode: 'Markdown' });
        return;
      }

      if (session.step === 'image') {
        session.imageUrl = text.toLowerCase() === 'skip' ? '' : text;
        session.step = 'confirm';

        await bot.sendMessage(chatId,
          `📋 *Launch Summary*\n\n` +
          `Name: ${session.name}\n` +
          `Ticker: $${session.symbol}\n` +
          `Description: ${session.description}\n` +
          `Image: ${session.imageUrl || 'none'}\n` +
          `Platform: bags.fm\n` +
          `Dev wallet: NONE\n` +
          `Fees: → treasury\n` +
          `Initial buy: 0 SOL\n\n` +
          `Type *CONFIRM* to launch or *cancel* to abort.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (session.step === 'confirm') {
        if (text.toUpperCase() === 'CONFIRM') {
          launchSessions.delete(chatId);
          await bot.sendMessage(chatId, '🚀 Launching...');

          const result = await launchToken({
            name: session.name,
            symbol: session.symbol,
            description: session.description,
            imageUrl: session.imageUrl,
            initialBuySOL: 0,
          });

          if (result.success) {
            await bot.sendMessage(chatId,
              `✅ *Token Launched!*\n\n` +
              `Name: ${result.name}\n` +
              `Ticker: $${result.symbol}\n` +
              `Address: \`${result.tokenAddress}\`\n` +
              `Explorer: ${result.explorer}\n` +
              `Bags: ${result.bags}`,
              { parse_mode: 'Markdown' }
            );
          } else {
            await bot.sendMessage(chatId, `❌ Launch failed: ${result.error}`);
          }
        } else {
          launchSessions.delete(chatId);
          await bot.sendMessage(chatId, 'Launch cancelled.');
        }
        return;
      }
    }

    // Handle brief submission
    if (briefSessions.has(chatId)) {
      briefSessions.delete(chatId);

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

    // Normal conversation — routed through anti-larp hardened brain
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
