// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

// ===== Owners from .env =====
const OWNER_IDS = (process.env.OWNER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(Number).filter(Number.isFinite);

// ===== Sheets helpers =====
const {
  // базове
  getFactions,
  findAllowedNick,
  getAllowedBuildings,
  getDataBuildingsKM,
  updateNoFightFlags,
  getAllowedEnemyNicks,
  getAllowedEnemyGuilds,
  setPlanningA1,
  getPlanLookRows,
  findRowByNick,
  appendPlayerRow,
  readRow,
  updateSlot,
  appendArchive,
  getDeckCategories,      
  getDecksByCategory,
  getPlanTargetsDetailed,
  setPlanRowStatus,
  getNextFreeUsageSlot,
  setUsageSlotText,
  updateGod,
  upsertEnemyRow,
  getEnemyDecks,
  incrementStatLoss,
  getRandomFightTarget,
  updateAltar,
  updateGodPower,

  // нове/для /fight
  getBuildingPriorities,   // читає data!K:M → Map<nameLower, {pL, pM}>
  getActiveGateKey,        // читає data!N2 ('' | 'порт' | 'головні ворота' | 'східний бастіон' | 'західний бастіон')
  setActiveGateKey,        // пише в data!N2
  setPlanRowAssigneeAndDeck, 
  getClassificationInfo,
  clearDestroyedAndSetRemain,
  getReservList,
} = require('./sheets');



// ===== Access: one chat + selected topics =====
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

if (!process.env.BOT_TOKEN) {
  console.error('❌ Missing BOT_TOKEN in .env');
  process.exit(1);
}
const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 60000 });

// Global error handler
bot.catch((err, ctx) => {
  console.error('Unhandled bot error:', err);

  const isTimeout =
    err?.name === 'TimeoutError' ||
    /Promise timed out/i.test(err?.message || '');

  // Якщо це таймаут Telegraf/p-timeout — не шлемо ❌
  if (isTimeout) {
    return; // тихо ігноруємо; краще підняти handlerTimeout (вже зробили до 60000)
  }

  try {
    if (ctx && typeof ctx.reply === 'function') {
      ctx.reply('❌ Сталася помилка при обробці команди. Спробуйте ще раз або напишіть координаторам.');
    }
  } catch (_) {}
});


// Access filter
bot.use((ctx, next) => {
  const chatId = getUpdateChatId(ctx);
  if (ALLOWED_CHAT_ID && String(chatId) !== ALLOWED_CHAT_ID) return;
  if (ALLOWED_TOPIC_IDS.length > 0) {
    const threadId = getUpdateThreadId(ctx);
    if (!ALLOWED_TOPIC_IDS.includes(Number(threadId))) return;
  }
  return next();
});

// ===== Local storage: users and roles =====
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}), 'utf8');
if (!fs.existsSync(ROLES_FILE)) fs.writeFileSync(ROLES_FILE, JSON.stringify({ admins: [], coordinators: [] }, null, 2), 'utf8');

function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } }
function saveUsers(obj) { fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2), 'utf8'); }
let USERS = loadUsers();
function getNickByUserId(uid) { return USERS[String(uid)] || null; }
function setNickForUser(uid, nick) { USERS[String(uid)] = nick.trim(); saveUsers(USERS); }

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
  if (/^\d+$/.test(String(arg || '').trim())) return Number(arg);
  return null;
}

const SLOTS = [
  { code: 's1',  label: '1',           index: 1 },
  { code: 's2',  label: '2',           index: 2 },
  { code: 's3',  label: '3',           index: 3 },
  { code: 's4',  label: '4',           index: 4 },
  { code: 'r1',  label: '1 резервна',  index: 5 },
  { code: 'r2',  label: '2 резервна',  index: 6 }
];


const CODE2SLOT = Object.fromEntries(SLOTS.map(s => [s.code, s]));
const sessions = new Map(); // deck wizard
const loseSessions = new Map(); // /lose flow

// ===== Helpers =====
function normalizeInt(x) {
  if (x == null) return null;
  const s = String(x).replace(/[^\d]/g, '');
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function fmtPowerShort(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return Math.round(v / 1e8) / 10 + 'B';
  if (v >= 1e6) return Math.round(v / 1e5) / 10 + 'M';
  if (v >= 1e3) return Math.round(v / 1e2) / 10 + 'K';
  return String(v);
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

// map: повертається getBuildingPriorities() як Map<lowerName, {pL, pM}>
function getPriorityFor(prioMap, buildingName, mode /* 'L' | 'M' */) {
  const rec = prioMap.get(canonName(buildingName));
  const v = mode === 'L' ? rec?.pL : rec?.pM;
  return Number.isFinite(v) ? v : 999999;
}

function includesNick(listStr, nick) {
  const s = ',' + String(listStr || '').toLowerCase().replace(/[;\s|/]+/g, ',') + ',';
  const q = ',' + String(nick || '').toLowerCase() + ',';
  return s.includes(q);
}
function deckLabelFromInstr(instr) {
  const s = (instr || '').toString().trim();

  // 1..4 звичайні колоди
  if (/^Перша колода$/i.test(s))    return { label: 'перша колода',   code: '1' };
  if (/^Друга колода$/i.test(s))    return { label: 'друга колода',    code: '2' };
  if (/^Третя колода$/i.test(s))    return { label: 'третя колода',    code: '3' };
  if (/^Четверта колода$/i.test(s)) return { label: 'четверта колода', code: '4' };

  // боги/вівтарі — будь-що, що містить ці слова
  if (/(вівтар|аква|гея|марок|кхас|таа)/i.test(s)) {
    return { label: s, code: 'god' }; // ВАЖЛИВО: НЕ число
  }

  // інше — нейтрально (щоб не чіпати G)
  return { label: s || '—', code: 'other' };
}




// ===== Keyboards =====
function buildDeckWizardKeyboard() {
  const rows = [
    // 4 звичайні колоди
    [ Markup.button.callback('Перша колода', 'slot:s1'), Markup.button.callback('Друга колода', 'slot:s2'),
      Markup.button.callback('Третя колода', 'slot:s3'), Markup.button.callback('Четверта колода', 'slot:s4') ],
    // вівтар
    [ Markup.button.callback('Вівтар зелений', 'slot:altarG'),
      Markup.button.callback('Вівтар червоний', 'slot:altarR') ],
    // боги
    [ Markup.button.callback('Аква', 'slot:god1'), Markup.button.callback('Гея', 'slot:god2'),
      Markup.button.callback('Марок', 'slot:god3'), Markup.button.callback('Кхас', 'slot:god4') ],
    [ Markup.button.callback('❌ Скасувати', 'cancel') ],
  ];
  return Markup.inlineKeyboard(rows);
}


function buildCategoriesKeyboard(categories, page=0, perPage=8, slotCode='s1') {
  const total = categories.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(0, Math.min(page, pages-1));
  const slice = categories.slice(p*perPage, p*perPage + perPage);

  const rows = slice.map((name, i) => [Markup.button.callback(name, `cat:${slotCode}:${p}:${i}`)]);
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push(Markup.button.callback('« Назад', `catnav:${slotCode}:${p-1}`));
    if (p < pages-1) nav.push(Markup.button.callback('Вперед »', `catnav:${slotCode}:${p+1}`));
    if (nav.length) rows.push(nav);
  }
  rows.push([Markup.button.callback('❌ Скасувати', 'cancel')]);
  return Markup.inlineKeyboard(rows);
}

function buildDecksByCategoryKeyboard(decks, page=0, perPage=8, slotCode='s1') {
  const total = decks.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(0, Math.min(page, pages-1));
  const slice = decks.slice(p*perPage, p*perPage + perPage);

  const rows = slice.map((name, i) => [Markup.button.callback(name, `deck:${slotCode}:${p}:${i}`)]);
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push(Markup.button.callback('« Назад', `decknav:${slotCode}:${p-1}`));
    if (p < pages-1) nav.push(Markup.button.callback('Вперед »', `decknav:${slotCode}:${p+1}`));
    if (nav.length) rows.push(nav);
  }
  rows.push([Markup.button.callback('❌ Скасувати', 'cancel')]);
  return Markup.inlineKeyboard(rows);
}


