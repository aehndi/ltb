// Mock-Apps-Script: führt Code.gs mit einem simulierten SpreadsheetApp aus und
// liefert die PWA statisch aus. GET/POST /exec wie bei Apps Script.
const fs = require('fs'), path = require('path'), http = require('http'), vm = require('vm');
const PWA = path.join(__dirname, '..', 'docs');
const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

function makeSheet(name) {
  const data = []; // 2D array, 1-based access via getRange
  const sh = {
    name, data,
    getLastRow: () => { let n = data.length; while (n && data[n-1].every(v => v === '' || v == null)) n--; return n; },
    getRange(a, b, c, d) {
      if (typeof a === 'string') return { setNumberFormat() { return this; } };
      const r0 = a - 1, c0 = b - 1, nr = c || 1, nc = d || 1;
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r0+i] && data[r0+i][c0+j] !== undefined) ? data[r0+i][c0+j] : '')),
        setValues(vals) { vals.forEach((row, i) => { data[r0+i] = data[r0+i] || []; row.forEach((v, j) => data[r0+i][c0+j] = v); }); return this; },
        setFontWeight() { return this; },
      };
    },
    appendRow(row) { data[sh.getLastRow()] = row.slice(); },
    setFrozenRows() {},
  };
  return sh;
}
const sheets = {};
const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = makeSheet(n)) };
const props = {};
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => props[k] = v, deleteProperty: k => delete props[k] }) },
  Utilities: { getUuid: () => 'abcd1234-ef56-7890-abcd-ef1234567890' },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Logger: { log: console.log },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
  console,
};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const KEY = vm.runInContext('setup()', ctx);
console.log('KEY', KEY);
module.exports = { ctx, sheets, KEY };

if (require.main === module) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/exec') {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
      if (req.method === 'OPTIONS') { res.writeHead(405); return res.end(); } // wie Apps Script: kein Preflight
      if (req.method === 'GET') {
        const out = ctx.doGet({ parameter: Object.fromEntries(u.searchParams) });
        res.writeHead(200, cors); return res.end(out.s);
      }
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        const out = ctx.doPost({ postData: { contents: body } });
        res.writeHead(200, cors); res.end(out.s);
      });
      return;
    }
    let p = path.join(PWA, u.pathname === '/' ? 'index.html' : u.pathname);
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(buf);
    });
  }).listen(8765, () => console.log('listening 8765'));
}
