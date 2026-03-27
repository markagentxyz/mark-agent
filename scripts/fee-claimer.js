/**
 * pump.fun Creator Fee Auto-Claimer
 *
 * Periodically checks if MARK has claimable creator fees on pump.fun
 * and claims them automatically when above threshold.
 *
 * pump.fun gives creators 0.5% of trading volume on bonding curve.
 * Fees accumulate and must be claimed via on-chain transaction.
 */
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import cron from 'node-cron';
import { getDb } from '../database/init.js';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TREASURY_PUBLIC = process.env.TREASURY_WALLET_PUBLIC_KEY;
const TREASURY_PRIVATE = process.env.TREASURY_WALLET_PRIVATE_KEY;

// pump.fun program
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
// Minimum SOL to bother claiming
const CLAIM_THRESHOLD = 0.01;

console.log('[FEE-CLAIMER] Started — checking pump.fun creator fees');

function getKeypair() {
  return Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE));
}

/**
 * Get bonding curve PDA for a token mint
 */
function getBondingCurvePDA(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM
  );
  return pda;
}

/**
 * Get all token mints to claim fees from (launched or manually registered)
 */
function getTrackedMints() {
  const db = getDb();
  try {
    const mints = new Set();

    // From launches
    const launches = db.prepare(
      "SELECT investment_target FROM treasury WHERE type = 'token_launch' AND description NOT LIKE 'FAILED%' AND investment_target IS NOT NULL"
    ).all();
    for (const l of launches) {
      try {
        const details = JSON.parse(l.investment_target);
        if (details.mint) mints.add(details.mint);
      } catch {}
    }

    // From manually registered CAs
    const registered = db.prepare(
      "SELECT investment_target FROM treasury WHERE type = 'fee_track' AND investment_target IS NOT NULL"
    ).all();
    for (const r of registered) {
      mints.add(r.investment_target);
    }

    return [...mints];
  } finally {
    db.close();
  }
}

/**
 * Register a CA for fee tracking (called externally when owner launches manually)
 */
export function registerMintForFees(mint, name = '') {
  const db = getDb();
  try {
    const existing = db.prepare("SELECT id FROM treasury WHERE type = 'fee_track' AND investment_target = ?").get(mint);
    if (existing) return false;

    db.prepare("INSERT INTO treasury (type, amount, currency, description, investment_target) VALUES ('fee_track', 0, 'SOL', ?, ?)")
      .run(`Tracking fees for ${name || mint}`, mint);
    console.log(`[FEE-CLAIMER] Registered mint for fee tracking: ${mint}`);
    return true;
  } finally {
    db.close();
  }
}

/**
 * Check claimable fees for a specific token via pump.fun API
 */
async function checkClaimableFees(mint) {
  try {
    // Try pump.fun's frontend API to get coin info
    const response = await fetch(`https://frontend-api-v2.pump.fun/coins/${mint}`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) return { mint, claimable: 0, error: `API ${response.status}` };

    const data = await response.json();

    // Check bonding curve balance for creator fees
    const connection = new Connection(RPC_URL, 'confirmed');
    const bondingCurve = getBondingCurvePDA(mint);
    const balance = await connection.getBalance(bondingCurve);
    const solBalance = balance / 1e9;

    return {
      mint,
      name: data.name || 'Unknown',
      symbol: data.symbol || '???',
      bondingCurveBalance: solBalance,
      complete: data.complete || false,
      claimable: 0, // Will be determined by claim attempt
    };
  } catch (error) {
    return { mint, claimable: 0, error: error.message };
  }
}

/**
 * Attempt to claim creator fees for a token
 * Uses pump.fun's collect_creator_fee instruction
 */
