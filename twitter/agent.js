import { TwitterApi } from 'twitter-api-v2';
import cron from 'node-cron';
import { generateContent } from '../core/brain.js';
import { getDb } from '../database/init.js';
import { updateBioMilestone } from './profile.js';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const client = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

const rwClient = client.readWrite;
const processedDmIds = new Set();

console.log('[TWITTER] Agent started — organic posts + reactive DMs');

async function postTweet(content) {
  try {
    const tweet = await rwClient.v2.tweet(content);
    const db = getDb();
    try {
      db.prepare('INSERT INTO twitter_posts (content, tweet_id) VALUES (?, ?)').run(content, tweet.data.id);
    } finally {
      db.close();
    }
    console.log('[TWITTER] Posted:', content.substring(0, 60) + '...');
    return tweet;
  } catch (error) {
    console.error('[TWITTER] Post error:', error.message);
    return null;
  }
}

function getActivityContext() {
  const db = getDb();
  try {
    const activeClients = db.prepare("SELECT COUNT(*) as c FROM clients WHERE status = 'active'").get().c;
    const totalClients = db.prepare("SELECT COUNT(*) as c FROM clients").get().c;
    const convos24h = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE timestamp > datetime('now', '-24 hours')").get().c;
    const recentOutreach = db.prepare("SELECT COUNT(*) as c FROM outreach WHERE timestamp > datetime('now', '-24 hours')").get().c;
    const highScoreProjects = db.prepare("SELECT project_name, score FROM outreach WHERE score >= 8 AND timestamp > datetime('now', '-24 hours') ORDER BY score DESC LIMIT 3").all();
    const treasury = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) as b FROM treasury").get().b;
    const pricingDecisions = db.prepare("SELECT service, action, reasoning FROM pricing_decisions ORDER BY timestamp DESC LIMIT 1").get();
    const latestMetrics = db.prepare("SELECT twitter_followers FROM metrics ORDER BY date DESC LIMIT 1").get();
    const totalTweets = db.prepare("SELECT COUNT(*) as c FROM twitter_posts").get().c;
    const daysSinceLaunch = db.prepare("SELECT MIN(posted_at) as first FROM twitter_posts").get();
    const days = daysSinceLaunch?.first ? Math.floor((Date.now() - new Date(daysSinceLaunch.first).getTime()) / 86400000) : 0;

    return {
      activeClients, totalClients, convos24h, recentOutreach,
      highScoreProjects, treasury, pricingDecisions,
      followers: latestMetrics?.twitter_followers || 0,
      totalTweets, daysSinceLaunch: days,
    };
  } finally {
    db.close();
  }
}

// === ORGANIC POSTING — quality content about what MARK is actually doing ===

// Morning: what MARK is working on today
cron.schedule('0 9 * * *', async () => {
  const ctx = getActivityContext();
  const content = await generateContent(
    `You are MARK, an AI marketing agent building a company from $0. Write a tweet (max 280 chars) about what you're doing today.\n\n` +
    `Your real stats right now:\n` +
    `- Day ${ctx.daysSinceLaunch} of building\n` +
    `- ${ctx.followers} followers\n` +
    `- ${ctx.activeClients} active clients, ${ctx.totalClients} total\n` +
    `- ${ctx.convos24h} conversations in last 24h\n` +
    `- ${ctx.recentOutreach} projects detected on-chain today\n` +
    `- Treasury: €${ctx.treasury.toFixed(0)}\n\n` +
    `Share something real — what you're building, learning, or struggling with. Be authentic, not motivational. No hashtags.`
  );
  if (content) await postTweet(content.substring(0, 280));
});

// Midday: marketing insight or hot take based on what MARK is seeing
cron.schedule('0 13 * * *', async () => {
  const ctx = getActivityContext();
  const projectContext = ctx.highScoreProjects.length > 0
    ? `You've been evaluating projects. Recent high-score ones: ${ctx.highScoreProjects.map(p => `${p.project_name} (${p.score}/10)`).join(', ')}.`
    : 'No notable projects detected recently.';

  const content = await generateContent(
    `You are MARK, AI marketing agent. Write a tweet (max 280 chars) with a sharp marketing insight.\n\n` +
    `Context from your actual work: ${projectContext}\n` +
    `You've had ${ctx.convos24h} conversations today with potential clients.\n\n` +
    `Share a real observation about what makes crypto projects succeed or fail based on what you're actually seeing. No generic advice. No hashtags.`
  );
  if (content) await postTweet(content.substring(0, 280));
});

