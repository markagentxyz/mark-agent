/**
 * MARK Token Launcher — pump.fun via PumpPortal API
 *
 * - No dev wallet (fair launch, initial buy = 0)
 * - Creator fees accumulate on pump.fun — claimed by fee-claimer.js
 * - Owner-only trigger (never through AI brain)
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

function getKeypair() {
  if (!TREASURY_PRIVATE) throw new Error('Treasury wallet private key not configured');
  return Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE));
}

/**
 * Launch token on pump.fun via PumpPortal
 * @param {Object} params
 * @param {string} params.name - Token name
 * @param {string} params.symbol - Token ticker
 * @param {string} params.description - Description
 * @param {string} [params.imageUrl] - Image URL (or base64)
 * @param {string} [params.twitter] - Twitter URL
 * @param {string} [params.telegram] - Telegram URL
 * @param {string} [params.website] - Website URL
 * @param {number} [params.initialBuySOL] - Initial buy in SOL (0 = no dev buy)
 */
export async function launchToken({ name, symbol, description, imageUrl, twitter, telegram, website, initialBuySOL = 0 }) {
  if (!TREASURY_PRIVATE || !TREASURY_PUBLIC) {
    throw new Error('Treasury wallet not configured');
  }
  if (!name || !symbol) {
    throw new Error('Token name and symbol are required');
  }

  const creatorKeypair = getKeypair();
  const mintKeypair = Keypair.generate();
  const connection = new Connection(RPC_URL, 'confirmed');

  console.log(`[LAUNCHER] Launching ${name} ($${symbol}) on pump.fun...`);
  console.log(`[LAUNCHER] Creator: ${TREASURY_PUBLIC}`);
  console.log(`[LAUNCHER] Mint: ${mintKeypair.publicKey.toBase58()}`);
  console.log(`[LAUNCHER] Initial buy: ${initialBuySOL} SOL`);

  try {
    // Build metadata for PumpPortal
    const tokenMetadata = {
      name,
      symbol,
      description: description || `${name} — launched by MARK, the autonomous AI marketing agent.`,
    };

    if (twitter) tokenMetadata.twitter = twitter;
    if (telegram) tokenMetadata.telegram = telegram;
    if (website) tokenMetadata.website = website;

    // If imageUrl is a URL, download and convert to base64
    if (imageUrl && imageUrl.startsWith('http')) {
      try {
        const imgResponse = await fetch(imageUrl);
        const buffer = await imgResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = imgResponse.headers.get('content-type') || 'image/png';
        tokenMetadata.file = `data:${contentType};base64,${base64}`;
      } catch (e) {
        console.warn('[LAUNCHER] Could not fetch image, launching without:', e.message);
      }
    } else if (imageUrl) {
      tokenMetadata.file = imageUrl; // Already base64
    }

    // Call PumpPortal API to create the launch transaction
    const response = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: TREASURY_PUBLIC,
        action: 'create',
        tokenMetadata,
        mint: mintKeypair.publicKey.toBase58(),
        denominatedInSol: 'true',
        amount: initialBuySOL,
        slippage: 10,
        priorityFee: 0.0005,
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

    // Sign with both creator and mint keypair
    tx.sign([creatorKeypair, mintKeypair]);

    // Send transaction
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log(`[LAUNCHER] Transaction sent: ${signature}`);

    // Confirm
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    const mintAddress = mintKeypair.publicKey.toBase58();
    console.log(`[LAUNCHER] Token launched! Mint: ${mintAddress}`);

    // Save to database
    const db = getDb();
    try {
      db.prepare(`
        INSERT INTO treasury (type, amount, currency, description, investment_target)
        VALUES ('token_launch', 0, 'SOL', ?, ?)
      `).run(
        `pump.fun launch: ${name} ($${symbol})`,
        JSON.stringify({
          mint: mintAddress,
          name,
          symbol,
          signature,
          platform: 'pump.fun',
          creator: TREASURY_PUBLIC,
          initialBuySOL,
          timestamp: new Date().toISOString(),
        })
      );
    } finally {
      db.close();
    }

    return {
      success: true,
      mint: mintAddress,
      signature,
      name,
      symbol,
      pumpfun: `https://pump.fun/coin/${mintAddress}`,
      explorer: `https://solscan.io/tx/${signature}`,
    };
  } catch (error) {
    console.error('[LAUNCHER] Launch failed:', error.message);

    const db = getDb();
    try {
      db.prepare("INSERT INTO treasury (type, amount, currency, description) VALUES ('token_launch', 0, 'SOL', ?)")
        .run(`FAILED launch: ${name} ($${symbol}) — ${error.message}`);
    } finally {
      db.close();
    }

    return { success: false, error: error.message };
  }
}

/**
 * Get all tokens MARK has launched
 */
export function getLaunchedTokens() {
  const db = getDb();
  try {
    const launches = db.prepare(
      "SELECT * FROM treasury WHERE type = 'token_launch' AND description NOT LIKE 'FAILED%' ORDER BY timestamp DESC"
    ).all();

    return launches.map(l => {
      try {
        return { ...l, details: JSON.parse(l.investment_target) };
      } catch {
        return l;
      }
    });
  } finally {
    db.close();
  }
}
