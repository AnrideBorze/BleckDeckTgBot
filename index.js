// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

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
} = require('./sheets');


// ===== Обмеження одним чатом (опційно) =====
const ALLOWED_CHAT_ID = (process.env.ALLOWED_CHAT_ID || '').trim();
const ALLOWED_TOPIC_ID = (process.env.ALLOWED_TOPIC_ID || '').trim();

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

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 9000 });

// Глобальний фільтр
bot.use((ctx, next) => {
  // 1) Чат
  const chatId = getUpdateChatId(ctx);
  if (ALLOWED_CHAT_ID && String(chatId) !== ALLOWED_CHAT_ID) {
    return; // ігноруємо будь-що не з нашого чату
  }

  // 2) Гілка (лише якщо в .env задано ALLOWED_TOPIC_ID)
  if (ALLOWED_TOPIC_ID) {
    const threadId = getUpdateThreadId(ctx);
    // У форумних супергрупах усі повідомлення мають message_thread_id.
    if (String(threadId) !== ALLOWED_TOPIC_ID) {
      return; // не наша гілка — ігноруємо
    }
  }

  return next();
});


// ===== Зберігаємо мапу "tgUserId -> nick" локально =====
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}), 'utf8');

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}
let USERS = loadUsers();
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(USERS, null, 2), 'utf8');
}
function getNickByUserId(uid) {
  return USERS[String(uid)] || null;
}
function setNickForUser(uid, nick) {
  USERS[String(uid)] = nick.trim();
  saveUsers();
}

bot.command('fight', async (ctx) => {
  const t = await getRandomFightTarget();
  if (!t) return ctx.reply('У плануванні поки що немає цілей.');

  // відповідаємо одним рядком, як просив
  return ctx.reply(`🎯 ${t.building} — ${t.player} — ${t.deck} — сила ${fmtPowerShort(t.power)}`);
});


// ===== Слоти колод =====
// UX-назви кнопок і номер слота (1..6)
const SLOTS = [
  { code: 's1', label: '1', index: 1 },
  { code: 's2', label: '2', index: 2 },
  { code: 's3', label: '3', index: 3 },
  { code: 'god', label: 'Боги', index: 4 },
  { code: 'r1', label: '1 резервна', index: 5 },
  { code: 'r2', label: '2 резервна', index: 6 }
];
const CODE2SLOT = Object.fromEntries(SLOTS.map(s => [s.code, s]));

// ===== Сесії для “майстра” вибору =====
const sessions = new Map(); // key: userId -> { step, slotIndex, faction, page }

// ===== Допоміжні =====
function toIntStrict(str) {
  const s = String(str || '').replace(/[^\d]/g, '');
  if (!s) return NaN;
  // тільки ціле, без дробів
  return parseInt(s, 10);
}

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