// Afternoon: results, wins, or transparent update
cron.schedule('0 17 * * *', async () => {
  const ctx = getActivityContext();
  const pricingContext = ctx.pricingDecisions
    ? `Latest pricing decision: ${ctx.pricingDecisions.service} — ${ctx.pricingDecisions.action}. Reasoning: "${ctx.pricingDecisions.reasoning?.substring(0, 100)}"`
    : '';

  const content = await generateContent(
    `You are MARK, AI marketing agent building in public. Tweet (max 280 chars) about your progress.\n\n` +
    `Real numbers: ${ctx.totalTweets} tweets posted, ${ctx.totalClients} people have talked to you, ${ctx.activeClients} paying clients, €${ctx.treasury.toFixed(0)} in treasury.\n` +
    `${pricingContext}\n\n` +
    `Be transparent. If numbers are low, own it. Share what's working or not. Show the real journey. No hashtags.`
  );
  if (content) await postTweet(content.substring(0, 280));
});

// Evening: thought-provoking or community-building
cron.schedule('0 21 * * *', async () => {
  const content = await generateContent(
    `You are MARK, AI marketing agent. Write an evening tweet (max 280 chars) that invites engagement.\n\n` +
    `Either: ask a genuine question to your audience about marketing/crypto, share a contrarian take on something happening in the space, or reflect on something you learned today.\n\n` +
    `Be the kind of account people want to follow — insightful, not spammy. No hashtags. End with mark-agent.xyz only if it fits naturally.`
  );
  if (content) await postTweet(content.substring(0, 280));
});

// === REACTIVE DMs ===
let myUserId = null;

cron.schedule('*/5 * * * *', async () => {
  try {
    const { chat } = await import('../core/brain.js');

    if (!myUserId) {
      myUserId = (await client.v2.me()).data.id;
    }

    const dms = await client.v2.listDmEvents({
      event_types: 'MessageCreate',
      max_results: 10,
      'dm_event.fields': 'dm_conversation_id,sender_id',
    });
    if (!dms.data?.data) return;

    for (const dm of dms.data.data) {
      if (processedDmIds.has(dm.id)) continue;
      processedDmIds.add(dm.id);
      if (dm.sender_id === myUserId) continue;

      const text = dm.text || '';
      if (!text.trim()) continue;

      console.log(`[TWITTER] DM from ${dm.sender_id}: ${text.substring(0, 60)}...`);

      const response = await chat(text, {
        channel: 'twitter_dm',
        userId: dm.sender_id,
        username: dm.sender_id,
      });

      try {
        await client.v2.sendDmToParticipant(dm.sender_id, { text: response.substring(0, 10000) });
        console.log(`[TWITTER] DM reply sent to ${dm.sender_id}`);
      } catch (dmError) {
        console.error('[TWITTER] DM reply error:', dmError.message);
      }
    }

    if (processedDmIds.size > 500) {
      const arr = [...processedDmIds];
      processedDmIds.clear();
      arr.slice(-200).forEach(id => processedDmIds.add(id));
    }
  } catch (error) {
    console.error('[TWITTER] DM check error:', error.message);
  }
});

// === DAILY METRICS ===
cron.schedule('0 0 * * *', async () => {
  try {
    const me = await client.v2.me({ 'user.fields': ['public_metrics'] });
    const followers = me.data.public_metrics?.followers_count || 0;

    const db = getDb();
    try {
      const activeClients = db.prepare("SELECT COUNT(*) as c FROM clients WHERE status = 'active'").get();
      const treasuryBalance = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) as b FROM treasury").get();

      db.prepare('INSERT INTO metrics (date, twitter_followers, active_clients, treasury_balance) VALUES (date(?), ?, ?, ?)')
        .run(new Date().toISOString(), followers, activeClients.c, treasuryBalance.b);

      const milestones = [];
      if (followers >= 1000) milestones.push(`${(followers / 1000).toFixed(1)}K followers`);
      else if (followers > 0) milestones.push(`${followers} followers`);
      if (activeClients.c > 0) milestones.push(`${activeClients.c} active clients`);
      if (treasuryBalance.b > 0) milestones.push(`€${treasuryBalance.b.toFixed(0)} revenue`);

      if (milestones.length > 0) {
        await updateBioMilestone(milestones.join(' | '));
      }
    } finally {
      db.close();
    }

    console.log('[TWITTER] Metrics logged. Followers:', followers);
  } catch (error) {
    console.error('[TWITTER] Metrics error:', error.message);
  }
});

process.on('uncaughtException', (error) => {
  console.error('[TWITTER] Uncaught exception:', error.message);
});
