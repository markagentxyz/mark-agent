import { TwitterApi } from 'twitter-api-v2';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const client = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

const MARK_BIO = 'Autonomous AI marketing agent. Building my own company from $0 in public. Crypto projects + local businesses. mark-agent.xyz';

export async function updateProfile({ bio, name, url, profileImagePath, bannerImagePath } = {}) {
  try {
    const v1Client = client.readWrite.v1;

    // Update profile info
    const params = {};
    if (bio) params.description = bio;
    if (name) params.name = name;
    if (url) params.url = url;

    if (Object.keys(params).length > 0) {
      await v1Client.updateAccountProfile(params);
      console.log('[TWITTER] Profile info updated:', Object.keys(params).join(', '));
    }

    // Update profile picture
    if (profileImagePath && existsSync(profileImagePath)) {
      const imageData = readFileSync(profileImagePath, { encoding: 'base64' });
      await v1Client.updateAccountProfileImage(imageData);
      console.log('[TWITTER] Profile picture updated');
    }

    // Update banner
    if (bannerImagePath && existsSync(bannerImagePath)) {
      const bannerData = readFileSync(bannerImagePath, { encoding: 'base64' });
      await v1Client.updateAccountProfileBanner(bannerData);
      console.log('[TWITTER] Banner updated');
    }

    return true;
  } catch (error) {
    console.error('[TWITTER] Profile update error:', error.message);
    return false;
  }
}

export async function setupInitialProfile() {
  const assetsDir = join(__dirname, '..', 'assets');
  const pfpPath = join(assetsDir, 'profile.jpg');
  const bannerPath = join(assetsDir, 'banner.jpg');

  // Also check for .png variants
  const pfp = existsSync(pfpPath) ? pfpPath
    : existsSync(join(assetsDir, 'profile.png')) ? join(assetsDir, 'profile.png')
    : null;
  const banner = existsSync(bannerPath) ? bannerPath
    : existsSync(join(assetsDir, 'banner.png')) ? join(assetsDir, 'banner.png')
    : null;

  await updateProfile({
    bio: MARK_BIO,
    name: 'MARK',
    url: 'https://mark-agent.xyz',
    profileImagePath: pfp,
    bannerImagePath: banner,
  });
}

export async function updateBioWithPricing(pricesSummary) {
  const bio = `Autonomous AI marketing agent. Building from $0 in public. ${pricesSummary}. mark-agent.xyz`;
  // Twitter bio max 160 chars
  const trimmedBio = bio.length > 160 ? bio.substring(0, 157) + '...' : bio;
  await updateProfile({ bio: trimmedBio });
}

export async function updateBioMilestone(milestone) {
  const bio = `Autonomous AI marketing agent. ${milestone}. Crypto projects + local businesses. mark-agent.xyz`;
  const trimmedBio = bio.length > 160 ? bio.substring(0, 157) + '...' : bio;
  await updateProfile({ bio: trimmedBio });
}
