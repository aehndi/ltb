/* LTB-Sammlung – PWA
 * Daten liegen im Google Sheet; dieses Script spricht mit der Apps-Script-API.
 */
'use strict';

const APP_VERSION = '1.1.0';
const LS_SETTINGS = 'ltb.settings';
const LS_CACHE = 'ltb.cache';
const LS_UI = 'ltb.ui';
const LS_DEMO = 'ltb.demo';
const DEMO_URL = 'demo';

/* ---------------- Speicher (immer abgesichert) ---------------- */
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } },
};

/* ---------------- Zustand ---------------- */
const state = {
  settings: store.get(LS_SETTINGS, { url: '', key: '', user: '' }),
  items: [],
  loadedAt: null,
  offline: false,
  view: 'sammlung',
  ui: Object.assign({ series: '*', filter: 'alle', list: 'fehlt', quick: false }, store.get(LS_UI, {})),
  search: '',
  detailKey: null,
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const normNr = nr => String(nr).trim().replace(/^0+(?=\d)/, '').toLowerCase();
const keyOf = (reihe, nr) => String(reihe).trim().toLowerCase() + '|' + normNr(nr);
const numVal = nr => { const n = parseFloat(nr); return isNaN(n) ? Infinity : n; };

function sortItems(arr) {
  return arr.sort((a, b) =>
    a.reihe.localeCompare(b.reihe, 'de') ||
    (numVal(a.nr) - numVal(b.nr)) ||
    a.nr.localeCompare(b.nr, 'de', { numeric: true }));
}
function seriesNames() {
  return [...new Set(state.items.map(i => i.reihe))].sort((a, b) => a.localeCompare(b, 'de'));
}
function findItem(reihe, nr) {
  const k = keyOf(reihe, nr);
  return state.items.find(i => keyOf(i.reihe, i.nr) === k);
}

/* ---------------- API ---------------- */
async function api(action, payload = {}) {
  const { url, key, user } = state.settings;
  if (!url) throw new Error('Noch nicht verbunden – bitte unter „Mehr → Einstellungen“ einrichten.');
  if (url === DEMO_URL) return demoApi(action, payload);

  let res;
  if (action === 'list' || action === 'ping') {
    const q = new URLSearchParams({ action, key, t: Date.now() });
    res = await fetch(url + (url.includes('?') ? '&' : '?') + q, { redirect: 'follow' });
  } else {
    // text/plain vermeidet den CORS-Preflight, den Apps Script nicht beantwortet
    res = await fetch(url, {
      method: 'POST', redirect: 'follow',
      body: JSON.stringify(Object.assign({}, payload, { action, key, user })),
    });
  }
  if (!res.ok) throw new Error('Server antwortet mit ' + res.status);
  let data;
  try { data = await res.json(); }
  catch { throw new Error('Unerwartete Antwort – stimmt die Web-App-URL und ist der Zugriff auf „Jeder“ gestellt?'); }
  if (!data.ok) throw new Error(data.error || 'Unbekannter Fehler');
  return data;
}

/* Schreibzugriffe nacheinander ausführen, damit die Reihenfolge stimmt */
let writeChain = Promise.resolve();
let pendingWrites = 0;
function queueWrite(fn) {
  pendingWrites++; renderSync();
  const p = writeChain.then(fn);
  writeChain = p.catch(() => {}).finally(() => { pendingWrites--; renderSync(); });
  return p;
}

/* ---------------- Laden ---------------- */
async function load({ silent = false } = {}) {
  if (!state.settings.url) { render(); return; }
  const btn = $('#btnRefresh');
  btn.classList.add('spin');
  try {
    const data = await api('list');
    state.items = sortItems(data.items);
    state.loadedAt = new Date();
    state.offline = false;
    store.set(LS_CACHE, { url: state.settings.url, items: state.items, at: state.loadedAt.toISOString() });
    hideBanner();
  } catch (err) {
    const cache = store.get(LS_CACHE, null);
    if (!state.items.length && cache && cache.url === state.settings.url) {
      state.items = cache.items; state.loadedAt = new Date(cache.at);
    }
    state.offline = true;
    showBanner('Keine Verbindung: ' + err.message + (state.items.length ? ' – Anzeige vom ' + fmtDate(state.loadedAt) + '.' : ''));
    if (!silent) toast(err.message, true);
  } finally {
    btn.classList.remove('spin');
    render();
  }
}

/* ---------------- Ändern ---------------- */
function changeItem(item, fields) {
  const before = Object.assign({}, item);
  Object.assign(item, fields, { geaendert: new Date().toISOString(), von: state.settings.user });
  render();
  return queueWrite(() => api('update', { reihe: item.reihe, nr: item.nr, fields }))
    .then(res => { if (res && res.item) Object.assign(item, res.item); saveCache(); })
    .catch(err => {
      Object.assign(item, before);
      render();
      toast('Nicht gespeichert: ' + err.message, true);
    });
}
function saveCache() {
  store.set(LS_CACHE, { url: state.settings.url, items: state.items, at: new Date().toISOString() });
}
function setOwned(item, owned) {
  const fields = owned
    ? { anzahl: Math.max(1, item.anzahl), wunsch: false }
    : { anzahl: 0 };
  return changeItem(item, fields);
}

/* ---------------- Rendering ---------------- */
function render() {
  renderSync();
  if (state.view === 'sammlung') renderSammlung();
  if (state.view === 'listen') renderListen();
  if (state.view === 'statistik') renderStatistik();
  if (state.view === 'mehr') renderMehr();
  if (state.detailKey) renderDetail();
}

function renderSync() {
  const el = $('#syncState');
  if (!state.settings.url) el.textContent = 'nicht verbunden';
  else if (pendingWrites) el.textContent = 'speichert …';
  else if (state.offline) el.textContent = 'offline';
  else if (state.settings.url === DEMO_URL) el.textContent = 'Demo';
  else el.textContent = state.loadedAt ? '✓ ' + fmtTime(state.loadedAt) : '';
}

function filteredItems() {
  const q = state.search.trim().toLowerCase();
  const { series, filter } = state.ui;
  return state.items.filter(i => {
    if (series !== '*' && i.reihe !== series) return false;
    if (filter === 'habe' && i.anzahl < 1) return false;
    if (filter === 'fehlt' && i.anzahl > 0) return false;
    if (filter === 'wunsch' && !i.wunsch) return false;
    if (filter === 'doppelt' && i.anzahl < 2) return false;
    if (q) {
      if (/^\d+[a-z]?$/.test(q)) return normNr(i.nr) === normNr(q) || normNr(i.nr).startsWith(normNr(q));
      return i.titel.toLowerCase().includes(q) || (i.reihe + ' ' + i.nr).toLowerCase().includes(q) || i.notiz.toLowerCase().includes(q);
    }
    return true;
  });
}

function renderSammlung() {
  const names = seriesNames();
  if (state.ui.series !== '*' && !names.includes(state.ui.series)) state.ui.series = '*';
  $('#seriesChips').innerHTML = (names.length > 1 ? [['*', 'Alle Reihen']] : []).concat(names.map(n => [n, n]))
    .map(([v, l]) => `<button class="chip ${state.ui.series === v || (names.length === 1) ? 'on' : ''}" data-s="${esc(v)}">${esc(l)}</button>`).join('');
  $$('#stateFilter button').forEach(b => b.classList.toggle('on', b.dataset.f === state.ui.filter));
  $('#quickMode').checked = state.ui.quick;

  const list = filteredItems();
  const showSeries = state.ui.series === '*' && names.length > 1;
  const owned = list.filter(i => i.anzahl > 0).length;
  $('#countLine').textContent = list.length ? `${list.length} Bände angezeigt · ${owned} vorhanden` : '';

  const grid = $('#grid');
  grid.innerHTML = list.map(i => {
    const k = esc(keyOf(i.reihe, i.nr));
    return `<button class="tile ${i.anzahl > 0 ? 'own' : ''}" data-k="${k}" title="${esc(i.reihe + ' ' + i.nr + (i.titel ? ' – ' + i.titel : ''))}">
      ${i.wunsch ? '<span class="star">★</span>' : ''}
      ${i.anzahl > 1 ? `<span class="badge">×${i.anzahl}</span>` : ''}
      ${showSeries ? `<span class="s">${esc(shortSeries(i.reihe))}</span>` : ''}
      <span class="n">${esc(i.nr)}</span>
      ${i.titel ? `<span class="t">${esc(i.titel)}</span>` : ''}
    </button>`;
  }).join('');

  const empty = $('#emptyHint');
  if (!state.settings.url) {
    empty.hidden = false;
    empty.innerHTML = `<p><b>Willkommen!</b><br>Verbinde die App mit deinem Google Sheet – oder probiere sie erst im Demo-Modus aus.</p>
      <button class="btn primary" data-go="settings">Einrichten</button> <button class="btn ghost" data-go="demo">Demo ansehen</button>`;
  } else if (!state.items.length) {
    empty.hidden = false;
    empty.innerHTML = state.offline ? '<p>Keine Daten – keine Verbindung zum Sheet.</p>'
      : `<p>Noch keine Bände im Katalog.<br>Lege zuerst eine Reihe an (z.&nbsp;B. „LTB“ 1 bis zur aktuellen Nummer).</p>
         <button class="btn primary" data-go="series">Reihe anlegen</button>`;
  } else if (!list.length) {
    empty.hidden = false;
    empty.innerHTML = '<p>Keine Treffer.</p>';
  } else empty.hidden = true;
}

function shortSeries(name) {
  return name.replace(/^lustiges taschenbuch\s*/i, 'LTB ').replace(/^LTB\s+/i, '') || 'LTB';
}

/* Nummern zu Bereichen zusammenfassen: 1, 2, 3, 5 -> 1–3, 5 */
function compactNumbers(nrs) {
  const nums = [], other = [];
  nrs.forEach(n => (/^\d+$/.test(n) ? nums.push(parseInt(n, 10)) : other.push(n)));
  nums.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j - i >= 2 ? `${nums[i]}–${nums[j]}` : (j > i ? `${nums[i]}, ${nums[j]}` : `${nums[i]}`));
    i = j;
  }
  return out.concat(other).join(', ');
}

