'use strict';
// v0.4（LOGILESS踏襲）で足した機能: SKU・出庫・棚移動・入荷予定の消込・出荷伝票（取り込み／検品／出荷）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, withCheck } = require('./gas-fake');

const J1 = '4901777300446';
const J2 = withCheck('490123456789');
const J3 = withCheck('450000000001');
const J4 = withCheck('490000000002');
const UPCA = withCheck('01234567890');
const MASTER = '商品マスタ', IO = '入出荷履歴', INSP = '検品履歴', PLAN = '入荷予定', PLINE = '入荷予定明細', SLIP = '出荷伝票', SLINE = '出荷伝票明細', SKUS = '商品対応表';
const ALL = [MASTER, IO, INSP, '棚卸履歴', PLAN, PLINE, SLIP, SLINE, SKUS];

function setup() {
  const env = createEnv();
  env.post('masterUpsert', { jan: J1, name: '商品A', price: 100, location: 'a-01', sku: 'SKU-A | A-ALT' });
  env.post('masterUpsert', { jan: J2, name: '商品B', price: 200, location: 'A-02', sku: 'sku-b' });
  env.post('masterUpsert', { jan: J3, name: '商品C', price: 300, location: 'B-01' });
  env.post('receive', { jan: J1, qty: 10 });
  env.post('receive', { jan: J2, qty: 5 });
  env.post('receive', { jan: J3, qty: 3 });
  return env;
}
const stock = (env, jan) => env.get('masterGet', { jan }).item.stock;
const io = (env) => env.sheet(IO).body();
const sheetSnap = (env) => JSON.stringify(ALL.map((n) => (env.sheet(n) ? env.sheet(n).dump() : null)));

test('SKU: 登録・複数・全角/大小/空白のゆれ・検索・消去', () => {
  const env = setup();
  const it = env.get('masterGet', { jan: J1 }).item;
  assert.equal(it.sku, 'SKU-A | A-ALT');
  assert.equal(env.get('masterList', { q: 'ｓｋｕ-ｂ' }).count, 1, '全角・大小を吸収して検索できる');
  const up = env.post('masterUpsert', { jan: J1, sku: ' x-1 ｜ X-1 | y 2 ' });
  assert.equal(up.item.sku, 'x-1 | y 2', '重複（大小違い）は1つにまとめる');
  assert.equal(env.post('masterUpsert', { jan: J1, sku: '' }).item.sku, '', '空にするとSKUが消える');
  assert.equal(env.post('masterUpsert', { jan: J1, name: '商品A2' }).item.sku, '', 'skuを指定しなければ変わらない');
});

test('SKU: 別の商品と重複したら sku_conflict。何も書かない', () => {
  const env = setup();
  const snap = sheetSnap(env);
  const a = env.post('masterUpsert', { jan: J3, sku: 'SKU-B' });
  assert.equal(a.error, 'sku_conflict');
  assert.equal(a.jan, J2);
  assert.equal(env.post('skuLink', { jan: J3, sku: 'sku-a' }).error, 'sku_conflict');
  assert.equal(sheetSnap(env), snap);
  const imp = env.post('masterImport', { text: `${J3},商品C,,,,SKU-A` });
  assert.equal(imp.skipped, 1);
  assert.match(imp.errors[0].reason, /登録済み/);
  assert.equal(env.post('masterUpsert', { jan: J1, sku: 'SKU-A' }).ok, true, '自分のSKUは再指定できる');
});

test('skuLink: 追記（既存は残す）・同じSKUの再登録は何もしない・未登録JAN', () => {
  const env = setup();
  const r = env.post('skuLink', { jan: J3, sku: 'EC-C1 | EC-C2' });
  assert.equal(r.item.sku, 'EC-C1 | EC-C2');
  assert.equal(env.post('skuLink', { jan: J3, sku: 'ec-c1' }).item.sku, 'EC-C1 | EC-C2');
  assert.equal(env.post('skuLink', { jan: J3, sku: 'EC-C3' }).item.sku, 'EC-C1 | EC-C2 | EC-C3');
  assert.equal(env.post('skuLink', { jan: J4, sku: 'Z' }).error, 'not_in_master');
  assert.equal(env.post('skuLink', { jan: J3, sku: '  ' }).error, 'bad_request');
});

test('masterImport: 6列目のSKUを取り込む。既存商品のSKUは空欄なら変えない', () => {
  const env = createEnv();
  const r = env.post('masterImport', { text: `JAN,商品名,価格,現在庫,ロケーション,SKU\n${J1},A,100,0,a-1,S1|S2\n${J2},B,,,,` });
  assert.equal(r.added, 2);
  assert.equal(env.get('masterGet', { jan: J1 }).item.sku, 'S1 | S2');
  env.post('masterImport', { text: `${J1},A改` });
  assert.equal(env.get('masterGet', { jan: J1 }).item.sku, 'S1 | S2');
  env.post('masterImport', { text: `${J1},A改,,,,S3` });
  assert.equal(env.get('masterGet', { jan: J1 }).item.sku, 'S3');
});

test('SKUは商品対応表シートに保存され、商品マスタの列は5列のまま。外した/空にしたSKUは表から消える', () => {
  const env = setup();
  assert.deepEqual(env.sheet(MASTER).dump()[0], ['JAN', '商品名', '価格', '現在庫', 'ロケーション']);
  assert.deepEqual(env.sheet(SKUS).dump()[0], ['SKU', 'JAN', 'EC側の名称']);
  const rows = env.sheet(SKUS).body().map((r) => [r[0], r[1]]);
  assert.deepEqual(rows, [['SKU-A', J1], ['A-ALT', J1], ['sku-b', J2]]);
  assert.equal(env.sheet(MASTER).body()[0].length, 5);
  env.post('skuLink', { jan: J3, sku: 'TOTE-1', name: 'トート（EC名）' });
  assert.deepEqual(env.sheet(SKUS).body().find((r) => r[0] === 'TOTE-1').slice(0, 3), ['TOTE-1', J3, 'トート（EC名）']);
  env.post('masterUpsert', { jan: J1, sku: 'ONLY-ONE' });
  assert.deepEqual(env.sheet(SKUS).body().map((r) => r[0]), ['ONLY-ONE', 'sku-b', 'TOTE-1'], '差し替えたSKUだけが残る');
  assert.equal(env.post('skuDelete', { sku: 'only-one' }).item.sku, '');
  assert.equal(env.post('skuDelete', { sku: 'NOPE' }).error, 'not_found');
  const l = env.get('skuList', { q: 'tote' });
  assert.deepEqual(l.items.map((x) => [x.sku, x.jan, x.note]), [['TOTE-1', J3, 'トート（EC名）']]);
  assert.equal(env.get('skuList').count, 2);
});

