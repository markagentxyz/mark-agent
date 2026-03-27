/**
 * MARK Token Launcher — bags.fm integration
 *
 * Launches MARK's own token on bags.fm with:
 * - No dev wallet (fair launch)
 * - All fees forwarded to MARK's treasury wallet
 * - Owner-only trigger (server-side auth, NOT through AI brain)
 */
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getDb } from '../database/init.js';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TREASURY_PUBLIC = process.env.TREASURY_WALLET_PUBLIC_KEY;
const TREASURY_PRIVATE = process.env.TREASURY_WALLET_PRIVATE_KEY;
const BAGS_API_KEY = process.env.BAGS_API_KEY || '';
const BAGS_API_BASE = 'https://public-api-v2.bags.fm/api/v1';

function getKeypair() {
  if (!TREASURY_PRIVATE) throw new Error('Treasury wallet private key not configured');
  return Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE));
}

function logLaunch(tokenAddress, name, symbol, status, details) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO treasury (type, amount, currency, description, investment_target)
      VALUES ('token_launch', 0, 'SOL', ?, ?)
    `).run(
      `Token launch: ${name} ($${symbol}) — ${status}`,
      JSON.stringify({ tokenAddress, name, symbol, status, details, timestamp: new Date().toISOString() })
    );
  } finally {
    db.close();
  }
}

/**
 * Launch MARK's token on bags.fm
 * @param {Object} params - Token parameters
 * @param {string} params.name - Token name
 * @param {string} params.symbol - Token ticker
 * @param {string} params.description - Token description
 * @param {string} params.imageUrl - Token image URL
 * @param {string} [params.twitter] - Twitter handle for fee routing
 * @param {number} [params.initialBuySOL] - Initial buy amount in SOL (0 = no dev buy)
 */
export async function launchToken({ name, symbol, description, imageUrl, twitter, initialBuySOL = 0 }) {
  if (!BAGS_API_KEY) {
    throw new Error('BAGS_API_KEY not configured in .env');
  }
  if (!TREASURY_PRIVATE || !TREASURY_PUBLIC) {
    throw new Error('Treasury wallet not configured');
  }
  if (!name || !symbol) {
    throw new Error('Token name and symbol are required');
  }

  const keypair = getKeypair();
  const connection = new Connection(RPC_URL, 'confirmed');

  console.log(`[LAUNCHER] Launching ${name} ($${symbol}) on bags.fm...`);
  console.log(`[LAUNCHER] Treasury wallet: ${TREASURY_PUBLIC}`);
  console.log(`[LAUNCHER] Initial buy: ${initialBuySOL} SOL`);
  console.log(`[LAUNCHER] No dev wallet — fees go to treasury`);

  try {
    // Step 1: Create launch transaction via bags.fm API
    const launchPayload = {
      name,
      symbol,
      description: description || `${name} — launched by MARK, the autonomous AI marketing agent.`,
      image: imageUrl || '',
      creator: TREASURY_PUBLIC,
      initialBuySOL: initialBuySOL,
      // Fee sharing: 100% to MARK's treasury
      feeRecipients: [
        {
          wallet: TREASURY_PUBLIC,
          bps: 10000, // 100% of creator fees
        }
      ],
    };

    // Add twitter handle for bags.fm social linking if provided
    if (twitter) {
      launchPayload.twitter = twitter;
    }

    const response = await fetch(`${BAGS_API_BASE}/token-launch/create-launch-transaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': BAGS_API_KEY,
      },
      body: JSON.stringify(launchPayload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`bags.fm API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    console.log('[LAUNCHER] Got transaction from bags.fm');

    // Step 2: Sign and send the transaction
    const txBuffer = Buffer.from(data.transaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([keypair]);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log(`[LAUNCHER] Transaction sent: ${signature}`);

    // Step 3: Confirm
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    const tokenAddress = data.mint || data.tokenAddress || 'unknown';
    console.log(`[LAUNCHER] Token launched! Address: ${tokenAddress}`);
    console.log(`[LAUNCHER] Signature: ${signature}`);

    // Log success
    logLaunch(tokenAddress, name, symbol, 'launched', {
      signature,
      initialBuySOL,
      feeRecipient: TREASURY_PUBLIC,
    });

    return {
      success: true,
      tokenAddress,
      signature,
      name,
      symbol,
      explorer: `https://solscan.io/tx/${signature}`,
      bags: `https://bags.fm/token/${tokenAddress}`,
    };
  } catch (error) {
    console.error('[LAUNCHER] Launch failed:', error.message);
    logLaunch('failed', name, symbol, 'failed', { error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

export function getLaunchHistory() {
  const db = getDb();
  try {
    return db.prepare(
      "SELECT * FROM treasury WHERE type = 'token_launch' ORDER BY timestamp DESC LIMIT 20"
    ).all();
  } finally {
    db.close();
  }
}