function listData() {
  const type = state.ui.list;
  const groups = [];
  seriesNames().forEach(name => {
    const all = state.items.filter(i => i.reihe === name);
    let sel;
    if (type === 'fehlt') sel = all.filter(i => i.anzahl < 1);
    else if (type === 'wunsch') sel = all.filter(i => i.wunsch);
    else sel = all.filter(i => i.anzahl > 1);
    if (sel.length) groups.push({ name, items: sel });
  });
  return groups;
}

function renderListen() {
  $$('#listType button').forEach(b => b.classList.toggle('on', b.dataset.l === state.ui.list));
  $('#btnShareList').hidden = !navigator.share;
  const groups = listData();
  const type = state.ui.list;
  if (!groups.length) {
    $('#listOut').innerHTML = `<p class="empty">${type === 'fehlt' ? 'Nichts fehlt – Glückwunsch! 🎉' : type === 'wunsch' ? 'Wunschliste ist leer. Markiere Bände in der Detailansicht mit ★.' : 'Keine doppelten Bände.'}</p>`;
    return;
  }
  $('#listOut').innerHTML = groups.map(g => {
    let body;
    if (type === 'fehlt') body = `<div class="nums">${esc(compactNumbers(g.items.map(i => i.nr)))}</div>`;
    else body = '<ul>' + g.items.map(i => `<li><a href="#" data-k="${esc(keyOf(i.reihe, i.nr))}"><b>${esc(i.nr)}</b></a>${i.titel ? ' – ' + esc(i.titel) : ''}${type === 'doppelt' ? ` <span class="muted">(${i.anzahl}×${i.zustand ? ', ' + esc(i.zustand) : ''})</span>` : ''}</li>`).join('') + '</ul>';
    return `<div class="grp"><h3>${esc(g.name)} <span>${g.items.length}</span></h3>${body}</div>`;
  }).join('');
}