test('9つのシートは最初のリクエストで自動作成され、見出しがつく。古い4シートのスプレッドシートにも5つ足される', () => {
  const env = createEnv();
  env.ss.insertSheet(MASTER).getRange(1, 1, 1, 5).setValues([['JAN', '商品名', '価格', '現在庫', 'ロケーション']]);
  assert.equal(env.get('masterList').ok, true);
  for (const n of ALL) assert.ok(env.sheet(n), n);
  assert.equal(env.ss.sheets.size, 9);
});

test('出庫: 理由が必須。履歴は区分＝出庫、メモ＝理由。足りない時は何も変えない', () => {
  const env = setup();
  for (const reason of [undefined, '', '   ']) {
    assert.equal(env.post('issue', { jan: J1, qty: 1, reason }).error, 'bad_request', String(reason));
  }
  assert.equal(env.post('issue', { jan: J1, qty: 1, reason: 'あ'.repeat(101) }).error, 'bad_request');
  assert.equal(stock(env, J1), 10);
  const ok = env.post('issue', { jan: J1, qty: 3, reason: ' 廃棄 ', memo: '賞味期限' });
  assert.equal(ok.item.stock, 7);
  const last = io(env).slice(-1)[0];
  assert.deepEqual([last[3], last[4], last[5], last[6]], ['出庫', 3, 7, '理由:廃棄 / 賞味期限']);
  const bad = env.post('issue', { jan: J1, qty: 8, reason: '破損' });
  assert.equal(bad.error, 'insufficient_stock');
  assert.equal(stock(env, J1), 7);
  assert.equal(env.post('issue', { jan: J4, qty: 1, reason: 'x' }).error, 'not_in_master');
  assert.equal(env.post('issue', { jan: J1, qty: 0, reason: 'x' }).error, 'bad_request');
  assert.equal(env.post('ship', { jan: J1, qty: 1 }).error, 'bad_request', '単品のshipは廃止');
});

test('棚移動: 在庫は変わらず、ロケだけ変わる。履歴は区分＝移動、数量＝移動した在庫数', () => {
  const env = setup();
  const r = env.post('move', { jan: J1, to: 'ｃ－09' });
  assert.equal(r.item.location, 'C-09');
  assert.equal(r.item.stock, 10);
  const last = io(env).slice(-1)[0];
  assert.deepEqual([last[3], last[4], last[5], last[6]], ['移動', 10, 10, 'ロケ移動: A-01→C-09']);
  assert.equal(env.post('move', { jan: J1, to: 'c-09' }).error, 'same_location');
  assert.equal(env.post('move', { jan: J1, to: '  ' }).error, 'bad_request');
  assert.equal(env.post('move', { jan: J4, to: 'A' }).error, 'not_in_master');
  const z = env.post('masterUpsert', { jan: J4, name: '在庫0', location: '' });
  assert.equal(env.post('move', { jan: J4, to: 'Z-1' }).history.qty, 0);
  assert.match(io(env).slice(-1)[0][6], /\(未設定\)→Z-1/);
  assert.equal(z.ok, true);
  assert.equal(stock(env, J1), 10);
});

const planOf = (env, name) => env.get('planGet', { name });
const st = (env, name) => planOf(env, name).plan.status;
const lineRows = (env, sheet) => env.sheet(sheet).body();

test('入荷予定の作成: ヘッダと明細に行が増える（シートは増えない）。SKUでもJANでも書ける。未解決があれば何も作らない', () => {
  const env = setup();
  const snap = sheetSnap(env);
  const bad = env.post('planCreate', { name: '便1', items: [{ code: 'SKU-A', qty: 2 }, { code: 'NOPE', qty: 1 }, { code: J4, qty: 1 }] });
  assert.equal(bad.error, 'unresolved');
  assert.deepEqual(bad.unresolved.map((u) => u.code), ['NOPE', J4]);
  assert.equal(sheetSnap(env), snap, '何も書かれていない');
  const sheets0 = env.ss.sheets.size;
  const ok = env.post('planCreate', { name: '便1', supplier: 'A商事', memo: '午前着', items: [{ code: 'sku-a', qty: 2 }, { code: J1, qty: 1 }, { code: J2, qty: 4 }] });
  assert.deepEqual([ok.id, ok.lines, ok.total], ['IB-0001', 2, 7]);
  assert.equal(env.post('planCreate', { name: '便2', items: [{ code: J3, qty: 1 }] }).id, 'IB-0002');
  assert.equal(env.ss.sheets.size, sheets0, 'シートは増えない（増えるのは行だけ）');
  const h = lineRows(env, PLAN);
  assert.deepEqual(h[0].slice(0, 7).map((x) => (/^\d{4}\/\d{2}\/\d{2} /.test(String(x)) ? 'date' : x)), ['IB-0001', '便1', 'A商事', '入荷待ち', 'date', '', '午前着']);
  assert.deepEqual(lineRows(env, PLINE).filter((r) => r[0] === 'IB-0001').map((r) => [r[1], r[3], r[4], r[5], r[6]]), [[J1, 3, 0, 0, '入荷待ち'], [J2, 4, 0, 0, '入荷待ち']]);
  assert.equal(env.post('planCreate', { name: '便1', items: [{ code: J3, qty: 1 }] }).error, 'duplicate_plan');
  assert.equal(env.post('planCreate', { name: '', items: [{ code: J3, qty: 1 }] }).error, 'bad_request');
  assert.equal(env.post('planCreate', { name: 'x', items: [] }).error, 'bad_request');
  assert.equal(env.post('planCreate', { name: 'x', items: [{ code: J3, qty: 0 }] }).error, 'bad_request');
  const g = planOf(env, '便1');
  assert.deepEqual(g.lines.map((l) => [l.jan, l.planned, l.inspected, l.received, l.state, l.location]), [[J1, 3, 0, 0, '入荷待ち', 'A-01'], [J2, 4, 0, 0, '入荷待ち', 'A-02']]);
  assert.equal(env.get('planGet', { id: 'IB-0001' }).plan.name, '便1');
  assert.equal(env.get('planGet', { name: 'なし' }).error, 'not_found');
});

