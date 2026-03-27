import { Connection, PublicKey } from '@solana/web3.js';
import { generateContent } from '../core/brain.js';
import { getDb } from '../database/init.js';
import cron from 'node-cron';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

console.log('[PRELAUNCHER] Pre-launch detection started');

// Known dev wallets database (starts empty, builds over time)
const knownDevWallets = new Map();

function addKnownDevWallet(address, info) {
  knownDevWallets.set(address, { ...info, addedAt: new Date().toISOString() });
}

// Monitor for new mint account creation from known devs
async function checkKnownDevActivity() {
  if (knownDevWallets.size === 0) return;

  try {
    const connection = new Connection(RPC_URL, 'confirmed');

    for (const [walletAddress, info] of knownDevWallets) {
      try {
        const pubkey = new PublicKey(walletAddress);
        const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 5 });

        for (const sig of signatures) {
          // Check if this is a new transaction we haven't seen
          const db = getDb();
          try {
            const existing = db.prepare(
              "SELECT id FROM outreach WHERE contact = ? AND token_address = ?"
            ).get(walletAddress, sig.signature);

            if (!existing && sig.blockTime) {
              const txAge = Date.now() / 1000 - sig.blockTime;
              if (txAge < 3600) { // Less than 1 hour old
                console.log(`[PRELAUNCHER] New activity from known dev ${walletAddress}`);

                // Check if it's a token mint
                const tx = await connection.getTransaction(sig.signature, {
                  maxSupportedTransactionVersion: 0,
                });

                if (tx?.meta?.logMessages?.some(log => log.includes('InitializeMint'))) {
                  console.log(`[PRELAUNCHER] New mint detected from ${walletAddress}!`);

                  db.prepare(
                    'INSERT INTO outreach (project_name, token_address, contact, score, status) VALUES (?, ?, ?, ?, ?)'
                  ).run(`Pre-launch: ${info.name || 'Unknown'}`, sig.signature, walletAddress, 8, 'pre_launch_detected');
                }
              }
            }
          } finally {
            db.close();
          }
        }
      } catch (error) {
        console.error(`[PRELAUNCHER] Error checking wallet ${walletAddress}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[PRELAUNCHER] Check error:', error.message);
  }
}

// Build dev wallet database from successful outreach
function updateDevWalletDatabase() {
  const db = getDb();
  try {
    const convertedOutreach = db.prepare(
      "SELECT DISTINCT contact, project_name FROM outreach WHERE status IN ('converted', 'responded') AND contact IS NOT NULL"
    ).all();

    for (const entry of convertedOutreach) {
      if (entry.contact && !knownDevWallets.has(entry.contact)) {
        addKnownDevWallet(entry.contact, { name: entry.project_name, source: 'outreach' });
      }
    }
  } finally {
    db.close();
  }
}

// Check known dev wallets every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  await checkKnownDevActivity();
});

// Update dev wallet database every hour
cron.schedule('0 * * * *', () => {
  updateDevWalletDatabase();
});

// Initial database build
setTimeout(() => updateDevWalletDatabase(), 5000);

process.on('uncaughtException', (error) => {
  console.error('[PRELAUNCHER] Uncaught exception:', error.message);
});
