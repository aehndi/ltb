const { chromium } = require('playwright');
const OUT = __dirname + '/shots/';  // Screenshots landen hier
require('fs').mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  const link = Buffer.from(JSON.stringify({ u: 'http://localhost:8765/exec', k: 'abcd1234ef567890abcd' })).toString('base64url');
  await page.goto('http://localhost:8765/#setup=' + link);
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + '01-start.png' });
  // Name setzen
  await page.fill('#setUser', 'Andreas');
  // URL-Feld enthält localhost -> Validierung würde scheitern; Name direkt speichern via localStorage
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ltb.settings')); s.user = 'Andreas'; localStorage.setItem('ltb.settings', JSON.stringify(s)); });
  await page.reload(); await page.waitForTimeout(600);
  // Reihe anlegen über Leer-Hinweis
  await page.click('[data-go=series]');
  await page.fill('#serName', 'LTB'); await page.fill('#serFrom', '1'); await page.fill('#serTo', '120');
  await page.click('#btnAddSeries'); await page.waitForTimeout(800);
  await page.fill('#serName', 'LTB Spezial'); await page.fill('#serTo', '30');
  await page.click('#btnAddSeries'); await page.waitForTimeout(800);
  // Import
  await page.click('#cardImport summary').catch(() => {});
  await page.evaluate(() => document.querySelector('#cardImport').open = true);
  await page.selectOption('#impSeries', 'LTB');
  await page.fill('#impText', '1, 2, 3, 5-12, LTB 12, Spezial 4, Spezial 7 x2, Enten 3, ??, 44, 45, 46, 99');
  await page.click('#btnImpPreview'); await page.waitForTimeout(200);
  await page.locator('#cardImport').screenshot({ path: OUT + '02-import-preview.png' });
  console.log('preview:', await page.textContent('#impPreview'));
  await page.click('#btnImpGo'); await page.waitForTimeout(1200);
  console.log('after import:', await page.textContent('#impPreview'));
  // Katalogtitel
  await page.evaluate(() => [...document.querySelectorAll('details.card')].forEach(d => d.open = true));
  await page.selectOption('#katSeries', 'LTB');
  await page.fill('#katText', '1; Der Kolumbusfalter\n2\tHallo, hier Micky\n3 - Donald, der Erfinder\nLTB Spezial; 4; Ein Spezialtitel\nquatsch');
  await page.click('#btnKatImport'); await page.waitForTimeout(1200);
  console.log('katalog:', await page.textContent('#katResult'));
  // Sammlung
  await page.click('.tabbar [data-view=sammlung]'); await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '03-sammlung.png' });
  await page.click('.chip[data-s="LTB"]');
  // Schnellmodus: 20 abhaken
  await page.check('#quickMode');
  await page.click('.tile[data-k="ltb|20"]'); await page.waitForTimeout(600);
  console.log('20 own class:', await page.getAttribute('.tile[data-k="ltb|20"]', 'class'));
  await page.uncheck('#quickMode');
  // Detail auf 12 (doppelt)
  await page.click('.tile[data-k="ltb|12"]'); await page.waitForTimeout(300);
  await page.click('#dPlus'); await page.waitForTimeout(500);
  await page.click('#dWish'); await page.waitForTimeout(500);
  await page.selectOption('#dCond', 'Gut'); await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '04-detail.png' });
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await page.fill('#search', 'micky'); await page.waitForTimeout(300);
  console.log('search micky:', await page.locator('.tile').count());
  await page.fill('#search', ''); await page.waitForTimeout(300);
  await page.click('#stateFilter [data-f=doppelt]'); await page.waitForTimeout(200);
  await page.screenshot({ path: OUT + '05-doppelt.png' });
  await page.click('#stateFilter [data-f=alle]');
  // Listen
  await page.click('.tabbar [data-view=listen]'); await page.waitForTimeout(200);
  await page.screenshot({ path: OUT + '06-fehlliste.png' });
  await page.click('#listType [data-l=doppelt]'); await page.waitForTimeout(200);
  console.log('doppelt list:', await page.textContent('#listOut'));
  // Statistik
  await page.click('.tabbar [data-view=statistik]'); await page.waitForTimeout(200);
  await page.screenshot({ path: OUT + '07-statistik.png', fullPage: true });
  // Server-Stand prüfen (zweites "Handy")
  const p2 = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await p2.goto('http://localhost:8765/#setup=' + link); await p2.waitForTimeout(1000);
  const st = await p2.evaluate(() => { const c = JSON.parse(localStorage.getItem('ltb.cache')); return c.items.filter(i => i.anzahl > 0).map(i => i.reihe + ' ' + i.nr + 'x' + i.anzahl).join(', '); });
  console.log('2nd device owned:', st);
  // dark mode
  const p3 = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await p3.goto('http://localhost:8765/#setup=' + link); await p3.waitForTimeout(1000);
  await p3.screenshot({ path: OUT + '08-dark.png' });
  console.log('ERRORS:', errors);
  await browser.close();
})();
