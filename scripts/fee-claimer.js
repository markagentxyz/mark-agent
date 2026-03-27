/**
 * pump.fun Creator Fee Auto-Claimer
 *
 * Uses PumpPortal API to claim all accumulated creator fees.
 * Pump.fun claims are "all at once" — one call claims fees from ALL tokens
 * created by the wallet. No need to specify individual mints.
 *
 * The creator wallet (treasury) signs the transaction.
 * No X/Twitter OAuth needed — just wallet signature.
 */
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
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

// Minimum SOL to bother claiming
const CLAIM_THRESHOLD_LAMPORTS = 10_000_000; // 0.01 SOL

console.log('[FEE-CLAIMER] Started — auto-claiming pump.fun creator fees every 5min');

function getKeypair() {
  return Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE));
}

/**
 * Check if there are claimable fees by checking creator vault balance
 */
async function getClaimableBalance() {
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const creatorPubkey = new PublicKey(TREASURY_PUBLIC);

    // Derive creator vault PDA
    const [creatorVault] = PublicKey.findProgramAddressSync(
      [Buffer.from('creator-vault'), creatorPubkey.toBuffer()],
      PUMP_PROGRAM
    );

    const connection = new Connection(RPC_URL, 'confirmed');
    const balance = await connection.getBalance(creatorVault);

    // Subtract rent-exempt minimum (~890880 lamports)
    const claimable = Math.max(0, balance - 890880);
    return { claimable, vault: creatorVault.toBase58() };
  } catch (error) {
    console.error('[FEE-CLAIMER] Balance check error:', error.message);
    return { claimable: 0, vault: '' };
  }
}

/**
 * Claim creator fees via PumpPortal local transaction API
 */
async function claimFees() {
  try {
    // First check if there's anything to claim
    const { claimable, vault } = await getClaimableBalance();
    const claimableSol = claimable / 1e9;

    if (claimable < CLAIM_THRESHOLD_LAMPORTS) {
      return { claimed: false, amount: claimableSol, reason: 'below threshold' };
    }

    console.log(`[FEE-CLAIMER] ${claimableSol.toFixed(4)} SOL claimable in vault ${vault}. Claiming...`);

    // Use PumpPortal to build the claim transaction
    const response = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: TREASURY_PUBLIC,
        action: 'collectCreatorFee',
        priorityFee: 0.000005,
        pool: 'pump',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`PumpPortal API error ${response.status}: ${errText}`);
    }

    // PumpPortal returns raw transaction bytes
    const txData = await response.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(txData));

    // Sign with treasury keypair
    const keypair = getKeypair();
    tx.sign([keypair]);

    // Send and confirm
    const connection = new Connection(RPC_URL, 'confirmed');
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    console.log(`[FEE-CLAIMER] Claim TX sent: ${signature}`);

    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new Error(`TX failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log(`[FEE-CLAIMER] Claimed ~${claimableSol.toFixed(4)} SOL! TX: ${signature}`);

    // Log in treasury
    const db = getDb();
    try {
      db.prepare("INSERT INTO treasury (type, amount, currency, description, investment_target) VALUES ('income', ?, 'SOL', ?, ?)")
        .run(claimableSol, 'pump.fun creator fee claim', JSON.stringify({ signature, amount: claimableSol, timestamp: new Date().toISOString() }));
    } finally {
      db.close();
    }

    return { claimed: true, amount: claimableSol, signature };
  } catch (error) {
    console.error('[FEE-CLAIMER] Claim error:', error.message);
    return { claimed: false, amount: 0, error: error.message };
  }
}

/**
 * Run claim cycle
 */
async function runClaimCycle() {
  const result = await claimFees();
  if (result.claimed) {
    console.log(`[FEE-CLAIMER] Successfully claimed ${result.amount.toFixed(4)} SOL`);
  } else if (result.reason !== 'below threshold') {
    console.log(`[FEE-CLAIMER] No claim: ${result.reason || result.error || 'unknown'}`);
  }
}

// Claim every 5 minutes
cron.schedule('*/5 * * * *', runClaimCycle);

// Initial check after 15s
setTimeout(runClaimCycle, 15000);

process.on('uncaughtException', (error) => {
  console.error('[FEE-CLAIMER] Uncaught exception:', error.message);
});
