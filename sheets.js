// sheets.js
const fs = require('fs');
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1CiIVg4aOmNL96cEkrgkrsaQ2mDIonGdrKOlrHDruAb0';
const SHEET_DECKS = 'Наші колоди';
const SHEET_ARCHIVE = 'Архів колод';
const SHEET_DATA = 'data';
const SHEET_PLAN = process.env.SHEET_PLAN || 'Планування'; // аркуш з цілями (A:Будівля, B:Ігрок, C:колода, D:сила)


// Авторизація: спочатку пробуємо keyFile, якщо нема — пару з .env
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
      credentials: {
        client_email: email,
        private_key: pkey.replace(/\\n/g, '\n'),
      },
      scopes,
    });
    return auth.getClient();
  }
  throw new Error('Google SA credentials not found: set GOOGLE_SA_KEY_FILE (preferred) OR both GOOGLE_SA_CLIENT_EMAIL and GOOGLE_SA_PRIVATE_KEY in .env');
}

async function getSheets() {
  const authClient = await getAuth();
  return google.sheets({ version: 'v4', auth: authClient });
}

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
      ]]}
    });
  }
}

async function getFactions() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DATA}!B:B`
  });
  const rows = res.data.values || [];
  const vals = rows.map(r => (r[0] || '').toString().trim()).filter(Boolean);
  return Array.from(new Set(vals));
}

async function findRowByNick(nick) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DECKS}!A:A`
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').toString().trim();
    if (cell && cell.toLowerCase() === nick.toLowerCase()) return i + 1; // 1-based
  }
  return null;
}

async function appendPlayerRow(nick) {
  const sheets = await getSheets();
  // 13 колонок: A..M (A=нік, далі 6 пар "Фракція/Сила")
  const blankRow = new Array(13).fill('');
  blankRow[0] = nick;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DECKS}!A:M`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [blankRow] }
  });
  const row = await findRowByNick(nick);
  return row;
}

async function readRow(row) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DECKS}!A${row}:M${row}`
  });
  const arr = res.data.values && res.data.values[0] ? res.data.values[0] : [];
  while (arr.length < 13) arr.push('');
  return arr;
}

// slotIndex: 1..6
function slotToCols(slotIndex) {
  // 1 -> (B,C), 2 -> (D,E), ...
  const start = 2 + (slotIndex - 1) * 2;
  return { colFaction: start, colPower: start + 1 };
}

function colNumberToLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
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
    ]]}
  });
}

async function getPlanTargets() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_PLAN}!A:D`, // A:Будівля, B:Ігрок, C:колода, D:сила
  });
  const rows = res.data.values || [];
  if (!rows.length) return [];

  // якщо перший рядок — заголовок, пропустимо його
  const dataRows = rows[0] && (rows[0][0] || '').toString().toLowerCase().includes('буд') ? rows.slice(1) : rows;

  // фільтруємо порожні
  return dataRows
    .map(r => {
      const [building, player, deck, power] = [r[0] || '', r[1] || '', r[2] || '', r[3] || ''];
      if (!building && !player && !deck && !power) return null;
      return { building, player, deck, power };
    })
    .filter(Boolean);
}

// --- Вайтлист ніків з data!E:E ---
async function getAllowedNicks() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DATA}!E:E`
  });
  const rows = res.data.values || [];
  return Array.from(new Set(
    rows.map(r => (r[0] || '').toString().trim()).filter(Boolean)
  ));
}

// Повертає канонічний нік із вайтлиста або null (порівняння без регістру/зайвих пробілів)
async function findAllowedNick(inputNick) {
  const list = await getAllowedNicks();
  const q = (inputNick || '').toString().trim().toLowerCase();
  return list.find(n => n.toLowerCase() === q) || null;
}


async function getRandomFightTarget() {
  const targets = await getPlanTargets();
  if (!targets.length) return null;
  const idx = Math.floor(Math.random() * targets.length);
  return targets[idx];
}


module.exports = {
  getFactions,
  findRowByNick,
  appendPlayerRow,
  readRow,
  updateSlot,
  appendArchive,
  getPlanTargets,
  getRandomFightTarget,
  findAllowedNick,
};
