/**
 * LTB-Sammlung – Backend (Google Apps Script)
 * ------------------------------------------------------------
 * Das Google Sheet ist die Datenbank. Dieses Script stellt eine kleine
 * JSON-API bereit, mit der die PWA liest und schreibt.
 *
 * Einrichtung (Kurzfassung, Details in ANLEITUNG.md):
 *   1. Im Sheet: Erweiterungen > Apps Script, diesen Code einfügen.
 *   2. Funktion "setup" einmal ausführen (Berechtigungen bestätigen).
 *      -> Der API-Schlüssel steht danach im Ausführungsprotokoll
 *         und im Tabellenblatt "Einstellungen".
 *   3. Bereitstellen > Neue Bereitstellung > Web-App
 *        Ausführen als: Ich
 *        Zugriff: Jeder
 *      -> Die Web-App-URL + den Schlüssel in der App eintragen.
 */

const SHEET_NAME = 'Bände';
const SETTINGS_SHEET = 'Einstellungen';
const HEADERS = ['Reihe', 'Nr', 'Titel', 'Anzahl', 'Wunsch', 'Zustand', 'Notiz', 'Geändert', 'Von'];
const COL = { reihe: 0, nr: 1, titel: 2, anzahl: 3, wunsch: 4, zustand: 5, notiz: 6, geaendert: 7, von: 8 };

/* ---------------- Setup ---------------- */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  // Nr- und Titel-Spalte als Text, damit "007" oder "12a" nicht umgewandelt werden
  sh.getRange('B:B').setNumberFormat('@');

  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('API_KEY', key);
  }
  let st = ss.getSheetByName(SETTINGS_SHEET);
  if (!st) st = ss.insertSheet(SETTINGS_SHEET);
  st.getRange(1, 1, 3, 2).setValues([
    ['API-Schlüssel', key],
    ['Hinweis', 'Diesen Schlüssel in der App unter "Mehr > Einstellungen" eintragen. Nicht öffentlich teilen.'],
    ['Neuen Schlüssel erzeugen', 'Funktion "neuerSchluessel" im Apps-Script-Editor ausführen.'],
  ]);
  Logger.log('API-Schlüssel: ' + key);
  return key;
}

/** Erzeugt einen neuen Schlüssel (alter wird ungültig). */
function neuerSchluessel() {
  PropertiesService.getScriptProperties().deleteProperty('API_KEY');
  return setup();
}

/* ---------------- HTTP-Einstieg ---------------- */

function doGet(e) {
  return handle_(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Ungültiges JSON' });
  }
  return handle_(body);
}

