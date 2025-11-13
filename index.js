// index.js - IgniteBot (clean, prefix-only, SFTP-enabled, uses injector.js if present)
// Features: economy, buy/store/verify flows, SFTP injection (Survival primary), injection queue,
// ephemeral interaction replies, admin (!inject), !linksteam, !buy shop (no duplicate), backups.

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  EmbedBuilder,
  StringSelectMenuBuilder
} = require('discord.js');

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SFTPClient = (() => {
  try { return require('ssh2-sftp-client'); } catch { return null; }
})();

// --- Config & files ---
const TOKEN = process.env.TOKEN || process.env.Discord_TOKEN || process.env.DISCORD_TOKEN;
const economyFile = path.join(__dirname, 'economy.json');
const storageFile = path.join(__dirname, 'storage.json');
const dinosFile = path.join(__dirname, 'dinos.json');
const queueFile = path.join(__dirname, 'injection_queue.json');

const TEMPLATE_FOLDER = process.env.TEMPLATE_FOLDER || path.join(__dirname, 'templates');
const SFTP_REMOTE_ROOT = process.env.SFTP_REMOTE_ROOT || (process.env.SFTP_REMOTE_PATH || '/TheIsle/Saved/Databases');
const SFTP_HOST = process.env.SFTP_HOST || '';
const SFTP_PORT = parseInt(process.env.SFTP_PORT || '8822', 10);
const SFTP_USER = process.env.SFTP_USER || '';
const SFTP_PASS = process.env.SFTP_PASS || '';
const SFTP_KEY_PATH = process.env.SFTP_KEY_PATH || '';
const SFTP_SAFE_THRESHOLD_SEC = parseInt(process.env.SFTP_SAFE_THRESHOLD_SEC || '120', 10);
const QUEUE_RETRY_INTERVAL_MS = parseInt(process.env.QUEUE_RETRY_INTERVAL_MS || String(60 * 1000), 10);
const DEFAULT_BALANCE = parseInt(process.env.DEFAULT_BALANCE || '10000', 10);

// admin role name (exact)
const ADMIN_ROLE_NAME = '🔥 The Catalyst/Owner';

// ensure local folders
if (!fs.existsSync('./backups')) fs.mkdirSync('./backups', { recursive: true });
if (!fs.existsSync(TEMPLATE_FOLDER)) fs.mkdirSync(TEMPLATE_FOLDER, { recursive: true });
if (!fs.existsSync(path.join(TEMPLATE_FOLDER, 'survival'))) fs.mkdirSync(path.join(TEMPLATE_FOLDER, 'survival'), { recursive: true });
if (!fs.existsSync(path.join(TEMPLATE_FOLDER, 'sandbox'))) fs.mkdirSync(path.join(TEMPLATE_FOLDER, 'sandbox'), { recursive: true });

