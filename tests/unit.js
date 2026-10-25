const assert = require('assert');
const { ctx, sheets, KEY } = require('./server.js');
const post = b => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ key: KEY, user: 'T' }, b)) } }).s);
const get = p => JSON.parse(ctx.doGet({ parameter: Object.assign({ key: KEY }, p) }).s);

assert.equal(get({ action: 'list', key: 'falsch' }).ok, false);
let r = post({ action: 'addSeries', reihe: 'LTB', von: 1, bis: 10 });
assert.equal(r.neu, 10, JSON.stringify(r));
r = post({ action: 'addSeries', reihe: 'LTB', von: 5, bis: 12 });
assert.equal(r.neu, 2); assert.equal(r.unveraendert, 6);
r = post({ action: 'import', mode: 'bestand', items: [{ reihe: 'LTB', nr: '3' }, { reihe: 'LTB', nr: '03' }, { reihe: 'LTB', nr: '7' }, { reihe: 'LTB Spezial', nr: '4' }] });
assert.deepEqual([r.neu, r.geaendert], [1, 2], JSON.stringify(r));
r = post({ action: 'update', reihe: 'LTB', nr: '7', fields: { wunsch: true, notiz: 'hi' } });
assert.ok(r.ok);
r = post({ action: 'import', mode: 'bestand', items: [{ reihe: 'LTB', nr: '3' }] }); // darf nicht verringern
assert.equal(r.unveraendert, 1);
r = post({ action: 'import', mode: 'katalog', items: [{ reihe: 'LTB', nr: '1', titel: 'Der Kolumbusfalter' }] });
assert.equal(r.geaendert, 1);
const items = get({ action: 'list' }).items;
const f = (s, n) => items.find(i => i.reihe === s && i.nr === n);
assert.equal(items.length, 13);
assert.equal(f('LTB', '3').anzahl, 2);
assert.equal(f('LTB', '7').anzahl, 1);
assert.equal(f('LTB', '7').wunsch, true);
assert.equal(f('LTB', '1').titel, 'Der Kolumbusfalter');
assert.equal(f('LTB Spezial', '4').anzahl, 1);
// Sortierung im Sheet: LTB 1..12, dann LTB Spezial
console.log(sheets['Bände'].data.slice(0, 15).map(r => r[0] + ' ' + r[1] + ' ' + r[3]).join(' | '));
// leere Zeile mitten im Sheet darf nichts verschieben
sheets['Bände'].data.splice(3, 0, ['', '', '', '', '', '', '', '', '']);
post({ action: 'import', mode: 'bestand', items: [{ reihe: 'LTB', nr: '10' }] });
const items2 = get({ action: 'list' }).items;
assert.equal(items2.find(i => i.nr === '10' && i.reihe === 'LTB').anzahl, 1);
assert.equal(items2.find(i => i.nr === '3' && i.reihe === 'LTB').anzahl, 2);
assert.equal(items2.length, 13);
console.log('UNIT OK');
