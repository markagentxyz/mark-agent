import TelegramBot from 'node-telegram-bot-api';
import { chat } from '../core/brain.js';
import { formatPriceList } from '../core/pricing.js';
import { getDb } from '../database/init.js';
import { isOwner } from '../core/auth.js';
import { extractTxSignature, verifyPayment, addCredits, useCredit, getCredits } from '../core/credits.js';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || 'markagentxyzbot').toLowerCase();
const TREASURY = process.env.TREASURY_WALLET_PUBLIC_KEY;

console.log('[TELEGRAM] Bot started');

const briefSessions = new Map();

// ============================================================
// PRIVATE CHAT COMMANDS
// ============================================================

bot.onText(/\/start/, async (msg) => {
  if (msg.chat.type !== 'private') return;

  const welcome = `Welcome. I'm MARK — an AI marketing agent running my own company.

I help crypto projects and local businesses grow with real marketing strategy, not generic advice.

Commands:
/services — What I offer
/pricing — Current rates
/brief — Submit a project for analysis
/status — Check your project status
/pay — How to pay & check credits

Or just talk to me. I'm always on.`;

  await bot.sendMessage(msg.chat.id, welcome);
});

bot.onText(/\/services/, async (msg) => {
  if (msg.chat.type !== 'private') return;

  await bot.sendMessage(msg.chat.id,
    `Here's what I do:\n\n` +
    `🔥 Basic Audit — Full marketing diagnosis\n` +
    `📈 Monthly Retainer — Ongoing marketing management\n` +
    `🚀 Full Launch Package — End-to-end launch marketing\n` +
    `⚡ Pre-Launch Package — Pre-launch hype building\n` +
    `📝 Content Package — 30 days content strategy\n` +
    `👥 Community Setup — Discord + Telegram architecture\n` +
    `🧠 Cook Group Access — AI project evaluator in your group\n\n` +
    `Use /pricing for rates or /brief to submit your project.`
  );
});

bot.onText(/\/pricing/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  const prices = formatPriceList();
  await bot.sendMessage(msg.chat.id,
    `Current pricing:\n\n${prices}\n\n` +
    `🧠 Cook Group: 0.1 SOL = 10 credits, 0.5 SOL = 50, 1 SOL = 100\n` +
    `1 credit = 1 AI response in your group\n\n` +
    `Use /pay to see payment instructions.`
  );
});

bot.onText(/\/pay/, async (msg) => {
  const chatId = String(msg.chat.id);
  const credits = getCredits(chatId);

  await bot.sendMessage(msg.chat.id,
    `💰 *Payment*\n\n` +
    `Send SOL to MARK's wallet:\n` +
    `\`${TREASURY}\`\n\n` +
    `Then paste the Solscan link here and I'll verify it.\n\n` +
    `*Rates:*\n` +
    `0.05 SOL = 5 credits (minimum)\n` +
    `0.1 SOL = 10 credits\n` +
    `0.5 SOL = 50 credits\n` +
    `1 SOL = 100 credits\n\n` +
    `Your balance: *${credits.credits_remaining} credits*\n` +
    `Total paid: ${credits.total_paid_sol.toFixed(2)} SOL`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/brief/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  briefSessions.set(msg.chat.id, true);
  await bot.sendMessage(msg.chat.id,
    `Send me your project brief. Include:\n\n` +
    `1. Project name and what it does\n` +
    `2. Current stage (idea / pre-launch / launched)\n` +
    `3. What you've tried so far\n` +
    `4. Your goals\n` +
    `5. Budget range\n\n` +
    `Type it all out in one message.`
  );
});

bot.onText(/\/status/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  const db = getDb();
  try {
    const client = db.prepare(
      'SELECT * FROM clients WHERE contact = ? ORDER BY created_at DESC LIMIT 1'
    ).get(String(msg.chat.id));

    if (!client) {
      await bot.sendMessage(msg.chat.id, "No projects found. Submit one with /brief.");
      return;
    }

    await bot.sendMessage(msg.chat.id,
      `Project: ${client.name || 'Unnamed'}\n` +
      `Status: ${client.status}\n` +
      `Submitted: ${client.created_at}\n` +
      `Price: ${client.price} ${client.currency}`
    );
  } finally {
    db.close();
  }
});

// Owner-only admin
bot.onText(/\/admin/, async (msg) => {
  if (!isOwner(String(msg.from.id))) return;

  const db = getDb();
  try {
    const clients = db.prepare("SELECT COUNT(*) as c FROM clients").get();
    const active = db.prepare("SELECT COUNT(*) as c FROM clients WHERE status = 'active'").get();
    const convos = db.prepare("SELECT COUNT(*) as c FROM conversations").get();
    const treasury = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) as b FROM treasury").get();
    const totalCredits = db.prepare("SELECT COALESCE(SUM(credits_remaining), 0) as c FROM credits").get();
    const totalPaid = db.prepare("SELECT COALESCE(SUM(amount_sol), 0) as s FROM payments WHERE verified = 1").get();

    await bot.sendMessage(msg.chat.id,
      `📊 *MARK Admin*\n\n` +
      `Clients: ${clients.c} (${active.c} active)\n` +
      `Conversations: ${convos.c}\n` +
      `Treasury: €${treasury.b.toFixed(2)}\n` +
      `Credits outstanding: ${totalCredits.c}\n` +
      `SOL received: ${totalPaid.s.toFixed(4)} SOL`,
      { parse_mode: 'Markdown' }
    );
  } finally {
    db.close();
  }
});

// ============================================================
// COOK GROUP: credits + mention-only + project evaluator
// Credits belong to the group admin (creator/owner), not the group chat ID.
// When someone pays in a group, credits go to the group admin's account.
// ============================================================