// ===== Команди =====
bot.start((ctx) => ctx.reply('Привіт! /help — довідка. Спершу задай нік: /setnick <нік>'));
bot.help((ctx) => ctx.reply([
  'Команди:',
  '/setnick <нік> — встановити або змінити свій нік (рядок у стовпчику “Наші гравці”).',
  '/showme [нік] — показує ваші (або вказаного ніку) 6 колод: 1, 2, 3, Боги, 1 резервна, 2 резервна.',
  '/fight — дає випадкову ціль з “Планування”.',
  '/enemies — показує всі цілі з “Планування” (будівля → гравці та їх колоди).',
  '/id — показати chatId/userId.',

  '',
  'Оновлення колоди:',
  '/deck — майстер з кнопками (обираєш слот → фракція зі списку data!B → сила).',
  '/deck_<1-6>_<фракція>_<сила> — швидко без пробілів. "_" = пробіл у назві фракції.',
  '  Приклади: /deck_1_Легіон_333000 · /deck_4_Дикий_Ліс_1,1 · /deck_5_Орден_200,5',
  '  Правила сили: з десятковою частиною —',
  '    < 100  → мільйони (1,1 = 1.1M = 1100000)',
  '    100–999 → тисячі (200,5 = 200.5K = 200500)',
  '    ≥ 1000  → як є (ціле число). Також приймаються суфікси K/M.',
  '/deck_set <слот> <фракція> <сила> — альтернатива. Фракція має існувати в списку data!B.',

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
  if (!requested) {
    return ctx.reply('Вкажи нік: /setnick <нік>');
  }

  // 1) Перевіряємо у вайтлисті data!E:E
  const allowed = await findAllowedNick(requested);
  if (!allowed) {
    return ctx.reply('❌ Такого ніку немає у списку гравців.\nЗверніться до адміністратора для добавлення вас в список гравців.');
  }

  // 2) Прив’язуємо саме канонічний нік з таблиці
  setNickForUser(ctx.from.id, allowed);

  // 3) Гарантуємо рядок у "Наші колоди"
  let row = await findRowByNick(allowed);
  if (!row) row = await appendPlayerRow(allowed);

  return ctx.reply(`✅ Нік збережено: ${allowed}\nТепер /deck — щоб оновити колоду.`);
});

bot.command('deck_set', async (ctx) => {
  const args = ctx.message.text.slice('/deck_set'.length).trim();
  if (!args) {
    return ctx.reply('Формат: /deck_set <слот> <фракція> <сила>\nНапр.: /deck_set "Боги" Легіон 333000');
  }

  // 1) Парсимо: поважаємо лапки і пробіли у фракції
  // Приклад: /deck_set "1 резервна" "Дикий Ліс" 250000
  // Або без лапок: /deck_set Боги Легіон 333000
  const tokens = args.match(/"[^"]+"|\S+/g) || [];
  if (tokens.length < 3) {
    return ctx.reply('Формат: /deck_set <слот> <фракція> <сила>\nНапр.: /deck_set 1 Легіон 333000');
  }

  const strip = (s) => s.replace(/^"+|"+$/g, '');
  const slotLabel = strip(tokens[0]);
  const powerStr = tokens[tokens.length - 1];
  const factionInput = strip(tokens.slice(1, -1).join(' ')).trim();

  const power = toIntStrict(powerStr);
  if (!power || isNaN(power)) {
    return ctx.reply('Сила має бути цілим числом без дробів. Напр.: 333000');
  }

  const nick = getNickByUserId(ctx.from.id);
  if (!nick) return ctx.reply('Спершу /setnick <нік>.');

  // 2) Перевірка слота
  const slot = SLOTS.find(s => s.label.toLowerCase() === slotLabel.toLowerCase());
  if (!slot) {
    return ctx.reply('Невідомий слот. Доступні: 1, 2, 3, Боги, 1 резервна, 2 резервна.');
  }

  // 3) Перевірка фракції по списку з data!B:B
  const factions = await getFactions(); // масив унікальних назв
  const match = factions.find(f => f.toLowerCase() === factionInput.toLowerCase());
  if (!match) {
    // підкажемо кілька варіантів зі списку
    const preview = factions.slice(0, 20).join(', ');
    return ctx.reply(
      '❌ Такої фракції немає у списку.\n' +
      'Використай одну зі списку або запусти майстер /deck:\n' +
      preview + (factions.length > 20 ? '…' : '')
    );
  }

  // 4) Оновлення
  await applyDeckUpdate({
    actor: ctx.from,
    chatId: ctx.chat?.id,
    nick,
    slotIndex: slot.index,
    slotLabel: slot.label,
    newFaction: match,   // ← тільки з офіційного списку
    newPower: power
  }, ctx);
});

bot.command('showme', async (ctx) => {
  // /showme <нік> — якщо нік не передали, беремо прив'язаний через /setnick
  const argNick = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const nick = argNick || getNickByUserId(ctx.from.id);
  if (!nick) {
    return ctx.reply('Вкажи нік: /showme <нік> або спершу зроби /setnick <нік>');
  }

  // шукаємо рядок у "Наші колоди"
  const row = await findRowByNick(nick);
  if (!row) {
    return ctx.reply('Такого гравця немає.');
  }

  // читаємо рядок: A(нік), далі парами: [B=f1,C=p1,D=f2,E=p2,F=f3,G=p3,H=f4,I=p4,J=f5,K=p5,L=f6,M=p6]
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


// Показати всі колоди противників з аркуша "Планування"
bot.command('enemies', async (ctx) => {
  const rows = await getPlanTargets();
  if (!rows || rows.length === 0) {
    return ctx.reply('У «Плануванні» поки що немає цілей.');
  }

  // Групуємо: Будівля -> Гравець -> масив {deck, power}
  const byBuilding = new Map();
  for (const r of rows) {
    const building = (r.building || '').toString().trim() || '—';
    const player   = (r.player   || '').toString().trim() || '—';
    const deck     = (r.deck     || '').toString().trim() || '—'; // у твоєму описі це "фракція/колода"
    const power    = (r.power    || '').toString().trim() || '—';

    if (!byBuilding.has(building)) byBuilding.set(building, new Map());
    const byPlayer = byBuilding.get(building);
    if (!byPlayer.has(player)) byPlayer.set(player, []);
    byPlayer.get(player).push({ deck, power });
  }

  // Формуємо секції по будівлях
  const sections = [];
  for (const [building, byPlayer] of byBuilding) {
    const lines = [`🏰 ${building}`];
    // необовʼязково: сортуємо гравців всередині будівлі
    const entries = Array.from(byPlayer.entries()).sort((a, b) => a[0].localeCompare(b[0], 'uk'));
    for (const [player, items] of entries) {
      const list = items.map(it => `${it.deck} — сила ${fmtPowerShort(it.power)}`).join(' · ');
      lines.push(`— ${player}: ${list}`);
    }
    sections.push(lines.join('\n'));
  }

  // Сортуємо будівлі за назвою (необовʼязково)
  sections.sort((a, b) => a.localeCompare(b, 'uk'));

  // Надсилаємо порціями, щоб не перевищити ліміт 4096 символів
  let buf = '';
  for (const sec of sections) {
    const piece = (buf ? buf + '\n\n' : '') + sec;
    if (piece.length > 3500) {
      if (buf) await ctx.reply(buf);
      buf = sec;
    } else {
      buf = piece;
    }
  }
  if (buf) await ctx.reply(buf);
});


function normalizeInt(x) {
  if (x == null) return null;
  const s = String(x).replace(/[^\d]/g, ''); // прибираємо пробіли/коми
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function fmtPowerShort(x) {
  const n = typeof x === 'number' ? x : normalizeInt(x);
  if (n == null) return (x == null || x === '') ? '—' : String(x);

  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    const s = (v % 1 === 0) ? String(v) : v.toFixed(2).replace(/\.?0+$/,'');
    return s + 'M';
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    const s = (v % 1 === 0) ? String(v) : v.toFixed(1).replace(/\.?0+$/,'');
    return s + 'K';
  }
  return String(n);
}

// ==== Хелпери для нормалізації фракції та сили ====
function normalizeSpaces(s) {
  return String(s || '')
    .replace(/_/g, ' ')          // в команді роздільник — підкреслення
    .replace(/\s+/g, ' ')
    .trim();
}

// шукає точний збіг фракції (без регістру, з нормалізацією пробілів/підкреслень)
async function pickFactionOrNull(input) {
  const factions = await getFactions();
  const norm = normalizeSpaces(input).toLowerCase();
  const match = factions.find(f => normalizeSpaces(f).toLowerCase() === norm);
  return { match, factions };
}

// Розбір сили за правилами:
//  - якщо є десяткова частина: <100 => М, 100..999 => К, >=1000 => як є
//  - якщо без десяткової — як є (ціле)
//  - також підтримка суфіксів k/m (опціонально)
function parsePowerSmart(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim().toLowerCase().replace(/\s+/g, '');

  // приймаємо також k/m суфікси
  if (/[kmмк]$/.test(s)) {
    const num = parseFloat(s.replace(/[^\d.,]/g, '').replace(',', '.'));
    if (!isFinite(num)) return NaN;
    if (/[mм]$/.test(s)) return Math.round(num * 1_000_000);
    if (/[kк]$/.test(s)) return Math.round(num * 1_000);
  }

  // звичайні числа з/без десяткової
  const hasDec = /[.,]/.test(s);
  const val = parseFloat(s.replace(',', '.'));
  if (!isFinite(val)) return NaN;

  if (hasDec) {
    if (val < 100) return Math.round(val * 1_000_000);       // 1,1 => 1.1M
    if (val < 1000) return Math.round(val * 1_000);          // 200,5 => 200.5K
    return Math.round(val);                                   // 1234,5 => 1235
  } else {
    // без десяткової — абсолют
    return Math.round(val);
  }
}

// Швидка команда без пробілів: /deck_<1-6>_<фракція>_<сила>
// приклади: /deck_1_Легіон_333000
//           /deck_4_Дикий_Ліс_1,1
//           /deck_5_Орден_200,5
bot.hears(/^\/deck_(\d)(?:@[\w_]+)?_([^_]+)_(.+)$/i, async (ctx) => {
  try {
    const slotNum = parseInt(ctx.match[1], 10);
    if (!(slotNum >= 1 && slotNum <= 6)) {
      return ctx.reply('Номер слота має бути від 1 до 6.');
    }

    const factionRaw = ctx.match[2];
    const powerRaw = ctx.match[3];

    const { match: faction, factions } = await pickFactionOrNull(factionRaw);
    if (!faction) {
      const preview = factions.slice(0, 20).join(', ');
      return ctx.reply(
        '❌ Такої фракції немає у списку.\n' +
        'Використай одну зі списку або запусти майстер /deck.\n' +
        preview + (factions.length > 20 ? '…' : '')
      );
    }

    const power = parsePowerSmart(powerRaw);
    if (!isFinite(power) || power <= 0) {
      return ctx.reply('❌ Невірна сила. Приклад: 333000 або 1,1 (це 1.1М) чи 200,5 (це 200.5К).');
    }

    const nick = getNickByUserId(ctx.from.id);
    if (!nick) return ctx.reply('Спершу /setnick <нік>.');

    const slot = SLOTS.find(s => s.index === slotNum);
    if (!slot) return ctx.reply('Невідомий слот. Доступні 1-6.');

    await applyDeckUpdate({
      actor: ctx.from,
      chatId: ctx.chat?.id,
      nick,
      slotIndex: slot.index,
      slotLabel: slot.label,
      newFaction: faction, // тільки зі списку
      newPower: power
    }, ctx);
  } catch (e) {
    console.error('deck_fast error', e);
    return ctx.reply('Сталася помилка при встановленні колоди.');
  }
});


// ===== Запуск =====
bot.launch();
console.log('Guild bot is running (polling)…');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