// ===== Commands =====
bot.start((ctx) => ctx.reply('Привіт! /help — довідка. Спершу задай нік: /setnick <нік>'));
bot.help((ctx) => ctx.reply([
  'Команди:',
  '/setnick <нік> — встановити або змінити свій нік (рядок у стовпчику “Наші гравці”).',
  '/showme [нік] — показує ваші (або вказаного ніку) 6 колод: 1, 2, 3, Боги, 1 резервна, 2 резервна.',
  '/fight — підбір цілі з «Планування» (видає 1 ціль за виклик). Враховує дозволи (F) і відмічає удар в Y/Z/AA/AB та H.',
  '/enemies — показує всі цілі з «Планування» (будівля → гравці та їх колоди), читаємо з 3-го рядка.',
  '/id — показати chatId/userId/threadId.',

  '',
  'Оновлення колоди:',
  '/deck — майстер: слот → фракція → колода  → сила.',
  '  Приклади: /deck_1_Легіон_333000 · /deck_4_Дикий_Ліс_1,1 · /deck_5_Орден_200,5',
  '  Правила сили: з десятковою — <100 → M; 100–999 → K; ≥1000 → як є; також суфікси K/M.',
  '/deck_set <1-6> <фракція> <сила> — пряме оновлення зі списком data!B.',

  '',
  'Слоти: 1, 2, 3, 4, боги 1 (5), боги 2 (6).',
  'Фракції: лише зі списку (data!B:B).',
  'Формат відображення сили: 350000 → 350K, 2000000 → 2M.'
].join('\n')));

bot.command('id', (ctx) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? '—';
  return ctx.reply(`chatId: ${chatId}\nuserId: ${userId}\nthreadId: ${threadId}`);
});

// ----- setnick (whitelist from data!E) + унікальність ніку -----
bot.command('setnick', async (ctx) => {
  const requested = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!requested) return ctx.reply('Вкажи нік: /setnick <нік>');

  const allowed = await findAllowedNick(requested); // канонічний нік із data!E
  if (!allowed) {
    return ctx.reply('❌ Такого ніку немає у списку гравців.\nЗверніться до адміністратора для добавлення вас в список гравців.');
  }

  // Перевірка: чи не зайнятий цей нік іншим користувачем
  const ownerUid = findUserIdByNick(allowed);
  if (ownerUid && ownerUid !== ctx.from.id) {
    return ctx.reply(`❌ Нік «${allowed}» уже зайнятий іншим гравцем.\nЯкщо це помилка — зверніться до координатора.`);
  }

  // Якщо нік уже прив’язаний до цього ж користувача — просто підтвердимо
  const currentNick = getNickByUserId(ctx.from.id);
  if (currentNick && currentNick.toLowerCase() === allowed.toLowerCase()) {
    // гарантуємо, що рядок у таблиці існує
    let row = await findRowByNick(allowed);
    if (!row) row = await appendPlayerRow(allowed);
    return ctx.reply(`✅ Нік уже прив’язаний: ${allowed}\nТепер /showme — щоб подивитись що в базі є і потім /deck щоб оновити колоду.`);
  }

  // Прив’язуємо нік до цього userId
  setNickForUser(ctx.from.id, allowed);

  // Гарантуємо рядок у "Наші колоди"
  let row = await findRowByNick(allowed);
  if (!row) row = await appendPlayerRow(allowed);

  return ctx.reply(`✅ Нік збережено: ${allowed}\nТепер /deck — щоб оновити колоду.`);
});

// ----- Deck wizard (/deck) -----
bot.command('deck', async (ctx) => {
  const nick = getNickByUserId(ctx.from.id);
  if (!nick) return ctx.reply('Спершу встанови нік: /setnick <нік>');
  sessions.set(ctx.from.id, { step: 'choose' });
  await ctx.reply('Оберіть, що оновлюємо:', buildDeckWizardKeyboard());
});


bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const uid = ctx.from.id;
  const sess = sessions.get(uid) || {};

  // Пагінація списку
if (data.startsWith('nfnav:')) {
  if (!requireCoordinator(ctx)) return ctx.answerCbQuery();
  const s = nofightSessions.get(ctx.from.id);
  if (!s) return ctx.answerCbQuery();

  const page = parseInt(data.split(':')[1], 10) || 0;
  s.page = page;
  nofightSessions.set(ctx.from.id, s);

  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(buildNoFightKeyboard(s.items, s.selected, s.page, 8).reply_markup);
  return;
}

// Тогл елемента
if (data.startsWith('nftoggle:')) {
  if (!requireCoordinator(ctx)) return ctx.answerCbQuery();
  const s = nofightSessions.get(ctx.from.id);
  if (!s) return ctx.answerCbQuery();

  const [, pageStr, idxStr] = data.split(':');
  const page = parseInt(pageStr, 10) || 0;
  const idx  = parseInt(idxStr, 10) || 0;
  const perPage = 8;

  const real = s.items[page * perPage + idx];
  if (!real) { await ctx.answerCbQuery('Нема такого'); return; }

  if (s.selected.has(real.row)) s.selected.delete(real.row);
  else s.selected.add(real.row);

  nofightSessions.set(ctx.from.id, s);

  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(buildNoFightKeyboard(s.items, s.selected, page, 8).reply_markup);
  return;
}

// Очистити вибір (нічого не ставити/прибрати всі)
if (data === 'nfclear') {
  if (!requireCoordinator(ctx)) return ctx.answerCbQuery();
  const s = nofightSessions.get(ctx.from.id);
  if (!s) return ctx.answerCbQuery();

  s.selected = new Set();
  nofightSessions.set(ctx.from.id, s);

  await ctx.answerCbQuery('Вибір очищено');
  await ctx.editMessageReplyMarkup(buildNoFightKeyboard(s.items, s.selected, s.page, 8).reply_markup);
  return;
}

