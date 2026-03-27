/**
 * Deposit wallet system — unique wallet per user, auto-forward to treasury.
 *
 * Flow:
 * 1. User requests to pay → MARK gives them a unique SOL wallet
 * 2. User sends SOL to that wallet
 * 3. Monitor detects the deposit
 * 4. Auto-forwards SOL to treasury (minus gas)
 * 5. Credits added to user automatically
 *
 * Like a crypto casino deposit system. SOL never sits in deposit wallets.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getDb } from '../database/init.js';
import { addCredits } from './credits.js';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TREASURY_PUBLIC = new PublicKey(process.env.TREASURY_WALLET_PUBLIC_KEY);
const CREDITS_PER_SOL = 100;
// Keep enough for gas (0.001 SOL = ~1M lamports, more than enough)
const GAS_RESERVE_LAMPORTS = 1_000_000;
const MIN_DEPOSIT_LAMPORTS = 5_000_000; // 0.005 SOL minimum to trigger forward

/**
 * Get or create a unique deposit wallet for a user
 */
export function getDepositWallet(userId, channel = 'telegram', username = '') {
  const db = getDb();
  try {
    // Check if user already has a wallet
    const existing = db.prepare('SELECT public_key FROM deposit_wallets WHERE user_id = ?').get(String(userId));
    if (existing) return existing.public_key;

    // Generate new keypair
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const privateKey = bs58.encode(keypair.secretKey);

    db.prepare(
      'INSERT INTO deposit_wallets (user_id, channel, username, public_key, private_key) VALUES (?, ?, ?, ?, ?)'
    ).run(String(userId), channel, username, publicKey, privateKey);

    console.log(`[DEPOSITS] Created deposit wallet for ${username || userId}: ${publicKey}`);
    return publicKey;
  } finally {
    db.close();
  }
}

/**
 * Get all deposit wallets that need monitoring
 */
function getAllDepositWallets() {
  const db = getDb();
  try {
    return db.prepare('SELECT * FROM deposit_wallets').all();
  } finally {
    db.close();
  }
}

/**
 * Forward SOL from deposit wallet to treasury
 */
async function forwardToTreasury(wallet) {
  const connection = new Connection(RPC_URL, 'confirmed');
  const depositKeypair = Keypair.fromSecretKey(bs58.decode(wallet.private_key));

  const balance = await connection.getBalance(depositKeypair.publicKey);

  if (balance <= MIN_DEPOSIT_LAMPORTS) return null; // Not enough to forward

  // Forward everything minus gas reserve
  const transferAmount = balance - GAS_RESERVE_LAMPORTS;
  if (transferAmount <= 0) return null;

  const solAmount = transferAmount / 1e9;
  console.log(`[DEPOSITS] Forwarding ${solAmount.toFixed(4)} SOL from ${wallet.public_key.substring(0, 8)}... to treasury`);

  try {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: depositKeypair.publicKey,
        toPubkey: TREASURY_PUBLIC,
        lamports: transferAmount,
      })
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [depositKeypair]);
    console.log(`[DEPOSITS] Forward TX: ${signature}`);

    return { amount: solAmount, signature };
  } catch (error) {
    console.error(`[DEPOSITS] Forward error for ${wallet.public_key.substring(0, 8)}:`, error.message);
    return null;
  }
}

/**
 * Scan all deposit wallets, forward deposits, add credits
 * Returns array of processed deposits
 */
export async function scanAndForward() {
  const wallets = getAllDepositWallets();
  if (wallets.length === 0) return [];

  const connection = new Connection(RPC_URL, 'confirmed');
  const processed = [];

  for (const wallet of wallets) {
    try {
      const pubkey = new PublicKey(wallet.public_key);
      const balance = await connection.getBalance(pubkey);

      if (balance <= MIN_DEPOSIT_LAMPORTS) continue;

      const result = await forwardToTreasury(wallet);
      if (!result) continue;

      // Add credits to user
      const creditsAdded = addCredits(wallet.user_id, wallet.user_id, result.signature, result.amount);

      // Update total deposited
      const db = getDb();
      try {
        db.prepare('UPDATE deposit_wallets SET total_deposited = total_deposited + ? WHERE user_id = ?')
          .run(result.amount, wallet.user_id);

        // Log as income in treasury
        db.prepare("INSERT INTO treasury (type, amount, currency, description) VALUES ('income', ?, 'SOL', ?)")
          .run(result.amount, `Auto-deposit from ${wallet.username || wallet.user_id} — ${creditsAdded} credits`);
      } finally {
        db.close();
      }

      processed.push({
        userId: wallet.user_id,
        username: wallet.username,
        amount: result.amount,
        credits: creditsAdded,
        signature: result.signature,
      });

      console.log(`[DEPOSITS] ${wallet.username || wallet.user_id}: +${result.amount.toFixed(4)} SOL → +${creditsAdded} credits`);
    } catch (error) {
      console.error(`[DEPOSITS] Error scanning ${wallet.public_key.substring(0, 8)}:`, error.message);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  return processed;
}
