// ============================================
// DRIVE AUDIT LOG — DISCORD BOT
// Node.js bot that handles slash commands and
// receives alerts from Google Apps Script
//
// Commands:
//   /audit search [filename]
//   /audit whochanged [filename]
//   /audit recent
//   /audit stats
//   /audit status
// ============================================

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const express = require('express');
const app = express();
app.use(express.json());

// ============================================
// CONFIG — set these in Railway environment variables
// ============================================
const BOT_TOKEN       = process.env.BOT_TOKEN;        // Discord bot token
const CLIENT_ID       = process.env.CLIENT_ID;        // Discord application ID
const GUILD_ID        = process.env.GUILD_ID;         // Your Discord server ID
const ALERT_CHANNEL   = process.env.ALERT_CHANNEL_ID; // Channel ID for Drive alerts
const BOT_SECRET      = process.env.BOT_SECRET;       // Secret key shared with Apps Script
const PORT            = process.env.PORT || 3000;

// In-memory store for recent changes (last 100)
// In a production setup you'd use a database, but this works fine for our needs
let recentChanges = [];
let lastScanTime  = null;
let scriptHealthy = true;

// ============================================
// SLASH COMMAND DEFINITIONS
// ============================================
const commands = [
  new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Search and query your Google Drive Audit Log')
    .addSubcommand(sub =>
      sub.setName('search')
        .setDescription('Search for a file by name')
        .addStringOption(opt =>
          opt.setName('filename')
            .setDescription('File name to search for (partial match works)')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('whochanged')
        .setDescription('See who touched a specific file')
        .addStringOption(opt =>
          opt.setName('filename')
            .setDescription('File name to look up')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('recent')
        .setDescription('Show the last 10 changes across the Drive'))
    .addSubcommand(sub =>
      sub.setName('stats')
        .setDescription('Show today\'s change counts'))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Check if the audit script is healthy')),
].map(cmd => cmd.toJSON());

// ============================================
// DISCORD CLIENT SETUP
// ============================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', () => {
  console.log(`Bot is online as ${client.user.tag}`);
});

// ============================================
// SLASH COMMAND HANDLER
// ============================================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'audit') return;

  const sub = interaction.options.getSubcommand();

  // Defer reply so Discord doesn't time out while we process
  await interaction.deferReply();

  try {
    switch (sub) {
      case 'search':     await handleSearch(interaction);     break;
      case 'whochanged': await handleWhoChanged(interaction); break;
      case 'recent':     await handleRecent(interaction);     break;
      case 'stats':      await handleStats(interaction);      break;
      case 'status':     await handleStatus(interaction);     break;
    }
  } catch (e) {
    console.error('Command error:', e);
    await interaction.editReply('Something went wrong. Check the bot logs.');
  }
});

// ============================================
// COMMAND HANDLERS
// ============================================

async function handleSearch(interaction) {
  const query = interaction.options.getString('filename').toLowerCase();
  const results = recentChanges.filter(c =>
    c.name && c.name.toLowerCase().includes(query)
  );

  if (results.length === 0) {
    return interaction.editReply({
      embeds: [simpleEmbed(
        `🔍 Search: "${query}"`,
        'No matching files found in recent changes. Changes older than the last 100 events may not appear here — check the Google Sheet for full history.',
        0x5865F2
      )]
    });
  }

  const lines = results.slice(0, 10).map(c =>
    `${actionEmoji(c.action)} **${c.name}** — ${c.action} by ${c.lastEditor}\n` +
    `📁 ${c.path || 'Unknown path'} • ${formatTime(c.timestamp)}`
  );

  if (results.length > 10) lines.push(`\n... and ${results.length - 10} more results`);

  await interaction.editReply({
    embeds: [simpleEmbed(
      `🔍 Search results for "${query}"`,
      lines.join('\n\n'),
      0x5865F2
    )]
  });
}

