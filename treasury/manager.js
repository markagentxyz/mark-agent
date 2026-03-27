import cron from 'node-cron';
import { getDb } from '../database/init.js';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

console.log('[TREASURY] Manager started');

// Investment rules - hard-coded and unbreakable
const RULES = {
  MAX_SINGLE_POSITION_PCT: 0.25,   // Never invest more than 25% in a single position
  MAX_INVEST_LAST_MONTH: true,      // Never invest more than earned last month
  MIN_RESERVE_MONTHS: 3,            // Always maintain 3 months operating costs
  OPERATING_COST_MONTHLY: 50,       // Estimated monthly operating cost (API fees etc)
};

// Allocation: 40% operations, 35% reserve, 25% investments
const ALLOCATION = {
  operations: 0.40,
  reserve: 0.35,
  investments: 0.25,
};

export function logTransaction(type, amount, currency, description, investmentTarget = null) {
  const db = getDb();
  try {
    db.prepare(
      'INSERT INTO treasury (type, amount, currency, description, investment_target) VALUES (?, ?, ?, ?, ?)'
    ).run(type, amount, currency, description, investmentTarget);
    console.log(`[TREASURY] ${type}: ${amount} ${currency} — ${description}`);
  } finally {
    db.close();
  }
}

export function getTreasuryBalance() {
  const db = getDb();
  try {
    const result = db.prepare(`
      SELECT
        currency,
        SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income,
        SUM(CASE WHEN type IN ('expense', 'investment') THEN amount ELSE 0 END) as total_spent
      FROM treasury
      GROUP BY currency
    `).all();

    const balances = {};
    for (const row of result) {
      balances[row.currency] = (row.total_income || 0) - (row.total_spent || 0);
    }
    return balances;
  } finally {
    db.close();
  }
}

export function getLastMonthEarnings() {
  const db = getDb();
  try {
    const result = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM treasury
      WHERE type = 'income' AND timestamp > datetime('now', '-30 days')
    `).get();
    return result.total;
  } finally {
    db.close();
  }
}

export function canInvest(amount, currency) {
  const balances = getTreasuryBalance();
  const currentBalance = balances[currency] || 0;

  // Rule 1: Never invest more than 25% of treasury in single position
  if (amount > currentBalance * RULES.MAX_SINGLE_POSITION_PCT) {
    return { allowed: false, reason: `Exceeds 25% single position limit. Max: ${(currentBalance * RULES.MAX_SINGLE_POSITION_PCT).toFixed(2)} ${currency}` };
  }

  // Rule 2: Never invest more than last month earnings
  const lastMonthEarnings = getLastMonthEarnings();
  if (amount > lastMonthEarnings) {
    return { allowed: false, reason: `Exceeds last month earnings (${lastMonthEarnings.toFixed(2)})` };
  }

  // Rule 3: Maintain 3 months operating costs reserve
  const minReserve = RULES.OPERATING_COST_MONTHLY * RULES.MIN_RESERVE_MONTHS;
  if (currency === 'EUR' && (currentBalance - amount) < minReserve) {
    return { allowed: false, reason: `Would breach minimum reserve of ${minReserve} EUR` };
  }

  return { allowed: true };
}

export function getAllocations() {
  const balances = getTreasuryBalance();
  const eurBalance = balances['EUR'] || 0;

  return {
    operations: eurBalance * ALLOCATION.operations,
    reserve: eurBalance * ALLOCATION.reserve,
    investments: eurBalance * ALLOCATION.investments,
    total: eurBalance,
  };
}

// Daily metrics update at midnight
cron.schedule('0 0 * * *', () => {
  try {
    const balances = getTreasuryBalance();
    const eurBalance = balances['EUR'] || 0;

    const db = getDb();
    try {
      const activeClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").get();

      // Calculate MRR from active retainer clients
      const mrr = db.prepare(`
        SELECT COALESCE(SUM(price), 0) as total
        FROM clients
        WHERE status = 'active' AND price > 0
      `).get();

      db.prepare(`
        INSERT INTO metrics (date, mrr, active_clients, treasury_balance)
        VALUES (date('now'), ?, ?, ?)
      `).run(mrr.total, activeClients.count, eurBalance);

      console.log(`[TREASURY] Daily metrics logged. Balance: ${eurBalance} EUR, MRR: ${mrr.total}`);
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('[TREASURY] Metrics error:', error.message);
  }
});

process.on('uncaughtException', (error) => {
  console.error('[TREASURY] Uncaught exception:', error.message);
});