// JSON helpers
function readJSON(file, defaultValue = {}) {
  try {
    if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2)); return defaultValue; }
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || raw.trim() === '') { fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2)); return defaultValue; }
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read/parse ${file}:`, err);
    try { fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2)); } catch {}
    return defaultValue;
  }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (err) { console.error(`Failed to write ${file}:`, err); }
}

// Ensure user record
function ensureUser(userId) {
  const econ = readJSON(economyFile, {});
  if (!econ[userId]) econ[userId] = { balance: DEFAULT_BALANCE };
  writeJSON(economyFile, econ);
  return { econ, user: econ[userId] };
}
function ensureStorage(userId) {
  const storage = readJSON(storageFile, {});
  if (!storage[userId]) storage[userId] = [];
  writeJSON(storageFile, storage);
  return { storage, userStorage: storage[userId] };
}

// dinos loader
function readDinos() {
  const defaults = {
    Carnotaurus: { class: 'carnivore', price: 3000, templateSurvival: 'Carnotaurus.json' },
    Tyrannosaurus: { class: 'carnivore', price: 3000, templateSurvival: 'Tyrannosaurus.json' },
    Triceratops: { class: 'herbivore', price: 3000, templateSurvival: 'Triceratops.json' },
    Brachiosaurus: { class: 'herbivore', price: 3000, templateSurvival: 'Brachiosaurus.json' },
    sandbox: {}
  };
  return readJSON(dinosFile, defaults);
}

// steam filename helper (uses econ steamId mapping)
function getSteamFilenameForUser(discordUserId) {
  const econ = readJSON(economyFile, {});
  if (econ[discordUserId] && econ[discordUserId].steamId) return `${econ[discordUserId].steamId}.json`;
  return `${discordUserId}.json`;
}

// --- Injector integration ---
// Try to use external injector.js if available and exports the two functions.
// injector.js should export { isSafeToInject, injectDinoToServer }.
// If not, fallback to a simple internal SFTP-based injector.
let externalInjector = null;
try {
  externalInjector = require(path.join(__dirname, 'injector.js'));
  if (!externalInjector || typeof externalInjector.isSafeToInject !== 'function' || typeof externalInjector.injectDinoToServer !== 'function') {
    console.warn('[INJECTOR] injector.js missing required exports. Falling back to internal injector.');
    externalInjector = null;
  } else {
    console.log('[INJECTOR] Using injector.js from disk.');
  }
} catch (err) {
  externalInjector = null;
}

// Internal fallback injector (only used if injector.js not provided)
const fallbackInjector = (function createFallbackInjector() {
  if (!SFTPClient) {
    console.warn('[INJECTOR] ssh2-sftp-client not installed; fallback injector disabled.');
    return null;
  }
  const sftpLib = require('ssh2-sftp-client');

  async function sftpConnect() {
    const sftp = new sftpLib();
    const cfg = { host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, readyTimeout: 20000 };
    if (SFTP_KEY_PATH) {
      try { cfg.privateKey = fs.readFileSync(SFTP_KEY_PATH); console.log('[SFTP] using key auth'); } catch (e) {}
    }
    if (!cfg.privateKey && SFTP_PASS) cfg.password = SFTP_PASS;
    await sftp.connect(cfg);
    return sftp;
  }

  async function backupRemoteFile(sftp, remoteFile, userId) {
    try {
      const localBackup = `./backups/${userId}_${Date.now()}.bak`;
      await sftp.fastGet(remoteFile, localBackup);
      console.log(`[SFTP] Backed up ${remoteFile} → ${localBackup}`);
    } catch (err) {
      console.log(`[SFTP] No existing remote file to back up for ${userId}.json`);
    }
  }

  // safe coordinate set requested
  const SAFE_SPAWN_COORDS = [
    "X=-341802.656 Y=-122799.562 Z=-70786.953"
  ];

  // isSafeToInject: checks both Survival and Sandbox players folders for the filename
  async function isSafeToInject(discordUserId) {
    const filename = getSteamFilenameForUser(discordUserId);
    const survivalPath = path.posix.join(SFTP_REMOTE_ROOT, 'Survival', 'Players');
    const sandboxPath = path.posix.join(SFTP_REMOTE_ROOT, 'Sandbox', 'Players');
    let sftp;
    try {
      sftp = await sftpConnect();
      async function check(folder) {
        try {
          const list = await sftp.list(folder);
          const file = list.find(f => f.name === filename);
          if (!file) return null;
          const modifyTimeSec = file.modifyTime || file.modify_time || (file.attrs && file.attrs.mtime) || null;
          if (!modifyTimeSec) return true; // permissive
          const modifiedAtMs = typeof modifyTimeSec === 'number' ? modifyTimeSec * 1000 : new Date(modifyTimeSec).getTime();
          const ageSec = (Date.now() - modifiedAtMs) / 1000;
          if (ageSec > SFTP_SAFE_THRESHOLD_SEC) return true;
          return false;
        } catch (err) {
          console.warn('[SAFE CHECK] could not list', folder, err && err.message ? err.message : err);
          return null;
        }
      }
      const sres = await check(survivalPath);
      if (sres === true) return true;
      if (sres === false) return false;
      const bres = await check(sandboxPath);
      if (bres === true) return true;
      if (bres === false) return false;
      return true;
    } catch (err) {
      console.error('[SAFE CHECK ERROR]', err && err.message ? err.message : err);
      return true;
    } finally {
      try { if (sftp) sftp.end(); } catch {}
    }
  }

  // injectDinoToServer writes the local template into Survival players folder as steam filename
  async function injectDinoToServer(discordUserId, purchaseObject, forceMode = 'survival') {
    try {
      const dinos = readDinos();
      const species = purchaseObject.name;
      if (!species) { console.error('[inject] missing species'); return false; }
      const entry = dinos[species] || {};
      // resolve local template
      let localTemplate = null;
      if (forceMode === 'sandbox' && entry.templateSandbox) localTemplate = path.join(TEMPLATE_FOLDER, 'sandbox', entry.templateSandbox);
      else if (entry.templateSurvival) localTemplate = path.join(TEMPLATE_FOLDER, 'survival', entry.templateSurvival);
      else localTemplate = path.join(TEMPLATE_FOLDER, 'survival', `${species}.json`);
      if (!fs.existsSync(localTemplate)) { console.error('[SFTP] Template missing:', localTemplate); return false; }

      const remoteDir = path.posix.join(SFTP_REMOTE_ROOT, 'Survival', 'Players');
      const steamFilename = getSteamFilenameForUser(discordUserId);
      const remoteFile = path.posix.join(remoteDir, steamFilename);
      const sftp = await sftpConnect();

      // ensure remote dir (attempt)
      try { await sftp.mkdir(remoteDir, true); } catch (e) {}

      // backup existing
      await backupRemoteFile(sftp, remoteFile, discordUserId);

      // upload
      await sftp.fastPut(localTemplate.replace(/\\/g, '/'), remoteFile);

      // optionally: verify sizes
      const remoteStat = await sftp.stat(remoteFile).catch(() => null);
      if (remoteStat) {
        console.log(`[SFTP] Uploaded ${localTemplate} -> ${remoteFile} (${remoteStat.size || 'unknown'} bytes)`);
      } else {
        console.log(`[SFTP] Uploaded ${localTemplate} -> ${remoteFile}`);
      }

      await sftp.end();
      return true;
    } catch (err) {
      console.error('[injectDinoToServer] error:', err && err.message ? err.message : err);
      return false;
    }
  }

  return { isSafeToInject, injectDinoToServer, SAFE_SPAWN_COORDS };
})();

const injector = externalInjector || fallbackInjector;
if (!injector) console.warn('[INJECTOR] No injector available. Injection features will fail until injector.js is installed or ssh2-sftp-client is available.');

// --- safeReply helper (for interactions only) ---
async function safeReply(interaction, contentOrOptions = { content: 'Done.' }) {
  try {
    const opts = (typeof contentOrOptions === 'string') ? { content: contentOrOptions, ephemeral: true } : Object.assign({}, contentOrOptions, { ephemeral: true });
    if (!interaction.replied && !interaction.deferred) return await interaction.reply(opts);
    return await interaction.followUp(opts);
  } catch (err) {
    console.error('safeReply error:', err && err.message ? err.message : err);
  }
}

// Admin check
function isAdmin(member) {
  try {
    if (!member || !member.roles) return false;
    return member.roles.cache.some(r => r.name === ADMIN_ROLE_NAME);
  } catch (e) {
    console.error('isAdmin error', e);
    return false;
  }
}

// --- Client setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel]
});

// --- Prevent duplicate listeners or double-shops ---
if (client.listenerCount(Events.MessageCreate) > 0) {
  console.warn('[Guard] Duplicate messageCreate listener prevented.');
  client.removeAllListeners(Events.MessageCreate);
}

// --- Commands: prefix handlers ---
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    const content = (message.content || '').trim();
    const lower = content.toLowerCase();
    const member = message.member;
    const userId = message.author.id;

    const { econ, user } = ensureUser(userId);
    const { storage, userStorage } = ensureStorage(userId);
    const dinos = readDinos();

    // helpers for message commands (message commands can't be ephemeral)
    async function replyDMorChannel(text) {
      try {
        await message.author.send({ content: text });
      } catch {
        // DM fail -> normal channel message
        try { await message.reply(text); } catch {}
      }
    }

    // !balance or !bal
    if (lower === '!balance' || lower === '!bal') {
      return replyDMorChannel(`You have ${user.balance} Ember Coins (EC).`);
    }

    // !work
    if (lower === '!work') {
      const earned = Math.floor(Math.random() * 1000) + 500;
      user.balance += earned;
      writeJSON(economyFile, econ);
      return replyDMorChannel(`You worked and earned ${earned} EC!`);
    }

    // !gamble <amt>
    if (lower.startsWith('!gamble')) {
      const parts = content.split(/\s+/);
      const bet = parseInt(parts[1], 10);
      if (!bet || bet <= 0) return replyDMorChannel('Enter a valid bet amount.');
      if (bet > user.balance) return replyDMorChannel('You do not have enough EC.');
      const win = Math.random() < 0.5;
      user.balance += win ? bet : -bet;
      writeJSON(economyFile, econ);
      return replyDMorChannel(win ? `You won ${bet} EC!` : `You lost ${bet} EC.`);
    }

    // !top
    if (lower === '!top') {
      const all = readJSON(economyFile, {});
      const leaderboard = Object.entries(all)
        .sort(([, a], [, b]) => (b.balance || 0) - (a.balance || 0))
        .slice(0, 10)
        .map(([id, data], i) => `${i + 1}. <@${id}> — ${data.balance || 0} EC`)
        .join('\n') || 'No data';
      return replyDMorChannel(`**Top 10 EC:**\n${leaderboard}`);
    }

    // !linksteam <steam64>
    if (lower.startsWith('!linksteam')) {
      const parts = content.split(/\s+/);
      const steam = parts[1];
      if (!steam) return replyDMorChannel('Usage: `!linksteam <Steam64ID>`');
      econ[userId] = econ[userId] || {};
      econ[userId].steamId = steam;
      writeJSON(economyFile, econ);
      return replyDMorChannel(`Linked Steam ID ${steam} to your Discord account.`);
    }

    // !store
    if (lower === '!store') {
      if (!member.roles.cache.some(r => r.name === '🔥 Kindled')) return replyDMorChannel('Only 🔥 Kindled players can store dinos.');
      if (!user.currentDino) return replyDMorChannel('You have no current dinosaur to store.');
      if (userStorage.length >= 20) return replyDMorChannel('Storage full (20).');
      userStorage.push(user.currentDino);
      delete user.currentDino;
      writeJSON(storageFile, storage);
      writeJSON(economyFile, econ);
      return replyDMorChannel('✅ Current dinosaur stored.');
    }

    // !storage
    if (lower === '!storage') {
      if (!member.roles.cache.some(r => r.name === '🔥 Kindled')) return replyDMorChannel('Only 🔥 Kindled players can view storage.');
      if (!userStorage || userStorage.length === 0) return replyDMorChannel('You have no stored dinosaurs.');
      const embed = new EmbedBuilder().setTitle(`${message.author.username}'s Storage`).setColor(0xFF8C00).setDescription(`Total: ${userStorage.length}`);
      userStorage.slice(-20).forEach((d, i) => embed.addFields({ name: `${i + 1}. ${d.name}`, value: `Gender: ${d.gender} | Growth: ${d.growth}% | Class: ${d.class}` }));
      try { await message.author.send({ embeds: [embed] }); } catch { await message.channel.send({ embeds: [embed] }); }
      return;
    }

    // !buy -> send single shop embed in channel (not DM) with buttons
    if (lower === '!buy') {
      if (!member.roles.cache.some(r => r.name === '🔥 Kindled')) return replyDMorChannel('Only 🔥 Kindled players can buy dinosaurs.');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_carnivore').setLabel('Carnivore 🦖').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('buy_herbivore').setLabel('Herbivore 🌿').setStyle(ButtonStyle.Success)
      );

      const shopEmbed = new EmbedBuilder().setTitle('Ignite Shop').setDescription(`${message.author}, choose your dinosaur type to begin.`).setColor(0xFF8C00);

      // send once in channel
      await message.channel.send({ content: `${message.author}`, embeds: [shopEmbed], components: [row] });
      return;
    }

    // Admin: !verifysetup (creates verify message)
    if (lower === '!verifysetup' && isAdmin(member)) {
      const verifyButton = new ButtonBuilder().setCustomId('verify_button').setLabel('Verify').setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(verifyButton);
      const embed = new EmbedBuilder().setTitle('🔥 Verify to Enter Ignite').setDescription('Click to verify and become **Kindled** (gives 10,000 EC).').setColor(0xFF4500);
      await message.channel.send({ embeds: [embed], components: [row] });
      return replyDMorChannel('Verification message posted.');
    }

    // Admin: !rolesetup (posts role lists from roles.json)
    if (lower === '!rolesetup' && isAdmin(member)) {
      if (!fs.existsSync(path.join(__dirname, 'roles.json'))) return replyDMorChannel('roles.json missing.');
      const rolesData = readJSON(path.join(__dirname, 'roles.json'), {});
      if (!rolesData.categories) return replyDMorChannel('roles.json malformed.');
      for (const category of rolesData.categories) {
        let contentText = `**${category.title}**\n${category.description}\n`;
        for (const r of category.roles) contentText += `${r.emoji} → <@&${r.roleId}>\n`;
        const posted = await message.channel.send({ content: contentText });
        for (const r of category.roles) try { await posted.react(r.emoji); } catch {}
      }
      return replyDMorChannel('Roles setup posted.');
    }

    // Admin: !inject <discordIdOr@mention> <species>  (force immediate injection, admin only)
    if (lower.startsWith('!inject') && isAdmin(member)) {
      const parts = content.split(/\s+/);
      const target = parts[1];
      const species = parts[2];
      if (!target || !species) return replyDMorChannel('Usage: !inject <discordId|@mention> <SpeciesName>');
      // resolve id
      let targetId = target.replace(/[<@!>]/g, '');
      if (!/^\d+$/.test(targetId)) return replyDMorChannel('Could not parse target id.');
      const purchase = { name: species, gender: 'male', class: (readDinos()[species] && readDinos()[species].class) || 'unknown', growth: 0, location: 'Spawn' };
      // attempt injection immediately (bypass safe check)
      const inj = injector;
      if (!inj) return replyDMorChannel('Injector not available (injector.js missing and ssh2-sftp-client not installed).');
      const ok = await inj.injectDinoToServer(targetId, purchase, 'survival');
      if (ok) return replyDMorChannel(`Injection attempt for <@${targetId}> (${species}) reported success.`);
      return replyDMorChannel('Injection failed; check logs.');
    }

  } catch (err) {
    console.error('MessageCreate handler error:', err);
  }
});

