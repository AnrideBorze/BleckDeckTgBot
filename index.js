// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

// ===== Owners (з .env) =====
const OWNER_IDS = (process.env.OWNER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(Number).filter(Number.isFinite);

// ===== Google Sheets helpers =====
const {
  getFactions,
  findRowByNick,
  appendPlayerRow,
  readRow,
  updateSlot,
  appendArchive,
  getRandomFightTarget,
  getPlanTargets,
  findAllowedNick,
  getAllowedBuildings,
  getAllowedEnemyNicks,
  getAllowedEnemyGuilds,
  upsertEnemyRow,
} = require('./sheets');

// ===== Обмеження одним чатом / кількома гілками =====
const ALLOWED_CHAT_ID = (process.env.ALLOWED_CHAT_ID || '').trim();
const rawTopicIds = (process.env.ALLOWED_TOPIC_IDS || process.env.ALLOWED_TOPIC_ID || '').trim();
const ALLOWED_TOPIC_IDS = rawTopicIds
  ? rawTopicIds.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite)
  : [];

function getUpdateChatId(ctx) {
  return (
    ctx.chat?.id ??
    ctx.message?.chat?.id ??
    ctx.channelPost?.chat?.id ??
    ctx.callbackQuery?.message?.chat?.id ??
    null
  );
}
function getUpdateThreadId(ctx) {
  return (
    ctx.message?.message_thread_id ??
    ctx.callbackQuery?.message?.message_thread_id ??
    ctx.channelPost?.message_thread_id ??
    null
  );
}

// ===== Bot init =====
if (!process.env.BOT_TOKEN) {
  console.error('❌ Missing BOT_TOKEN in .env');
  process.exit(1);
}
const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 9000 });

// Глобальний error handler (до launch)
bot.catch((err, ctx) => {
  console.error('Unhandled bot error:', err);
  try {
    if (ctx && typeof ctx.reply === 'function') {
      ctx.reply('❌ Сталася помилка при обробці команди. Спробуйте ще раз або напишіть координаторам.');
    }
  } catch (_) {}
});

// Дозвіл лише на наш чат/гілки
bot.use((ctx, next) => {
  const chatId = getUpdateChatId(ctx);
  if (ALLOWED_CHAT_ID && String(chatId) !== ALLOWED_CHAT_ID) return;
  if (ALLOWED_TOPIC_IDS.length > 0) {
    const threadId = getUpdateThreadId(ctx);
    if (!ALLOWED_TOPIC_IDS.includes(Number(threadId))) return;
  }
  return next();
});

// ===== Локальна мапа "tgUserId -> nick" =====
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}), 'utf8');

function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } }
let USERS = loadUsers();
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(USERS, null, 2), 'utf8'); }
function getNickByUserId(uid) { return USERS[String(uid)] || null; }
function setNickForUser(uid, nick) { USERS[String(uid)] = nick.trim(); saveUsers(); }