function listAsText() {
  const type = state.ui.list;
  const title = { fehlt: 'Fehlliste', wunsch: 'Wunschliste', doppelt: 'Doppelte (zum Tauschen)' }[type];
  const lines = [title + ' – Stand ' + new Date().toLocaleDateString('de-DE'), ''];
  listData().forEach(g => {
    if (type === 'fehlt') lines.push(`${g.name}: ${compactNumbers(g.items.map(i => i.nr))}`);
    else {
      lines.push(g.name + ':');
      g.items.forEach(i => lines.push(`  ${i.nr}${i.titel ? ' – ' + i.titel : ''}${type === 'doppelt' ? ` (${i.anzahl - 1}× übrig)` : ''}`));
    }
  });
  return lines.join('\n');
}

function renderStatistik() {
  const all = state.items;
  const owned = all.filter(i => i.anzahl > 0);
  const copies = all.reduce((s, i) => s + i.anzahl, 0);
  const doubles = all.filter(i => i.anzahl > 1);
  const pct = all.length ? Math.round(owned.length / all.length * 100) : 0;
  $('#statTiles').innerHTML = [
    [owned.length, 'verschiedene Bände'],
    [pct + ' %', 'vom Katalog'],
    [copies, 'Hefte insgesamt'],
    [doubles.reduce((s, i) => s + i.anzahl - 1, 0), 'doppelte Exemplare'],
    [all.filter(i => i.wunsch).length, 'auf der Wunschliste'],
    [all.length - owned.length, 'fehlen noch'],
  ].map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  $('#statSeries').innerHTML = seriesNames().map(name => {
    const s = all.filter(i => i.reihe === name);
    const o = s.filter(i => i.anzahl > 0).length;
    const p = s.length ? (o / s.length * 100) : 0;
    return `<div class="bar-row"><div class="top"><b>${esc(name)}</b><span>${o} / ${s.length} · ${Math.round(p)} %</span></div>
      <div class="bar"><i style="width:${p.toFixed(1)}%"></i></div></div>`;
  }).join('') || '<p class="muted">Noch keine Daten.</p>';

  const recent = all.filter(i => i.geaendert).sort((a, b) => String(b.geaendert).localeCompare(String(a.geaendert))).slice(0, 12);
  $('#statRecent').innerHTML = recent.map(i =>
    `<li><div><b>${esc(i.reihe)} ${esc(i.nr)}</b> ${i.anzahl > 0 ? (i.anzahl > 1 ? i.anzahl + '× vorhanden' : 'vorhanden') : 'fehlt'}${i.wunsch ? ' ★' : ''}</div>
      <span>${esc(i.von || '')} · ${esc(fmtDate(i.geaendert))}</span></li>`).join('') || '<li class="muted">–</li>';
}