// Застосувати: виставити M="dont touch" для вибраних і зняти для решти, що були відмічені раніше
if (data === 'nfapply') {
  if (!requireCoordinator(ctx)) return ctx.answerCbQuery();
  const s = nofightSessions.get(ctx.from.id);
  if (!s) return ctx.answerCbQuery();

  const toSet   = Array.from(s.selected);
  const toClear = Array.from(s.prevSelected).filter(r => !s.selected.has(r));

  try {
    await updateNoFightFlags({ setRows: toSet, clearRows: toClear });
    nofightSessions.delete(ctx.from.id);

    await ctx.answerCbQuery('Збережено');
    const setNames = s.items.filter(it => s.selected.has(it.row)).map(it => it.name);
    const clrNames = s.items.filter(it => s.prevSelected.has(it.row) && !s.selected.has(it.row)).map(it => it.name);

    await ctx.editMessageText(
      [
        '✅ Застосовано.',
        setNames.length ? `Поставлено "dont touch" для: ${setNames.join(', ')}` : '(без нових позначок)',
        clrNames.length ? `Знято "dont touch" для: ${clrNames.join(', ')}` : ''
      ].filter(Boolean).join('\n')
    );
  } catch (e) {
    console.error('nfapply error', e);
    await ctx.answerCbQuery('Помилка');
    await ctx.reply('❌ Не вдалося оновити data!M. Перевір доступ/діапазони.');
  }
  return;
}

  if (data === 'cancel') {
  sessions.delete(uid);
  // додати:
  if (typeof nofightSessions !== 'undefined') {
    nofightSessions.delete(uid);
  }
  await ctx.answerCbQuery('Скасовано');
  try { await ctx.editMessageText('❌ Скасовано.'); } catch (_) {}
  return;
}


  // ВИБІР СЛОТА
  if (data.startsWith('slot:')) {
    const code = data.split(':')[1];

      // 4 звичайні колоди — ТЕПЕР ПО-НОВОМУ
  const normalCodes = { s1: {index:1,label:'Колода 1'}, s2:{index:2,label:'Колода 2'}, s3:{index:3,label:'Колода 3'}, s4:{index:4,label:'Колода 4'} };
  if (normalCodes[code]) {
    const slot = normalCodes[code];

    // 1) список "фракцій/груп" із data!I:I (без "Боги")
    let categories = await getDeckCategories();
    categories = categories.filter(x => (x || '').toLowerCase() !== 'боги');
    if (!categories.length) {
      await ctx.answerCbQuery();
      return ctx.reply('❗ У списку груп (data!I) порожньо або лишилась тільки "Боги".');
    }

    sessions.set(uid, {
      step: 'normal_category',
      slotIndex: slot.index,
      slotLabel: slot.label,
      page: 0,
      categories
    });
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `Слот: ${slot.label}\nОберіть **фракцію/групу**:`,
      { parse_mode: 'Markdown', ...buildCategoriesKeyboard(categories, 0, 8, code) }
    );
    return;
  }


    // Вівтар
    if (code === 'altarG' || code === 'altarR') {
      const color = (code === 'altarG') ? 'green' : 'red';
      const label = (color === 'green') ? 'Вівтар зелений' : 'Вівтар червоний';
      sessions.set(uid, { step: 'altar_power', altarColor: color, altarLabel: label });
      await ctx.answerCbQuery();
      await ctx.editMessageText(`${label}\n\nВведи силу (числом) або 1,1 М / 200,5 К:`);
      return;
    }

    // Боги
    const godMap = { god1:1, god2:2, god3:3, god4:4 };
    if (godMap[code]) {
      const idx = godMap[code];
      sessions.set(uid, { step: 'god_power', godIndex: idx }); // ⬅️ одразу god_power
      await ctx.answerCbQuery();
      await ctx.editMessageText(`Бог ${idx}\n\nВведи силу **числом** або 1,1 М / 200,5 К:`, { parse_mode: 'Markdown' });
      return;
    }

    return ctx.answerCbQuery('Невідомий слот');
  }

// ПАГІНАЦІЯ груп
if (data.startsWith('catnav:')) {
  const [, code, pageStr] = data.split(':');
  const s = sessions.get(uid);
  if (!s || s.step !== 'normal_category') return ctx.answerCbQuery();
  const page = parseInt(pageStr, 10) || 0;
  s.page = page;
  sessions.set(uid, s);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(buildCategoriesKeyboard(s.categories, s.page, 8, code).reply_markup);
  return;
}
// Пагінація списку суперників
if (data.startsWith('setteamnav:')) {
  if (!requireCoordinator(ctx)) return ctx.answerCbQuery();
  const page = parseInt(data.split(':')[1], 10) || 0;

  let teams = await getAllowedEnemyGuilds();
  teams = Array.from(new Set(teams))
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'uk'));

  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(buildSetTeamKeyboard(teams, page, 8).reply_markup);
  return;
}

// Вибір конкретного суперника
if (data.startsWith('setteam:')) {
  if (!requireCoordinator(ctx)) return ctx.answerCbQuery();
  const [, pageStr, idxStr] = data.split(':');
  const page = parseInt(pageStr, 10) || 0;
  const idx  = parseInt(idxStr, 10) || 0;

  let teams = await getAllowedEnemyGuilds();
  teams = Array.from(new Set(teams))
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'uk'));

  const perPage = 8;
  const team = teams[page * perPage + idx];
  if (!team) {
    await ctx.answerCbQuery('Помилка вибору');
    return;
  }

  await setPlanningA1(team);
  await ctx.answerCbQuery(`Обрано: ${team}`);
  await ctx.editMessageText(`✅ Поточного суперника встановлено: *${team}*\nЗаписано у «Планування!A1».`, { parse_mode: 'Markdown' });
  return;
}

// ВИБІР групи
if (data.startsWith('cat:')) {
  const [, code, pageStr, idxStr] = data.split(':');
  const s = sessions.get(uid);
  if (!s || s.step !== 'normal_category') return ctx.answerCbQuery();

  const page = parseInt(pageStr, 10) || 0;
  const idx  = parseInt(idxStr, 10) || 0;
  const category = (s.categories[page * 8 + idx] || '').trim();
  if (!category) return ctx.answerCbQuery('Помилка вибору');

  // 2) Витягнути колоди для цієї групи (G за H=category)
  const decks = await getDecksByCategory(category);
  if (!decks.length) {
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      `Слот: ${s.slotLabel}\nФракція: ${category}\n\nДля цієї групи немає жодної колоди (data!G:H).`
    );
  }

  s.category = category;
  s.decks = decks;
  s.step = 'normal_deck';
  s.page = 0;
  sessions.set(uid, s);

  await ctx.answerCbQuery(`Фракція: ${category}`);
  await ctx.editMessageText(
    `Слот: ${s.slotLabel}\nФракція: ${category}\n\nОберіть **колоду**:`,
    { parse_mode: 'Markdown', ...buildDecksByCategoryKeyboard(decks, 0, 8, code) }
  );
  return;
}

