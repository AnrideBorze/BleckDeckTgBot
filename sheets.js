// sheets.js
const fs = require('fs');
const { google } = require('googleapis');
google.options({ timeout: 300000 });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1CiIVg4aOmNL96cEkrgkrsaQ2mDIonGdrKOlrHDruAb0';
const SHEET_DECKS   = 'Наші колоди';
const SHEET_ARCHIVE = 'Архів колод';
const SHEET_DATA    = 'data';
const SHEET_PLAN    = process.env.SHEET_PLAN || 'Планування';
const SHEET_ENEMIES = process.env.SHEET_ENEMIES || 'Колоди противників';
const SHEET_CLASS  = process.env.SHEET_CLASS || 'Класифікація сил';
const SHEET_STATS = process.env.SHEET_STATS || 'Статистика';

// ---------- Auth ----------
async function getAuth() {
  const keyFile = process.env.GOOGLE_SA_KEY_FILE || 'credentials/service-account.json';
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

  if (fs.existsSync(keyFile)) {
    const auth = new google.auth.GoogleAuth({ keyFile, scopes });
    return auth.getClient();
  }
  const email = process.env.GOOGLE_SA_CLIENT_EMAIL;
  const pkey  = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (email && pkey) {
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: email, private_key: pkey.replace(/\\n/g, '\n') },
      scopes,
    });
    return auth.getClient();
  }
  throw new Error('Google SA credentials not found: set GOOGLE_SA_KEY_FILE OR GOOGLE_SA_CLIENT_EMAIL + GOOGLE_SA_PRIVATE_KEY in .env');
}
async function getSheets() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

// ---------- Utils ----------
function colNumberToLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------- Data (lists) ----------
async function getColumnUnique(range) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = res.data.values || [];
  const vals = rows.map(r => (r[0] || '').toString().trim()).filter(Boolean);
  return Array.from(new Set(vals));
}

async function getFactions() {
  return getColumnUnique(`${SHEET_DATA}!B:B`);
}
async function findAllowedNick(nick) {
  const list = await getColumnUnique(`${SHEET_DATA}!E:E`);
  const q = (nick || '').toString().trim().toLowerCase();
  const match = list.find(x => x.toLowerCase() === q);
  return match || null;
}
async function getAllowedBuildings() {
  return getColumnUnique(`${SHEET_DATA}!A:A`);
}
async function getAllowedEnemyNicks() {
  return getColumnUnique(`${SHEET_DATA}!C:C`);
}
async function getAllowedEnemyGuilds() {
  return getColumnUnique(`${SHEET_DATA}!D:D`);
}

// Повертає унікальний список категорій (data!I:I), відфільтрований від порожніх
async function getDeckCategories() {
  const sheet = SHEET_DATA;
  // I2:I
  const range = `${SHEET_DATA}!I2:I`; // з 2-го рядка
  const list = values
    .map(r => (r[0] || '').toString().trim())
    .filter(Boolean);
  // унікально + відсортувати за абеткою
  return Array.from(new Set(list)).sort((a,b)=>a.localeCompare(b,'uk'));
}

// За назвою категорії (H) повертає список колод (G), унікально і відсортовано
async function getDecksByCategory(category) {
  const sheet = SHEET_DATA;
  // прочитати діапазон G2:H (або G2:H1000 — як зручно)
  const range = `${SHEET_DATA}!G2:H`; // G=назва колоди, H=категорія
  const norm = s => (s||'').toString().trim().toLowerCase();
  const target = norm(category);
  const decks = rows
    .filter(r => norm(r[1]) === target)   // H дорівнює категорії
    .map(r => (r[0] || '').toString().trim()) // беремо G
    .filter(Boolean);
  return Array.from(new Set(decks)).sort((a,b)=>a.localeCompare(b,'uk'));
}

// Повертає унікальний список категорій (data!I:I), без порожніх і без "Боги"
async function getDeckCategories() {
  const sheets = await getSheets();
  const range = `${SHEET_DATA}!I2:I`;            // з 2-го рядка
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });
  const values = res.data.values || [];           // <-- Оце якраз потрібно

  const list = values
    .map(r => (r[0] || '').toString().trim())
    .filter(Boolean)
    .filter(v => v.toLowerCase() !== 'боги');     // "Боги" не показуємо як категорію

  return Array.from(new Set(list)).sort((a, b) => a.localeCompare(b, 'uk'));
}