function renderMehr() {
  const names = seriesNames();
  const opts = (names.length ? names : ['LTB']).map(n => `<option>${esc(n)}</option>`).join('');
  ['#impSeries', '#katSeries'].forEach(sel => {
    const el = $(sel), prev = el.value;
    el.innerHTML = opts;
    if (prev && (names.includes(prev))) el.value = prev;
  });
  $('#seriesList').innerHTML = ['LTB', 'LTB Spezial', 'LTB Enten-Edition', 'LTB Ultimate', 'LTB Premium', ...names]
    .filter((v, i, a) => a.indexOf(v) === i).map(n => `<option value="${esc(n)}">`).join('');
  const s = state.settings;
  if (document.activeElement?.closest('#cardSettings') == null) {
    $('#setUrl').value = s.url === DEMO_URL ? '' : s.url;
    $('#setKey').value = s.url === DEMO_URL ? '' : s.key;
    $('#setUser').value = s.user;
  }
  $('#setupShare').hidden = !s.url || s.url === DEMO_URL;
  $('#versionLine').textContent = 'Version ' + APP_VERSION + (s.url === DEMO_URL ? ' · Demo-Modus' : '');
}

/* ---------------- Detail-Dialog ---------------- */
function openDetail(item) {
  state.detailKey = keyOf(item.reihe, item.nr);
  renderDetail();
  const d = $('#detail');
  if (!d.open) d.showModal();
}
function renderDetail() {
  const item = state.items.find(i => keyOf(i.reihe, i.nr) === state.detailKey);
  if (!item) return;
  $('#dSeries').textContent = item.reihe;
  $('#dNr').textContent = 'Nr. ' + item.nr;
  if (document.activeElement !== $('#dTitle')) $('#dTitle').value = item.titel;
  const own = item.anzahl > 0;
  const ob = $('#dOwn');
  ob.classList.toggle('on', own);
  ob.textContent = own ? '✓ Hab ich' : 'Fehlt – antippen zum Abhaken';
  $('#dCount').textContent = item.anzahl;
  $('#dMinus').disabled = item.anzahl <= 0;
  const wb = $('#dWish');
  wb.classList.toggle('on', item.wunsch);
  wb.textContent = item.wunsch ? '★ Auf der Wunschliste' : '☆ Auf die Wunschliste';
  $('#dCond').value = item.zustand;
  if (document.activeElement !== $('#dNote')) $('#dNote').value = item.notiz;
  $('#dMeta').textContent = item.geaendert ? `Zuletzt geändert ${fmtDate(item.geaendert)}${item.von ? ' von ' + item.von : ''}` : '';
}
function detailItem() { return state.items.find(i => keyOf(i.reihe, i.nr) === state.detailKey); }

/* ---------------- Import ---------------- */
function normSeries(s) {
  return s.toLowerCase().replace(/lustiges?\s*taschenbuch/g, 'ltb').replace(/[^a-z0-9äöüß]/g, '');
}
function resolveSeries(prefix, def, names) {
  if (!prefix) return def;
  const p = normSeries(prefix);
  if (!p) return def;
  const exact = names.find(n => normSeries(n) === p);
  if (exact) return exact;
  const withLtb = names.find(n => normSeries(n) === 'ltb' + p);
  if (withLtb) return withLtb;
  const partial = names.filter(n => normSeries(n).includes(p));
  if (partial.length === 1) return partial[0];
  return null;
}