// ПАГІНАЦІЯ колод
if (data.startsWith('decknav:')) {
  const [, code, pageStr] = data.split(':');
  const s = sessions.get(uid);
  if (!s || s.step !== 'normal_deck') return ctx.answerCbQuery();
  const page = parseInt(pageStr, 10) || 0;
  s.page = page;
  sessions.set(uid, s);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(buildDecksByCategoryKeyboard(s.decks, s.page, 8, code).reply_markup);
  return;
}


// ВИБІР конкретної колоди (G)
if (data.startsWith('deck:')) {
  const [, code, pageStr, idxStr] = data.split(':');
  const s = sessions.get(uid);
  if (!s || s.step !== 'normal_deck') return ctx.answerCbQuery();

  const page = parseInt(pageStr, 10) || 0;
  const idx  = parseInt(idxStr, 10) || 0;
  const deckName = (s.decks[page * 8 + idx] || '').trim();
  if (!deckName) return ctx.answerCbQuery('Помилка вибору');

  // записуємо вибрану назву колоди як "фракцію" для збереження
  s.faction = deckName;
  s.step = 'normal_power';
  sessions.set(uid, s);

  await ctx.answerCbQuery(deckName);
  await ctx.editMessageText(
    `Слот: ${s.slotLabel}\nФракція: ${s.category}\nКолода: ${deckName}\n\nВведи силу **числом** або 1,1 М / 200,5 К:`,
    { parse_mode: 'Markdown' }
  );
  return;
}


  // ВИБІР ФРАКЦІЇ для звичайної колоди
  if (data.startsWith('fac:')) {
    const [, code, pageStr, idxStr] = data.split(':');
    const s = sessions.get(uid);
    if (!s || s.step !== 'normal_faction') return ctx.answerCbQuery();
    const page = parseInt(pageStr, 10) || 0;
    const idx  = parseInt(idxStr, 10) || 0;
    const faction = (s.factions[page * 8 + idx] || '').trim();
    if (!faction) return ctx.answerCbQuery('Помилка вибору');

    s.faction = faction;
    s.step = 'normal_power';
    sessions.set(uid, s);

    await ctx.answerCbQuery(`Фракція: ${faction}`);
    await ctx.editMessageText(
      `Слот: ${s.slotLabel}\nФракція: ${faction}\n\nВведи силу **числом** або 1,1 М / 200,5 К:`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.answerCbQuery();
});

bot.on('text', async (ctx, next) => {
  // =====  A) /lose інтерактив  =====
  const ls = loseSessions.get(ctx.from.id);
  if (ls) {
    const reply = (m) => ctx.reply(m);
    const nick = ls.nick || getNickByUserId(ctx.from.id);
    if (!nick) {
      loseSessions.delete(ctx.from.id);
      return reply('Спершу /setnick <нік>.');
    }

    const msg = String(ctx.message?.text || '').trim();

    if (ls.step === 'await_deck') {
      const deckNo = parseInt(msg, 10);
      if (!(deckNo >= 1 && deckNo <= 4)) {
        return reply('Номер колоди має бути 1..4. Надішли лише число (напр., 3).');
      }
      ls.deckNo = deckNo;
      ls.step = 'await_cards';
      loseSessions.set(ctx.from.id, ls);
      return reply(
        `Колода №${deckNo}. Скільки **звичайних** карт ти виніс? (0..8)\n` +
        `Герой **не враховується** (він завжди останній).`
      );
    }

    if (ls.step === 'await_cards') {
      const killed = parseInt(msg, 10);
      if (!(killed >= 0 && killed <= 8)) {
        return reply('Вкажи число 0..8 (скільки звичайних карт знищено).');
      }
      const remain = Math.max(0, 100 - killed * 10); // герой не рахується

      try {
        // ⬇️ НОВА функція з sheets.js — див. розділ 2
        const res = await clearDestroyedAndSetRemain(nick, ls.deckNo, remain);
        loseSessions.delete(ctx.from.id);

        if (res.cleared > 0) {
          return reply(
            `✅ Зняв "знесли" і записав залишок **${remain}%** у колонку I.\n` +
            `Оновлені рядки: ${res.rows.join(', ')}.`
          );
        } else {
          return reply(
            `ℹ️ Не знайшов у «Плануванні» рядків для **${nick}** з колодою №${ls.deckNo}.\n` +
            `Переконайся, що у F=нік, у G=${ls.deckNo}, а в H було "знесли: ...".`
          );
        }
      } catch (e) {
        console.error('lose flow error', e);
        loseSessions.delete(ctx.from.id);
        return reply('❌ Не вдалося оновити «Планування». Перевір доступ і структуру аркуша.');
      }
    }

    // якщо ls був, але крок невідомий — приберемо його
    loseSessions.delete(ctx.from.id);
    return;
  }

  // =====  B) Майстер колод (sessions)  =====
  const s = sessions.get(ctx.from.id);
  if (!s) return next();

  const nick = getNickByUserId(ctx.from.id);
  if (!nick) {
    sessions.delete(ctx.from.id);
    return ctx.reply('Спершу /setnick <нік>.');
  }

  // 1) ЗВИЧАЙНА КОЛОДА: вводимо силу
  if (s.step === 'normal_power') {
    const power = parsePowerSmart(ctx.message.text);
    if (!isFinite(power) || power <= 0) {
      return ctx.reply('Сила має бути числом. Приклади: 333000 або 1,1 (це 1.1M) чи 200,5 (це 200.5K).');
    }

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
    return;
  }

  // 2) ВІВТАР: вводимо силу
  if (s.step === 'altar_power') {
    const power = parsePowerSmart(ctx.message.text);
    if (!isFinite(power) || power <= 0) {
      return ctx.reply('Сила має бути числом. Приклади: 333000 або 1,1 (це 1.1M) чи 200,5 (це 200.5K).');
    }

    await applyAltarUpdate({
      actor: ctx.from,
      chatId: ctx.chat?.id,
      nick,
      color: s.altarColor,
      label: s.altarLabel,
      power
    }, ctx);

    sessions.delete(ctx.from.id);
    return;
  }

 

  if (s.step === 'god_power') {
    const power = parsePowerSmart(ctx.message.text);
    if (!isFinite(power) || power <= 0) {
      return ctx.reply('Сила має бути числом. Приклади: 333000 або 1,1 (це 1.1M) чи 200,5 (це 200.5K).');
    }

    await applyGodPowerUpdate({
      actor: ctx.from,
      chatId: ctx.chat?.id,
      nick,
      godIndex: s.godIndex,   // 1..4
      power
    }, ctx);

    sessions.delete(ctx.from.id);
    return;
  }


  return next();
});


// ----- /deck_set <1-6> <faction> <power> -----
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