test('入荷予定の状態: 入荷待ち→検品中（途中保存。在庫は動かない）→一部入荷→完了', () => {
  const env = setup();
  env.post('planCreate', { name: '便1', items: [{ code: J1, qty: 5 }, { code: J2, qty: 2 }] });
  assert.equal(st(env, '便1'), '入荷待ち');
  const stock0 = stock(env, J1);
  const ins = env.post('planInspect', { name: '便1', lines: [{ jan: J1, count: 3 }, { jan: J2, count: 2 }] });
  assert.equal(ins.plan.status, '検品中');
  assert.equal(stock(env, J1), stock0, '検品の途中保存では在庫は動かない');
  assert.deepEqual(planOf(env, '便1').lines.map((l) => [l.inspected, l.received, l.state]), [[3, 0, '検品中'], [2, 0, '検品中']]);
  assert.equal(io(env).filter((r) => r[3] === '入荷').length, 3, 'セットアップの入荷3件だけ');

  const r1 = env.post('planReceive', { name: '便1', lines: [{ jan: J1, count: 3, location: 'ｄ-1' }, { jan: J2, count: 2 }] });
  assert.equal(r1.received, 5);
  assert.equal(r1.plan.status, '一部入荷');
  assert.deepEqual([r1.plan.planned, r1.plan.received, r1.plan.remaining], [7, 5, 2]);
  assert.equal(stock(env, J1), stock0 + 3);
  assert.equal(env.get('masterGet', { jan: J1 }).item.location, 'D-1');
  assert.deepEqual(planOf(env, '便1').lines.map((l) => [l.inspected, l.received, l.state]), [[3, 3, '一部入荷'], [2, 2, '完了']]);
  const h1 = io(env).slice(-2);
  assert.equal(h1[0][6], '入荷予定:便1 / ロケ変更: A-01→D-1');
  assert.equal(h1[1][6], '入荷予定:便1');
  assert.deepEqual(env.sheet(INSP).body()[0].slice(1), ['入荷予定 便1', J1, '商品A', 5, 3, -2], '予定数＝その時点の残、差異＝今回−残');

  // 続き（検品済数は累計）: 残2のところを5まで数える → 超過（予定5・累計7）
  const r2 = env.post('planReceive', { name: '便1', lines: [{ jan: J1, count: 7 }] });
  assert.equal(r2.received, 4);
  assert.equal(r2.plan.status, '完了');
  assert.notEqual(r2.plan.finished, '');
  assert.equal(io(env).slice(-1)[0][6], '入荷予定:便1 / 超過+2');
  assert.equal(stock(env, J1), stock0 + 7);
});

test('入荷予定の予定外: 予定数0の行として追加され、計上できる', () => {
  const env = setup();
  env.post('planCreate', { name: '便X', items: [{ code: J1, qty: 1 }] });
  env.post('planReceive', { name: '便X', lines: [{ jan: J1, count: 1 }, { jan: J3, count: 2 }] });
  const g = planOf(env, '便X');
  assert.deepEqual(g.lines.map((l) => [l.jan, l.planned, l.received, l.state, l.note]), [[J1, 1, 1, '完了', ''], [J3, 0, 2, '完了', '予定外']]);
  assert.equal(io(env).slice(-1)[0][6], '入荷予定:便X / 予定外');
  assert.equal(g.plan.status, '完了');
  const insOnly = env.post('planInspect', { name: '便X', lines: [{ jan: J2, count: 4 }] });
  assert.equal(insOnly.plan.status, '検品中', '予定外を数えた段階では検品中（在庫は動かない）');
  assert.equal(stock(env, J2), 5);
});

test('入荷予定: 予定を閉じる（消込）→ 完了。在庫は動かない。キャンセルは入荷済みが無いときだけ', () => {
  const env = setup();
  env.post('planCreate', { name: '便2', items: [{ code: J1, qty: 5 }, { code: J2, qty: 5 }] });
  env.post('planReceive', { name: '便2', lines: [{ jan: J1, count: 2 }] });
  assert.equal(st(env, '便2'), '一部入荷');
  const before = stock(env, J1) + stock(env, J2);
  const c = env.post('planClose', { name: '便2' });
  assert.equal(c.closed, 2);
  assert.equal(c.plan.status, '完了');
  assert.equal(c.plan.remaining, 0);
  assert.equal(stock(env, J1) + stock(env, J2), before, '在庫は動かない');
  assert.equal(env.post('planClose', { name: '便2' }).closed, 0);
  assert.deepEqual(planOf(env, '便2').lines.map((l) => [l.state, l.note]), [['消込', '消込'], ['消込', '消込']]);
  assert.equal(env.post('planCancel', { name: '便2' }).error, 'bad_state', '入荷済みがあるとキャンセルできない');

  env.post('planCreate', { name: '便3', items: [{ code: J3, qty: 2 }] });
  const cc = env.post('planCancel', { name: '便3' });
  assert.equal(cc.plan.status, 'キャンセル');
  assert.notEqual(cc.plan.finished, '');
  assert.equal(planOf(env, '便3').lines[0].state, 'キャンセル');
  assert.equal(env.post('planInspect', { name: '便3', lines: [{ jan: J3, count: 1 }] }).error, 'bad_state');
  assert.equal(env.post('planReceive', { name: '便3', lines: [{ jan: J3, count: 1 }] }).error, 'bad_state');
  assert.equal(env.post('planCreate', { name: '便3', items: [{ code: J3, qty: 1 }] }).error, 'duplicate_plan', 'キャンセルした名前も再利用できない');
  assert.equal(env.post('planCancel', { name: 'なし' }).error, 'not_found');
});