// За назвою категорії (H) повертає список колод (G), унікально і відсортовано
async function getDecksByCategory(category) {
  const sheets = await getSheets();
  const range = `${SHEET_DATA}!G2:H`;            // G=назва колоди, H=категорія
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });
  const rows = res.data.values || [];            // масив [[G,H], ...]

  const norm = s => (s || '').toString().trim().toLowerCase();
  const target = norm(category);

  const decks = rows
    .filter(r => norm(r[1]) === target)          // H дорівнює вибраній категорії
    .map(r => (r[0] || '').toString().trim())    // беремо G
    .filter(Boolean);

  return Array.from(new Set(decks)).sort((a, b) => a.localeCompare(b, 'uk'));
}


// Записати вибраного суперника в "Планування!A1"
async function setPlanningA1(value) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_PLAN}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ String(value || '') ]] }
  });
}


// ---------- Players row ops ----------
async function findRowByNick(nick) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DECKS}!A:A`
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').toString().trim();
    if (cell && cell.toLowerCase() === (nick || '').toString().trim().toLowerCase()) {
      return i + 1; // 1-based
    }
  }
  return null;
}
async function appendPlayerRow(nick) {
  const sheets = await getSheets();
  // A..M = 13 колонок: A(нік), далі 6 пар (фракція/сила)
  const blankRow = new Array(13).fill('');
  blankRow[0] = nick;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DECKS}!A:M`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [blankRow] }
  });
  return findRowByNick(nick);
}

// Пише лише силу бога (Q/S/U/W), не чіпаючи назву (P/R/T/V)
async function updateGodPower(row, godIndex, power) {
  const sheets = await getSheets();
  // номера колонок 1-based: Q=17, S=19, U=21, W=23
  const powerColMap = { 1:17, 2:19, 3:21, 4:23 };
  const colNum = powerColMap[godIndex];
  const range = `${SHEET_DECKS}!${colNumberToLetter(colNum)}${row}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [[ power ]] }
  });
}


async function readRow(row) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DECKS}!A${row}:W${row}` // до W
  });
  const arr = (res.data.values && res.data.values[0]) ? res.data.values[0] : [];
  while (arr.length < 23) arr.push(''); // A..W = 23
  return arr;
}


// N=14, O=15
async function updateAltar(row, color, power) {
  const sheets = await getSheets();
  const colNum = (color === 'green') ? 14 : 15;
  const range = `${SHEET_DECKS}!${colNumberToLetter(colNum)}${row}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [[ power ]] }
  });
}

// P/Q=(16/17), R/S=(18/19), T/U=(20/21), V/W=(22/23)
async function updateGod(row, godIndex, name, power) {
  const sheets = await getSheets();
  const baseMap = { 1:16, 2:18, 3:20, 4:22 }; // стартова колонка для імені
  const start = baseMap[godIndex];
  const range = `${SHEET_DECKS}!${colNumberToLetter(start)}${row}:${colNumberToLetter(start+1)}${row}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [[ name, power ]] }
  });
}



function slotToCols(slotIndex) {
  // 1 -> B,C; 2 -> D,E; ... (A=1)
  const start = 2 + (slotIndex - 1) * 2;
  return { colFaction: start, colPower: start + 1 };
}
async function updateSlot(row, slotIndex, newFaction, newPower) {
  const sheets = await getSheets();
  const { colFaction, colPower } = slotToCols(slotIndex);
  const range = `${SHEET_DECKS}!${colNumberToLetter(colFaction)}${row}:${colNumberToLetter(colPower)}${row}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [[newFaction, newPower]] }
  });
}

// ---------- Archive ----------
async function ensureArchiveSheet() {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const titles = new Set(meta.data.sheets.map(s => s.properties.title));
  if (!titles.has(SHEET_ARCHIVE)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_ARCHIVE } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_ARCHIVE}!A1:J1`,
      valueInputOption: 'RAW',
      requestBody: { values: [[
        'timestamp','actorUserId','actorUsername','playerNick',
        'slot','oldFaction','oldPower','newFaction','newPower','chatId'
      ]] }
    });
  }
}
async function appendArchive(rec) {
  await ensureArchiveSheet();
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_ARCHIVE}!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      new Date().toISOString(),
      String(rec.actorUserId || ''),
      String(rec.actorUsername || ''),
      String(rec.playerNick || ''),
      String(rec.slot || ''),
      String(rec.oldFaction ?? ''),
      String(rec.oldPower ?? ''),
      String(rec.newFaction ?? ''),
      String(rec.newPower ?? ''),
      String(rec.chatId ?? '')
    ]] }
  });
}

