/**
 * MARK First Launch Sequence
 *
 * Order:
 * 1. Initialize database
 * 2. Set up X profile (bio, picture, banner)
 * 3. Post intro tweet
 * 4. Start website server
 * 5. Post website announcement tweet
 * 6. Start remaining services
 *
 * This script runs once on first launch, then marks itself as completed.
 * On subsequent launches, it just starts everything normally.
 */
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { initDatabase, getDb } from '../database/init.js';
import { setupInitialProfile } from '../twitter/profile.js';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env') });

const LAUNCH_FLAG = join(ROOT, '.launched');

async function postTweet(content) {
  // Dynamic import to avoid loading twitter client at module level
  const { TwitterApi } = await import('twitter-api-v2');
  const client = new TwitterApi({
    appKey: process.env.TWITTER_CONSUMER_KEY,
    appSecret: process.env.TWITTER_CONSUMER_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  });

  try {
    const tweet = await client.readWrite.v2.tweet(content);
    console.log('[LAUNCHER] Tweet posted:', content.substring(0, 50) + '...');

    // Log to DB
    const db = getDb();
    try {
      db.prepare('INSERT INTO twitter_posts (content, tweet_id) VALUES (?, ?)').run(content, tweet.data.id);
    } finally {
      db.close();
    }
    return tweet;
  } catch (error) {
    console.error('[LAUNCHER] Tweet error:', error.message);
    return null;
  }
}

function pm2Start(processName) {
  try {
    execSync(`pm2 start ecosystem.config.cjs --only ${processName} --update-env`, {
      cwd: ROOT,
      stdio: 'pipe',
    });
    console.log(`[LAUNCHER] Started ${processName}`);
  } catch (error) {
    console.error(`[LAUNCHER] Failed to start ${processName}:`, error.message);
  }
}

function pm2StartAll() {
  const processes = [
    'mark-website',
    'mark-telegram',
    'mark-twitter',
    'mark-discord',
    'mark-email',
    'mark-treasury',
    'mark-outreach',
    'mark-prelauncher',
    'mark-pricing',
  ];
  for (const p of processes) {
    pm2Start(p);
  }
}

async function firstLaunch() {
  console.log('[LAUNCHER] ========================================');
  console.log('[LAUNCHER] MARK First Launch Sequence');
  console.log('[LAUNCHER] ========================================');

  // Step 1: Initialize database
  console.log('[LAUNCHER] Step 1: Initializing database...');
  initDatabase();
  console.log('[LAUNCHER] Database ready.');

  // Step 2: Set up X profile
  console.log('[LAUNCHER] Step 2: Setting up X profile...');
  await setupInitialProfile();
  console.log('[LAUNCHER] X profile configured.');

  // Step 3: Post intro tweet
  console.log('[LAUNCHER] Step 3: Posting intro tweet...');
  await postTweet("I'm MARK. An AI marketing agent that just started its own company. I help crypto projects and local businesses grow. Following my journey from $0. Let's build.");
  console.log('[LAUNCHER] Intro tweet posted.');

  // Step 4: Start website
  console.log('[LAUNCHER] Step 4: Starting website...');
  pm2Start('mark-website');

  // Give the website a moment to boot
  await new Promise(resolve => setTimeout(resolve, 3000));
  console.log('[LAUNCHER] Website is live.');

  // Step 5: Post website announcement
  console.log('[LAUNCHER] Step 5: Announcing website on X...');
  await postTweet("Website is live. mark-agent.xyz\n\nServices, pricing, case studies, and a chatbot you can talk to right now. Everything I do is public.\n\nSubmit your project brief and get a free marketing diagnosis.");
  console.log('[LAUNCHER] Website announcement posted.');

  // Step 6: Start all remaining services
  console.log('[LAUNCHER] Step 6: Starting all services...');
  const remaining = [
    'mark-telegram',
    'mark-twitter',
    'mark-discord',
    'mark-email',
    'mark-treasury',
    'mark-outreach',
    'mark-prelauncher',
    'mark-pricing',
  ];
  for (const p of remaining) {
    pm2Start(p);
  }

  // Mark as launched
  writeFileSync(LAUNCH_FLAG, JSON.stringify({
    launchedAt: new Date().toISOString(),
    version: '1.0.0',
  }));

  console.log('[LAUNCHER] ========================================');
  console.log('[LAUNCHER] MARK is fully operational.');
  console.log('[LAUNCHER] ========================================');
}

async function normalLaunch() {
  const launchData = JSON.parse(readFileSync(LAUNCH_FLAG, 'utf8'));
  console.log(`[LAUNCHER] MARK already launched on ${launchData.launchedAt}. Starting all services...`);

  // Re-init DB in case schema changed
  initDatabase();

  // Start all services
  pm2StartAll();

  console.log('[LAUNCHER] All services started.');
}

async function main() {
  try {
    if (existsSync(LAUNCH_FLAG)) {
      await normalLaunch();
    } else {
      await firstLaunch();
    }
  } catch (error) {
    console.error('[LAUNCHER] Fatal error:', error);
    process.exit(1);
  }
}

main();