/** Text wie "1, 2, 5-9, LTB 12, Spezial 45 x2" in Einträge zerlegen. */
function parseBestand(text, def, names) {
  const items = [], unknown = [], bad = [];
  text.split(/[,;\n\r]+/).map(t => t.trim()).filter(Boolean).forEach(tok => {
    const clean = tok.replace(/[?]/g, '').replace(/^(nr\.?|band|bd\.?)\s*/i, '').trim();
    const m = clean.match(/^(.*?)[\s#.:-]*(\d+[a-z]?)(?:\s*[-–]\s*(\d+))?(?:\s*[x×]\s*(\d+))?$/i);
    if (!m) { bad.push(tok); return; }
    let prefix = m[1].replace(/(nr\.?|band|bd\.?)\s*$/i, '').trim();
    const reihe = resolveSeries(prefix, def, names);
    if (!reihe) { unknown.push(tok); return; }
    const from = m[2], to = m[3] ? parseInt(m[3], 10) : null, mult = m[4] ? parseInt(m[4], 10) : 1;
    if (to !== null && /^\d+$/.test(from)) {
      const f = parseInt(from, 10);
      if (to < f || to - f > 2000) { bad.push(tok); return; }
      for (let n = f; n <= to; n++) for (let k = 0; k < mult; k++) items.push({ reihe, nr: String(n) });
    } else {
      for (let k = 0; k < mult; k++) items.push({ reihe, nr: normNr(from) });
    }
  });
  return { items, unknown, bad };
}

function parseKatalog(text, def) {
  const items = [], bad = [];
  text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
    let parts = line.split(/\t|;/).map(p => p.trim());
    if (parts.length >= 3) { items.push({ reihe: parts[0], nr: normNr(parts[1]), titel: parts.slice(2).join('; ') }); return; }
    if (parts.length === 2 && /^\d+[a-z]?$/i.test(parts[0])) { items.push({ reihe: def, nr: normNr(parts[0]), titel: parts[1] }); return; }
    const m = line.match(/^(?:nr\.?\s*)?(\d+[a-z]?)\s*[:.\-–]\s*(.+)$/i);
    if (m) { items.push({ reihe: def, nr: normNr(m[1]), titel: m[2].trim() }); return; }
    bad.push(line);
  });
  return { items, bad };
}

let impParsed = null;
function previewImport() {
  const def = $('#impSeries').value || 'LTB';
  impParsed = parseBestand($('#impText').value, def, seriesNames().length ? seriesNames() : [def]);
  const { items, unknown, bad } = impParsed;
  const counts = new Map(), bySeries = new Map();
  items.forEach(i => { const k = keyOf(i.reihe, i.nr); counts.set(k, (counts.get(k) || 0) + 1); });
  let notInCatalog = 0, already = 0;
  counts.forEach((c, k) => {
    const [r] = k.split('|');
    const it = state.items.find(x => keyOf(x.reihe, x.nr) === k);
    const name = it ? it.reihe : items.find(x => keyOf(x.reihe, x.nr) === k).reihe;
    bySeries.set(name, (bySeries.get(name) || 0) + 1);
    if (!it) notInCatalog++; else if (it.anzahl >= c) already++;
  });
  const dupl = [...counts.values()].filter(c => c > 1).length;
  let html = `<p class="good"><b>${counts.size}</b> verschiedene Bände erkannt` +
    (bySeries.size ? ' (' + [...bySeries].map(([n, c]) => `${esc(n)}: ${c}`).join(', ') + ')' : '') + '.</p>';
  if (dupl) html += `<p>${dupl} davon mehrfach → werden als Doppelte gezählt.</p>`;
  if (already) html += `<p class="muted">${already} sind bereits so eingetragen (bleiben unverändert).</p>`;
  if (notInCatalog) html += `<p>${notInCatalog} stehen noch nicht im Katalog und werden neu angelegt.</p>`;
  if (unknown.length) html += `<p class="warn">Unbekannte Reihe (übersprungen): ${esc(unknown.slice(0, 15).join(', '))}${unknown.length > 15 ? ' …' : ''}<br><span class="muted">Tipp: Reihe zuerst anlegen oder als Standard-Reihe auswählen.</span></p>`;
  if (bad.length) html += `<p class="warn">Nicht lesbar (übersprungen): ${esc(bad.slice(0, 15).join(', '))}${bad.length > 15 ? ' …' : ''}</p>`;
  $('#impPreview').innerHTML = html;
  $('#btnImpGo').disabled = !items.length;
}

async function runImport() {
  if (!impParsed || !impParsed.items.length) return;
  const btn = $('#btnImpGo'); btn.disabled = true;
  try {
    const r = await queueWrite(() => api('import', { mode: 'bestand', items: impParsed.items }));
    $('#impPreview').innerHTML = `<p class="good">Fertig: ${r.neu} neu angelegt, ${r.geaendert} aktualisiert, ${r.unveraendert} unverändert.</p>`;
    $('#impText').value = ''; impParsed = null;
    toast('Import abgeschlossen');
    await load({ silent: true });
  } catch (err) {
    toast('Import fehlgeschlagen: ' + err.message, true);
    btn.disabled = false;
  }
}