// ---------- Planning (A3:H) ----------
async function getPlanTargetsDetailed() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_PLAN}!A3:H`
  });
  const rows = res.data.values || [];
  return rows.map((r, i) => ({
    row: i + 3,
    building: r[0] || '',
    player:   r[1] || '',
    deck:     r[2] || '',
    power:    r[3] || '',
    e:        r[4] || '',
    allowed:  r[5] || '',        // F
    deckInstr:(r[6] || ''),      // G: "1..4" або "5-6"
    status:   r[7] || ''         // H
  })).filter(x => x.building || x.player || x.deck || x.power);
}
async function setPlanRowStatus(rowNumber, text) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_PLAN}!H${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[text || '']] }
  });
}

// ---------- "Наші колоди" usage marks (Y,Z,AA,AB) ----------
const USAGE_COL_LETTERS = ['Y','Z','AA','AB'];

async function getNextFreeUsageSlot(row) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DECKS}!Y${row}:AB${row}`
  });
  const vals = (res.data.values && res.data.values[0]) ? res.data.values[0] : [];
  for (let i = 0; i < 4; i++) {
    const val = (vals[i] || '').toString().trim();
    if (!val) {
      return { index: i + 1, colLetter: USAGE_COL_LETTERS[i] }; // 1..4
    }
  }
  return null;
}
async function setUsageSlotText(row, slotIndex1to4, text) {
  const colNumber = 24 + slotIndex1to4;           // Y(25)=24+1
  const colLetter = colNumberToLetter(colNumber);  // Y/Z/AA/AB
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DECKS}!${colLetter}${row}:${colLetter}${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[text || '']] }
  });
}

// ---------- Enemies sheet (A..F) ----------
async function ensureEnemiesHeader() {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = (meta.data.sheets || []).find(s => s.properties.title === SHEET_ENEMIES);
  if (!sheet) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_ENEMIES } } }] }
    });
  }
  // (Не переписуємо заголовки, просто працюємо з даними)
}
async function upsertEnemyRow({ player, building, faction, power, guild, deckIndex }) {
  await ensureEnemiesHeader();
  const sheets = await getSheets();
  const range = `${SHEET_ENEMIES}!A:F`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = res.data.values || [];

  // Пошук рядка за player + building + deckIndex (F)
  let foundRow = null; // 1-based
  for (let i = 1; i <= rows.length; i++) { // якщо 1-й рядок — заголовок, все одно ок
    const r = rows[i - 1] || [];
    const p = (r[0] || '').toString().trim().toLowerCase();
    const b = (r[1] || '').toString().trim().toLowerCase();
    const idx = parseInt((r[5] || '1').toString().trim(), 10) || 1;
    if (p === player.toLowerCase().trim() && b === building.toLowerCase().trim() && idx === deckIndex) {
      foundRow = i;
      break;
    }
  }

  if (foundRow) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_ENEMIES}!A${foundRow}:F${foundRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[player, building, faction, power, guild, deckIndex]] }
    });
    return false; // оновлено
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_ENEMIES}!A:F`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[player, building, faction, power, guild, deckIndex]] }
    });
    return true; // додано
  }
}

// (опційно) Прочитати всі рядки з "Колоди противників"
async function getEnemyDecks() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_ENEMIES}!A:F`
  });
  const rows = res.data.values || [];
  // пропустимо заголовок якщо є
  const body = rows[0] && /грав|будівл|фракц|сила/i.test(rows[0].join('')) ? rows.slice(1) : rows;
  return body.map(r => ({
    player:   r[0] || '',
    building: r[1] || '',
    deck:     r[2] || '',
    power:    r[3] || '',
    guild:    r[4] || '',
    index:    parseInt(r[5] || '1', 10) || 1
  }));
}