test('入荷予定の一覧: 状態で絞り込める。検品中→一部入荷→入荷待ち→完了→キャンセルの順', () => {
  const env = setup();
  for (const n of ['P待ち', 'P一部', 'P検品', 'P完了', 'Pキャンセル']) env.post('planCreate', { name: n, items: [{ code: J1, qty: 2 }] });
  env.post('planReceive', { name: 'P一部', lines: [{ jan: J1, count: 1 }] });
  env.post('planInspect', { name: 'P検品', lines: [{ jan: J1, count: 1 }] });
  env.post('planReceive', { name: 'P完了', lines: [{ jan: J1, count: 2 }] });
  env.post('planCancel', { name: 'Pキャンセル' });
  assert.deepEqual(env.get('planList').plans.map((p) => [p.name, p.status]), [['P検品', '検品中'], ['P一部', '一部入荷'], ['P待ち', '入荷待ち'], ['P完了', '完了'], ['Pキャンセル', 'キャンセル']]);
  assert.deepEqual(env.get('planList', { status: '一部入荷' }).plans.map((p) => p.name), ['P一部']);
  assert.equal(env.get('planList', { status: '完了' }).plans.length, 1);
});

test('入荷予定: 検証エラーのときは何も書かない（未登録JAN・検品済数が入荷済数より少ない・数が増えない）', () => {
  const env = setup();
  env.post('planCreate', { name: '便4', items: [{ code: J1, qty: 3 }] });
  env.post('planReceive', { name: '便4', lines: [{ jan: J1, count: 2 }] });
  const snap = sheetSnap(env);
  assert.equal(env.post('planReceive', { name: '便4', lines: [{ jan: J1, count: 3 }, { jan: J4, count: 1 }] }).error, 'not_in_master');
  assert.equal(env.post('planReceive', { name: '便4', lines: [{ jan: J1, count: 1 }] }).error, 'bad_request', '入荷済数（2）より少ない');
  assert.equal(env.post('planInspect', { name: '便4', lines: [{ jan: J1, count: 1 }] }).error, 'bad_request');
  assert.equal(env.post('planReceive', { name: '便4', lines: [{ jan: J1, count: 2 }] }).error, 'nothing_to_receive');
  assert.equal(env.post('planReceive', { name: '便4', lines: [] }).error, 'bad_request');
  assert.equal(env.post('planReceive', { name: '便4', lines: [{ jan: J1, count: -1 }] }).error, 'bad_request');
  assert.equal(env.post('planReceive', { name: 'なし', lines: [{ jan: J1, count: 1 }] }).error, 'not_found');
  assert.equal(sheetSnap(env), snap);
});

const CSV = (lines) => lines.join('\r\n');

test('伝票の取り込み: ヘッダと明細に行が増える。見出しあり／なし・SKU・JAN・同じ商品の合算・注文単位', () => {
  const env = setup();
  const sheets0 = env.ss.sheets.size;
  const r = env.post('slipImport', { text: CSV(['伝票番号,SKUまたはJAN,数量', '#1001,SKU-A,2', `#1001,${J2},1`, '#1001,A-ALT,1', `#1002,${J3},3`]) });
  assert.deepEqual([r.orders, r.created, r.lines, r.duplicates.length, r.errors.length], [2, 2, 3, 0, 0]);
  assert.equal(env.ss.sheets.size, sheets0);
  assert.deepEqual(lineRows(env, SLIP).map((x) => [x[0], x[1], x[2], x[3]]), [['SH-0001', '#1001', 'CSV', '未検品'], ['SH-0002', '#1002', 'CSV', '未検品']]);
  assert.deepEqual(lineRows(env, SLINE).map((x) => [x[0], x[1], x[3], x[4], x[5]]), [['SH-0001', J1, 3, 0, 'SKU-A'], ['SH-0001', J2, 1, 0, J2], ['SH-0002', J3, 3, 0, J3]]);
  const list = env.get('slipList').slips;
  const s1 = list.find((s) => s.no === '#1001');
  assert.deepEqual([s1.id, s1.status, s1.lines, s1.qty, s1.source, s1.inspected], ['SH-0001', '未検品', 2, 4, 'CSV', 0]);
  const g = env.get('slipGet', { no: '#1001' });
  assert.deepEqual(g.lines.map((l) => [l.jan, l.qty, l.done, l.code, l.location]), [[J1, 3, 0, 'SKU-A', 'A-01'], [J2, 1, 0, J2, 'A-02']], 'SKU-AとA-ALTは同じ商品として合算');
  assert.equal(env.get('slipGet', { id: 'SH-0002' }).slip.no, '#1002');
  const r2 = env.post('slipImport', { text: `#2001,${J1},1\n#2001,${J2},2` });
  assert.equal(r2.created, 1);
  assert.equal(env.get('slipGet', { no: '#2001' }).lines.length, 2);
});

test('伝票の取り込み: Shopify風の列名。伝票番号が空の行は直前の注文の続き', () => {
  const env = setup();
  const r = env.post('slipImport', { text: CSV(['Name,Email,Lineitem quantity,Lineitem name,Lineitem sku', '#3001,a@example.com,2,商品A,SKU-A', ',,1,商品B,sku-b', '#3002,b@example.com,1,商品C,' + J3]) });
  assert.deepEqual([r.created, r.errors.length], [2, 0]);
  assert.deepEqual(env.get('slipGet', { no: '#3001' }).lines.map((l) => [l.jan, l.qty]), [[J1, 2], [J2, 1]]);
});

test('伝票の取り込み: 二重取り込みは無視。未解決・数量不正の注文は作らず、他の注文は作る。SKUを紐づけて再取り込み', () => {
  const env = setup();
  const text = CSV(['伝票番号,コード,数量', `#1,${J1},1`, '#2,UNKNOWN-SKU,1', `#2,${J2},1`, `#3,${J3},0`, `#4,${J3},x`, '#5,SKU-B,2', `#6,${J4},1`]);
  const r = env.post('slipImport', { text });
  assert.equal(r.created, 2);
  assert.deepEqual(r.errors.map((e) => e.no), ['#2', '#3', '#4', '#6']);
  assert.deepEqual(r.unresolved.map((u) => [u.code, u.orders]), [['UNKNOWN-SKU', ['#2']], [J4, ['#6']]]);
  assert.equal(env.get('slipGet', { no: '#2' }).error, 'not_found');
  const again = env.post('slipImport', { text });
  assert.equal(again.created, 0);
  assert.deepEqual(again.duplicates, ['#1', '#5']);
  env.post('skuLink', { jan: J2, sku: 'UNKNOWN-SKU' });
  const third = env.post('slipImport', { text });
  assert.equal(third.created, 1);
  assert.deepEqual(third.duplicates, ['#1', '#5']);
  assert.equal(env.post('slipImport', { text: '' }).error, 'bad_request');
});

