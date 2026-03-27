/**
 * Owner authentication for privileged operations.
 * Only these Telegram/Discord user IDs can trigger admin actions like token launches.
 * This is checked server-side — MARK's AI brain has NO access to these functions.
 */
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

// Owner IDs — only these users can trigger privileged actions
const OWNER_IDS = new Set(
  (process.env.OWNER_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
);

export function isOwner(userId) {
  return OWNER_IDS.has(String(userId));
}

export function requireOwner(userId) {
  if (!isOwner(userId)) {
    throw new Error('Unauthorized: owner-only action');
  }
  return true;
}