// ---------- (optional) Random from planning ----------
async function getRandomFightTarget() {
  const items = await getPlanTargetsDetailed();
  const candidates = items.filter(x => !x.status || !x.status.toString().trim());
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
// === /info ===
// Повертає масив об’єктів { a, b } з A+B, пропускаючи порожні
async function getClassificationInfo() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_CLASS}!A2:B`
  });
  const rows = res.data.values || [];
  return rows
    .map(r => ({ a: (r[0] || '').toString().trim(), b: (r[1] || '').toString().trim() }))
    .filter(r => r.a || r.b);
}

// === /lose ===
// Знімає "знесли: ..." у «Плануванні» для Н-ої виданої атаки гравця.
// Логіка:
// 1) читаємо з «Наші колоди» Y/Z/AA/AB текст слоту №n → парсимо "Будівля/Гравець" (як було видано /fight)
// 2) серед «Планування» шукаємо рядок, де H містить "знесли:" + нік, і збігається будівля/гравець → очищаємо H
async function clearDestroyedMarkForLoss(nick, idx1to4) {
  const sheets = await getSheets();
  const rowNum = await findRowByNick(nick);
  if (!rowNum) return { cleared: 0, rows: [], matchedDeckNos: [] };

  const USAGE = ['Y','Z','AA','AB'];
  const col = USAGE[idx1to4 - 1];
  let building = null, enemy = null;

  // 1) прочитати текст конкретного usage-слоту
  if (col) {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_DECKS}!${col}${rowNum}`
    });
    const text = (r.data.values && r.data.values[0] && r.data.values[0][0]) ? String(r.data.values[0][0]) : '';
    // очікуваний формат: "<мітка колоди> → <Будівля>/<Гравець>"
    const afterArrow = text.split('→')[1] || text.split('->')[1] || '';
    if (afterArrow) {
      const t = afterArrow.trim();
      const parts = t.split('/');
      if (parts.length >= 2) {
        building = (parts[0] || '').trim();
        enemy = parts.slice(1).join('/').trim();
      }
    }
  }

  // 2) знайти відповідний рядок у «Плануванні»
  const list = await getPlanTargetsDetailed(); // A3:H
  const norm = s => String(s || '').trim().toLowerCase();

  // Лейбли, які бот пише в H (під час /fight): "перша/друга/третя/четверта колода"
  const deckLabel = {1:'перша колода', 2:'друга колода', 3:'третя колода', 4:'четверта колода'}[idx1to4];

  // спершу шукаємо повний збіг: nick + building + enemy + label
  let candidate = list.find(r =>
    /знесли/i.test(r.status || '') &&
    norm(r.status).includes(norm(nick)) &&
    (!building || norm(r.building) === norm(building)) &&
    (!enemy || norm(r.player) === norm(enemy)) &&
    (deckLabel ? norm(r.status).includes(deckLabel) : true)
  );

  // якщо не знайшли — послаблюємо критерії
  if (!candidate) {
    candidate = list.find(r =>
      /знесли/i.test(r.status || '') &&
      norm(r.status).includes(norm(nick)) &&
      (!building || norm(r.building) === norm(building)) &&
      (!enemy || norm(r.player) === norm(enemy))
    );
  }
  if (!candidate) return { cleared: 0, rows: [], matchedDeckNos: [] };

  await setPlanRowStatus(candidate.row, '');
  return { cleared: 1, rows: [candidate.row], matchedDeckNos: [idx1to4] };
}