// ----- Quick /deck_<1-6>_<faction>_<power> -----
bot.hears(/^\/deck_(.+)$/i, async (ctx) => {
  try {
    const raw = ctx.match[1];
    const parts = raw.split('_').filter(Boolean);
    if (parts.length < 3) return ctx.reply('Формат: /deck_<1-6>_<фракція>_<сила>');

    const slotNum = parseInt(parts[0], 10);
    if (!(slotNum >= 1 && slotNum <= 6)) return ctx.reply('Номер слота має бути від 1 до 6.');

    const powerRaw = parts.pop();
    const factionRaw = parts.slice(1).join('_');

    const nick = getNickByUserId(ctx.from.id);
    if (!nick) return ctx.reply('Спершу /setnick <нік>.');

    const slot = SLOTS.find(s => s.index === slotNum);
    if (!slot) return ctx.reply('Невідомий слот. Доступні 1..6.');

    const factions = await getFactions();
    const match = factions.find(f => normalizeSpaces(f).toLowerCase() === normalizeSpaces(factionRaw).toLowerCase());
    if (!match) {
      const preview = factions.slice(0, 20).join(', ');
      return ctx.reply('❌ Такої фракції немає у списку.\nСпробуй /deck або одну зі списку:\n' + preview + (factions.length > 20 ? '…' : ''));
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
    console.error('deck_fast error', e);
    return ctx.reply('Сталася помилка при встановленні колоди.');
  }
});

// ----- showme (4 звичайні + боги) -----
bot.command('showme', async (ctx) => {
  const argNick = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const nick = argNick || getNickByUserId(ctx.from.id);
  if (!nick) return ctx.reply('Вкажи нік: /showme <нік> або спершу зроби /setnick <нік>');

  const row = await findRowByNick(nick);
  if (!row) return ctx.reply('Такого гравця немає.');

  // читаємо до W (потрібні N..W для богів) — див. правку у sheets.js нижче
  const arr = await readRow(row);

  const get = (i) => (arr[i] ?? '').toString().trim();
  const getOrDash = (i) => get(i) || '—';

  // Звичайні колоди:
  // 1: B(1)+C(2), 2: D(3)+E(4), 3: F(5)+G(6), 4: H(7)+I(8)
  const f1 = getOrDash(1),  p1 = getOrDash(2);
  const f2 = getOrDash(3),  p2 = getOrDash(4);
  const f3 = getOrDash(5),  p3 = getOrDash(6);
  const f4 = getOrDash(7),  p4 = getOrDash(8);

  // Вівтар (блок богів): N(13)=зелений, O(14)=червоний
  const altarGreen = get(13);
  const altarRed   = get(14);

  // Перелік богів: пари P+Q (15,16), R+S (17,18), T+U (19,20), V+W (21,22)
  const godPairs = [
    { name: get(15), power: get(16) },
    { name: get(17), power: get(18) },
    { name: get(19), power: get(20) },
    { name: get(21), power: get(22) },
  ].filter(g => (g.name || g.power)); // показуємо тільки заповнені

  const lines = [
    `Колода 1 — ${f1} — сила ${fmtPowerShort(p1) || '—'}`,
    `Колода 2 — ${f2} — сила ${fmtPowerShort(p2) || '—'}`,
    `Колода 3 — ${f3} — сила ${fmtPowerShort(p3) || '—'}`,
    `Колода 4 — ${f4} — сила ${fmtPowerShort(p4) || '—'}`,
    '',
    '🛡️ Боги:',
    `Вівтар: зелений — ${altarGreen ? fmtPowerShort(altarGreen) : '—'}; червоний — ${altarRed ? fmtPowerShort(altarRed) : '—'}`,
    ...(godPairs.length
      ? godPairs.map((g, i) => `Бог ${i + 1} — ${g.name || '—'} — сила ${g.power ? fmtPowerShort(g.power) : '—'}`)
      : ['(немає даних про богів)']
    ),
  ];

  return ctx.reply(`👤 ${nick}\n` + lines.join('\n'));
});


// ----- enemies (from Planning A3:H) — показуємо лише ЖИВІ (status порожній) -----
bot.command('enemies', async (ctx) => {
  const rows = await getPlanTargetsDetailed(); // читає A3:H і повертає {building, player, deck, power, status, ...}
  // беремо лише живі
  const alive = rows.filter(r => isAliveStatus(r.status));

  if (!alive.length) {
    return ctx.reply('Зараз немає живих цілей у «Плануванні».');
  }

  // групуємо: Будівля -> Гравець -> [{deck, power}]
  const byBuilding = new Map();
  for (const r of alive) {
    const building = (r.building || '').trim() || '—';
    const player   = (r.player   || '').trim() || '—';
    const deck     = (r.deck     || '').trim() || '—';
    const power    = fmtPowerShort(r.power);

    if (!byBuilding.has(building)) byBuilding.set(building, new Map());
    const byPlayer = byBuilding.get(building);
    if (!byPlayer.has(player)) byPlayer.set(player, []);
    byPlayer.get(player).push({ deck, power });
  }

  const sections = [];
  for (const [building, byPlayer] of byBuilding) {
    const lines = [`🏰 ${building}`];
    const entries = Array.from(byPlayer.entries()).sort((a,b)=>a[0].localeCompare(b[0], 'uk'));
    for (const [player, items] of entries) {
      const list = items.map(it => `${it.deck} — сила ${it.power}`).join(' · ');
      lines.push(`— ${player}: ${list}`);
    }
    sections.push(lines.join('\n'));
  }
  sections.sort((a,b)=>a.localeCompare(b, 'uk'));

  let buf = '';
  for (const sec of sections) {
    const piece = (buf ? buf + '\n\n' : '') + sec;
    if (piece.length > 3500) { if (buf) await ctx.reply(buf); buf = sec; }
    else { buf = piece; }
  }
  if (buf) await ctx.reply(buf);
});

bot.command('look', async (ctx) => {
  if (!requireCoordinator(ctx)) return;

  const raw = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
  if (!raw) {
    return ctx.reply('Вкажи будівлю: /look <назва>\nПриклад: /look Бібліотека');
  }

  const norm = (s) => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const buildings = await getAllowedBuildings(); // data!A2:A20
  const match = buildings.find(b => norm(b) === norm(raw));

  if (!match) {
    const sample = buildings.slice(0, 10).join(', ');
    return ctx.reply('❌ Невідома будівля. Перевір назву у data!A.\nПриклади: ' + sample + (buildings.length > 10 ? '…' : ''));
  }

  const rows = await getPlanLookRows(match);
  if (!rows.length) return ctx.reply(`Для «${match}» записів не знайдено.`);

  const lines = rows.map(r => `Ціль (${r.goal}) - Виносить (${r.carrier})`);

  // проста відправка з невеликим чанкуванням (на всяк випадок)
  const header = `🏰 ${match}\n`;
  let buf = header;
  for (const line of lines) {
    const next = (buf ? buf + '\n' : '') + line;
    if (next.length > 3500) { // запас до ліміту TG
      await ctx.reply(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) await ctx.reply(buf);
});

// ----- /setteam — вибір поточного суперника (з data!D) і запис у Планування!A1 -----
bot.command(['setteam', 'Setteam'], async (ctx) => {
  if (!requireCoordinator(ctx)) return;
  try {
    let teams = await getAllowedEnemyGuilds();          // data!D:D
    teams = Array.from(new Set(teams))                  // унікально
      .map(s => String(s || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'uk'));

    if (!teams.length) return ctx.reply('❗ У data!D немає жодного значення.');

    await ctx.reply(
      'Оберіть поточного суперника (з початку дня):',
      buildSetTeamKeyboard(teams, 0, 8)
    );
  } catch (e) {
    console.error('/setteam error', e);
    return ctx.reply('❌ Помилка /setteam.');
  }
});

// ----- roles commands -----
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
  ctx.reply(`Власники: ${o}\nАдміни: ${a}\nКоординатори: ${c}\n\n(айді через кому)`);
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

// ----- enemy_set -----
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
// /info — витягує усі непорожні пари A+B з «Класифікація сил»
bot.command('info', async (ctx) => {
  try {
    await ctx.reply('⏳ Збираю інформацію…');
    const rows = await getClassificationInfo();
    if (!rows.length) return ctx.reply('Порожньо: у «Класифікація сил» немає даних в стовпцях A+B.');

    const lines = rows.map(r => `• ${r.a} — ${r.b}`).join('\n');
    for (const part of chunkText(lines)) {
      await ctx.reply(part);
    }
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ Помилка /info. Перевір доступ до аркуша «Класифікація сил».');
  }
});

bot.command('lose', async (ctx) => {
  try {
    const txt = (ctx.message?.text || '').trim();
    const parts = txt.split(/\s+/);

    const deckNo = parseInt(parts[1], 10);
    const nickArg = parts.slice(2).join(' ').trim();
    const nick = nickArg || getNickByUserId(ctx.from.id);
    if (!nick) return ctx.reply('Спершу встанови нік: /setnick <нік>.');

    if (!(deckNo >= 1 && deckNo <= 4)) {
      loseSessions.set(ctx.from.id, { step: 'await_deck', nick });
      return ctx.reply(
        'Вкажи **№ колоди (1–4)** з колонки G у «Плануванні», яка програла.\n' +
        'Приклад: просто надішли 4.'
      );
    }

    loseSessions.set(ctx.from.id, { step: 'await_cards', nick, deckNo });
    return ctx.reply(
      `Окей, ${nick}. Скільки **звичайних** карт ти виніс? (0..8)\n` +
      `Герой **не враховується** (він завжди останній). Напр.: "5".`
    );
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ Помилка /lose.');
  }
});



// /reserv — усі гравці без РОЗПОДІЛЕНИХ атак + їхні вільні колоди
// Формат: "гравець — фракція/тип сила; фракція/тип сила; ..."
bot.command('reserv', async (ctx) => {
  try {
    await ctx.reply('⏳ Рахую резерви…');
    const items = await getReservList();
    if (!items.length) return ctx.reply('🎉 Усі мають розподілені атаки.');

    const lines = items.map(p => {
      const decks = p.decks.length
        ? p.decks.map(d => `${d.faction}/${d.type} ${fmtPowerShort(d.power)}`).join('; ')
        : '—';
      return `${p.nick} — ${decks}`;
    }).join('\n');

    for (const part of chunkText(lines)) {
      await ctx.reply(part);
    }
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ Помилка /reserv.');
  }
});

bot.command('win', async (ctx) => {
  try {
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    const nick = getNickByUserId(ctx.from.id);
    if (!nick) return ctx.reply('Спершу встанови нік: /setnick <нік>.');

    const plan = await getPlanTargetsDetailed();

    // Якщо користувач передав номер рядка: /win 27
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
      const rowNum = parseInt(parts[1], 10);
      const r = plan.find(x => x.row === rowNum);
      if (!r) return ctx.reply(`Рядок ${rowNum} не знайдено у «Плануванні».`);
      if (!r.status || !/^видано/i.test(r.status)) {
        return ctx.reply(`У рядку ${rowNum} немає статусу «видано».`);
      }
      if (!r.status.toLowerCase().includes(nick.toLowerCase())) {
        return ctx.reply(`Рядок ${rowNum} «видано» не на тебе (${nick}).`);
      }

      const newStatus = r.status.replace(/^видано/i, 'знесли');
      await setPlanRowStatus(rowNum, newStatus);
      // (опц.) якщо хочеш одразу добивати — розкоментуй:
      // await setPlanRowRemainPercent(rowNum, 0);

      return ctx.reply(`✅ Готово! Рядок ${rowNum}: статус змінено на «знесли».`);
    }

    // Без номера — беремо останній «видано» на цього гравця
    const myIssued = plan
      .filter(r => r.status && /^видано/i.test(r.status) && r.status.toLowerCase().includes(nick.toLowerCase()))
      .sort((a, b) => b.row - a.row); // «останній» — з найбільшим номером рядка

    if (!myIssued.length) {
      return ctx.reply('Немає рядків зі статусом «видано» на тебе.');
    }

    const t = myIssued[0];
    const newStatus = t.status.replace(/^видано/i, 'знесли');
    await setPlanRowStatus(t.row, newStatus);
    // (опц.) добити залишок:
    // await setPlanRowRemainPercent(t.row, 0);

    return ctx.reply(`✅ Готово! Рядок ${t.row}: статус змінено на «знесли».`);
  } catch (e) {
    console.error('win error', e);
    return ctx.reply('Сталася помилка при оновленні статусу.');
  }
});

// .env (приклад)
// ASSIGN_WEBAPP_URL=https://script.google.com/macros/s/XXXX/exec
// ASSIGN_SECRET=your-long-secret
const ASSIGN_WEBAPP_URL = process.env.ASSIGN_WEBAPP_URL;
const ASSIGN_SECRET = process.env.ASSIGN_SECRET;

// (опційно) обмежити команду лише для координаторів
const ASSIGN_ADMINS = (process.env.ASSIGN_ADMINS || '').split(',').filter(Boolean);
// приклад: ASSIGN_ADMINS=12345678,987654321

bot.command('assign', async (ctx) => {
  try {
    // перевірка прав (опційно — прибери якщо не треба)
    if (ASSIGN_ADMINS.length && !ASSIGN_ADMINS.includes(String(ctx.from.id))) {
      return ctx.reply('⛔ Ця команда доступна лише координаторам.');
    }

    if (!ASSIGN_WEBAPP_URL || !ASSIGN_SECRET) {
      return ctx.reply('Не налаштовано ASSIGN_WEBAPP_URL / ASSIGN_SECRET.');
    }

    await ctx.reply('⏳ Запускаю розподіл цілей…');
    const res = await fetch(ASSIGN_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ASSIGN_SECRET })
    });

    let json = {};
    try { json = await res.json(); } catch {}

    if (res.ok && json.ok) {
      return ctx.reply('✅ Розподіл запущено. Перевіряйте «Планування» за хвилину.');
    } else {
      return ctx.reply(`❗ Не вдалось запустити розподіл. ${json.error ? 'Помилка: ' + json.error : ''}`);
    }
  } catch (e) {
    console.error('/assign error', e);
    return ctx.reply('Сталася помилка при виклику розподілу.');
  }
});

