'use strict';
// v0.5（LOGILESSの「出荷作業中」＋ロジクラのトータルピッキング）で足した機能: 出荷作業グループ・グループ解除・トータルピッキングリスト
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, withCheck } = require('./gas-fake');

const J1 = '4901777300446';
const J2 = withCheck('490123456789');
const J3 = withCheck('450000000001');
const SLIP = '出荷伝票';

function setup() {
  const env = createEnv();
  env.post('masterUpsert', { jan: J1, name: '商品A', price: 100, location: 'a-01' });
  env.post('masterUpsert', { jan: J2, name: '商品B', price: 200, location: 'A-02' });
  env.post('masterUpsert', { jan: J3, name: '商品C', price: 300 });          // ロケなし → 最後
  env.post('receive', { jan: J1, qty: 10 });
  env.post('receive', { jan: J2, qty: 5 });
  env.post('receive', { jan: J3, qty: 3 });
  return env;
}
const slip = (env, no, items) => env.post('slipCreate', { no, items });
const get = (env, no) => env.get('slipGet', { no }).slip;
const sheetRow = (env, no) => env.sheet(SLIP).dump().find((r) => r[1] === no);

test('出荷作業を開始: 選んだ伝票が作業グループに入る。状態（検品の進み）は変えない。シートに記録される', () => {
  const env = setup();
  slip(env, 'S1', [{ code: J1, qty: 2 }]);
  slip(env, 'S2', [{ code: J2, qty: 1 }]);
  slip(env, 'S3', [{ code: J3, qty: 1 }]);
  env.post('slipInspect', { no: 'S2', items: [{ jan: J2, count: 1 }] });   // 検品済
  const r = env.post('slipGroupStart', { nos: ['S1', 'S2'], name: '午前便' });
  assert.equal(r.ok, true);
  assert.equal(r.group, '午前便');
  assert.equal(r.started, 2);
  assert.equal(get(env, 'S1').group, '午前便');
  assert.equal(get(env, 'S1').status, '未検品');
  assert.equal(get(env, 'S2').status, '検品済');
  assert.equal(get(env, 'S3').group, '');
  assert.match(get(env, 'S1').groupAt, /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/);
  const row = sheetRow(env, 'S1');
  assert.equal(row[10], '午前便');
  assert.equal(row[11], get(env, 'S1').groupAt);
  assert.equal(sheetRow(env, 'S3')[10], '');
});

test('グループ名を省くと自動で付く。同じ名前で続けて追加できる。重複した伝票番号・全角/大小のゆれは1件にまとまる', () => {
  const env = setup();
  slip(env, 'ab-1', [{ code: J1, qty: 1 }]);
  slip(env, 'S2', [{ code: J2, qty: 1 }]);
  const r = env.post('slipGroupStart', { nos: ['AB-1', 'ab-1'] });
  assert.equal(r.started, 1);
  assert.match(r.group, /^G-\d{12}$/);
  const r2 = env.post('slipGroupStart', { nos: ['S2'], name: r.group });
  assert.equal(r2.group, r.group);
  assert.equal(get(env, 'S2').group, r.group);
  assert.equal(env.post('slipGroupStart', { nos: ['AB-1'], name: r.group }).ok, true, '同じグループへの再実行は何も壊さない');
});