// === /reserv ===
// Повертає активних (AD="так") гравців з < 4 призначеними ударами,
// і список ЇХНІХ НЕ-РОЗПОДІЛЕНИХ колод (звич. і боги).
// Рахуємо призначення по «Планування»: F=нік, G=№ колоди (1..8).
async function getReservList() {
  const sheets = await getSheets();

  // 1) Усі наші колоди (з AD до колонки AD включно)
  const decksResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DECKS}!A2:AD`
  });
  const drows = decksResp.data.values || [];

  // 2) Усі призначення з «Планування»: F=нік, G=№ колоди
  const planResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_PLAN}!F2:G`
  });
  const prows = planResp.data.values || [];

  // build map: nick -> { count, used:Set(deckId) }
  const assigned = new Map();
  for (const r of prows) {
    const nick = (r?.[0] || '').trim();
    if (!nick) continue;
    const deckId = parseInt((r?.[1] || '').toString().trim(), 10);
    if (!assigned.has(nick)) assigned.set(nick, { count: 0, used: new Set() });
    const slot = assigned.get(nick);
    slot.count++;
    if (Number.isFinite(deckId)) slot.used.add(deckId);
  }

  const out = [];

  for (const r of drows) {
    const nick = (r?.[0] || '').trim();
    if (!nick) continue;

    // Враховуємо лише активних: AD (30-та колонка = index 29) має бути "так" якщо колонка існує
    const hasAD = r.length >= 30;
    if (hasAD) {
      const ad = (r[29] || '').toString().trim().toLowerCase();
      if (ad !== 'так') continue;
    }

    const rec = assigned.get(nick) || { count: 0, used: new Set() };
    if (rec.count >= 4) continue; // вже має 4 або більше — не в резерві

    // Зібрати НЕ-розподілені колоди
    const freeDecks = [];

    // Звичайні: B/C (1,2), D/E (3,4), F/G (5,6), H/I (7,8) — але deckId 1..4
    const normals = [
      { id: 1, fac: r[1], p: r[2] },
      { id: 2, fac: r[3], p: r[4] },
      { id: 3, fac: r[5], p: r[6] },
      { id: 4, fac: r[7], p: r[8] },
    ];
    for (const d of normals) {
      const f = (d.fac || '').toString().trim();
      const p = parsePower(d.p);
      if (!f || p <= 0) continue;
      if (!rec.used.has(d.id)) freeDecks.push({ id: d.id, faction: f, type: 'звич.', power: p });
    }

    // Боги: P/Q(15,16)->id5, R/S(17,18)->id6, T/U(19,20)->id7, V/W(21,22)->id8
    const gods = [
      { id: 5, name: r[15], p: r[16] },
      { id: 6, name: r[17], p: r[18] },
      { id: 7, name: r[19], p: r[20] },
      { id: 8, name: r[21], p: r[22] },
    ];
    for (const g of gods) {
      const name = (g.name || '').toString().trim();
      const p = parsePower(g.p);
      if (!name && p <= 0) continue;
      if (!rec.used.has(g.id)) freeDecks.push({ id: g.id, faction: name || 'Бог', type: 'бог', power: p });
    }

    // Включаємо в результат тільки тих, у кого є що показати (або покажемо порожній список — за бажанням)
    out.push({
      nick,
      remaining: Math.max(0, 4 - rec.count),
      decks: freeDecks.sort((a, b) => {
        if (a.type !== b.type) return a.type.localeCompare(b.type, 'uk'); // бог/звич.
        return b.power - a.power;
      }),
    });
  }

  // Виводимо у зручному порядку
  out.sort((a, b) => a.nick.localeCompare(b.nick, 'uk'));
  return out;
}


// ---- Статистика: ensure + find + increment D ----
async function ensureStatsSheet() {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const has = (meta.data.sheets || []).some(s => s.properties?.title === SHEET_STATS);
  if (has) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: SHEET_STATS } } }]
    }
  });
  // (не обов’язково) — можеш поставити хедери A..D, якщо хочеш:
  // await sheets.spreadsheets.values.update({
  //   spreadsheetId: SPREADSHEET_ID,
  //   range: `${SHEET_STATS}!A1:D1`,
  //   valueInputOption: 'RAW',
  //   requestBody: { values: [[ 'Гравець', 'B', 'C', 'D' ]] }
  // });
}