test('伝票の手入力: 重複番号・未解決は拒否。全角・大小のゆれは同じ番号', () => {
  const env = setup();
  assert.equal(env.post('slipCreate', { no: 'A-1', memo: 'テスト', items: [{ code: J1, qty: 1 }] }).slip.source, '手入力');
  assert.equal(env.post('slipCreate', { no: 'a-1', items: [{ code: J1, qty: 1 }] }).error, 'duplicate_slip');
  assert.equal(env.post('slipCreate', { no: 'A-2', items: [{ code: 'NOPE', qty: 1 }] }).error, 'unresolved');
  assert.equal(env.post('slipCreate', { no: '', items: [{ code: J1, qty: 1 }] }).error, 'bad_request');
  assert.equal(env.get('slipGet', { no: 'ａ-1' }).ok, true);
  assert.equal(lineRows(env, SLIP).length, 1, '失敗した作成は行を増やさない');
});

function slip(env, no, items) { return env.post('slipCreate', { no, items }); }
const slipStatus = (env, no) => env.get('slipGet', { no }).slip.status;

test('出荷検品: 途中保存で「検品中」、全数一致で「検品済」。在庫は動かず、検品済になった時に検品履歴へ', () => {
  const env = setup();
  slip(env, 'S1', [{ code: J1, qty: 2 }, { code: J2, qty: 1 }]);
  const stockSnap = JSON.stringify(env.sheet(MASTER).dump());
  assert.equal(slipStatus(env, 'S1'), '未検品');
  const p = env.post('slipInspect', { no: 'S1', items: [{ jan: J1, count: 1 }] });
  assert.equal(p.slip.status, '検品中');
  assert.equal(p.slip.inspected, 1);
  assert.equal(env.sheet(INSP).body().length, 0, '検品済になるまで検品履歴は書かない');
  assert.deepEqual(env.get('slipGet', { no: 'S1' }).lines.map((l) => l.done), [1, 0], '別の端末からも続きの数が分かる');
  const ok = env.post('slipInspect', { no: 'S1', items: [{ jan: J1, count: 2 }, { jan: J2, count: 1 }] });
  assert.equal(ok.slip.status, '検品済');
  assert.notEqual(ok.slip.inspectedAt, '');
  assert.equal(JSON.stringify(env.sheet(MASTER).dump()), stockSnap, '検品では在庫は動かない');
  assert.deepEqual(env.sheet(INSP).body().map((r) => r.slice(1)), [['出荷伝票 S1', J1, '商品A', 2, 2, 0], ['出荷伝票 S1', J2, '商品B', 1, 1, 0]]);
  assert.equal(env.post('slipInspect', { no: 'S1', items: [{ jan: J1, count: 2 }, { jan: J2, count: 1 }] }).ok, true, '同じ内容の再送は何もしない');
  assert.equal(env.sheet(INSP).body().length, 2);
  assert.equal(env.post('slipInspect', { no: 'S1', items: [{ jan: J1, count: 1 }] }).error, 'already_inspected');
  assert.equal(env.post('slipInspect', { no: 'なし', items: [] }).error, 'not_found');
});

test('出荷検品: 明細にない商品・数量超過は拒否（差異つき）。何も書かない', () => {
  const env = setup();
  slip(env, 'S2', [{ code: J1, qty: 2 }]);
  const snap = sheetSnap(env);
  const bad = env.post('slipInspect', { no: 'S2', items: [{ jan: J1, count: 3 }, { jan: J3, count: 1 }] });
  assert.equal(bad.error, 'not_matched');
  assert.equal(bad.diffs.length, 2);
  assert.equal(sheetSnap(env), snap);
  assert.equal(env.post('slipInspect', { no: 'S2', items: [{ jan: J1, count: -1 }] }).error, 'bad_request');
  assert.equal(slipStatus(env, 'S2'), '未検品');
});

test('出荷確定: 検品済みの伝票だけ。明細分だけ在庫が減り、履歴は区分＝出荷・メモ＝伝票番号。二重出荷は拒否', () => {
  const env = setup();
  slip(env, 'S3', [{ code: J1, qty: 4 }, { code: J2, qty: 5 }]);
  assert.equal(env.post('slipShip', { no: 'S3' }).error, 'not_inspected');
  env.post('slipInspect', { no: 'S3', items: [{ jan: J1, count: 4 }] });
  assert.equal(env.post('slipShip', { no: 'S3' }).error, 'not_inspected', '検品中は出荷できない');
  env.post('slipInspect', { no: 'S3', items: [{ jan: J1, count: 4 }, { jan: J2, count: 5 }] });
  const ioN = io(env).length;
  const r = env.post('slipShip', { no: 'S3', memo: '宅配' });
  assert.equal(r.slip.status, '出荷済');
  assert.notEqual(r.slip.shippedAt, '');
  assert.equal(stock(env, J1), 6);
  assert.equal(stock(env, J2), 0);
  assert.deepEqual(io(env).slice(ioN).map((x) => [x[1], x[3], x[4], x[5], x[6]]), [[J1, '出荷', 4, 6, '出荷伝票:S3 / 宅配'], [J2, '出荷', 5, 0, '出荷伝票:S3 / 宅配']]);
  assert.equal(env.post('slipShip', { no: 'S3' }).error, 'already_shipped');
  assert.equal(stock(env, J1), 6);
  assert.equal(env.get('slipList', { status: '出荷済' }).slips.length, 1);
  assert.equal(env.get('slipList', { status: '未検品' }).slips.length, 0);
  assert.equal(env.post('slipInspect', { no: 'S3', items: [{ jan: J1, count: 4 }] }).error, 'bad_state');
});

test('出荷確定: 在庫が足りない行が1つでもあれば、伝票全体を拒否して何も書かない', () => {
  const env = setup();
  slip(env, 'S4', [{ code: J1, qty: 2 }, { code: J3, qty: 9 }]);
  env.post('slipInspect', { no: 'S4', items: [{ jan: J1, count: 2 }, { jan: J3, count: 9 }] });
  const snap = sheetSnap(env);
  const bad = env.post('slipShip', { no: 'S4' });
  assert.equal(bad.error, 'insufficient_stock');
  assert.deepEqual(bad.short.map((x) => [x.jan, x.stock, x.qty]), [[J3, 3, 9]]);
  assert.equal(sheetSnap(env), snap);
  env.post('receive', { jan: J3, qty: 6 });
  assert.equal(env.post('slipShip', { no: 'S4' }).ok, true);
  assert.equal(stock(env, J3), 0);
});

