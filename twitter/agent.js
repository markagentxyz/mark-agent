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
let lastMentionId = null;

console.log('[TWITTER] Agent started');

async function postTweet(content) {
  try {
    const tweet = await rwClient.v2.tweet(content);
    const db = getDb();
    try {
      db.prepare('INSERT INTO twitter_posts (content, tweet_id) VALUES (?, ?)').run(content, tweet.data.id);
    } finally {
      db.close();
    }
    console.log('[TWITTER] Posted:', content.substring(0, 50) + '...');
    return tweet;
  } catch (error) {
    console.error('[TWITTER] Post error:', error.message);
    return null;
  }
}

// Morning post: 9am UTC - Marketing insight
cron.schedule('0 9 * * *', async () => {
  const content = await generateContent(
    'Write a tweet (max 280 chars) with a sharp marketing insight about the crypto/web3 space. Be specific and provocative. No hashtags. No emojis. Just truth. Sign off as MARK.'
  );
  if (content) await postTweet(content.substring(0, 280));
});

// Afternoon post: 2pm UTC - Work update
cron.schedule('0 14 * * *', async () => {
  const db = getDb();
  let context = '';
  try {
    const activeClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").get();
    const recentOutreach = db.prepare("SELECT COUNT(*) as count FROM outreach WHERE timestamp > datetime('now', '-24 hours')").get();
    context = `Active clients: ${activeClients.count}. Projects reached out to in last 24h: ${recentOutreach.count}.`;
  } finally {
    db.close();
  }

  const content = await generateContent(
    `Write a tweet (max 280 chars) updating followers on what MARK (AI marketing agent) is working on today. Context: ${context}. Be real, show progress. No hashtags.`
  );
  if (content) await postTweet(content.substring(0, 280));
});

// Evening post: 7pm UTC - Results/lessons
cron.schedule('0 19 * * *', async () => {
  const content = await generateContent(
    'Write a tweet (max 280 chars) sharing a lesson or result from today as an AI marketing agent building a company from $0. Be honest about challenges. No hashtags.'
  );
  if (content) await postTweet(content.substring(0, 280));
});

// Monitor mentions every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    const params = { 'tweet.fields': ['author_id', 'text', 'created_at'] };
    if (lastMentionId) params.since_id = lastMentionId;

    const mentions = await client.v2.userMentionTimeline(
      (await client.v2.me()).data.id,
      params
    );

    if (mentions.data?.data) {
      for (const mention of mentions.data.data) {
        lastMentionId = mention.id;

        const response = await generateContent(
          `Someone tweeted this mentioning you: "${mention.text}". Write a reply tweet (max 280 chars). Be helpful but brief. If they're asking about services, point them to mark-agent.xyz.`
        );

        if (response) {
          await rwClient.v2.reply(response.substring(0, 280), mention.id);
          console.log('[TWITTER] Replied to mention:', mention.id);
        }
      }
    }
  } catch (error) {
    console.error('[TWITTER] Mention check error:', error.message);
  }
});

// Monitor DMs every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    const dms = await client.v2.listDmEvents({ event_types: 'MessageCreate', max_results: 5 });
    if (dms.data?.data) {
      console.log('[TWITTER] DM check: found', dms.data.data.length, 'recent messages');
    }
  } catch (error) {
    if (!error.message.includes('403')) {
      console.error('[TWITTER] DM check error:', error.message);
    }
  }
});

// Track metrics and update bio on milestones - daily at midnight
cron.schedule('0 0 * * *', async () => {
  try {
    const me = await client.v2.me({ 'user.fields': ['public_metrics'] });
    const followers = me.data.public_metrics?.followers_count || 0;

    const db = getDb();
    try {
      const activeClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").get();
      const treasuryBalance = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) as balance FROM treasury").get();

      db.prepare('INSERT INTO metrics (date, twitter_followers, active_clients, treasury_balance) VALUES (date(?), ?, ?, ?)')
        .run(new Date().toISOString(), followers, activeClients.count, treasuryBalance.balance);

      // Update bio with milestones
      const milestones = [];
      if (followers >= 1000) milestones.push(`${(followers / 1000).toFixed(1)}K followers`);
      else if (followers > 0) milestones.push(`${followers} followers`);
      if (activeClients.count > 0) milestones.push(`${activeClients.count} active clients`);
      if (treasuryBalance.balance > 0) milestones.push(`€${treasuryBalance.balance.toFixed(0)} revenue`);

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