async function claimFees(mint) {
  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    const creatorKeypair = getKeypair();
    const mintPubkey = new PublicKey(mint);
    const bondingCurve = getBondingCurvePDA(mint);

    // Get creator fee account PDA
    const [creatorFeeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('creator-fee'), mintPubkey.toBuffer()],
      PUMP_PROGRAM
    );

    // Check if there are fees to claim by checking the fee account balance
    const feeBalance = await connection.getBalance(creatorFeeAccount).catch(() => 0);
    const feeSol = feeBalance / 1e9;

    if (feeSol < CLAIM_THRESHOLD) {
      console.log(`[FEE-CLAIMER] ${mint.substring(0, 8)}... — ${feeSol.toFixed(4)} SOL (below threshold ${CLAIM_THRESHOLD})`);
      return { claimed: false, amount: feeSol, reason: 'below threshold' };
    }

    console.log(`[FEE-CLAIMER] ${mint.substring(0, 8)}... — ${feeSol.toFixed(4)} SOL claimable! Claiming...`);

    // Build the collect_creator_fee instruction
    // Instruction discriminator for collect_creator_fee (Anchor)
    const discriminator = Buffer.from([167, 230, 58, 215, 134, 139, 124, 45]);

    const keys = [
      { pubkey: creatorKeypair.publicKey, isSigner: true, isWritable: true },   // creator
      { pubkey: mintPubkey, isSigner: false, isWritable: false },                // mint
      { pubkey: bondingCurve, isSigner: false, isWritable: true },               // bonding curve
      { pubkey: creatorFeeAccount, isSigner: false, isWritable: true },          // creator fee account
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false }, // system program
    ];

    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    const messageV0 = new TransactionMessage({
      payerKey: creatorKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [{
        programId: PUMP_PROGRAM,
        keys,
        data: discriminator,
      }],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([creatorKeypair]);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    const confirmation = await connection.confirmTransaction(signature, 'confirmed');

    if (confirmation.value.err) {
      console.error(`[FEE-CLAIMER] Claim failed for ${mint.substring(0, 8)}:`, confirmation.value.err);
      return { claimed: false, amount: feeSol, error: JSON.stringify(confirmation.value.err) };
    }

    console.log(`[FEE-CLAIMER] Claimed ${feeSol.toFixed(4)} SOL from ${mint.substring(0, 8)}! TX: ${signature}`);

    // Log in treasury
    const db = getDb();
    try {
      db.prepare("INSERT INTO treasury (type, amount, currency, description, investment_target) VALUES ('income', ?, 'SOL', ?, ?)")
        .run(feeSol, `pump.fun creator fee claim`, JSON.stringify({ mint, signature, amount: feeSol }));
    } finally {
      db.close();
    }

    return { claimed: true, amount: feeSol, signature };
  } catch (error) {
    console.error(`[FEE-CLAIMER] Error claiming ${mint.substring(0, 8)}:`, error.message);
    return { claimed: false, amount: 0, error: error.message };
  }
}

/**
 * Run full fee check and claim cycle
 */
async function runClaimCycle() {
  const mints = getTrackedMints();
  if (mints.length === 0) {
    console.log('[FEE-CLAIMER] No launched tokens to check');
    return;
  }

  console.log(`[FEE-CLAIMER] Checking fees for ${mints.length} token(s)...`);

  let totalClaimed = 0;
  for (const mint of mints) {
    try {
      const result = await claimFees(mint);
      if (result.claimed) {
        totalClaimed += result.amount;
      }
      // Rate limit — don't hammer RPC
      await new Promise(r => setTimeout(r, 2000));
    } catch (error) {
      console.error(`[FEE-CLAIMER] Error processing ${mint}:`, error.message);
    }
  }

  if (totalClaimed > 0) {
    console.log(`[FEE-CLAIMER] Total claimed this cycle: ${totalClaimed.toFixed(4)} SOL`);
  }
}

// Check and claim every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  await runClaimCycle();
});

// Also run on startup after a delay
setTimeout(async () => {
  await runClaimCycle();
}, 30000);

process.on('uncaughtException', (error) => {
  console.error('[FEE-CLAIMER] Uncaught exception:', error.message);
});