// /nofight — позначити будівлі як "dont touch" у data!M
bot.command(['nofight', 'Nofight'], async (ctx) => {
  if (!requireCoordinator(ctx)) return;
  try {
    let items = await getDataBuildingsKM(); // [{row,name,p1,p2}]
    if (!items.length) return ctx.reply('❗ У data!K немає переліку будівель.');

    // попередньо виділяємо ті, де вже стоїть "dont touch" у M
    const prev = new Set(
      items
        .filter(it => String(it.p2 || '').trim().toLowerCase() === 'dont touch')
        .map(it => it.row)
    );
    const sel = new Set(prev);

    nofightSessions.set(ctx.from.id, {
      items,
      selected: sel,
      prevSelected: prev, // щоб знати, що треба зняти при застосуванні
      page: 0
    });

    await ctx.reply(
      'Оберіть будівлі, які **не розписувати** (залишити на кінець):\n' +
      '— повертайтесь стрілками; ✅ — вибрано; натисніть «Застосувати», щоб зберегти.',
      { ...buildNoFightKeyboard(items, sel, 0, 8), parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('/nofight error', e);
    return ctx.reply('❌ Помилка /nofight.');
  }
});


// ----- Fight: /fight [N] -----
// Нова логіка: порт → одна з брам/бастіонів (фіксуємо у data!N2) → далі за пріоритетами з data!M
bot.command('fight', async (ctx) => {
  try {
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    const want = 1;
    // якщо користувач передав число ≠ 1 — просто підкажемо, але ігноруємо параметр
if (parts.length >= 2) {
  const n = parseInt(parts[1], 10);
  if (Number.isFinite(n) && n !== 1) {
    await ctx.reply('Зараз /fight видає лише 1 ціль. Повтори команду ще раз, щоб отримати наступну.');
  } else if (!Number.isFinite(n)) {
    await ctx.reply('Формат: /fight (без параметрів).');
  }
}

    const nick = getNickByUserId(ctx.from.id);
    if (!nick) return ctx.reply('Спершу встанови нік: /setnick <нік>.');

    const row = await findRowByNick(nick);
    if (!row) return ctx.reply('Твого ніку немає у листі «Наші колоди». Звернись до координаторів.');

    const plan = await getPlanTargetsDetailed();
    const alive = plan.filter(r => isAliveStatus(r.status));

    // 0) Якщо немає живих — нічого давати
    if (!alive.length) return ctx.reply('Зараз немає живих цілей у «Плануванні».');

    // 1) Перевіряємо порт
    const portAlive = alive.some(r => buildingGodKey(r.building) === 'порт');

    // 2) Стан активної брами/бастіону (data!N2)
    let activeGate = await getActiveGateKey();

    // 3) Живі "брами/бастіони"
    const gateKeys = new Set(['головні ворота', 'східний бастіон', 'західний бастіон']);
    const gatesAlive = alive.filter(r => gateKeys.has(buildingGodKey(r.building)));

    // 4) Пріоритети будівель із data!K:M (для фази після богів)
    const prioMap = await getBuildingPriorities();

    // 5) Визначаємо фазу і формуємо пул кандидатів
    let filtered = [];

    if (portAlive) {
      // ФАЗА 1: ПОРТ — видаємо лише порт
      filtered = alive.filter(r =>
        buildingGodKey(r.building) === 'порт' && includesNick(r.allowed, nick)
      );
    } else if (gatesAlive.length > 0) {
      // ФАЗА 2: БРАМИ/БАСТІОНИ
      // якщо активна ще не вибрана — перший гравець, який має призначення на будь-яку з трьох, «відкриває» її
      if (!activeGate) {
        const myGateRows = gatesAlive.filter(r => includesNick(r.allowed, nick));
        if (myGateRows.length > 0) {
          activeGate = buildingGodKey(myGateRows[0].building);
          await setActiveGateKey(activeGate);
        }
      } else {
        // якщо активна вибрана, але вже добита — очищаємо
        const stillAlive = gatesAlive.some(r => buildingGodKey(r.building) === activeGate);
        if (!stillAlive) {
          await setActiveGateKey('');
          activeGate = '';
        }
      }

      if (!activeGate) {
        // ніхто ще не «відкрив» конкретну браму/бастіон
        return ctx.reply(
          'Зараз відкривається одна з цілей: «Головні ворота» / «Східний бастіон» / «Західний бастіон».\n' +
          'Як тільки хтось із призначених на одну з них візьме удар (/fight), решта отримають саме її.'
        );
      }

      // даємо лише активну браму/бастіон
      filtered = gatesAlive.filter(r =>
        buildingGodKey(r.building) === activeGate && includesNick(r.allowed, nick)
      );
    } else {
      // ФАЗА 3: ПІСЛЯ БОГІВ — працюємо за пріоритетами з data!M
      // знаходимо мінімальний активний пріоритет серед ЖИВИХ
      const minPrio = alive.reduce((min, r) => {
        const p = getPriorityFor(prioMap, r.building, 'M');
        return Math.min(min, p);
      }, Number.POSITIVE_INFINITY);

      // беремо тільки будівлі з цим пріоритетом
      const tierRows = alive.filter(r => getPriorityFor(prioMap, r.building, 'M') === minPrio);

      // і серед них — лише ті, де гравець у дозволених (F)
      filtered = tierRows.filter(r => includesNick(r.allowed, nick));
    }

    if (!filtered.length) {
      return ctx.reply('Для тебе зараз немає доступних цілей у цій фазі.');
    }

    // 6) Роздати до want ударів + позначки
    const given = [];
    // Збережемо порядок як у "Плануванні" (можеш замінити на власне сортування)
    const candidates = filtered.slice();

    for (let i = 0; i < want; i++) {
      const usage = await getNextFreeUsageSlot(row);
      if (!usage) {
        if (i === 0) return ctx.reply('У тебе немає вільних ударів (усі 4 вже використано).');
        break;
      }
      const target = candidates.shift();
      if (!target) break;

      const deck = deckLabelFromInstr(target.deckInstr);
      const usedText = `${deck.label} → ${target.building}/${target.player}`;
      await setUsageSlotText(row, usage.index, usedText);

      const stamp = new Date().toLocaleString('uk-UA');
      await setPlanRowStatus(target.row, `видано: ${nick} (${deck.label}) ${stamp}`);
      
      // якщо інструкція каже бити 1..4 (звичайна), проставляємо F/G,
      // щоб /lose міг знайти рядок (шукає F=нік і G=№ колоди)
      const deckId = Number(deck.code);
if (Number.isInteger(deckId) && deckId >= 1 && deckId <= 4) {
  await setPlanRowAssigneeAndDeck(target.row, nick, deckId);
}


      given.push({
        building: target.building,
        player: target.player,
        deck: target.deck,
        power: target.power,
        deckLabel: deck.label,
      });
    }

    if (!given.length) {
      return ctx.reply('Немає вільних ударів або цілей для тебе.');
    }

    const lines = given.map((t, i) =>
      `${i + 1}) 🏰 ${t.building} — ${t.player} — ${t.deck} — сила ${fmtPowerShort(t.power)}\n` +
      `   Бий: ${t.deckLabel}`
    );

    const header = `👤 Запит від: ${nick} • видано ударів: ${given.length}`;
    await ctx.reply(`${header}\n\n${lines.join('\n\n')}`);
  } catch (e) {
    console.error('fight error', e);
    return ctx.reply('Сталася помилка при підборі цілей.');
  }
});

function isAliveStatus(status) {
  return String(status || '').trim() === '';
}

function findUserIdByNick(nick) {
  const norm = String(nick || '').trim().toLowerCase();
  for (const [uid, n] of Object.entries(USERS)) {
    if (String(n || '').trim().toLowerCase() === norm) {
      return Number(uid);
    }
  }
  return null;
}

// ----- Shared deck update -----
async function applyDeckUpdate(payload, ctx) {
  const { actor, chatId, nick, slotIndex, slotLabel, newFaction, newPower } = payload;

  let row = await findRowByNick(nick);
  if (!row) row = await appendPlayerRow(nick);

  const before = await readRow(row);
  const posFaction = 1 + (slotIndex - 1) * 2; // B=1, D=3, F=5, H=7
  const posPower   = posFaction + 1;          // C=2, E=4, G=6, I=8

  const oldFaction = before[posFaction] || '';
  const oldPower   = before[posPower] || '';

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

const nofightSessions = new Map(); // сесії мультивибору /nofight

function buildNoFightKeyboard(items, selectedSet, page = 0, perPage = 8) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(0, Math.min(page, pages - 1));
  const slice = items.slice(p * perPage, p * perPage + perPage);

  const rows = slice.map((it, i) => {
    const picked = selectedSet.has(it.row);
    const label = (picked ? '✅ ' : '▫️ ') + it.name;
    return [ Markup.button.callback(label, `nftoggle:${p}:${i}`) ];
  });

  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push(Markup.button.callback('« Назад',  `nfnav:${p - 1}`));
    if (p < pages - 1) nav.push(Markup.button.callback('Вперед »', `nfnav:${p + 1}`));
    if (nav.length) rows.push(nav);
  }

  rows.push([
    Markup.button.callback('✅ Застосувати', 'nfapply'),
    Markup.button.callback('🧹 Очистити вибір', 'nfclear')
  ]);
  rows.push([ Markup.button.callback('❌ Скасувати', 'cancel') ]);
  return Markup.inlineKeyboard(rows);
}


// ----- Altar update (N/O) -----
async function applyAltarUpdate(payload, ctx) {
  const { actor, chatId, nick, color, label, power } = payload;

  let row = await findRowByNick(nick);
  if (!row) row = await appendPlayerRow(nick);

  const arr = await readRow(row);
  const oldPower = (color === 'green') ? (arr[13] || '') : (arr[14] || ''); // N(13), O(14) 0-based

  await appendArchive({
    actorUserId: actor.id,
    actorUsername: actor.username || actor.first_name || '',
    playerNick: nick,
    slot: label,
    oldFaction: label,
    oldPower,
    newFaction: label,
    newPower: power,
    chatId
  });

  await updateAltar(row, color, power);

  await ctx.reply([
    `✅ Оновлено для **${nick}**`,
    `${label}: ${oldPower || '—'} → **${power}**`
  ].join('\n'), { parse_mode: 'Markdown' });
}

async function applyGodPowerUpdate(payload, ctx) {
  const { actor, chatId, nick, godIndex, power } = payload;

  let row = await findRowByNick(nick);
  if (!row) row = await appendPlayerRow(nick);

  const arr = await readRow(row);
  const map = {
    1: { powerIdx: 16, label: 'Аква' }, // Q (0-based)
    2: { powerIdx: 18, label: 'Гея' }, // S
    3: { powerIdx: 20, label: 'Марок' }, // U
    4: { powerIdx: 22, label: 'Кхас' }, // W
  };
  const meta = map[godIndex];
  const oldPower = arr[meta.powerIdx] || '';

  // архів — фіксуємо лише зміну сили
  await appendArchive({
    actorUserId: actor.id,
    actorUsername: actor.username || actor.first_name || '',
    playerNick: nick,
    slot: meta.label,
    oldFaction: meta.label,
    oldPower,
    newFaction: meta.label,
    newPower: power,
    chatId
  });

  // пишемо тільки силу, без назви
  await updateGodPower(row, godIndex, power);

  await ctx.reply([
    `✅ Оновлено для **${nick}**`,
    `${meta.label}: ${oldPower || '—'} → **${power}**`,
  ].join('\n'), { parse_mode: 'Markdown' });
}


function canonName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Повертає ключ групи для "богів"
function buildingGodKey(name) {
  const s = canonName(name);
  if (/^порт(\b|$)/.test(s)) return 'порт';
  if (/^головн\w*\s*ворота/.test(s)) return 'головні ворота';
  if (/^східн\w*\s*бастіон/.test(s)) return 'східний бастіон';
  if (/^західн\w*\s*бастіон/.test(s)) return 'західний бастіон';
  if (/^лаборатор/.test(s)) return 'лабораторія';
  return '';
}

function isGodBuilding(name) {
  return !!buildingGodKey(name);
}


function chunkText(text, size = 3800) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}