async function findStatsRowByNick(nick) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_STATS}!A:A`
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').toString().trim();
    if (cell && cell.toLowerCase() === nick.toLowerCase()) {
      return i + 1; // 1-based
    }
  }
  return null;
}

/**
 * Інкрементує колонку D у «Статистика» для вказаного ніку.
 * Якщо рядка немає — додає новий рядок: [nick, '', '', <inc>]
 */
async function incrementStatLoss(nick, inc = 1) {
  await ensureStatsSheet();
  const sheets = await getSheets();
  let row = await findStatsRowByNick(nick);
  if (!row) {
    // якщо рядка немає — додаємо з нулів і одразу інкрементним значенням у D
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_STATS}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[ nick, '', '', inc ]] }
    });
    return inc;
  }
  // читаємо поточне D
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_STATS}!D${row}:D${row}`
  });
  const curRaw = (getRes.data.values && getRes.data.values[0] && getRes.data.values[0][0]) || '0';
  const cur = Number.parseInt(String(curRaw).replace(/[^\d-]/g, ''), 10);
  const next = (Number.isFinite(cur) ? cur : 0) + inc;
    await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_STATS}!D${row}:D${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ next ]] }
  });
  return next;
} 

// Очищає "знесли ..." в колонці H для (F=nick, G=deckNo) і записує залишок (0..100) у колонку I.
async function clearDestroyedAndSetRemain(nick, deckNo, remainPercent) {
  const sheets = await getSheets();

  // Читаємо діапазон, який точно покриває F..I (6..9) з 3-го рядка
  const range = `${SHEET_PLAN}!A3:K`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });
  const rows = res.data.values || [];

  const lowerNick = String(nick || '').trim().toLowerCase();
  const wantedDeck = Number(deckNo);

  const updates = [];
  const affected = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const rowIdx = i + 3; // фактичний номер рядка на аркуші

    const fNick = (r[5] || '').toString().trim().toLowerCase();  // F (6-й стовпець)
    const gDeck = parseInt((r[6] || '').toString().trim(), 10);  // G (7-й)
    const hStat = (r[7] || '').toString().trim();                // H (8-й)

    // Шукаємо рядки з нашим ніком і № колоди, де в H було "знесли..."
    if (fNick === lowerNick && gDeck === wantedDeck && /^знесли/i.test(hStat)) {
      affected.push(rowIdx);

      // очистити H
      updates.push({
        range: `${SHEET_PLAN}!H${rowIdx}:H${rowIdx}`,
        values: [['']]
      });
      // записати залишок у I (числом)
      updates.push({
        range: `${SHEET_PLAN}!I${rowIdx}:I${rowIdx}`,
        values: [[Number(remainPercent)]]
      });
    }
  }

  if (!affected.length) return { cleared: 0, rows: [] };

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates
    }
  });

  return { cleared: affected.length, rows: affected };
}


// === Building priorities & active gate state (data!K:M + data!N2) ===
const DATA_ACTIVE_GATE_CELL = process.env.DATA_ACTIVE_GATE_CELL || `${SHEET_DATA}!N2`;

/** Повертає Map<canon(name), { name, pL:number|null, pM:number|null }> з data!K:M */
async function getBuildingPriorities() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DATA}!K:M`
  });
  const rows = res.data.values || [];
  const m = new Map();
  for (const r of rows) {
    const name = (r?.[0] || '').toString().trim();
    if (!name) continue;
    const pL = Number((r?.[1] || '').toString().trim());
    const pM = Number((r?.[2] || '').toString().trim());
    m.set(name.toLowerCase(), {
      name,
      pL: Number.isFinite(pL) ? pL : null,
      pM: Number.isFinite(pM) ? pM : null,
    });
  }
  return m;
}

async function getPlanLookRows(building) {
  const sheets = await getSheets();
  const range = `${SHEET_PLAN}!A3:G`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });
  const values = res.data.values || [];
  const norm = (s) => String(s || '').trim().toLowerCase();

  const target = norm(building);
  const rows = [];
  for (const r of values) {
    const A = r[0], B = r[1], C = r[2], D = r[3], E = r[4], F = r[5], G = r[6];
    if (norm(A) === target) {
      const goal = [B, C, D, E].filter(Boolean).join(' ');
      const carrier = [F, G].filter(Boolean).join(' ');
      rows.push({ goal, carrier });
    }
  }
  return rows;
}

// === Gate priorities from data!K:M ===
// K = назва будівлі (як у Плануванні), L = пріоритет фаза1, M = пріоритет фаза2
// Повертає масив об'єктів: { name, p1, p2 }
async function getGateConfig() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DATA}!K2:M`
  });
  const rows = res.data.values || [];
  const items = [];
  for (const r of rows) {
    const name = (r?.[0] || '').toString().trim();
    if (!name) continue;
    const toNum = (x) => {
      const s = (x ?? '').toString().trim().replace(',', '.');
      const n = Number(s);
      return Number.isFinite(n) ? n : 9999; // якщо не число — дуже низький пріоритет
    };
    items.push({ name, p1: toNum(r?.[1]), p2: toNum(r?.[2]) });
  }
  return items;
}