// ===== Ролі (owner/admin/coordinator) =====
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');
if (!fs.existsSync(ROLES_FILE)) {
  fs.writeFileSync(ROLES_FILE, JSON.stringify({ admins: [], coordinators: [] }, null, 2), 'utf8');
}
function loadRoles() { try { return JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8')); } catch { return { admins: [], coordinators: [] }; } }
function saveRoles(r) { fs.writeFileSync(ROLES_FILE, JSON.stringify(r, null, 2), 'utf8'); }
let ROLES = loadRoles();

function isOwner(id)       { return OWNER_IDS.includes(Number(id)); }
function isAdmin(id)       { return isOwner(id) || ROLES.admins.includes(Number(id)); }
function isCoordinator(id) { return isAdmin(id) || ROLES.coordinators.includes(Number(id)); }

function requireOwner(ctx) {
  if (!isOwner(ctx.from.id)) { ctx.reply('⛔ Лише власник може це робити.'); return false; }
  return true;
}
function requireAdmin(ctx) {
  if (!isAdmin(ctx.from.id)) { ctx.reply('⛔ Лише адмін або власник.'); return false; }
  return true;
}
function requireCoordinator(ctx) {
  if (!isCoordinator(ctx.from.id)) { ctx.reply('⛔ Лише координатор/адмін/власник.'); return false; }
  return true;
}
function resolveTargetUserId(ctx, arg) {
  if (ctx.message?.reply_to_message?.from?.id) return Number(ctx.message.reply_to_message.from.id);
  if (/^\d+$/.test(String(arg||'').trim())) return Number(arg);
  return null;
}

// ===== Слоти колод =====
const SLOTS = [
  { code: 's1', label: '1', index: 1 },
  { code: 's2', label: '2', index: 2 },
  { code: 's3', label: '3', index: 3 },
  { code: 'god', label: 'Боги', index: 4 },
  { code: 'r1', label: '1 резервна', index: 5 },
  { code: 'r2', label: '2 резервна', index: 6 }
];
const CODE2SLOT = Object.fromEntries(SLOTS.map(s => [s.code, s]));
const sessions = new Map(); // step, slotIndex, faction, page

// ===== Хелпери сили/рядків =====
function normalizeInt(x) {
  if (x == null) return null;
  const s = String(x).replace(/[^\d]/g, '');
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
function fmtPowerShort(x) {
  const n = typeof x === 'number' ? x : normalizeInt(x);
  if (n == null) return (x == null || x === '') ? '—' : String(x);
  if (n >= 1_000_000) { const v = n / 1_000_000; const s = (v % 1 === 0) ? String(v) : v.toFixed(2).replace(/\.?0+$/,''); return s + 'M'; }
  if (n >= 1_000)     { const v = n / 1_000;     const s = (v % 1 === 0) ? String(v) : v.toFixed(1).replace(/\.?0+$/,''); return s + 'K'; }
  return String(n);
}
function normalizeSpaces(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
function parsePowerSmart(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (/[kmмк]$/.test(s)) {
    const num = parseFloat(s.replace(/[^\d.,]/g, '').replace(',', '.'));
    if (!isFinite(num)) return NaN;
    if (/[mм]$/.test(s)) return Math.round(num * 1_000_000);
    if (/[kк]$/.test(s)) return Math.round(num * 1_000);
  }
  const hasDec = /[.,]/.test(s);
  const val = parseFloat(s.replace(',', '.'));
  if (!isFinite(val)) return NaN;
  if (hasDec) {
    if (val < 100)  return Math.round(val * 1_000_000);
    if (val < 1000) return Math.round(val * 1_000);
    return Math.round(val);
  }
  return Math.round(val);
}
function toIntStrict(str) {
  const s = String(str || '').replace(/[^\d]/g, '');
  if (!s) return NaN;
  return parseInt(s, 10);
}

// ===== Клавіатури =====
function buildSlotsKeyboard() {
  const rows = [
    [ Markup.button.callback('1', 'slot:s1'), Markup.button.callback('2', 'slot:s2'), Markup.button.callback('3', 'slot:s3') ],
    [ Markup.button.callback('Боги', 'slot:god') ],
    [ Markup.button.callback('1 резервна', 'slot:r1'), Markup.button.callback('2 резервна', 'slot:r2') ],
  ];
  return Markup.inlineKeyboard(rows);
}
function buildFactionsKeyboard(factions, page=0, perPage=8, slotCode='s1') {
  const total = factions.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(0, Math.min(page, pages-1));
  const slice = factions.slice(p*perPage, p*perPage + perPage);

  const rows = slice.map((name, i) => [Markup.button.callback(name, `fac:${slotCode}:${p}:${i}`)]);
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push(Markup.button.callback('« Назад', `facnav:${slotCode}:${p-1}`));
    if (p < pages-1) nav.push(Markup.button.callback('Вперед »', `facnav:${slotCode}:${p+1}`));
    if (nav.length) rows.push(nav);
  }
  rows.push([Markup.button.callback('❌ Скасувати', 'cancel')]);
  return Markup.inlineKeyboard(rows);
}

// ===== Команди базові =====
bot.start((ctx) => ctx.reply('Привіт! /help — довідка. Спершу задай нік: /setnick <нік>'));
bot.help((ctx) => ctx.reply([
  'Команди:',
  '/setnick <нік> — встановити або змінити свій нік (рядок у стовпчику “Наші гравці”).',
  '/showme [нік] — показує ваші (або вказаного ніку) 6 колод: 1, 2, 3, Боги, 1 резервна, 2 резервна.',
  '/fight — дає випадкову ціль з “Планування”.',
  '/enemies — показує всі цілі з “Планування” (будівля → гравці та їх колоди, з рядка 3).',
  '/id — показати chatId/userId.',

  '',
  'Оновлення колоди:',
  '/deck — майстер з кнопками (обираєш слот → фракція зі списку data!B → сила).',
  '/deck_<1-6>_<фракція>_<сила> — швидко без пробілів. "_" = пробіл у назві фракції.',
  '  Приклади: /deck_1_Легіон_333000 · /deck_4_Дикий_Ліс_1,1 · /deck_5_Орден_200,5',
  '  Правила сили: з десятковою — <100 → M; 100–999 → K; ≥1000 → як є; також приймаються суфікси K/M.',
  '/deck_set <1-6> <фракція> <сила> — пряме оновлення зі списком data!B.',

  '',
  'Слоти: 1, 2, 3, Боги (4), 1 резервна (5), 2 резервна (6).',
  'Фракції: лише зі списку (data!B:B).',
  'Формат відображення сили: 350000 → 350K, 2000000 → 2M.'
].join('\n')));

bot.command('id', (ctx) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? '—';
  return ctx.reply(`chatId: ${chatId}\nuserId: ${userId}\nthreadId: ${threadId}`);
});

bot.command('setnick', async (ctx) => {
  const requested = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!requested) return ctx.reply('Вкажи нік: /setnick <нік>');

  const allowed = await findAllowedNick(requested);
  if (!allowed) {
    return ctx.reply('❌ Такого ніку немає у списку гравців.\nЗверніться до адміністратора для добавлення вас в список гравців.');
  }
  setNickForUser(ctx.from.id, allowed);

  let row = await findRowByNick(allowed);
  if (!row) row = await appendPlayerRow(allowed);

  return ctx.reply(`✅ Нік збережено: ${allowed}\nТепер /deck — щоб оновити колоду.`);
});

// ===== /deck — майстер =====
bot.command('deck', async (ctx) => {
  const nick = getNickByUserId(ctx.from.id);
  if (!nick) return ctx.reply('Спершу встанови нік: /setnick <нік>');
  sessions.set(ctx.from.id, { step: 'slot' });
  await ctx.reply('Оберіть слот колоди:', buildSlotsKeyboard());
});

// Кнопки майстра
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const uid = ctx.from.id;
  const sess = sessions.get(uid) || {};

  if (data === 'cancel') {
    sessions.delete(uid);
    await ctx.answerCbQuery('Скасовано');
    return;
  }

  if (data.startsWith('slot:')) {
    const code = data.split(':')[1];
    const slot = CODE2SLOT[code];
    if (!slot) return ctx.answerCbQuery('Невідомий слот');

    const factions = await getFactions();
    sessions.set(uid, { step: 'faction', slotIndex: slot.index, slotLabel: slot.label, page: 0, factions });
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Слот: ${slot.label}\nОберіть фракцію:`,
      buildFactionsKeyboard(factions, 0, 8, code)
    );
    return;
  }

  if (data.startsWith('facnav:')) {
    const [, code, pageStr] = data.split(':');
    const slot = CODE2SLOT[code];
    if (!slot) return ctx.answerCbQuery('Невідомий слот');
    const page = parseInt(pageStr, 10) || 0;

    const s = sessions.get(uid);
    if (!s || s.step !== 'faction') return ctx.answerCbQuery();
    s.page = page;
    sessions.set(uid, s);

    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(
      buildFactionsKeyboard(s.factions, s.page, 8, code).reply_markup
    );
    return;
  }

  if (data.startsWith('fac:')) {
    const [, code, pageStr, idxStr] = data.split(':');
    const s = sessions.get(uid);
    if (!s || s.step !== 'faction') return ctx.answerCbQuery();
    const page = parseInt(pageStr, 10) || 0;
    const idx = parseInt(idxStr, 10) || 0;
    const faction = (s.factions[page * 8 + idx] || '').trim();
    if (!faction) return ctx.answerCbQuery('Помилка вибору');

    s.faction = faction;
    s.step = 'power';
    sessions.set(uid, s);

    await ctx.answerCbQuery(`Фракція: ${faction}`);
    await ctx.editMessageText(
      `Слот: ${s.slotLabel}\nФракція: ${faction}\n\nВведи силу **цілим числом** або у форматі 1,1 (М) / 200,5 (К):`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.answerCbQuery();
});

// Ввід сили у майстрі
bot.on('text', async (ctx, next) => {
  const s = sessions.get(ctx.from.id);
  if (!s || s.step !== 'power') return next();

  const power = parsePowerSmart(ctx.message.text);
  if (!isFinite(power) || power <= 0) {
    return ctx.reply('Сила має бути числом. Приклади: 333000 або 1,1 (це 1.1M) чи 200,5 (це 200.5K).');
  }
  const nick = getNickByUserId(ctx.from.id);
  if (!nick) return ctx.reply('Спершу /setnick <нік>.');

  await applyDeckUpdate({
    actor: ctx.from,
    chatId: ctx.chat?.id,
    nick,
    slotIndex: s.slotIndex,
    slotLabel: s.slotLabel,
    newFaction: s.faction,
    newPower: power
  }, ctx);

  sessions.delete(ctx.from.id);
});

// ===== Прямий сеттер: /deck_set <1-6> <фракція> <сила> =====
bot.command('deck_set', async (ctx) => {
  try {
    const args = ctx.message.text.slice('/deck_set'.length).trim();
    if (!args) return ctx.reply('Формат: /deck_set <1-6> <фракція> <сила>\nНапр.: /deck_set 1 Легіон 333000');

    const tokens = args.match(/"[^"]+"|\S+/g) || [];
    if (tokens.length < 3) return ctx.reply('Формат: /deck_set <1-6> <фракція> <сила>');

    const slotNum = parseInt(tokens[0], 10);
    if (!(slotNum >= 1 && slotNum <= 6)) return ctx.reply('Номер слота має бути від 1 до 6.');

    const strip = (s) => s.replace(/^"+|"+$/g, '');
    const factionInput = normalizeSpaces(strip(tokens.slice(1, -1).join(' ')));
    const powerRaw = tokens[tokens.length - 1];

    const nick = getNickByUserId(ctx.from.id);
    if (!nick) return ctx.reply('Спершу /setnick <нік>.');

    const slot = SLOTS.find(s => s.index === slotNum);
    if (!slot) return ctx.reply('Невідомий слот. Доступні 1..6.');

    const factions = await getFactions();
    const match = factions.find(f => normalizeSpaces(f).toLowerCase() === factionInput.toLowerCase());
    if (!match) {
      const preview = factions.slice(0, 20).join(', ');
      return ctx.reply('❌ Такої фракції немає у списку.\n' +
        'Спробуй /deck (майстер) або одну зі списку:\n' +
        preview + (factions.length > 20 ? '…' : '')
      );
    }

    const power = parsePowerSmart(powerRaw);
    if (!isFinite(power) || power <= 0) {
      return ctx.reply('❌ Невірна сила. Приклади: 333000 або 1,1 (це 1.1M) чи 200,5 (це 200.5K).');
    }

    await applyDeckUpdate({
      actor: ctx.from,
      chatId: ctx.chat?.id,
      nick,
      slotIndex: slot.index,
      slotLabel: slot.label,
      newFaction: match,
      newPower: power
    }, ctx);
  } catch (e) {
    console.error('deck_set error', e);
    return ctx.reply('Сталася помилка при встановленні колоди.');
  }
});

// ===== /showme =====
bot.command('showme', async (ctx) => {
  const argNick = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const nick = argNick || getNickByUserId(ctx.from.id);
  if (!nick) return ctx.reply('Вкажи нік: /showme <нік> або спершу зроби /setnick <нік>');

  const row = await findRowByNick(nick);
  if (!row) return ctx.reply('Такого гравця немає.');

  const arr = await readRow(row);
  const get = (i) => (arr[i] ?? '').toString().trim() || '—';

  const f1 = get(1),  p1 = get(2);
  const f2 = get(3),  p2 = get(4);
  const f3 = get(5),  p3 = get(6);
  const f4 = get(7),  p4 = get(8);
  const f5 = get(9),  p5 = get(10);
  const f6 = get(11), p6 = get(12);

  const lines = [
    `Колода 1 — ${f1} — сила ${fmtPowerShort(p1)}`,
    `Колода 2 — ${f2} — сила ${fmtPowerShort(p2)}`,
    `Колода 3 — ${f3} — сила ${fmtPowerShort(p3)}`,
    `Колода 4 (Боги) — ${f4} — сила ${fmtPowerShort(p4)}`,
    `Колода 5 (1 резервна) — ${f5} — сила ${fmtPowerShort(p5)}`,
    `Колода 6 (2 резервна) — ${f6} — сила ${fmtPowerShort(p6)}`,
  ];
  return ctx.reply(`👤 ${nick}\n` + lines.join('\n'));
});

// ===== /enemies (з «Планування», з 3-го рядка) =====
bot.command('enemies', async (ctx) => {
  const all = await getPlanTargets();
  const rows = all.slice(2); // починаючи з 3-го

  if (!rows || rows.length === 0) return ctx.reply('У «Плануванні» поки що немає цілей.');

  const byBuilding = new Map();
  for (const r of rows) {
    const building = (r.building || '').toString().trim() || '—';
    const player   = (r.player   || '').toString().trim() || '—';
    const deck     = (r.deck     || '').toString().trim() || '—';
    const power    = fmtPowerShort(r.power);

    if (!byBuilding.has(building)) byBuilding.set(building, new Map());
    const byPlayer = byBuilding.get(building);
    if (!byPlayer.has(player)) byPlayer.set(player, []);
    byPlayer.get(player).push({ deck, power });
  }

  const sections = [];
  for (const [building, byPlayer] of byBuilding) {
    const lines = [`🏰 ${building}`];
    const entries = Array.from(byPlayer.entries()).sort((a, b) => a[0].localeCompare(b[0], 'uk'));
    for (const [player, items] of entries) {
      const list = items.map(it => `${it.deck} — сила ${it.power}`).join(' · ');
      lines.push(`— ${player}: ${list}`);
    }
    sections.push(lines.join('\n'));
  }
  sections.sort((a, b) => a.localeCompare(b, 'uk'));

  let buf = '';
  for (const sec of sections) {
    const piece = (buf ? buf + '\n\n' : '') + sec;
    if (piece.length > 3500) { if (buf) await ctx.reply(buf); buf = sec; }
    else { buf = piece; }
  }
  if (buf) await ctx.reply(buf);
});

// ===== Ролі: команди =====
bot.command('whoami', (ctx) => {
  const uid = ctx.from.id;
  const nick = getNickByUserId(uid) || '—';
  const role = isOwner(uid) ? 'власник' : isAdmin(uid) ? 'адмін' : isCoordinator(uid) ? 'координатор' : 'гравець';
  ctx.reply(`userId: ${uid}\nнік: ${nick}\nроль: ${role}`);
});
bot.command('admins', (ctx) => {
  if (!requireAdmin(ctx)) return;
  const a = ROLES.admins.map(String).join(', ') || '—';
  const c = ROLES.coordinators.map(String).join(', ') || '—';
  const o = OWNER_IDS.map(String).join(', ') || '—';
  ctx.reply(`Власники: ${o}\nАдміни: ${a}\нКоординатори: ${c}\n\n(айді через кому)`);
});
bot.command('grant_admin', (ctx) => {
  if (!requireOwner(ctx)) return;
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const target = resolveTargetUserId(ctx, arg);
  if (!target) return ctx.reply('Вкажи userId або відповідай реплаєм на повідомлення користувача.');
  if (isOwner(target)) return ctx.reply('Цей користувач уже власник.');
  if (!ROLES.admins.includes(target)) {
    ROLES.admins.push(target);
    ROLES.admins = Array.from(new Set(ROLES.admins));
    saveRoles(ROLES);
  }
  ctx.reply(`✅ Надано роль АДМІН: ${target}`);
});
bot.command('revoke_admin', (ctx) => {
  if (!requireOwner(ctx)) return;
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const target = resolveTargetUserId(ctx, arg);
  if (!target) return ctx.reply('Вкажи userId або відповідай реплаєм.');
  ROLES.admins = ROLES.admins.filter(id => id !== target);
  saveRoles(ROLES);
  ctx.reply(`✅ Забрано роль АДМІН: ${target}`);
});
bot.command('grant_coord', (ctx) => {
  if (!requireAdmin(ctx)) return;
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const target = resolveTargetUserId(ctx, arg);
  if (!target) return ctx.reply('Вкажи userId або відповідай реплаєм.');
  if (isOwner(target) || ROLES.admins.includes(target)) return ctx.reply('Це власник/адмін — у нього й так більше прав.');
  if (!ROLES.coordinators.includes(target)) {
    ROLES.coordinators.push(target);
    ROLES.coordinators = Array.from(new Set(ROLES.coordinators));
    saveRoles(ROLES);
  }
  ctx.reply(`✅ Надано роль КООРДИНАТОР: ${target}`);
});
bot.command('revoke_coord', (ctx) => {
  if (!requireAdmin(ctx)) return;
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const target = resolveTargetUserId(ctx, arg);
  if (!target) return ctx.reply('Вкажи userId або відповідай реплаєм.');
  ROLES.coordinators = ROLES.coordinators.filter(id => id !== target);
  saveRoles(ROLES);
  ctx.reply(`✅ Забрано роль КООРДИНАТОР: ${target}`);
});

// ===== enemy_set =====
async function parseEnemySetFields(raw) {
  const parts = raw.split('_').filter(Boolean);
  if (parts.length < 5) return { error: 'Формат: /enemy_set_<будівля>_<фракція>_<нік>_<гільдія>_<сила>[_<індекс>]' };
  let deckIndex = 1;
  if (/^\d+$/.test(parts[parts.length - 1])) deckIndex = Math.max(1, parseInt(parts.pop(), 10));
  const powerRaw = parts.pop();

  const buildings = await getAllowedBuildings();
  const factions  = await getFactions();
  const nicks     = await getAllowedEnemyNicks();
  const guilds    = await getAllowedEnemyGuilds();

  const join = (arr) => arr.join('_');
  const norm = (s) => normalizeSpaces(s).toLowerCase();

  for (let i = 1; i <= parts.length - 3; i++) {
    const candBuilding = join(parts.slice(0, i));
    if (!buildings.find(b => norm(b) === norm(candBuilding))) continue;

    for (let j = i + 1; j <= parts.length - 2; j++) {
      const candFaction = join(parts.slice(i, j));
      if (!factions.find(f => norm(f) === norm(candFaction))) continue;

      for (let k = j + 1; k <= parts.length - 1; k++) {
        const candNick  = join(parts.slice(j, k));
        const candGuild = join(parts.slice(k));
        const okNick  = nicks.find(n => norm(n) === norm(candNick));
        const okGuild = guilds.find(g => norm(g) === norm(candGuild));
        if (okNick && okGuild) {
          return {
            building: buildings.find(b => norm(b) === norm(candBuilding)),
            faction: factions.find(f => norm(f) === norm(candFaction)),
            enemyNick: okNick,
            enemyGuild: okGuild,
            powerRaw,
            deckIndex
          };
        }
      }
    }
  }
  return { error: 'Не вдалося розпізнати параметри. Перевір, що всі назви існують у data (A–D) і розділені підкресленням _ .' };
}

bot.hears(/^\/enemy_set_(.+)$/i, async (ctx) => {
  if (!requireCoordinator(ctx)) return;
  try {
    const parsed = await parseEnemySetFields(ctx.match[1]);
    if (parsed.error) return ctx.reply(`❌ ${parsed.error}`);
    const { building, faction, enemyNick, enemyGuild, powerRaw, deckIndex } = parsed;

    const power = parsePowerSmart(powerRaw);
    if (!isFinite(power) || power <= 0) {
      return ctx.reply('❌ Невірна сила. Приклади: 333000 або 1,1 (це 1.1M) чи 200,5 (це 200.5K).');
    }

    const created = await upsertEnemyRow({
      player: enemyNick, building, faction, power, guild: enemyGuild, deckIndex
    });

    return ctx.reply([
      created ? '✅ Додано в «Колоди противників»:' : '✅ Оновлено в «Колоди противників»:',
      `Будівля: ${building}`,
      `Гравець: ${enemyNick}`,
      `Гільдія: ${enemyGuild}`,
      `Фракція: ${faction}`,
      `Сила: ${fmtPowerShort(power)}`,
      `№ колоди: ${deckIndex}`
    ].join('\n'));
  } catch (e) {
    console.error('enemy_set error', e);
    return ctx.reply('Сталася помилка при оновленні даних противника.');
  }
});

// ===== Fight (рандом із Планування) =====
bot.command('fight', async (ctx) => {
  const t = await getRandomFightTarget();
  if (!t) return ctx.reply('У плануванні поки що немає цілей.');
  return ctx.reply(`🎯 ${t.building} — ${t.player} — ${t.deck} — сила ${fmtPowerShort(t.power)}`);
});

// ===== Оновлення колоди (спільна логіка) =====
async function applyDeckUpdate(payload, ctx) {
  const { actor, chatId, nick, slotIndex, slotLabel, newFaction, newPower } = payload;

  let row = await findRowByNick(nick);
  if (!row) row = await appendPlayerRow(nick);

  const before = await readRow(row);
  const pairIndex = slotIndex; // 1..6
  const posFaction = 1 + (pairIndex - 1) * 2;
  const posPower = posFaction + 1;

  const oldFaction = before[posFaction] || '';
  const oldPower = before[posPower] || '';

  await appendArchive({
    actorUserId: actor.id,
    actorUsername: actor.username || actor.first_name || '',
    playerNick: nick,
    slot: slotLabel,
    oldFaction, oldPower,
    newFaction, newPower,
    chatId
  });

  await updateSlot(row, slotIndex, newFaction, newPower);

  await ctx.reply([
    `✅ Оновлено для **${nick}**`,
    `Слот: ${slotLabel}`,
    `Фракція: ${oldFaction || '—'} → **${newFaction}**`,
    `Сила: ${oldPower || '—'} → **${newPower}**`
  ].join('\n'), { parse_mode: 'Markdown' });
}

// ===== Запуск =====
bot.launch();
console.log('Guild bot is running (polling)…');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
