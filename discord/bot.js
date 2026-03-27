import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { chat } from '../core/brain.js';
import { formatPriceList } from '../core/pricing.js';
import { getDb } from '../database/init.js';
import cron from 'node-cron';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const CHANNEL_NAMES = ['announcements', 'get-marketing', 'case-studies', 'general'];
const guildChannels = new Map();

console.log('[DISCORD] Bot starting...');

// Register slash commands
const commands = [
  new SlashCommandBuilder().setName('brief').setDescription('Submit a project brief for marketing analysis')
    .addStringOption(opt => opt.setName('project').setDescription('Your project brief').setRequired(true)),
  new SlashCommandBuilder().setName('services').setDescription('View MARK\'s marketing services'),
  new SlashCommandBuilder().setName('pricing').setDescription('View current pricing'),
  new SlashCommandBuilder().setName('ask').setDescription('Ask MARK a marketing question')
    .addStringOption(opt => opt.setName('question').setDescription('Your question').setRequired(true)),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once('ready', async () => {
  console.log(`[DISCORD] Logged in as ${client.user.tag}`);

  // Register commands globally
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_APP_ID), { body: commands });
    console.log('[DISCORD] Slash commands registered');
  } catch (error) {
    console.error('[DISCORD] Command registration error:', error.message);
  }

  // Set up channels in each guild
  for (const guild of client.guilds.cache.values()) {
    await setupChannels(guild);
  }
});

async function setupChannels(guild) {
  const channels = {};
  for (const name of CHANNEL_NAMES) {
    let channel = guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText);
    if (!channel) {
      try {
        channel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          topic: getChannelTopic(name),
        });
        console.log(`[DISCORD] Created #${name} in ${guild.name}`);
      } catch (error) {
        console.error(`[DISCORD] Could not create #${name}:`, error.message);
        continue;
      }
    }
    channels[name] = channel;
  }
  guildChannels.set(guild.id, channels);

  // Send welcome message in announcements if first time
  if (channels.announcements) {
    try {
      const messages = await channels.announcements.messages.fetch({ limit: 1 });
      if (messages.size === 0) {
        await channels.announcements.send(
          "**MARK is online.**\n\n" +
          "I'm an AI marketing agent running my own company. I help crypto projects and local businesses grow with real strategy.\n\n" +
          "→ Submit a project in #get-marketing\n" +
          "→ Use `/brief` to get a marketing analysis\n" +
          "→ Check `/pricing` for current rates\n\n" +
          "Let's build something."
        );
      }
    } catch (error) {
      console.error('[DISCORD] Welcome message error:', error.message);
    }
  }
}

function getChannelTopic(name) {
  const topics = {
    'announcements': 'MARK posts updates and insights here',
    'get-marketing': 'Submit your project briefs for marketing analysis',
    'case-studies': 'Results, wins, and live case studies',
    'general': 'Community chat — MARK is always listening',
  };
  return topics[name] || '';
}

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'services') {
    await interaction.reply(
      "**MARK's Services:**\n\n" +
      "🔥 **Basic Audit** — Full marketing diagnosis\n" +
      "📈 **Monthly Retainer** — Ongoing marketing management\n" +
      "🚀 **Full Launch Package** — End-to-end launch marketing\n" +
      "⚡ **Pre-Launch Package** — Marketing before you launch\n" +
      "📝 **Content Package** — 30 days of content strategy\n" +
      "👥 **Community Setup** — Discord + Telegram architecture\n\n" +
      "Use `/pricing` for rates or `/brief` to submit your project."
    );
  }

  if (commandName === 'pricing') {
    const prices = formatPriceList();
    await interaction.reply(`**Current Pricing:**\n\n${prices}\n\nPrices adjust based on demand. Lock in today's rate with \`/brief\`.`);
  }

  if (commandName === 'brief') {
    const brief = interaction.options.getString('project');
    await interaction.deferReply();

    const db = getDb();
    try {
      db.prepare('INSERT INTO clients (name, contact, channel, project_brief, status) VALUES (?, ?, ?, ?, ?)')
        .run(interaction.user.username, interaction.user.id, 'discord', brief, 'inquiry');
    } finally {
      db.close();
    }

    const analysis = await chat(
      `A potential client submitted this project brief on Discord. Analyze and provide marketing diagnosis:\n\n${brief}`,
      { channel: 'discord', userId: interaction.user.id, username: interaction.user.username }
    );
    await interaction.editReply(analysis.substring(0, 2000));
  }

  if (commandName === 'ask') {
    const question = interaction.options.getString('question');
    await interaction.deferReply();
    const response = await chat(question, {
      channel: 'discord',
      userId: interaction.user.id,
      username: interaction.user.username,
    });
    await interaction.editReply(response.substring(0, 2000));
  }
});

// Monitor messages in relevant channels
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const channelName = message.channel.name;

  // Respond in get-marketing and general
  if (channelName === 'get-marketing' || channelName === 'general') {
    // Only respond if mentioned or in get-marketing
    if (channelName === 'general' && !message.mentions.has(client.user)) return;

    try {
      const response = await chat(message.content, {
        channel: 'discord',
        userId: message.author.id,
        username: message.author.username,
      });
      await message.reply(response.substring(0, 2000));
    } catch (error) {
      console.error('[DISCORD] Message response error:', error.message);
    }
  }
});

// Daily summary at 8pm UTC
cron.schedule('0 20 * * *', async () => {
  const db = getDb();
  try {
    const todayConvos = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE timestamp > datetime('now', '-24 hours')").get();
    const activeClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").get();
    const newInquiries = db.prepare("SELECT COUNT(*) as count FROM clients WHERE created_at > datetime('now', '-24 hours')").get();

    const summary = `**Daily Summary**\n\n` +
      `📊 Conversations today: ${todayConvos.count}\n` +
      `🔥 Active clients: ${activeClients.count}\n` +
      `📋 New inquiries: ${newInquiries.count}\n\n` +
      `MARK is always on. Submit your project with \`/brief\`.`;

    for (const [, channels] of guildChannels) {
      if (channels.announcements) {
        await channels.announcements.send(summary);
      }
    }
  } catch (error) {
    console.error('[DISCORD] Daily summary error:', error.message);
  } finally {
    db.close();
  }
});

client.on('guildCreate', async (guild) => {
  console.log(`[DISCORD] Joined guild: ${guild.name}`);
  await setupChannels(guild);
});

client.login(process.env.DISCORD_BOT_TOKEN);

process.on('uncaughtException', (error) => {
  console.error('[DISCORD] Uncaught exception:', error.message);
});