test('出荷作業を開始できない伝票が1つでもあれば、何も変えない（別グループ・出荷済み・キャンセル・存在しない番号）', () => {
  const env = setup();
  slip(env, 'S1', [{ code: J1, qty: 1 }]);
  slip(env, 'S2', [{ code: J2, qty: 1 }]);
  slip(env, 'S3', [{ code: J3, qty: 1 }]);
  slip(env, 'S4', [{ code: J1, qty: 1 }]);
  env.post('slipGroupStart', { nos: ['S3'], name: 'A便' });
  env.post('slipInspect', { no: 'S2', items: [{ jan: J2, count: 1 }] });
  env.post('slipShip', { no: 'S2' });
  env.post('slipVoid', { no: 'S4' });
  const before = JSON.stringify(env.sheet(SLIP).dump());
  const r = env.raw('POST', JSON.stringify({ action: 'slipGroupStart', token: 'dev-token-0123456789abcdef', nos: ['S1', 'S2', 'S3', 'S4', 'NOPE'], name: 'B便' }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_state');
  assert.equal(r.errors ? r.errors.length : (r.extra && r.extra.errors.length), 4);
  assert.equal(JSON.stringify(env.sheet(SLIP).dump()), before, 'シートは変わらない');
  const empty = env.raw('POST', JSON.stringify({ action: 'slipGroupStart', token: 'dev-token-0123456789abcdef', nos: [] }));
  assert.equal(empty.error, 'bad_request');
});

test('出荷作業中の伝票はキャンセルできない。出荷待ちに戻すとキャンセルできる。検品の途中経過は消えない', () => {
  const env = setup();
  slip(env, 'S1', [{ code: J1, qty: 3 }]);
  env.post('slipInspect', { no: 'S1', items: [{ jan: J1, count: 1 }] });
  env.post('slipGroupStart', { nos: ['S1'], name: 'G1' });
  const v = env.raw('POST', JSON.stringify({ action: 'slipVoid', token: 'dev-token-0123456789abcdef', no: 'S1' }));
  assert.equal(v.error, 'grouped');
  assert.match(v.message, /出荷待ちに戻す/);
  const rel = env.post('slipGroupRelease', { nos: ['S1'] });
  assert.equal(rel.released, 1);
  assert.equal(get(env, 'S1').group, '');
  assert.equal(get(env, 'S1').status, '検品中');
  assert.equal(env.get('slipGet', { no: 'S1' }).lines[0].done, 1);
  assert.equal(env.post('slipVoid', { no: 'S1' }).slip.status, 'キャンセル');
});

test('グループ名で一括して出荷待ちに戻せる。作業中でない伝票だけを指定するとエラー。出荷済みは戻せない', () => {
  const env = setup();
  slip(env, 'S1', [{ code: J1, qty: 1 }]);
  slip(env, 'S2', [{ code: J2, qty: 1 }]);
  slip(env, 'S3', [{ code: J3, qty: 1 }]);
  env.post('slipGroupStart', { nos: ['S1', 'S2', 'S3'], name: 'G1' });
  env.post('slipInspect', { no: 'S1', items: [{ jan: J1, count: 1 }] });
  env.post('slipShip', { no: 'S1' });
  assert.equal(get(env, 'S1').group, 'G1', '出荷済みでも履歴としてグループ名は残る');
  const rel = env.post('slipGroupRelease', { group: 'G1' });
  assert.equal(rel.released, 2, '出荷済みは対象外');
  assert.equal(get(env, 'S2').group, '');
  assert.equal(get(env, 'S1').group, 'G1');
  const none = env.raw('POST', JSON.stringify({ action: 'slipGroupRelease', token: 'dev-token-0123456789abcdef', nos: ['S2', 'S3'] }));
  assert.equal(none.error, 'not_found');
});

test('作業中のまま検品・送り状の登録・出荷ができる（出荷で在庫が減る）', () => {
  const env = setup();
  slip(env, 'S1', [{ code: J1, qty: 2 }]);
  env.post('slipGroupStart', { nos: ['S1'], name: 'G1' });
  env.post('slipTracking', { no: 'S1', tracking: '123456789012' });
  const bad = env.raw('POST', JSON.stringify({ action: 'slipInspect', token: 'dev-token-0123456789abcdef', no: 'S1', items: [{ jan: J1, count: 2 }] }));
  assert.equal(bad.error, 'tracking_required');
  const ok = env.post('slipInspect', { no: 'S1', items: [{ jan: J1, count: 2 }], tracking: '123456789012' });
  assert.equal(ok.slip.status, '検品済');
  assert.equal(ok.slip.group, 'G1');
  env.post('slipShip', { no: 'S1' });
  assert.equal(env.get('masterGet', { jan: J1 }).item.stock, 8);
  assert.equal(get(env, 'S1').status, '出荷済');
});

test('トータルピッキングリスト: 商品ごとに合計し、ロケーション順（ロケなしは最後）。出荷済み・キャンセルは除く', () => {
  const env = setup();
  slip(env, 'S1', [{ code: J3, qty: 1 }, { code: J1, qty: 2 }]);
  slip(env, 'S2', [{ code: J2, qty: 1 }, { code: J1, qty: 1 }]);
  slip(env, 'S3', [{ code: J1, qty: 5 }]);
  slip(env, 'S4', [{ code: J2, qty: 2 }]);
  env.post('slipGroupStart', { nos: ['S1', 'S2', 'S3', 'S4'], name: 'G1' });
  env.post('slipInspect', { no: 'S3', items: [{ jan: J1, count: 5 }] });
  env.post('slipShip', { no: 'S3' });
  env.post('slipGroupRelease', { nos: ['S4'] });
  env.post('slipVoid', { no: 'S4' });
  const r = env.post('slipPicking', { group: 'G1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.slips.map((x) => x.no).sort(), ['S1', 'S2']);
  assert.deepEqual(r.lines.map((l) => [l.jan, l.location, l.qty, l.orders]), [
    [J1, 'A-01', 3, 2],
    [J2, 'A-02', 1, 1],
    [J3, '', 1, 1],
  ]);
  assert.equal(r.lines[0].name, '商品A');
  assert.equal(r.lines[0].stock, 5, 'S3の出荷（5個）のあとの在庫');
  assert.equal(r.totalQty, 5);
  const byNos = env.post('slipPicking', { nos: ['S2'] });
  assert.deepEqual(byNos.lines.map((l) => [l.jan, l.qty]), [[J1, 1], [J2, 1]]);
  const none = env.raw('POST', JSON.stringify({ action: 'slipPicking', token: 'dev-token-0123456789abcdef', group: 'NOPE' }));
  assert.equal(none.error, 'not_found');
});

test('新しいAPIはPOSTのみ。合言葉が無いと拒否される。ピッキングは何も書き込まない', () => {
  const env = setup();
  slip(env, 'S1', [{ code: J1, qty: 1 }]);
  env.post('slipGroupStart', { nos: ['S1'], name: 'G1' });
  const g = env.raw('GET', { action: 'slipGroupStart', token: 'dev-token-0123456789abcdef', nos: 'S1' });
  assert.equal(g.error, 'bad_request');
  const g2 = env.raw('GET', { action: 'slipPicking', token: 'dev-token-0123456789abcdef', group: 'G1' });
  assert.equal(g2.error, 'bad_request');
  const noTok = env.raw('POST', JSON.stringify({ action: 'slipPicking', group: 'G1' }));
  assert.equal(noTok.ok, false);
  const snap = JSON.stringify(env.sheet(SLIP).dump());
  env.post('slipPicking', { group: 'G1' });
  assert.equal(JSON.stringify(env.sheet(SLIP).dump()), snap);
});

test('グループ名は改行が空白になり30文字まで。数式として解釈される文字列はそのまま文字列で保存', () => {
  const env = setup();
  slip(env, 'S1', [{ code: J1, qty: 1 }]);
  const r = env.post('slipGroupStart', { nos: ['S1'], name: '=1+1\n' + 'x'.repeat(50) });
  assert.ok(r.group.length <= 30);
  assert.ok(!/\n/.test(r.group));
  assert.equal(sheetRow(env, 'S1')[10], r.group);
  assert.equal(typeof sheetRow(env, 'S1')[10], 'string');
});