// ----- God update (P–W) -----
async function applyGodUpdate(payload, ctx) {
  const { actor, chatId, nick, godIndex, godName, power } = payload;

  let row = await findRowByNick(nick);
  if (!row) row = await appendPlayerRow(nick);

  const arr = await readRow(row);
  const map = {
    1: { nameIdx: 15, powerIdx: 16, label: 'Аква' }, // P,Q (0-based)
    2: { nameIdx: 17, powerIdx: 18, label: 'Гея' }, // R,S
    3: { nameIdx: 19, powerIdx: 20, label: 'Марок' }, // T,U
    4: { nameIdx: 21, powerIdx: 22, label: 'Кхас' }, // V,W
  };
  const meta = map[godIndex];
  const oldName  = arr[meta.nameIdx]  || '';
  const oldPower = arr[meta.powerIdx] || '';

  await appendArchive({
    actorUserId: actor.id,
    actorUsername: actor.username || actor.first_name || '',
    playerNick: nick,
    slot: meta.label,
    oldFaction: oldName,
    oldPower,
    newFaction: godName,
    newPower: power,
    chatId
  });

  await updateGod(row, godIndex, godName, power);

  await ctx.reply([
    `✅ Оновлено для **${nick}**`,
    `${meta.label}:`,
    `Назва: ${oldName || '—'} → **${godName}**`,
    `Сила: ${oldPower || '—'} → **${power}**`,
  ].join('\n'), { parse_mode: 'Markdown' });
}

function buildSetTeamKeyboard(teams, page = 0, perPage = 8) {
  const total = teams.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(0, Math.min(page, pages - 1));
  const slice = teams.slice(p * perPage, p * perPage + perPage);

  const rows = slice.map((name, i) => [
    Markup.button.callback(name, `setteam:${p}:${i}`)
  ]);

  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push(Markup.button.callback('« Назад',  `setteamnav:${p - 1}`));
    if (p < pages - 1) nav.push(Markup.button.callback('Вперед »', `setteamnav:${p + 1}`));
    if (nav.length) rows.push(nav);
  }

  rows.push([Markup.button.callback('❌ Скасувати', 'cancel')]);
  return Markup.inlineKeyboard(rows);
}


// ===== Launch =====
bot.launch();
console.log('Guild bot is running (polling)…');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
