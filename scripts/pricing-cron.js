import cron from 'node-cron';
import { autonomousPricingReview, generatePricingTweet } from '../core/pricing.js';
import { updateBioWithPricing } from '../twitter/profile.js';
import { TwitterApi } from 'twitter-api-v2';
import { getDb } from '../database/init.js';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
}).readWrite;

console.log('[PRICING] Autonomous pricing engine started');

async function postTweet(content) {
  try {
    const tweet = await twitterClient.v2.tweet(content);
    const db = getDb();
    try {
      db.prepare('INSERT INTO twitter_posts (content, tweet_id) VALUES (?, ?)').run(content, tweet.data.id);
    } finally {
      db.close();
    }
    console.log('[PRICING] Tweet posted:', content.substring(0, 60) + '...');
    return tweet;
  } catch (error) {
    console.error('[PRICING] Tweet error:', error.message);
    return null;
  }
}

async function runPricingReview() {
  console.log('[PRICING] MARK is reviewing pricing...');

  const changes = await autonomousPricingReview();

  if (changes.length === 0) {
    console.log('[PRICING] MARK decided to hold all prices.');
    return;
  }

  console.log(`[PRICING] MARK made ${changes.length} price change(s).`);

  // Post about it on X
  const tweet = await generatePricingTweet(changes);
  if (tweet) {
    await postTweet(tweet);
  }

  // Update X bio with new pricing summary
  try {
    const db = getDb();
    try {
      const eurMin = db.prepare("SELECT MIN(price) as min FROM prices WHERE currency = 'EUR'").get();
      const solMin = db.prepare("SELECT MIN(price) as min FROM prices WHERE currency = 'SOL'").get();
      await updateBioWithPricing(`From €${eurMin.min} / ${solMin.min} SOL`);
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('[PRICING] Bio update error:', error.message);
  }
}

// MARK reviews pricing every 24 hours at 6am UTC
cron.schedule('0 6 * * *', async () => {
  await runPricingReview();
});

// Also run on startup after a delay (give other services time to start)
setTimeout(async () => {
  // Only run if there are no pricing decisions yet (first time)
  const db = getDb();
  try {
    const count = db.prepare("SELECT COUNT(*) as count FROM pricing_decisions").get();
    if (count.count === 0) {
      console.log('[PRICING] First run — MARK is setting initial pricing strategy...');
      await runPricingReview();
    }
  } finally {
    db.close();
  }
}, 15000);

process.on('uncaughtException', (error) => {
  console.error('[PRICING] Uncaught exception:', error.message);
});