async function handleWhoChanged(interaction) {
  const query = interaction.options.getString('filename').toLowerCase();
  const results = recentChanges.filter(c =>
    c.name && c.name.toLowerCase().includes(query)
  );

  if (results.length === 0) {
    return interaction.editReply({
      embeds: [simpleEmbed(
        `👤 Who changed "${query}"`,
        'No matching files found in recent changes.',
        0x5865F2
      )]
    });
  }

  // Group by editor
  const byEditor = {};
  for (const c of results) {
    const editor = c.lastEditor || 'Unknown';
    if (!byEditor[editor]) byEditor[editor] = [];
    byEditor[editor].push(c);
  }

  const lines = Object.entries(byEditor).map(([editor, changes]) => {
    const actions = changes.map(c => `${actionEmoji(c.action)} ${c.action} at ${formatTime(c.timestamp)}`).join('\n');
    return `**${editor}**\n${actions}`;
  });

  await interaction.editReply({
    embeds: [simpleEmbed(
      `👤 Who changed "${results[0].name}"`,
      lines.join('\n\n'),
      0x5865F2
    )]
  });
}

async function handleRecent(interaction) {
  if (recentChanges.length === 0) {
    return interaction.editReply({
      embeds: [simpleEmbed(
        '🕐 Recent changes',
        'No changes recorded yet. Either nothing has happened since the bot started, or the Apps Script hasn\'t run yet.',
        0x980727
      )]
    });
  }

  const latest = recentChanges.slice(-10).reverse();
  const lines = latest.map(c =>
    `${actionEmoji(c.action)} **${c.name}** — ${c.action}\n` +
    `👤 ${c.lastEditor || 'Unknown'} • 📁 ${c.path || 'Unknown'} • ${formatTime(c.timestamp)}`
  );

  await interaction.editReply({
    embeds: [simpleEmbed(
      '🕐 Last 10 changes',
      lines.join('\n\n'),
      0x980727
    )]
  });
}