function handle_(req) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key) return json_({ ok: false, error: 'Backend nicht eingerichtet – bitte setup() ausführen.' });
    if (String(req.key || '') !== key) return json_({ ok: false, error: 'Falscher API-Schlüssel' });

    switch (req.action) {
      case 'ping':      return json_({ ok: true });
      case 'list':      return json_(list_());
      case 'update':    return json_(withLock_(() => update_(req)));
      case 'import':    return json_(withLock_(() => importItems_(req)));
      case 'addSeries': return json_(withLock_(() => addSeries_(req)));
      default:          return json_({ ok: false, error: 'Unbekannte Aktion: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------------- Aktionen ---------------- */

function list_() {
  const rows = readRows_();
  return { ok: true, items: rows.filter(isRealRow_).map(rowToItem_), serverTime: new Date().toISOString() };
}

/**
 * Ein Band ändern (oder anlegen, falls noch nicht im Katalog).
 * req: { reihe, nr, fields: { anzahl?, wunsch?, zustand?, notiz?, titel? }, user }
 */
function update_(req) {
  const reihe = clean_(req.reihe), nr = clean_(req.nr);
  if (!reihe || !nr) return { ok: false, error: 'Reihe und Nr erforderlich' };
  const f = req.fields || {};
  const sh = sheet_();
  const rows = readRows_();
  const idx = rows.findIndex(r => isRealRow_(r) && keyOf_(r[COL.reihe], r[COL.nr]) === keyOf_(reihe, nr));
  let row = idx >= 0 ? rows[idx].slice() : [reihe, nr, '', 0, false, '', '', '', ''];

  if ('anzahl' in f)  row[COL.anzahl] = Math.max(0, parseInt(f.anzahl, 10) || 0);
  if ('wunsch' in f)  row[COL.wunsch] = !!f.wunsch;
  if ('zustand' in f) row[COL.zustand] = clean_(f.zustand);
  if ('notiz' in f)   row[COL.notiz] = clean_(f.notiz);
  if ('titel' in f)   row[COL.titel] = clean_(f.titel);
  row[COL.geaendert] = new Date();
  row[COL.von] = clean_(req.user);

  if (idx >= 0) sh.getRange(idx + 2, 1, 1, HEADERS.length).setValues([row]);
  else sh.appendRow(row);
  return { ok: true, item: rowToItem_(row) };
}

/**
 * Mehrere Einträge auf einmal importieren.
 * req.mode = 'bestand': items [{reihe, nr}] – mehrfach genannte Nummern zählen als Doppelte.
 *            Anzahl wird auf max(bisher, gezählt) gesetzt – nie verringert.
 * req.mode = 'katalog': items [{reihe, nr, titel}] – legt fehlende Bände an / setzt Titel.
 */
function importItems_(req) {
  const mode = req.mode === 'katalog' ? 'katalog' : 'bestand';
  const items = Array.isArray(req.items) ? req.items : [];
  const user = clean_(req.user);
  const now = new Date();

  // Eingaben zusammenfassen
  const incoming = new Map();
  items.forEach(it => {
    const reihe = clean_(it.reihe), nr = clean_(it.nr);
    if (!reihe || !nr) return;
    const k = keyOf_(reihe, nr);
    const prev = incoming.get(k);
    if (prev) { prev.count++; if (it.titel) prev.titel = clean_(it.titel); }
    else incoming.set(k, { reihe, nr, titel: clean_(it.titel), count: 1 });
  });

  const sh = sheet_();
  const rows = readRows_();
  const index = new Map();
  rows.forEach((r, i) => { if (isRealRow_(r)) index.set(keyOf_(r[COL.reihe], r[COL.nr]), i); });

  let neu = 0, geaendert = 0, unveraendert = 0;
  const changed = new Set();
  const appended = [];

  incoming.forEach((inc, k) => {
    const i = index.get(k);
    if (i === undefined) {
      const row = [inc.reihe, inc.nr, inc.titel || '', mode === 'bestand' ? inc.count : 0, false, '', '', now, user];
      appended.push(row);
      neu++;
      return;
    }
    const row = rows[i];
    let dirty = false;
    if (mode === 'bestand') {
      const cur = parseInt(row[COL.anzahl], 10) || 0;
      if (inc.count > cur) { row[COL.anzahl] = inc.count; dirty = true; }
      if (row[COL.wunsch] === true) { row[COL.wunsch] = false; dirty = true; } // jetzt vorhanden
    } else if (inc.titel && inc.titel !== String(row[COL.titel])) {
      row[COL.titel] = inc.titel; dirty = true;
    }
    if (dirty) { row[COL.geaendert] = now; row[COL.von] = user; changed.add(i); geaendert++; }
    else unveraendert++;
  });

  // Geänderte Zeilen zurückschreiben (gesamter Block, ein Schreibzugriff)
  if (changed.size) sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  if (appended.length) sh.getRange(sh.getLastRow() + 1, 1, appended.length, HEADERS.length).setValues(appended);
  if (appended.length) sortSheet_();

  return { ok: true, neu, geaendert, unveraendert };
}

/** Legt für eine Reihe alle Nummern von..bis an (vorhandene bleiben unberührt). */
function addSeries_(req) {
  const reihe = clean_(req.reihe);
  const von = parseInt(req.von, 10), bis = parseInt(req.bis, 10);
  if (!reihe || !(von >= 0) || !(bis >= von)) return { ok: false, error: 'Ungültige Angaben' };
  if (bis - von > 5000) return { ok: false, error: 'Maximal 5000 Bände auf einmal' };
  const items = [];
  for (let n = von; n <= bis; n++) items.push({ reihe, nr: String(n) });
  return importItems_({ mode: 'katalog', items, user: req.user });
}

/* ---------------- Hilfsfunktionen ---------------- */

function sheet_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Tabellenblatt "' + SHEET_NAME + '" fehlt – bitte setup() ausführen.');
  return sh;
}

function readRows_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  // Ungefiltert, damit Zeilenindex = Position im Sheet bleibt
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
}

function isRealRow_(r) {
  return String(r[COL.reihe]).trim() !== '' && String(r[COL.nr]).trim() !== '';
}

function sortSheet_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 3) return;
  const range = sh.getRange(2, 1, last - 1, HEADERS.length);
  const rows = range.getValues();
  rows.sort((a, b) => {
    // Leere Zeilen ans Ende
    if (isRealRow_(a) !== isRealRow_(b)) return isRealRow_(a) ? -1 : 1;
    const r = String(a[COL.reihe]).localeCompare(String(b[COL.reihe]), 'de');
    if (r) return r;
    const na = parseFloat(a[COL.nr]), nb = parseFloat(b[COL.nr]);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(a[COL.nr]).localeCompare(String(b[COL.nr]), 'de', { numeric: true });
  });
  range.setValues(rows);
}

function rowToItem_(r) {
  const g = r[COL.geaendert];
  return {
    reihe: String(r[COL.reihe]).trim(),
    nr: String(r[COL.nr]).trim(),
    titel: String(r[COL.titel] || ''),
    anzahl: parseInt(r[COL.anzahl], 10) || 0,
    wunsch: r[COL.wunsch] === true || String(r[COL.wunsch]).toUpperCase() === 'TRUE',
    zustand: String(r[COL.zustand] || ''),
    notiz: String(r[COL.notiz] || ''),
    geaendert: g instanceof Date ? g.toISOString() : String(g || ''),
    von: String(r[COL.von] || ''),
  };
}

function keyOf_(reihe, nr) {
  return String(reihe).trim().toLowerCase() + '|' + String(nr).trim().replace(/^0+(?=\d)/, '').toLowerCase();
}

function clean_(v) {
  return v === undefined || v === null ? '' : String(v).trim().slice(0, 500);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