/* ---------------- Demo-Backend (nur lokal im Browser) ---------------- */
function demoData() {
  let d = store.get(LS_DEMO, null);
  if (!d) {
    d = [];
    const titles = { 1: 'Der Kolumbusfalter', 2: 'Hallo, hier Micky!', 3: 'Donald, der Erfinder' };
    for (let n = 1; n <= 80; n++) d.push({ reihe: 'LTB', nr: String(n), titel: titles[n] || '', anzahl: (n % 3 === 0 || n < 12) ? (n % 10 === 0 ? 2 : 1) : 0, wunsch: n === 14 || n === 41, zustand: '', notiz: '', geaendert: '', von: '' });
    for (let n = 1; n <= 25; n++) d.push({ reihe: 'LTB Spezial', nr: String(n), titel: '', anzahl: n % 4 === 0 ? 1 : 0, wunsch: false, zustand: '', notiz: '', geaendert: '', von: '' });
    store.set(LS_DEMO, d);
  }
  return d;
}
async function demoApi(action, p) {
  await new Promise(r => setTimeout(r, 150));
  const d = demoData();
  const now = new Date().toISOString(), user = state.settings.user;
  const find = (r, n) => d.find(i => keyOf(i.reihe, i.nr) === keyOf(r, n));
  const save = () => store.set(LS_DEMO, d);
  if (action === 'ping') return { ok: true };
  if (action === 'list') return { ok: true, items: JSON.parse(JSON.stringify(d)) };
  if (action === 'update') {
    let it = find(p.reihe, p.nr);
    if (!it) { it = { reihe: p.reihe, nr: p.nr, titel: '', anzahl: 0, wunsch: false, zustand: '', notiz: '' }; d.push(it); }
    Object.assign(it, p.fields, { geaendert: now, von: user }); save();
    return { ok: true, item: Object.assign({}, it) };
  }
  if (action === 'import' || action === 'addSeries') {
    let items = p.items, mode = p.mode;
    if (action === 'addSeries') { items = []; mode = 'katalog'; for (let n = +p.von; n <= +p.bis; n++) items.push({ reihe: p.reihe, nr: String(n) }); }
    const inc = new Map();
    items.forEach(i => { const k = keyOf(i.reihe, i.nr); const x = inc.get(k); if (x) { x.count++; if (i.titel) x.titel = i.titel; } else inc.set(k, Object.assign({ count: 1 }, i)); });
    let neu = 0, geaendert = 0, unveraendert = 0;
    inc.forEach(x => {
      const it = find(x.reihe, x.nr);
      if (!it) { d.push({ reihe: x.reihe, nr: x.nr, titel: x.titel || '', anzahl: mode === 'bestand' ? x.count : 0, wunsch: false, zustand: '', notiz: '', geaendert: now, von: user }); neu++; return; }
      let dirty = false;
      if (mode === 'bestand') { if (x.count > it.anzahl) { it.anzahl = x.count; dirty = true; } if (it.wunsch) { it.wunsch = false; dirty = true; } }
      else if (x.titel && x.titel !== it.titel) { it.titel = x.titel; dirty = true; }
      if (dirty) { it.geaendert = now; it.von = user; geaendert++; } else unveraendert++;
    });
    save();
    return { ok: true, neu, geaendert, unveraendert };
  }
  return { ok: false, error: 'Unbekannte Aktion' };
}

/* ---------------- Einrichtungslink ---------------- */
function b64urlEncode(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }

function setupLink() {
  const base = location.href.split('#')[0];
  return base + '#setup=' + b64urlEncode(JSON.stringify({ u: state.settings.url, k: state.settings.key }));
}
function showSetupQr() {
  if (typeof qrcode !== 'function') { toast('QR-Code nicht verfügbar', true); return; }
  const qr = qrcode(0, 'M');           // Größe automatisch, mittlere Fehlerkorrektur
  qr.addData(setupLink());
  qr.make();
  $('#qrBox').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
  $('#qrDialog').showModal();
}
function consumeSetupHash() {
  const m = location.hash.match(/setup=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const { u, k } = JSON.parse(b64urlDecode(m[1]));
    if (u && k) {
      state.settings.url = u; state.settings.key = k;
      store.set(LS_SETTINGS, state.settings);
    }
  } catch { toast('Einrichtungslink ungültig', true); }
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

/* ---------------- Hilfen ---------------- */
function fmtDate(d) {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return String(d);
  return x.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + fmtTime(x);
}
function fmtTime(d) { return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), err ? 4500 : 2200);
}
function showBanner(msg) { const b = $('#banner'); b.textContent = msg; b.hidden = false; }
function hideBanner() { $('#banner').hidden = true; }

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { }
    ta.remove(); return ok;
  }
}
function saveUi() { store.set(LS_UI, { series: state.ui.series, filter: state.ui.filter, list: state.ui.list, quick: state.ui.quick }); }