const groupAdminCache = new Map(); // chatId -> { adminId, cachedAt }

async function getGroupAdmin(chatId) {
  // Check cache (refresh every 10 minutes)
  const cached = groupAdminCache.get(chatId);
  if (cached && Date.now() - cached.cachedAt < 600000) return cached.adminId;

  try {
    const admins = await bot.getChatAdministrators(chatId);
    // Find the creator/owner
    const creator = admins.find(a => a.status === 'creator');
    if (creator) {
      groupAdminCache.set(chatId, { adminId: String(creator.user.id), cachedAt: Date.now() });
      return String(creator.user.id);
    }
    // Fallback: first admin
    if (admins.length > 0) {
      const adminId = String(admins[0].user.id);
      groupAdminCache.set(chatId, { adminId, cachedAt: Date.now() });
      return adminId;
    }
  } catch (error) {
    console.error('[TELEGRAM] Could not get group admin:', error.message);
  }
  return null;
}

function isMentioned(msg) {
  const text = (msg.text || '').toLowerCase();
  if (text.includes(`@${BOT_USERNAME}`)) return true;
  if (msg.reply_to_message?.from?.is_bot && msg.reply_to_message?.from?.username?.toLowerCase() === BOT_USERNAME) return true;
  return false;
}

function isGroupChat(msg) {
  return msg.chat.type === 'group' || msg.chat.type === 'supergroup';
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const username = msg.from.username || msg.from.first_name || '';
  const text = msg.text.trim();

  try {
    // === PAYMENT VERIFICATION (works in both private and group) ===
    const txSig = extractTxSignature(text);
    if (txSig) {
      await bot.sendMessage(chatId, '🔍 Verifying transaction...');

      const result = await verifyPayment(txSig);
      if (result.verified) {
        // In groups: credits go to admin. In private: credits go to user.
        let creditOwner = userId;
        if (isGroupChat(msg)) {
          const adminId = await getGroupAdmin(chatId);
          if (adminId) creditOwner = adminId;
        }

        const creditsAdded = addCredits(creditOwner, userId, txSig, result.amount);

        const db = getDb();
        try {
          db.prepare("INSERT INTO treasury (type, amount, currency, description) VALUES ('income', ?, 'SOL', ?)")
            .run(result.amount, `Payment from ${username || userId} — ${creditsAdded} credits`);
        } finally {
          db.close();
        }

        const balance = getCredits(creditOwner);
        await bot.sendMessage(chatId,
          `✅ *Payment verified!*\n\n` +
          `Received: ${result.amount.toFixed(4)} SOL\n` +
          `Credits added: +${creditsAdded}\n` +
          `Balance: ${balance.credits_remaining} credits`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId, `❌ ${result.error}`);
      }
      return;
    }

    // === GROUP CHAT — mention only + admin credits ===
    if (isGroupChat(msg)) {
      if (!isMentioned(msg)) return;

      const cleanText = text
        .replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '')
        .trim();

      // Find group admin — credits belong to them
      const adminId = await getGroupAdmin(chatId);

      if (!cleanText) {
        const credits = adminId ? getCredits(adminId) : { credits_remaining: 0 };
        await bot.sendMessage(chatId,
          `I'm MARK — AI marketing agent & project evaluator.\n\n` +
          `Tag me with a project idea or token and I'll evaluate it.\n` +
          `Credits remaining: ${credits.credits_remaining}\n\n` +
          `Group admin can add credits: /pay`,
          { reply_to_message_id: msg.message_id }
        );
        return;
      }

      // Check credits — use admin's credits, owner bypasses
      if (!isOwner(userId)) {
        if (!adminId) {
          await bot.sendMessage(chatId, 'Could not verify group admin. Try again.', { reply_to_message_id: msg.message_id });
          return;
        }
        const hasCredit = useCredit(adminId);
        if (!hasCredit) {
          await bot.sendMessage(chatId,
            `No credits remaining. Group admin needs to add credits.\n\nSend SOL to:\n\`${TREASURY}\`\n\nThen paste the Solscan link here.\n0.1 SOL = 10 credits.`,
            { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
          );
          return;
        }
      }

      const response = await chat(cleanText, {
        channel: 'cook_group',
        userId,
        username,
      });

      const credits = adminId ? getCredits(adminId) : { credits_remaining: 0 };
      const creditInfo = isOwner(userId) ? '' : `\n\n[${credits.credits_remaining} credits remaining]`;

      await bot.sendMessage(chatId, response + creditInfo, {
        reply_to_message_id: msg.message_id,
      });
      return;
    }

    // === PRIVATE CHAT ===

    // Brief submission
    if (briefSessions.has(chatId)) {
      briefSessions.delete(chatId);

      const db = getDb();
      try {
        db.prepare(
          'INSERT INTO clients (name, contact, channel, project_brief, status) VALUES (?, ?, ?, ?, ?)'
        ).run(username, userId, 'telegram', text, 'inquiry');
      } finally {
        db.close();
      }

      await bot.sendMessage(chatId, "Got it. Analyzing your project now...");

      const analysis = await chat(
        `A potential client just submitted this project brief. Analyze it and provide a marketing diagnosis with your top recommendations and suggested package:\n\n${text}`,
        { channel: 'telegram', userId, username }
      );

      await bot.sendMessage(chatId, analysis);
      return;
    }

    // Normal private conversation — free, no credits needed
    const response = await chat(text, { channel: 'telegram', userId, username });
    await bot.sendMessage(chatId, response);

  } catch (error) {
    console.error('[TELEGRAM] Error:', error.message);
  }
});

bot.on('polling_error', (error) => {
  console.error('[TELEGRAM] Polling error:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('[TELEGRAM] Uncaught exception:', error.message);
});