// --- Interaction handler (buttons & selects) ---
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    const userId = interaction.user.id;
    const { econ, user } = ensureUser(userId);
    const { storage, userStorage } = ensureStorage(userId);
    const dinos = readDinos();

    // verify
    if (interaction.isButton() && interaction.customId === 'verify_button') {
      await safeReply(interaction, 'Processing verification...');
      const guild = interaction.guild;
      const kindled = guild.roles.cache.find(r => r.name === '🔥 Kindled');
      const emberling = guild.roles.cache.find(r => r.name === '🌱 Emberling');
      if (!kindled || !emberling) return await safeReply(interaction, 'Roles not configured properly.');
      await interaction.member.roles.remove(emberling).catch(() => {});
      await interaction.member.roles.add(kindled).catch(() => {});
      user.balance = (user.balance || 0) + 10000;
      writeJSON(economyFile, econ);
      return await safeReply(interaction, 'You are now **Kindled**! +10,000 EC.');
    }

    // Buy class buttons
    if (interaction.isButton() && (interaction.customId === 'buy_carnivore' || interaction.customId === 'buy_herbivore')) {
      await safeReply(interaction, 'Loading dino list...');
      if (!interaction.member.roles.cache.some(r => r.name === '🔥 Kindled')) return await safeReply(interaction, 'Only 🔥 Kindled players can buy dinosaurs.');
      const targetClass = interaction.customId === 'buy_carnivore' ? 'carnivore' : 'herbivore';
      const options = Object.entries(dinos).filter(([k, v]) => k !== 'sandbox' && v && v.class === targetClass).map(([name]) => ({ label: name, value: name }));
      if (!options.length) return await safeReply(interaction, `No ${targetClass} dinos available right now.`);
      const menu = new StringSelectMenuBuilder().setCustomId(`select_dino_${targetClass}`).setPlaceholder(`Select a ${targetClass} species`).addOptions(options);
      const row = new ActionRowBuilder().addComponents(menu);
      return await safeReply(interaction, { content: `Choose a ${targetClass}:`, components: [row] });
    }

    // species selected -> gender
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_dino_')) {
      await safeReply(interaction, 'Loading gender options...');
      const species = interaction.values[0];
      if (!dinos[species]) return await safeReply(interaction, 'Species data missing.');
      const maleBtn = new ButtonBuilder().setCustomId(`gender_${species}_male`).setLabel('Male ♂️').setStyle(ButtonStyle.Secondary);
      const femaleBtn = new ButtonBuilder().setCustomId(`gender_${species}_female`).setLabel('Female ♀️').setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder().addComponents(maleBtn, femaleBtn);
      return await safeReply(interaction, { content: `Selected **${species}** — choose a gender:`, components: [row] });
    }

    // gender -> preview
    if (interaction.isButton() && interaction.customId.startsWith('gender_')) {
      await safeReply(interaction, 'Preparing purchase preview...');
      const parts = interaction.customId.split('_');
      const species = parts[1], gender = parts[2];
      if (!dinos[species]) return await safeReply(interaction, 'Species not found.');
      const price = dinos[species].price || 3000;
      const preview = { name: species, gender, class: dinos[species].class || 'unknown', growth: 0, location: 'Spawn' };
      user.pendingPurchase = preview;
      writeJSON(economyFile, readJSON(economyFile)); // ensure write
      const embed = new EmbedBuilder().setTitle('Purchase Preview').setDescription(`**${gender === 'male' ? 'Male' : 'Female'} ${species}**\nPrice: ${price} EC\nChoose: storage or overwrite (inject).`).setColor(0xFFD700);
      const addBtn = new ButtonBuilder().setCustomId('confirm_add_storage').setLabel('Add to Storage 🗄️').setStyle(ButtonStyle.Primary);
      const overwriteBtn = new ButtonBuilder().setCustomId('confirm_overwrite').setLabel('Overwrite Character ⚔️').setStyle(ButtonStyle.Danger);
      const row = new ActionRowBuilder().addComponents(addBtn, overwriteBtn);
      return await safeReply(interaction, { embeds: [embed], components: [row] });
    }

    // confirm actions
    if (interaction.isButton() && (interaction.customId === 'confirm_add_storage' || interaction.customId === 'confirm_overwrite')) {
      await safeReply(interaction, 'Processing purchase...');
      if (!user.pendingPurchase) return await safeReply(interaction, 'No pending purchase found.');
      const purchase = user.pendingPurchase;
      const price = (dinos[purchase.name] && dinos[purchase.name].price) ? dinos[purchase.name].price : 3000;
      if ((user.balance || 0) < price) return await safeReply(interaction, `Not enough EC (need ${price}).`);
      if (interaction.customId === 'confirm_add_storage') {
        const st = ensureStorage(userId);
        if (st.userStorage.length >= 20) return await safeReply(interaction, 'Storage full (20).');
        st.userStorage.push(purchase);
        user.balance -= price;
        delete user.pendingPurchase;
        writeJSON(storageFile, readJSON(storageFile));
        writeJSON(economyFile, readJSON(economyFile));
        return await safeReply(interaction, `✅ ${purchase.name} added to storage (-${price} EC).`);
      } else {
        // overwrite -> attempt injection (Survival)
        user.balance -= price;
        user.currentDino = purchase;
        delete user.pendingPurchase;
        writeJSON(economyFile, readJSON(economyFile));

        if (!injector) {
          user.balance += price; writeJSON(economyFile, readJSON(economyFile));
          return await safeReply(interaction, 'Injector not available. Purchase refunded.');
        }

        // check safe
        const safe = await injector.isSafeToInject(userId);
        if (!safe) {
          const queue = readJSON(queueFile, {});
          queue[userId] = user.currentDino;
          writeJSON(queueFile, queue);
          console.log(`[QUEUE] Queued injection for ${userId} (not safe).`);
          return await safeReply(interaction, 'Player appears online / file recent. Injection queued.');
        }

        const ok = await injector.injectDinoToServer(userId, user.currentDino, 'survival');
        if (ok) return await safeReply(interaction, `⚔️ ${purchase.name} injected into your Survival character! (-${price} EC)`);
        user.balance += price; writeJSON(economyFile, readJSON(economyFile));
        return await safeReply(interaction, 'Injection failed. You were refunded.');
      }
    }

  } catch (err) {
    console.error('Interaction handler error:', err);
    try { if (!interaction.replied && !interaction.deferred) await safeReply(interaction, 'An error occurred.'); } catch {}
  }
});

