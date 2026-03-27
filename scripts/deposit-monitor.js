/**
 * Deposit wallet monitor — scans every 30 seconds for incoming SOL,
 * auto-forwards to treasury, adds credits to user.
 */
import cron from 'node-cron';
import { scanAndForward } from '../core/deposits.js';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

console.log('[DEPOSIT-MONITOR] Started — scanning deposit wallets every 30s');

let scanning = false;

async function runScan() {
  if (scanning) return; // Prevent overlapping scans
  scanning = true;
  try {
    const deposits = await scanAndForward();
    if (deposits.length > 0) {
      console.log(`[DEPOSIT-MONITOR] Processed ${deposits.length} deposit(s)`);
    }
  } catch (error) {
    console.error('[DEPOSIT-MONITOR] Scan error:', error.message);
  } finally {
    scanning = false;
  }
}

// Scan every 30 seconds
setInterval(runScan, 30000);

// Initial scan after 10s
setTimeout(runScan, 10000);

process.on('uncaughtException', (error) => {
  console.error('[DEPOSIT-MONITOR] Uncaught exception:', error.message);
});