function setView(v) {
  state.view = v;
  $$('.view').forEach(s => s.hidden = s.id !== 'view-' + v);
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  window.scrollTo(0, 0);
  render();
}
function openCard(id) {
  setView('mehr');
  const c = $(id); c.open = true; c.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- Ereignisse ---------------- */
function bind() {
  $$('.tabbar button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#btnRefresh').addEventListener('click', () => load());

  let searchTimer;
  $('#search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value; renderSammlung(); }, 120);
  });
  $('#seriesChips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.ui.series = b.dataset.s; saveUi(); renderSammlung();
  });
  $('#stateFilter').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.ui.filter = b.dataset.f; saveUi(); renderSammlung();
  });
  $('#quickMode').addEventListener('change', e => {
    state.ui.quick = e.target.checked; saveUi();
    toast(state.ui.quick ? 'Schnellmodus: Antippen hakt ab bzw. wieder aus' : 'Antippen öffnet die Details');
  });

  $('#grid').addEventListener('click', e => {
    const t = e.target.closest('.tile'); if (!t) return;
    const item = state.items.find(i => keyOf(i.reihe, i.nr) === t.dataset.k); if (!item) return;
    if (state.ui.quick && item.anzahl <= 1) {
      setOwned(item, item.anzahl < 1);
      requestAnimationFrame(() => { const el = $(`.tile[data-k="${CSS.escape(t.dataset.k)}"]`); el && el.classList.add('flash'); });
      if (navigator.vibrate) navigator.vibrate(15);
    } else openDetail(item);
  });
  $('#emptyHint').addEventListener('click', e => {
    const g = e.target.closest('[data-go]'); if (!g) return;
    if (g.dataset.go === 'settings') openCard('#cardSettings');
    if (g.dataset.go === 'demo') startDemo();
    if (g.dataset.go === 'series') openCard('#cardSeries');
  });

  // Listen
  $('#listType').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.ui.list = b.dataset.l; saveUi(); renderListen();
  });
  $('#listOut').addEventListener('click', e => {
    const a = e.target.closest('a[data-k]'); if (!a) return; e.preventDefault();
    const it = state.items.find(i => keyOf(i.reihe, i.nr) === a.dataset.k); if (it) openDetail(it);
  });
  $('#btnCopyList').addEventListener('click', async () => toast(await copyText(listAsText()) ? 'Liste kopiert' : 'Kopieren nicht möglich', false));
  $('#btnShareList').addEventListener('click', () => navigator.share({ title: 'LTB-Liste', text: listAsText() }).catch(() => {}));

  // Detail
  $('#dOwn').addEventListener('click', () => { const i = detailItem(); if (i) setOwned(i, i.anzahl < 1); });
  $('#dPlus').addEventListener('click', () => { const i = detailItem(); if (i) changeItem(i, i.anzahl < 1 ? { anzahl: 1, wunsch: false } : { anzahl: i.anzahl + 1 }); });
  $('#dMinus').addEventListener('click', () => { const i = detailItem(); if (i && i.anzahl > 0) changeItem(i, { anzahl: i.anzahl - 1 }); });
  $('#dWish').addEventListener('click', () => { const i = detailItem(); if (i) changeItem(i, { wunsch: !i.wunsch }); });
  $('#dCond').addEventListener('change', e => { const i = detailItem(); if (i) changeItem(i, { zustand: e.target.value }); });
  $('#dNote').addEventListener('change', e => { const i = detailItem(); if (i && e.target.value !== i.notiz) changeItem(i, { notiz: e.target.value }); });
  $('#dTitle').addEventListener('change', e => { const i = detailItem(); if (i && e.target.value !== i.titel) changeItem(i, { titel: e.target.value.trim() }); });
  const d = $('#detail');
  d.addEventListener('close', () => { document.activeElement?.blur?.(); state.detailKey = null; });
  d.addEventListener('click', e => { if (e.target === d) d.close(); }); // Klick auf Hintergrund

  // Import
  $('#btnImpPreview').addEventListener('click', previewImport);
  $('#impText').addEventListener('input', () => { $('#btnImpGo').disabled = true; });
  $('#btnImpGo').addEventListener('click', runImport);
  $('#btnCopyPrompt').addEventListener('click', async () => toast(await copyText($('#aiPrompt').textContent) ? 'Prompt kopiert' : 'Kopieren nicht möglich'));

  // Katalog
  $('#btnAddSeries').addEventListener('click', async () => {
    const reihe = $('#serName').value.trim(), von = parseInt($('#serFrom').value, 10), bis = parseInt($('#serTo').value, 10);
    if (!reihe || isNaN(von) || isNaN(bis) || bis < von) { toast('Bitte Name sowie „von“ und „bis“ angeben', true); return; }
    try {
      const r = await queueWrite(() => api('addSeries', { reihe, von, bis }));
      toast(`${reihe}: ${r.neu} Bände angelegt`);
      await load({ silent: true });
    } catch (err) { toast(err.message, true); }
  });
  $('#btnKatImport').addEventListener('click', async () => {
    const { items, bad } = parseKatalog($('#katText').value, $('#katSeries').value || 'LTB');
    if (!items.length) { $('#katResult').innerHTML = '<p class="warn">Keine Zeilen erkannt.</p>'; return; }
    try {
      const r = await queueWrite(() => api('import', { mode: 'katalog', items }));
      $('#katResult').innerHTML = `<p class="good">${r.geaendert} Titel gesetzt, ${r.neu} Bände neu angelegt, ${r.unveraendert} unverändert.</p>` +
        (bad.length ? `<p class="warn">${bad.length} Zeilen nicht lesbar: ${esc(bad.slice(0, 5).join(' | '))}</p>` : '');
      $('#katText').value = '';
      await load({ silent: true });
    } catch (err) { toast(err.message, true); }
  });

  // Einstellungen
  $('#btnSaveSettings').addEventListener('click', async () => {
    let url = $('#setUrl').value.trim();
    const key = $('#setKey').value.trim(), user = $('#setUser').value.trim();
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      $('#setResult').innerHTML = '<p class="warn">Die URL sollte mit https://script.google.com/… beginnen und auf /exec enden.</p>'; return;
    }
    const prev = state.settings;
    state.settings = { url, key, user };
    try {
      if (url) await api('ping');
      store.set(LS_SETTINGS, state.settings);
      if (prev.url !== url) state.items = [];
      $('#setResult').innerHTML = url ? '<p class="good">Verbindung klappt ✓</p>' : '<p>Gespeichert.</p>';
      await load({ silent: true });
    } catch (err) {
      state.settings = prev;
      $('#setResult').innerHTML = `<p class="warn">Verbindung fehlgeschlagen: ${esc(err.message)}</p>`;
    }
  });
  $('#btnDemo').addEventListener('click', startDemo);
  $('#btnShareSetup').addEventListener('click', async () => {
    const link = setupLink();
    if (navigator.share) navigator.share({ title: 'LTB-Sammlung einrichten', text: 'Öffne den Link in Chrome, dann „Zum Startbildschirm hinzufügen“:', url: link }).catch(() => {});
    else toast(await copyText(link) ? 'Link kopiert' : 'Kopieren nicht möglich');
  });

  $('#btnShowQr').addEventListener('click', showSetupQr);
  $('#qrDialog').addEventListener('click', e => { if (e.target.id === 'qrDialog') e.target.close(); });

  // Export
  $('#btnExport').addEventListener('click', () => {
    const head = ['Reihe', 'Nr', 'Titel', 'Anzahl', 'Wunsch', 'Zustand', 'Notiz', 'Geändert', 'Von'];
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const csv = [head.join(';')].concat(state.items.map(i => [i.reihe, i.nr, i.titel, i.anzahl, i.wunsch ? 'ja' : '', i.zustand, i.notiz, i.geaendert, i.von].map(q).join(';'))).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'ltb-sammlung-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // Beim Zurückkehren in die App aktualisieren (andere haben evtl. etwas geändert)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.settings.url && !pendingWrites &&
        (!state.loadedAt || Date.now() - state.loadedAt.getTime() > 30000)) load({ silent: true });
  });
  window.addEventListener('online', () => load({ silent: true }));
}

function startDemo() {
  state.settings = { url: DEMO_URL, key: '', user: state.settings.user || 'Demo' };
  store.set(LS_SETTINGS, state.settings);
  state.items = [];
  toast('Demo-Modus – Daten bleiben nur auf diesem Gerät');
  setView('sammlung');
  load();
}

/* ---------------- Start ---------------- */
function init() {
  bind();
  const fromLink = consumeSetupHash();
  const cache = store.get(LS_CACHE, null);
  if (cache && cache.url === state.settings.url && state.settings.url !== DEMO_URL) {
    state.items = cache.items; state.loadedAt = new Date(cache.at);
  }
  setView('sammlung');
  load({ silent: false });
  if (fromLink) {
    toast('Verbunden! Trag bitte noch deinen Namen ein.');
    if (!state.settings.user) openCard('#cardSettings');
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
document.addEventListener('DOMContentLoaded', init);