// === NOFIGHT: читання data!K:M (імена будівель і стан колонки M) ===
async function getDataBuildingsKM() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DATA}!K2:M`, // K=name, L=prio1, M=prio2/dont touch
  });
  const vals = res.data.values || [];
  // вертаємо [{ row, name, p1, p2 }]
  return vals.map((r, i) => ({
    row: i + 2, // реальний рядок на аркуші
    name: String((r[0] || '')).trim(),
    p1: (r[1] ?? ''),
    p2: (r[2] ?? ''),
  })).filter(x => x.name);
}

// === NOFIGHT: оновлення міток у колонці M (ставити/знімати "dont touch") ===
async function updateNoFightFlags({ setRows = [], clearRows = [] }) {
  const sheets = await getSheets();
  const data = [];

  for (const row of setRows) {
    data.push({ range: `${SHEET_DATA}!M${row}:M${row}`, values: [[ 'dont touch' ]] });
  }
  for (const row of clearRows) {
    data.push({ range: `${SHEET_DATA}!M${row}:M${row}`, values: [[ '' ]] });
  }
  if (!data.length) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data
    }
  });
}

/** Прочитати активну "браму/бастіон": data!N2 (порожньо = не вибрано) */
async function getActiveGateKey() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: DATA_ACTIVE_GATE_CELL
  });
  const v = res.data.values?.[0]?.[0] || '';
  return String(v).trim();
}

/** Встановити/очистити активну "браму/бастіон" у data!N2 */
async function setActiveGateKey(key) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: DATA_ACTIVE_GATE_CELL,
    valueInputOption: 'RAW',
    requestBody: { values: [[ key ? String(key) : '' ]] }
  });
}

// Встановити призначення в «Плануванні»: F=нік, G=№ нашої колоди (1..4 для звич.)
async function setPlanRowAssigneeAndDeck(rowNumber, nick, deckNo) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_PLAN}!F${rowNumber}:G${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ nick || '', Number(deckNo) || '' ]] }
  });
}


// --- power parser: "333k", "11M", "420 000" -> число ---
function parsePower(v) {
  if (v == null) return 0;
  const s = String(v).trim().replace(/\s+/g, '').replace(/,/g, '');
  if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)([kKmMmмК])?$/);
  if (m) {
    let num = parseFloat(m[1]);
    const suf = (m[2] || '').toLowerCase();
    if (suf === 'k' || suf === 'к') num *= 1e3;
    else if (suf === 'm' || suf === 'м') num *= 1e6;
    return Math.round(num);
  }
  const n = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
}


module.exports = {
  SPREADSHEET_ID,
  SHEET_DECKS,
  SHEET_ARCHIVE,
  SHEET_DATA,
  SHEET_PLAN,
  SHEET_ENEMIES,

  getFactions,
  findAllowedNick,
  getAllowedBuildings,
  getAllowedEnemyNicks,
  getAllowedEnemyGuilds,
  getDeckCategories,
  getDecksByCategory,
  findRowByNick,
  getDataBuildingsKM,
  updateNoFightFlags,
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
  setPlanRowAssigneeAndDeck,
  upsertEnemyRow,
  getEnemyDecks,
  getGateConfig,
  getRandomFightTarget,
  getClassificationInfo,
  getReservList,
  getPlanLookRows,
  clearDestroyedAndSetRemain,
  updateAltar,
  updateGod,
  getBuildingPriorities,
  getActiveGateKey,
  setActiveGateKey,
  incrementStatLoss,
  updateGodPower,
  setPlanningA1,
};
