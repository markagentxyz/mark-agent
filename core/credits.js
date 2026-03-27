/**
 * Credit system for MARK's cook groups and paid services.
 *
 * Payment flow:
 * 1. User sends SOL to MARK's treasury wallet
 * 2. User shares Solscan TX link in Telegram
 * 3. MARK verifies the transaction on-chain via Helius/RPC
 * 4. Credits are added: 1 SOL = 100 credits, 1 credit = 1 AI response
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getDb } from '../database/init.js';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TREASURY = process.env.TREASURY_WALLET_PUBLIC_KEY;

// 1 SOL = 100 credits (1 credit = 1 AI response in cook group)
const CREDITS_PER_SOL = 100;
// Minimum payment
const MIN_SOL = 0.05;

/**
 * Extract transaction signature from a Solscan/Explorer URL or raw signature
 */
export function extractTxSignature(input) {
  const text = input.trim();

  // Direct signature (base58, 87-88 chars)
  if (/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(text)) {
    return text;
  }

  // Solscan URL
  const solscanMatch = text.match(/solscan\.io\/tx\/([1-9A-HJ-NP-Za-km-z]{87,88})/);
  if (solscanMatch) return solscanMatch[1];

  // Solana Explorer URL
  const explorerMatch = text.match(/explorer\.solana\.com\/tx\/([1-9A-HJ-NP-Za-km-z]{87,88})/);
  if (explorerMatch) return explorerMatch[1];

  // Solana FM
  const fmMatch = text.match(/solana\.fm\/tx\/([1-9A-HJ-NP-Za-km-z]{87,88})/);
  if (fmMatch) return fmMatch[1];

  return null;
}

/**
 * Verify a SOL payment transaction on-chain
 * Returns { verified, amount, error }
 */
export async function verifyPayment(txSignature) {
  try {
    const connection = new Connection(RPC_URL, 'confirmed');

    // Check if already processed
    const db = getDb();
    try {
      const existing = db.prepare('SELECT id FROM payments WHERE tx_signature = ?').get(txSignature);
      if (existing) {
        return { verified: false, amount: 0, error: 'Transaction already processed' };
      }
    } finally {
      db.close();
    }

    // Fetch transaction
    const tx = await connection.getTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return { verified: false, amount: 0, error: 'Transaction not found. Make sure it is confirmed.' };
    }

    if (tx.meta?.err) {
      return { verified: false, amount: 0, error: 'Transaction failed on-chain' };
    }

    // Check if treasury wallet received SOL
    const accountKeys = tx.transaction.message.staticAccountKeys
      ? tx.transaction.message.staticAccountKeys.map(k => k.toBase58())
      : tx.transaction.message.accountKeys.map(k => k.toBase58());

    const treasuryIndex = accountKeys.indexOf(TREASURY);
    if (treasuryIndex === -1) {
      return { verified: false, amount: 0, error: `Payment not sent to MARK\'s wallet (${TREASURY.substring(0, 8)}...)` };
    }

    // Calculate SOL received by treasury
    const preBalance = tx.meta.preBalances[treasuryIndex];
    const postBalance = tx.meta.postBalances[treasuryIndex];
    const lamportsReceived = postBalance - preBalance;
    const solReceived = lamportsReceived / 1e9;

    if (solReceived < MIN_SOL) {
      return { verified: false, amount: solReceived, error: `Payment too small (${solReceived.toFixed(4)} SOL). Minimum is ${MIN_SOL} SOL.` };
    }

    return { verified: true, amount: solReceived, error: null };
  } catch (error) {
    console.error('[CREDITS] Verify error:', error.message);
    return { verified: false, amount: 0, error: 'Could not verify transaction: ' + error.message };
  }
}

/**
 * Process a verified payment: add credits to user/chat
 */
export function addCredits(chatId, userId, txSignature, solAmount) {
  const creditsToAdd = Math.floor(solAmount * CREDITS_PER_SOL);

  const db = getDb();
  try {
    // Record payment
    db.prepare(
      'INSERT INTO payments (chat_id, user_id, tx_signature, amount_sol, credits_added, verified) VALUES (?, ?, ?, ?, ?, 1)'
    ).run(String(chatId), String(userId), txSignature, solAmount, creditsToAdd);

    // Update or create credits record
    const existing = db.prepare('SELECT id, credits_remaining, total_paid_sol FROM credits WHERE chat_id = ?').get(String(chatId));

    if (existing) {
      db.prepare(
        'UPDATE credits SET credits_remaining = credits_remaining + ?, total_paid_sol = total_paid_sol + ?, last_payment_tx = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?'
      ).run(creditsToAdd, solAmount, txSignature, String(chatId));
    } else {
      db.prepare(
        'INSERT INTO credits (chat_id, user_id, credits_remaining, total_paid_sol, last_payment_tx) VALUES (?, ?, ?, ?, ?)'
      ).run(String(chatId), String(userId), creditsToAdd, solAmount, txSignature);
    }

    console.log(`[CREDITS] Added ${creditsToAdd} credits to chat ${chatId} (${solAmount} SOL)`);
    return creditsToAdd;
  } finally {
    db.close();
  }
}

/**
 * Use 1 credit from a chat. Returns true if credit was available.
 */
export function useCredit(chatId) {
  const db = getDb();
  try {
    const record = db.prepare('SELECT credits_remaining FROM credits WHERE chat_id = ?').get(String(chatId));
    if (!record || record.credits_remaining <= 0) return false;

    db.prepare('UPDATE credits SET credits_remaining = credits_remaining - 1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?')
      .run(String(chatId));
    return true;
  } finally {
    db.close();
  }
}

/**
 * Get credits balance for a chat
 */
export function getCredits(chatId) {
  const db = getDb();
  try {
    const record = db.prepare('SELECT credits_remaining, total_paid_sol FROM credits WHERE chat_id = ?').get(String(chatId));
    return record || { credits_remaining: 0, total_paid_sol: 0 };
  } finally {
    db.close();
  }
}