test('伝票のキャンセル: 出荷済み以外。行は消さず、番号は再利用できない', () => {
  const env = setup();
  slip(env, 'S5', [{ code: J1, qty: 1 }]);
  assert.equal(env.post('slipVoid', { no: 'S5' }).slip.status, 'キャンセル');
  assert.equal(env.post('slipVoid', { no: 'S5' }).ok, true);
  assert.equal(lineRows(env, SLIP).length, 1);
  assert.equal(lineRows(env, SLINE).length, 1, '行は消さない');
  assert.equal(env.post('slipInspect', { no: 'S5', items: [{ jan: J1, count: 1 }] }).error, 'bad_state');
  assert.equal(env.post('slipShip', { no: 'S5' }).error, 'not_inspected');
  assert.equal(slip(env, 'S5', [{ code: J1, qty: 1 }]).error, 'duplicate_slip');
  slip(env, 'S6', [{ code: J1, qty: 1 }]);
  env.post('slipInspect', { no: 'S6', items: [{ jan: J1, count: 1 }] });
  assert.equal(env.post('slipVoid', { no: 'S6' }).slip.status, 'キャンセル', '検品済みでも未出荷ならキャンセルできる');
  slip(env, 'S7', [{ code: J1, qty: 1 }]);
  env.post('slipInspect', { no: 'S7', items: [{ jan: J1, count: 1 }] });
  env.post('slipShip', { no: 'S7' });
  assert.equal(env.post('slipVoid', { no: 'S7' }).error, 'bad_state');
});

test('新しいシートの文字列保存: ID・JAN・伝票番号の先頭0が壊れない。IDは連番', () => {
  const env = setup();
  env.post('masterUpsert', { jan: UPCA, name: 'UPC商品', location: 'U-1' });
  env.post('planCreate', { name: '便U', items: [{ code: UPCA, qty: 1 }] });
  slip(env, '001234', [{ code: UPCA, qty: 1 }]);
  slip(env, '001235', [{ code: UPCA, qty: 1 }]);
  assert.equal(lineRows(env, PLINE)[0][1], UPCA);
  assert.deepEqual(lineRows(env, SLIP).map((r) => [r[0], r[1]]), [['SH-0001', '001234'], ['SH-0002', '001235']]);
  assert.ok(lineRows(env, SLINE).every((r) => typeof r[1] === 'string'));
  assert.equal(env.get('slipGet', { no: '001234' }).ok, true);
  assert.deepEqual(env.sheet(SLIP).dump()[0], ['伝票ID', '伝票番号', '出所', '状態', '作成日時', '検品日時', '出荷日時', 'メモ', '送り状番号', '配送業者', '作業グループ', '作業開始日時']);
  assert.deepEqual(env.sheet(SLINE).dump()[0], ['伝票ID', 'JAN', '商品名', '数量', '検品済数', '元コード']);
  assert.deepEqual(env.sheet(PLINE).dump()[0], ['予定ID', 'JAN', '商品名', '予定数', '検品済数', '入荷済数', '状態', '備考']);
});

test('履歴の検索（管理ビュー）: 新しい順・区分・キーワード・件数上限', () => {
  const env = setup();
  env.post('issue', { jan: J1, qty: 1, reason: '破損' });
  env.post('move', { jan: J2, to: 'Z-1' });
  const all = env.get('historyList', {});
  assert.equal(all.count, 5);
  assert.deepEqual(all.rows.slice(0, 2).map((r) => r.kubun), ['移動', '出庫'], '新しい順');
  assert.deepEqual(env.get('historyList', { kubun: '入荷' }).rows.map((r) => r.jan).sort(), [J1, J2, J3].sort());
  assert.equal(env.get('historyList', { q: '破損' }).count, 1);
  assert.equal(env.get('historyList', { q: '商品B' }).count, 2, '商品名でも探せる');
  const lim = env.get('historyList', { limit: 2 });
  assert.deepEqual([lim.rows.length, lim.count, lim.truncated], [2, 5, true]);
});

test('CSV用のデータ（exportData）: 商品マスタ・在庫一覧・入出荷履歴・入荷予定・出荷伝票', () => {
  const env = setup();
  env.post('planCreate', { name: '便E', items: [{ code: J1, qty: 2 }, { code: J2, qty: 1 }] });
  env.post('planReceive', { name: '便E', lines: [{ jan: J1, count: 2 }] });
  slip(env, 'E1', [{ code: J3, qty: 1 }]);
  const ex = (kind) => env.get('exportData', { kind });
  const m = ex('master');
  assert.deepEqual(m.header, ['JAN', '商品名', '価格', '現在庫', 'ロケーション', 'SKU']);
  assert.deepEqual(m.rows.find((r) => r[0] === J1), [J1, '商品A', 100, 12, 'A-01', 'SKU-A | A-ALT']);
  const sk = ex('stock');
  assert.deepEqual(sk.rows.map((r) => r[0]), ['A-01', 'A-02', 'B-01'], 'ロケ順');
  assert.equal(sk.rows[0][5], 100 * 12);
  assert.equal(ex('io').rows.length, io(env).length);
  const pl = ex('plans');
  assert.equal(pl.rows.length, 2, '1行1明細に展開');
  assert.deepEqual(pl.rows[0].slice(0, 4), ['IB-0001', '便E', '', '一部入荷']);
  assert.deepEqual([pl.rows[0][9], pl.rows[0][10], pl.rows[0][11], pl.rows[0][12]], [2, 2, 2, '完了']);
  const sl = ex('slips');
  assert.deepEqual(sl.rows[0].slice(0, 4), ['SH-0001', 'E1', '手入力', '未検品']);
  assert.equal(ex('slips').title, '出荷伝票');
  assert.equal(env.get('exportData', { kind: 'nope' }).error, 'bad_request');
});