async function handleStats(interaction) {
  // Count today's changes from the in-memory store
  const todayStr = toGMT8DateString(new Date());
  const todayChanges = recentChanges.filter(c => {
    const d = c.timestamp ? toGMT8DateString(new Date(c.timestamp)) : '';
    return d === todayStr;
  });

  const counts = { CREATED: 0, MODIFIED: 0, DELETED: 0, RENAMED: 0, MOVED: 0 };
  for (const c of todayChanges) {
    if (counts.hasOwnProperty(c.action)) counts[c.action]++;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const embed = new EmbedBuilder()
    .setTitle('📊 Today\'s Drive Stats')
    .setDescription(total === 0 ? 'No changes recorded today yet.' : `**${total}** total changes today`)
    .addFields(
      { name: '🟢 Created',  value: String(counts.CREATED),  inline: true },
      { name: '🔴 Deleted',  value: String(counts.DELETED),  inline: true },
      { name: '🔵 Moved',    value: String(counts.MOVED),    inline: true },
      { name: '🟡 Modified', value: String(counts.MODIFIED), inline: true },
      { name: '🔵 Renamed',  value: String(counts.RENAMED),  inline: true },
    )
    .setColor(0x980727)
    .setFooter({ text: 'Drive Audit Log • GMT+8' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleStatus(interaction) {
  const timeSinceScan = lastScanTime
    ? Math.round((Date.now() - new Date(lastScanTime).getTime()) / 60000)
    : null;

  const statusOk = scriptHealthy && timeSinceScan !== null && timeSinceScan < 30;
  const color = statusOk ? 0x57F287 : 0xED4245;
  const icon  = statusOk ? '✅' : '⚠️';

  const embed = new EmbedBuilder()
    .setTitle(icon + ' Audit Script Status')
    .addFields(
      {
        name: 'Script health',
        value: scriptHealthy ? '✅ Healthy' : '❌ Last run had errors',
        inline: true,
      },
      {
        name: 'Last scan',
        value: lastScanTime
          ? `${timeSinceScan} minute${timeSinceScan === 1 ? '' : 's'} ago`
          : 'Never received a ping yet',
        inline: true,
      },
      {
        name: 'Changes in memory',
        value: String(recentChanges.length) + ' (last 100 max)',
        inline: true,
      },
    )
    .setColor(color)
    .setFooter({ text: 'Drive Audit Log' })
    .setTimestamp();

  if (!statusOk && timeSinceScan !== null && timeSinceScan >= 30) {
    embed.setDescription('⚠️ The Apps Script hasn\'t reported in over 30 minutes. It may have stopped running. Check your triggers in Apps Script.');
  }

  await interaction.editReply({ embeds: [embed] });
}

// ============================================
// WEBHOOK ENDPOINT — receives data from Apps Script
// ============================================

// Apps Script posts alerts here
app.post('/alert', (req, res) => {
  // Verify the secret key so only your Apps Script can post here
  const secret = req.headers['x-bot-secret'];
  if (secret !== BOT_SECRET) {
    console.warn('Rejected request with invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { changes, scanTime, healthy } = req.body;

  if (scanTime) lastScanTime = scanTime;
  if (typeof healthy === 'boolean') scriptHealthy = healthy;

  if (!changes || changes.length === 0) {
    return res.json({ ok: true, message: 'No changes to post' });
  }

  // Store in memory (keep last 100)
  recentChanges = [...recentChanges, ...changes].slice(-100);

  // Post immediate alerts to the alert channel
  const channel = client.channels.cache.get(ALERT_CHANNEL);
  if (!channel) {
    console.error('Alert channel not found:', ALERT_CHANNEL);
    return res.status(500).json({ error: 'Alert channel not found' });
  }

  const immediateActions = ['DELETED', 'CREATED', 'MOVED'];
  const toAlert = changes.filter(c => immediateActions.includes(c.action));

  for (const change of toAlert) {
    const color  = actionColor(change.action);
    const emoji  = actionEmoji(change.action);
    const fields = [
      { name: 'File',        value: change.name        || 'Unknown', inline: true  },
      { name: 'Action',      value: emoji + ' ' + change.action,     inline: true  },
      { name: 'Modified by', value: change.lastEditor   || 'Unknown', inline: true  },
      { name: 'Path',        value: truncate(change.path || 'Unknown path', 100), inline: false },
    ];

    if (change.url && change.action !== 'DELETED') {
      fields.push({ name: 'Link', value: `[Open file](${change.url})`, inline: false });
    }

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} ${change.action} — ${truncate(change.name || 'Unknown', 50)}`)
      .addFields(fields)
      .setColor(color)
      .setFooter({ text: 'Drive Audit Log' })
      .setTimestamp();

    channel.send({ embeds: [embed] }).catch(console.error);
  }

  res.json({ ok: true, alerted: toAlert.length });
});

// Health check endpoint — Railway uses this to confirm the app is running
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    bot: client.user ? client.user.tag : 'connecting...',
    lastScan: lastScanTime,
    changesInMemory: recentChanges.length,
  });
});

// ============================================
// REGISTER SLASH COMMANDS WITH DISCORD
// Run this once by calling: node bot.js --register
// ============================================
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Slash commands registered successfully.');
  } catch (e) {
    console.error('Failed to register commands:', e);
  }
}

// ============================================
// HELPERS
// ============================================

function simpleEmbed(title, description, color) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description || 'No data')
    .setColor(color)
    .setFooter({ text: 'Drive Audit Log' })
    .setTimestamp()
    .toJSON();
}

function actionEmoji(action) {
  const map = { CREATED: '🟢', MODIFIED: '🟡', DELETED: '🔴', RENAMED: '🔵', MOVED: '🔵' };
  return map[action] || '⚪';
}

function actionColor(action) {
  const map = { CREATED: 0x57F287, MODIFIED: 0xFEE75C, DELETED: 0xED4245, RENAMED: 0x5865F2, MOVED: 0x5865F2 };
  return map[action] || 0x980727;
}

function truncate(str, max) {
  return str && str.length > max ? '...' + str.slice(-(max - 3)) : (str || '');
}

function formatTime(iso) {
  if (!iso) return 'Unknown time';
  return new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
}

function toGMT8DateString(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ============================================
// START
// ============================================
async function main() {
  if (process.argv.includes('--register')) {
    await registerCommands();
    process.exit(0);
  }

  // Start Express server for incoming webhooks from Apps Script
  app.listen(PORT, () => console.log(`Express listening on port ${PORT}`));

  // Start Discord bot
  await client.login(BOT_TOKEN);
}

main().catch(console.error);