// --- Injection queue runner ---
setInterval(async () => {
  try {
    const queue = readJSON(queueFile, {});
    const keys = Object.keys(queue);
    if (!keys.length) return;
    for (const userId of keys) {
      try {
        const item = queue[userId];
        console.log(`[Queue] Checking ${userId}...`);
        if (!injector) { console.warn('[Queue] injector missing'); continue; }
        const safe = await injector.isSafeToInject(userId);
        if (!safe) { console.log(`[Queue] Not safe yet for ${userId}`); continue; }
        const success = await injector.injectDinoToServer(userId, item, 'survival');
        if (success) { delete queue[userId]; writeJSON(queueFile, queue); console.log(`[Queue] Injection for ${userId} completed.`); }
        else console.warn(`[Queue] Injection failed for ${userId} (will retry).`);
      } catch (e) {
        console.error('[Queue] user error', e);
      }
    }
  } catch (err) {
    console.error('[Queue] top error', err);
  }
}, QUEUE_RETRY_INTERVAL_MS);

// --- ready & login ---
client.once(Events.ClientReady, () => {
  console.log(`${client.user.tag} is online (SFTP mode)!`);
});

if (!TOKEN) {
  console.error('Missing TOKEN. Set process.env.TOKEN or Discord_TOKEN in .env');
  process.exit(1);
}
client.login(TOKEN).catch(err => { console.error('Login failed:', err && err.message ? err.message : err); process.exit(1); });

// unhandled rejections
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); });