test('通しの整合: 入荷予定・出荷伝票・出庫・棚移動・棚卸のあとも、履歴の「処理後の在庫数」がマスタとつながる', () => {
  const env = setup();
  env.post('planCreate', { name: 'T', items: [{ code: J1, qty: 5 }] });
  env.post('planReceive', { name: 'T', lines: [{ jan: J1, count: 3 }] });
  env.post('move', { jan: J1, to: 'Z-9' });
  env.post('issue', { jan: J1, qty: 2, reason: '破損' });
  slip(env, 'T1', [{ code: J1, qty: 4 }]);
  env.post('slipInspect', { no: 'T1', items: [{ jan: J1, count: 4 }] });
  env.post('slipShip', { no: 'T1' });
  env.post('stocktakeSave', { name: '棚', counts: [{ jan: J1, actual: 6 }] });
  env.post('receive', { jan: J1, qty: 1 });
  const run = {};
  for (const row of io(env)) {
    const [, jan, , kubun, qty, after] = row;
    if (run[jan] === undefined) run[jan] = 0;
    run[jan] += kubun === '入荷' ? qty : (kubun === '出荷' || kubun === '出庫') ? -qty : kubun === '棚卸調整' ? qty : 0;
    assert.equal(after, run[jan], `${jan} ${kubun}`);
  }
  assert.equal(stock(env, J1), run[J1]);
  assert.equal(stock(env, J1), 7);
});

test('書き込み系は排他（ロック）の中で行い、新しい操作もロックが取れなければ busy', () => {
  const env = setup();
  env.post('planCreate', { name: 'L', items: [{ code: J1, qty: 1 }] });
  slip(env, 'L1', [{ code: J1, qty: 1 }]);
  env.state.lockFails = true;
  for (const [a, b] of [['issue', { jan: J1, qty: 1, reason: 'x' }], ['move', { jan: J1, to: 'Q' }], ['planCreate', { name: 'x', items: [{ code: J1, qty: 1 }] }],
    ['planInspect', { name: 'L', lines: [{ jan: J1, count: 1 }] }], ['planReceive', { name: 'L', lines: [{ jan: J1, count: 1 }] }], ['planClose', { name: 'L' }], ['planCancel', { name: 'L' }],
    ['slipImport', { text: `a,${J1},1` }], ['slipInspect', { no: 'L1', items: [] }], ['slipShip', { no: 'L1' }], ['slipVoid', { no: 'L1' }],
    ['skuLink', { jan: J1, sku: 'Q' }], ['skuDelete', { sku: 'SKU-A' }]]) {
    assert.equal(env.post(a, b).error, 'busy', a);
  }
  for (const a of ['planList', 'slipList', 'skuList', 'historyList']) assert.equal(env.get(a).ok, true, a);
  assert.equal(env.get('exportData', { kind: 'master' }).ok, true);
  env.state.lockFails = false;
  env.post('issue', { jan: J1, qty: 1, reason: 'x' });
  assert.equal(env.state.unlocks, env.state.locks);
});

/* ================= v0.4.1: 送り状番号・送り状検品・セキュリティ ================= */
const TRK = 'ABC1234567890';

test('送り状番号: 伝票に登録・変更・消去。全角・空白・ハイフンのゆれは同一視して保存。重複は拒否', () => {
  const env = setup();
  slip(env, 'T1', [{ code: J1, qty: 1 }]);
  slip(env, 'T2', [{ code: J2, qty: 1 }]);
  const r = env.post('slipTracking', { no: 'T1', tracking: ' ａｂｃ-1234 5678-90 ', carrier: 'ヤマト運輸' });
  assert.deepEqual([r.slip.tracking, r.slip.carrier], [TRK, 'ヤマト運輸']);
  assert.deepEqual(lineRows(env, SLIP)[0].slice(8, 10), [TRK, 'ヤマト運輸'], '出荷伝票シートに記録される');
  assert.equal(env.post('slipTracking', { no: 'T2', tracking: TRK }).error, 'duplicate_tracking');
  assert.equal(env.post('slipTracking', { no: 'T2', tracking: '12' }).error, 'bad_request');
  assert.equal(env.post('slipTracking', { no: 'T2', tracking: '日本語番号です' }).error, 'bad_request');
  assert.equal(env.post('slipTracking', { no: 'T1', tracking: TRK, carrier: '佐川' }).slip.carrier, '佐川', '自分の番号の再登録はできる');
  assert.equal(env.post('slipTracking', { no: 'T1', tracking: '' }).slip.tracking, '', '空で消去');
  assert.equal(env.post('slipTracking', { no: 'なし', tracking: TRK }).error, 'not_found');
  env.post('slipVoid', { no: 'T2' });
  assert.equal(env.post('slipTracking', { no: 'T2', tracking: TRK }).error, 'bad_state');
  assert.equal(env.post('slipTracking', { no: 'T1', tracking: TRK }).ok, true, 'キャンセル済みの伝票の番号は重複扱いにしない');
});

test('送り状番号CSV（配送業者のソフトの追跡番号CSV）: 受注コードで伝票を引いて一括登録', () => {
  const env = setup();
  slip(env, '#1001', [{ code: J1, qty: 1 }]); slip(env, '#1002', [{ code: J2, qty: 1 }]); slip(env, '#1003', [{ code: J3, qty: 1 }]);
  const r = env.post('slipTrackingImport', { text: ['受注コード,お問い合わせ番号,配送会社', '#1001,1234-5678-9012,ヤマト運輸', '#1002,JP12345678,日本郵便', '#9999,111111111111,x', '#1003,', '#1001,1234-5678-9012'].join('\r\n') });
  assert.deepEqual([r.total, r.updated, r.unchanged, r.skipped], [5, 2, 1, 2]);
  assert.deepEqual(r.errors.map((e) => e.no), ['#9999', '#1003']);
  assert.equal(env.get('slipGet', { no: '#1001' }).slip.tracking, '123456789012');
  assert.equal(env.get('slipGet', { no: '#1002' }).slip.carrier, '日本郵便');
  const r2 = env.post('slipTrackingImport', { text: '#1003,123456789012' });
  assert.match(r2.errors[0].reason, /登録済み/);
  assert.equal(env.post('slipTrackingImport', { text: '' }).error, 'bad_request');
  assert.equal(env.post('slipTrackingImport', { text: '#1003,Z99999999,ヤマト' }).updated, 1, '見出しなしでもよい');
});

test('送り状検品: 送り状番号がある伝票は、一致する送り状をスキャンしないと検品済みにならない', () => {
  const env = setup();
  slip(env, 'K1', [{ code: J1, qty: 2 }]);
  env.post('slipTracking', { no: 'K1', tracking: TRK });
  const all = [{ jan: J1, count: 2 }];
  assert.equal(env.post('slipInspect', { no: 'K1', items: all }).error, 'tracking_required');
  const bad = env.post('slipInspect', { no: 'K1', items: all, tracking: 'ZZZ999' });
  assert.equal(bad.error, 'tracking_mismatch');
  assert.equal(bad.expected, TRK);
  assert.equal(slipStatus(env, 'K1'), '未検品', '失敗しても何も変わらない（検品済数も0）');
  assert.equal(env.get('slipGet', { no: 'K1' }).lines[0].done, 0);
  assert.equal(env.post('slipInspect', { no: 'K1', items: [{ jan: J1, count: 1 }] }).slip.status, '検品中', '途中保存は送り状なしでもよい');
  const ok = env.post('slipInspect', { no: 'K1', items: all, tracking: 'abc-1234567890' });
  assert.equal(ok.slip.status, '検品済');
  const r = env.post('slipShip', { no: 'K1' });
  assert.match(io(env).slice(-1)[0][6], /出荷伝票:K1 \/ 送り状:ABC1234567890/, '履歴に送り状番号が残る');
  assert.equal(r.slip.tracking, TRK);
  assert.equal(env.post('slipTracking', { no: 'K1', tracking: 'Q99999999' }).error, 'bad_state', '出荷済みは変更不可');
});

test('送り状検品: 検品済みのあとに送り状番号を変えると、検品をやり直す（古い送り状で検品済みのまま出荷しない）', () => {
  const env = setup();
  slip(env, 'K2', [{ code: J1, qty: 1 }]);
  env.post('slipTracking', { no: 'K2', tracking: TRK });
  env.post('slipInspect', { no: 'K2', items: [{ jan: J1, count: 1 }], tracking: TRK });
  assert.equal(slipStatus(env, 'K2'), '検品済');
  env.post('slipTracking', { no: 'K2', tracking: 'NEW9999999' });
  assert.equal(slipStatus(env, 'K2'), '未検品');
  assert.equal(env.post('slipShip', { no: 'K2' }).error, 'not_inspected');
});

test('送り状番号が無い伝票は、従来どおり検品済みにできる。REQUIRE_TRACKING=true なら要求する', () => {
  const env = setup();
  slip(env, 'K3', [{ code: J1, qty: 1 }]);
  assert.equal(env.post('slipInspect', { no: 'K3', items: [{ jan: J1, count: 1 }] }).slip.status, '検品済');
  env.config.REQUIRE_TRACKING = true;
  slip(env, 'K4', [{ code: J1, qty: 1 }]);
  assert.equal(env.post('slipInspect', { no: 'K4', items: [{ jan: J1, count: 1 }] }).error, 'tracking_required');
});

test('CSV出力（出荷伝票）に送り状番号と配送業者が入る。シートの見出しは既存の8列に4列だけ補われる', () => {
  const env = setup();
  slip(env, 'K5', [{ code: J1, qty: 1 }]);
  env.post('slipTracking', { no: 'K5', tracking: TRK, carrier: 'ヤマト運輸' });
  const ex = env.get('exportData', { kind: 'slips' });
  assert.deepEqual(ex.header.slice(8, 10), ['送り状番号', '配送業者']);
  assert.deepEqual(ex.rows[0].slice(8, 10), [TRK, 'ヤマト運輸']);
  const env2 = createEnv();
  const sh = env2.ss.insertSheet(SLIP);
  sh.getRange(1, 1, 1, 8).setValues([['伝票ID', '伝票番号', '出所', '状態', '作成日時', '検品日時', '出荷日時', 'メモ']]);
  env2.get('slipList');
  assert.deepEqual(env2.sheet(SLIP).dump()[0].slice(8), ['送り状番号', '配送業者', '作業グループ', '作業開始日時']);
});

test('セキュリティ: 合言葉が短いと拒否する。数式として解釈される文字列は文字列のまま保存される。メモの改行は空白になる', () => {
  const short = createEnv({ props: { APP_TOKEN: 'short-token' } });
  const r = short.raw('GET', { action: 'masterList', token: 'short-token' });
  assert.equal(r.error, 'server_not_configured');
  assert.match(r.message, /16文字以上/);
  assert.equal(short.raw('GET', { action: 'ping' }).ok, true, 'pingは通る');

  const env = setup();
  const evil = ['=HYPERLINK("http://example.com","x")', '+1+1', '@SUM(1)', '-cmd|calc'];
  evil.forEach((t, i) => env.post('masterUpsert', { jan: withCheck('49111111111' + i), name: t, location: t, sku: 'S' + i + t }));
  const rows = env.sheet(MASTER).body();
  evil.forEach((t) => assert.ok(rows.some((x) => x[1] === t && typeof x[1] === 'string'), t + ' が文字列として残る'));
  assert.ok(rows.every((x) => x.every((c) => !(c && typeof c === 'object' && c.fakeFormula))), '数式として解釈されたセルは無い');
  env.post('issue', { jan: J1, qty: 1, reason: '=1+1', memo: '行1\r\n行2\n=A1' });
  const last = io(env).slice(-1)[0];
  assert.equal(last[6], '理由:=1+1 / 行1 行2 =A1');
  assert.ok(!(typeof last[6] === 'object'));
  const ex = env.get('exportData', { kind: 'io' }).rows.slice(-1)[0];
  assert.equal(ex[6], '理由:=1+1 / 行1 行2 =A1');
});

test('個人情報を取り込まない: 伝票CSVに氏名・住所・メールがあっても、シートには伝票番号・商品・数量だけが残る', () => {
  const env = setup();
  const csv = ['Name,Email,Shipping Name,Shipping Address1,Shipping Zip,Phone,Lineitem quantity,Lineitem sku', '#7001,taro@example.com,山田太郎,東京都千代田区1-1,100-0001,090-1234-5678,1,SKU-A'].join('\n');
  assert.equal(env.post('slipImport', { text: csv }).created, 1);
  const dumps = JSON.stringify([SLIP, SLINE, PLAN, PLINE, IO, INSP, SKUS, MASTER].map((n) => env.sheet(n).dump()));
  for (const secret of ['taro@example.com', '山田太郎', '東京都', '100-0001', '090-1234-5678']) assert.ok(!dumps.includes(secret), secret + ' は保存されない');
  assert.ok(!JSON.stringify(env.get('slipGet', { no: '#7001' })).includes('山田'));
  assert.ok(!JSON.stringify(env.get('exportData', { kind: 'slips' })).includes('taro@'));
});
