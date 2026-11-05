'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, withCheck } = require('./gas-fake');

const J1 = '4901777300446'; // 実在の例（チェックデジット有効）
const J2 = withCheck('490123456789');
const J3 = withCheck('450000000001');
const J4 = withCheck('490000000002');
const UPCA = withCheck('01234567890'); // 12桁
const EAN13_LEAD0 = '0' + UPCA; // 13桁（先頭0）
const EAN8 = withCheck('4912345');

const MASTER = '商品マスタ', IO = '入出荷履歴', INSP = '検品履歴', STK = '棚卸履歴';

function seed(env) {
  env.post('masterUpsert', { jan: J1, name: 'サントリー 伊右衛門 600ml', price: 120, location: 'a-01' });
  env.post('masterUpsert', { jan: J2, name: '商品B', price: 300, location: 'A-02' });
  env.post('masterUpsert', { jan: J3, name: '商品C', price: '¥1,500', location: 'B-01' });
}
const stockOf = (env, jan) => env.get('masterGet', { jan }).item.stock;

test('チェックデジットの作り方が合っている（テスト補助の確認）', () => {
  assert.equal(J1, withCheck('490177730044'));
  assert.equal(EAN8.length, 8);
  assert.equal(UPCA.length, 12);
});

test('ping はtokenなしで通り、バージョンを返す。POSTでも通る', () => {
  const env = createEnv();
  const g = env.raw('GET', { action: 'ping' });
  assert.equal(g.ok, true);
  assert.equal(g.app, 'simple-wms');
  const p = env.raw('POST', { action: 'ping' });
  assert.equal(p.ok, true);
  assert.equal(p.method, 'POST');
});

test('認証: tokenなし・違う・未設定', () => {
  const env = createEnv();
  assert.equal(env.raw('GET', { action: 'masterList' }).error, 'unauthorized');
  assert.equal(env.raw('GET', { action: 'masterList', token: 'x' }).error, 'unauthorized');
  const env2 = createEnv({ props: {} });
  assert.equal(env2.raw('GET', { action: 'masterList', token: 'x' }).error, 'server_not_configured');
});

test('壊れたJSON・不明なaction・GETで書き込みは拒否', () => {
  const env = createEnv();
  assert.equal(env.raw('POST', '{oops').error, 'bad_request');
  assert.equal(env.raw('POST', '[1,2]').error, 'bad_request');
  assert.equal(env.post('nothing').error, 'bad_request');
  assert.equal(env.get('receive', { jan: J1, qty: 1 }).error, 'bad_request');
  assert.equal(env.get('stocktakePreview').error, 'bad_request');
});

test('JAN検証: 桁数・チェックデジット・全角数字', () => {
  const env = createEnv();
  assert.equal(env.get('masterGet', { jan: '123' }).error, 'invalid_jan');
  assert.equal(env.get('masterGet', { jan: '4901777300447' }).error, 'invalid_jan');
  assert.equal(env.get('masterGet', { jan: '' }).error, 'invalid_jan');
  const full = J1.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
  assert.equal(env.get('masterGet', { jan: full }).ok, true);
  env.config.STRICT_CHECK_DIGIT = false;
  assert.equal(env.get('masterGet', { jan: '4901777300447' }).ok, true);
});

test('シートは最初のリクエストで自動作成され、見出しがつく', () => {
  const env = createEnv();
  env.get('masterList');
  assert.deepEqual(env.sheet(MASTER).dump()[0], ['JAN', '商品名', '価格', '現在庫', 'ロケーション']);
  env.post('receive', { jan: J1, qty: 1 }); // マスタに無いのでエラー。ただしシートは作られる
  env.post('masterUpsert', { jan: J1, name: 'x', stock: 1 });
  assert.deepEqual(env.sheet(IO).dump()[0], ['日時', 'JAN', '商品名', '区分', '数量', '処理後の在庫数', 'メモ']);
  env.post('inspectionSave', { name: 't', items: [{ jan: J1, planned: 1, actual: 1 }] });
  env.post('stocktakeSave', { name: 't', counts: [{ jan: J1, actual: 1 }] });
  assert.deepEqual(env.sheet(INSP).dump()[0], ['日時', '検品名', 'JAN', '商品名', '予定数', '実績数', '差異']);
  assert.deepEqual(env.sheet(STK).dump()[0], ['日時', '棚卸名', 'JAN', '商品名', '帳簿在庫', '実績数', '差異']);
  assert.equal(env.sheet(MASTER).frozen, 1);
});

test('masterUpsert: 新規・更新・価格クリア・既存の在庫は変えない', () => {
  const env = createEnv();
  const a = env.post('masterUpsert', { jan: J1, name: '  商品　A  ', price: '¥1,200', location: ' ａ－０１ ' });
  assert.equal(a.created, true);
  assert.deepEqual(a.item, { jan: J1, name: '商品 A', price: 1200, stock: 0, location: 'A-01', sku: '' });
  const b = env.post('masterUpsert', { jan: J1, name: '商品A改', stock: 99 });
  assert.equal(b.created, false);
  assert.equal(b.item.name, '商品A改');
  assert.equal(b.item.stock, 0, '既存商品の在庫は上書きされない');
  assert.equal(b.item.price, 1200, '指定しない項目は変えない');
  const c = env.post('masterUpsert', { jan: J1, price: '', location: '' });
  assert.equal(c.item.price, null);
  assert.equal(c.item.location, '');
  assert.equal(env.post('masterUpsert', { jan: J2 }).error, 'bad_request', '新規は商品名が要る');
  assert.equal(env.post('masterUpsert', { jan: J2, name: 'x', price: 'abc' }).error, 'bad_request');
  assert.equal(env.sheet(MASTER).body().length, 1);
});

test('masterUpsert: 初期在庫つきの新規は履歴（入荷／初期登録）が残る', () => {
  const env = createEnv();
  env.post('masterUpsert', { jan: J1, name: 'A', stock: 5 });
  assert.equal(stockOf(env, J1), 5);
  const h = env.sheet(IO).body();
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].slice(1), [J1, 'A', '入荷', 5, 5, '初期登録']);
  assert.match(h[0][0].fakeDate || h[0][0], /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('JANの先頭0が保存で消えない（UPC-A 12桁・EAN-13先頭0・EAN-8）', () => {
  const env = createEnv();
  for (const j of [UPCA, EAN13_LEAD0, EAN8]) {
    const r = env.post('masterUpsert', { jan: j, name: 'n' + j });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const col = env.sheet(MASTER).body().map((r) => r[0]);
  assert.ok(col.includes(UPCA));
  assert.ok(col.includes(EAN8));
  assert.ok(col.every((v) => typeof v === 'string'), 'JAN列は文字列のまま');
});

test('同じ商品の別表記（12桁と先頭0つき13桁）は同一商品として扱う', () => {
  const env = createEnv();
  env.post('masterUpsert', { jan: EAN13_LEAD0, name: 'US品', location: 'c-1' });
  assert.equal(env.get('masterGet', { jan: UPCA }).found, true);
  const r = env.post('receive', { jan: UPCA, qty: 2 });
  assert.equal(r.item.stock, 2);
  assert.equal(env.sheet(MASTER).body().length, 1, '行は増えない');
  assert.equal(env.post('masterUpsert', { jan: UPCA, name: 'US品2' }).created, false);
});

test('masterGet: あり・なし', () => {
  const env = createEnv();
  seed(env);
  const hit = env.get('masterGet', { jan: J1 });
  assert.equal(hit.found, true);
  assert.equal(hit.item.location, 'A-01');
  const miss = env.get('masterGet', { jan: J4 });
  assert.equal(miss.found, false);
  assert.equal(miss.item, null);
});

test('masterList: 検索・ロケ絞り込み・合計・ロケ一覧', () => {
  const env = createEnv();
  seed(env);
  env.post('receive', { jan: J1, qty: 3 });
  env.post('receive', { jan: J2, qty: 4 });
  const all = env.get('masterList');
  assert.equal(all.count, 3);
  assert.equal(all.totalStock, 7);
  assert.deepEqual(all.locations, ['A-01', 'A-02', 'B-01']);
  assert.equal(env.get('masterList', { q: '伊右衛門' }).count, 1);
  assert.equal(env.get('masterList', { q: J2 }).count, 1);
  assert.equal(env.get('masterList', { q: 'a-0' }).count, 2, 'ロケ名でも検索できる');
  assert.equal(env.get('masterList', { location: 'ｂ-01' }).count, 1, 'ロケの表記ゆれを吸収');
  assert.equal(env.get('masterList', { location: 'A-01', q: '商品' }).count, 0);
  assert.equal(env.post('masterList', { location: 'A-02' }).items[0].jan, J2);
});

test('masterImport: 見出し・タブ・カンマ・引用符・価格の記号・重複・不正行', () => {
  const env = createEnv();
  const text = [
    'JAN,商品名,価格,現在庫,ロケーション',
    `${J1},"サントリー, 伊右衛門 ""600ml""",¥120,10,a-01`,
    `${J2}\t商品B\t300\t\tb-02`,
    `${J3},商品C`,
    `${J1},重複行`,
    '4901777300447,チェックデジット不正',
    `${J4},`,
    `abc,JANじゃない`,
    '# コメント行',
    ''
  ].join('\r\n');
  const r = env.post('masterImport', { text });
  assert.equal(r.ok, true);
  assert.equal(r.added, 3);
  assert.equal(r.skipped, 4);
  assert.deepEqual(r.errors.map((e) => e.line), [5, 6, 7, 8]);
  assert.match(r.errors[0].reason, /重複/);
  assert.match(r.errors[1].reason, /チェックデジット/);
  assert.match(r.errors[2].reason, /商品名/);
  const a = env.get('masterGet', { jan: J1 }).item;
  assert.equal(a.name, 'サントリー, 伊右衛門 "600ml"');
  assert.equal(a.price, 120);
  assert.equal(a.stock, 10);
  assert.equal(a.location, 'A-01');
  assert.equal(env.get('masterGet', { jan: J2 }).item.price, 300);
  assert.equal(env.get('masterGet', { jan: J3 }).item.price, null);
  const h = env.sheet(IO).body();
  assert.equal(h.length, 1, '在庫つきの新規だけ履歴が残る');
  assert.equal(h[0][6], '初期登録');
});

test('masterImport: 既存商品は名前・価格・ロケを更新するが在庫は変えない。空欄は更新しない', () => {
  const env = createEnv();
  env.post('masterUpsert', { jan: J1, name: '旧名', price: 100, location: 'X-1', stock: 7 });
  const r = env.post('masterImport', { text: `${J1},新名,,999,` });
  assert.equal(r.updated, 1);
  const it = env.get('masterGet', { jan: J1 }).item;
  assert.deepEqual([it.name, it.price, it.stock, it.location], ['新名', 100, 7, 'X-1']);
  const again = env.post('masterImport', { text: `${J1},新名` });
  assert.equal(again.unchanged, 1);
  assert.equal(again.updated, 0);
  assert.equal(env.post('masterImport', {}).error, 'bad_request');
});

test('masterImport: items配列でも取り込める。Shift_JIS由来でも壊れない前提のBOM除去', () => {
  const env = createEnv();
  const r = env.post('masterImport', { items: [{ jan: J1, name: 'A', price: 10 }, { jan: J2, name: 'B' }] });
  assert.equal(r.added, 2);
  const r2 = env.post('masterImport', { text: `﻿JAN,商品名\n${J3},C` });
  assert.equal(r2.added, 1);
});

test('入荷: 在庫が増え、履歴が残る。ロケ変更はマスタとメモに残る', () => {
  const env = createEnv();
  seed(env);
  const r = env.post('receive', { jan: J1, qty: 5 });
  assert.equal(r.item.stock, 5);
  assert.deepEqual(r.history.kubun, '入荷');
  const r2 = env.post('receive', { jan: J1, qty: 3, location: 'ｃ-09', memo: '午前便' });
  assert.equal(r2.item.stock, 8);
  assert.equal(r2.item.location, 'C-09');
  const h = env.sheet(IO).body();
  assert.equal(h.length, 2);
  assert.deepEqual(h[1].slice(1), [J1, 'サントリー 伊右衛門 600ml', '入荷', 3, 8, '午前便 / ロケ変更: A-01→C-09']);
  assert.equal(env.get('masterGet', { jan: J1 }).item.location, 'C-09');
  const same = env.post('receive', { jan: J1, qty: 1, location: 'c-09' });
  assert.equal(same.history.memo, '', '同じロケならメモなし');
});

test('入荷: 数量の検証とマスタ未登録', () => {
  const env = createEnv();
  seed(env);
  for (const q of [0, -1, 1.5, 'x', 100001, null, undefined]) {
    assert.equal(env.post('receive', { jan: J1, qty: q }).error, 'bad_request', String(q));
  }
  const miss = env.post('receive', { jan: J4, qty: 1 });
  assert.equal(miss.error, 'not_in_master');
  assert.equal(miss.jan, J4);
  assert.equal(env.sheet(IO).body().length, 0);
});

test('出庫: 在庫が減り履歴が残る。足りない時は何も変えない', () => {
  const env = createEnv();
  seed(env);
  env.post('receive', { jan: J1, qty: 5 });
  const r = env.post('issue', { reason: 'テスト', jan: J1, qty: 2, memo: '注文123' });
  assert.equal(r.item.stock, 3);
  const bad = env.post('issue', { reason: 'テスト', jan: J1, qty: 4 });
  assert.equal(bad.error, 'insufficient_stock');
  assert.equal(bad.stock, 3);
  assert.equal(stockOf(env, J1), 3);
  const h = env.sheet(IO).body();
  assert.equal(h.length, 2, '失敗した出荷は履歴に出ない');
  assert.deepEqual(h[1].slice(3, 6), ['出庫', 2, 3]);
  env.config.ALLOW_NEGATIVE_STOCK = true;
  assert.equal(env.post('issue', { reason: 'テスト', jan: J1, qty: 4 }).item.stock, -1);
});

test('出庫でも入荷でも、マスタの在庫と履歴の「処理後の在庫数」が一致し続ける', () => {
  const env = createEnv();
  seed(env);
  let seedv = 12345;
  const rnd = () => (seedv = (seedv * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const jans = [J1, J2, J3];
  const model = { [J1]: 0, [J2]: 0, [J3]: 0 };
  for (let i = 0; i < 200; i++) {
    const j = jans[Math.floor(rnd() * 3)];
    const q = 1 + Math.floor(rnd() * 5);
    if (rnd() < 0.55) { env.post('receive', { jan: j, qty: q }); model[j] += q; }
    else {
      const r = env.post('issue', { reason: 'テスト', jan: j, qty: q });
      if (model[j] >= q) { assert.equal(r.ok, true); model[j] -= q; } else assert.equal(r.error, 'insufficient_stock');
    }
  }
  for (const j of jans) assert.equal(stockOf(env, j), model[j]);
  // 履歴を最初から足し合わせると、各行の「処理後の在庫数」と一致する
  const run = { [J1]: 0, [J2]: 0, [J3]: 0 };
  for (const row of env.sheet(IO).body()) {
    const [, jan, , kubun, qty, after] = row;
    run[jan] += kubun === '入荷' ? qty : (kubun === '出荷' || kubun === '出庫') ? -qty : qty;
    assert.equal(after, run[jan]);
  }
});

test('検品取り込み(receiveBatch): 実績数で入荷、二重取り込みは拒否、未登録JANがあれば何も書かない', () => {
  const env = createEnv();
  seed(env);
  const miss = env.post('receiveBatch', { key: '検品:便A', items: [{ jan: J1, qty: 2 }, { jan: J4, qty: 1 }] });
  assert.equal(miss.error, 'not_in_master');
  assert.deepEqual(miss.missing, [J4]);
  assert.equal(stockOf(env, J1), 0);
  assert.equal(env.sheet(IO).body().length, 0);

  const ok = env.post('receiveBatch', { key: '検品:便A', items: [{ jan: J1, qty: 2 }, { jan: J2, qty: 3 }, { jan: J1, qty: 1 }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.lines, 2);
  assert.equal(ok.totalQty, 6);
  assert.equal(stockOf(env, J1), 3);
  assert.equal(stockOf(env, J2), 3);
  const h = env.sheet(IO).body();
  assert.equal(h.length, 2);
  assert.ok(h.every((r) => r[6] === '検品:便A' && r[3] === '入荷'));

  const dup = env.post('receiveBatch', { key: '検品:便A', items: [{ jan: J1, qty: 1 }] });
  assert.equal(dup.error, 'already_imported');
  assert.equal(stockOf(env, J1), 3);
  const other = env.post('receiveBatch', { key: '検品:便A2', items: [{ jan: J1, qty: 1 }] });
  assert.equal(other.ok, true, '名前が前方一致するだけの別の検品は取り込める');
  assert.equal(env.post('receiveBatch', { items: [] }).error, 'bad_request');
  assert.equal(env.post('receiveBatch', { key: 'k', items: [] }).error, 'bad_request');
  assert.equal(env.post('receiveBatch', { key: 'k', items: [{ jan: J1, qty: 0 }] }).error, 'bad_request');
});

test('検品保存: 全行が履歴に残り、在庫は動かない。件数と「検品OK」の判定', () => {
  const env = createEnv();
  seed(env);
  env.post('receive', { jan: J1, qty: 10 });
  const before = env.sheet(MASTER).body().map((r) => r.slice());
  const ioBefore = env.sheet(IO).body().length;
  const r = env.post('inspectionSave', {
    name: '便A',
    items: [
      { jan: J1, planned: 3, actual: 3 },
      { jan: J2, planned: 5, actual: 2 },
      { jan: J3, planned: 1, actual: 4 },
      { jan: J4, planned: 0, actual: 1, name: '予定外の品' },
      { jan: EAN8, planned: 0, actual: 0 }
    ]
  });
  assert.deepEqual([r.saved, r.matched, r.short, r.over, r.unplanned, r.allOk], [4, 1, 1, 1, 1, false]);
  const rows = env.sheet(INSP).body();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1].slice(1), ['便A', J2, '商品B', 5, 2, -3]);
  assert.deepEqual(rows[3].slice(1), ['便A', J4, '予定外の品', 0, 1, 1]);
  assert.deepEqual(env.sheet(MASTER).body().map((x) => x.slice()), before, '在庫は変わらない');
  assert.equal(env.sheet(IO).body().length, ioBefore, '入出荷履歴も増えない');

  const ok = env.post('inspectionSave', { name: '便B', items: [{ jan: J1, planned: 2, actual: 2 }, { jan: J2, planned: 1, actual: 1 }] });
  assert.equal(ok.allOk, true);
  assert.equal(env.post('inspectionSave', { name: '', items: [{ jan: J1, planned: 1, actual: 1 }] }).error, 'bad_request');
  assert.equal(env.post('inspectionSave', { name: 'x', items: [{ jan: J1, planned: 1, actual: 1 }, { jan: J1, planned: 1, actual: 1 }] }).error, 'bad_request');
  assert.equal(env.post('inspectionSave', { name: 'x', items: [{ jan: J1, planned: 0, actual: 0 }] }).error, 'bad_request');
  assert.equal(env.post('inspectionSave', { name: 'x', items: [{ jan: J1, planned: -1, actual: 0 }] }).error, 'bad_request');
});

function stockSetup() {
  const env = createEnv();
  seed(env);
  env.post('masterUpsert', { jan: J4, name: '商品D', location: 'A-01' });
  env.post('receive', { jan: J1, qty: 10 }); // A-01
  env.post('receive', { jan: J2, qty: 5 }); // A-02
  env.post('receive', { jan: J3, qty: 7 }); // B-01
  env.post('receive', { jan: J4, qty: 2 }); // A-01
  return env;
}

test('棚卸プレビュー: 書き込みなしで差異を出す。未カウントは既定でそのまま', () => {
  const env = stockSetup();
  const ioN = env.sheet(IO).body().length;
  const p = env.post('stocktakePreview', { name: '棚卸1', counts: [{ jan: J1, actual: 8 }, { jan: J2, actual: 5 }] });
  assert.equal(p.ok, true);
  assert.equal(p.uncounted, 'keep');
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows.map((r) => [r.jan, r.book, r.actual, r.diff]), [[J1, 10, 8, -2], [J2, 5, 5, 0]]);
  assert.equal(p.adjust, 1);
  assert.equal(p.keptUncounted, 2);
  assert.equal(stockOf(env, J1), 10);
  assert.equal(env.sheet(IO).body().length, ioN);
  assert.equal(env.sheet(STK).body().length, 0);
});

test('棚卸確定（そのまま）: 在庫が実績に合い、差異分だけ入出荷履歴に棚卸調整、棚卸履歴に全行', () => {
  const env = stockSetup();
  const ioN = env.sheet(IO).body().length;
  const r = env.post('stocktakeSave', { name: '棚卸1', counts: [{ jan: J1, actual: 8 }, { jan: J2, actual: 5 }, { jan: J3, actual: 9 }] });
  assert.equal(r.ok, true);
  assert.equal(r.adjust, 2);
  assert.equal(stockOf(env, J1), 8);
  assert.equal(stockOf(env, J2), 5);
  assert.equal(stockOf(env, J3), 9);
  assert.equal(stockOf(env, J4), 2, '数えていない商品は変わらない');
  const io = env.sheet(IO).body().slice(ioN);
  assert.equal(io.length, 2, '差異0の行は入出荷履歴に出ない');
  assert.deepEqual(io[0].slice(1), [J1, 'サントリー 伊右衛門 600ml', '棚卸調整', -2, 8, '棚卸:棚卸1']);
  assert.deepEqual(io[1].slice(3, 6), ['棚卸調整', 2, 9]);
  const st = env.sheet(STK).body();
  assert.equal(st.length, 3);
  assert.deepEqual(st[0].slice(1), ['棚卸1', J1, 'サントリー 伊右衛門 600ml', 10, 8, -2]);
  assert.deepEqual(st[1].slice(4), [5, 5, 0]);
  assert.deepEqual(r.items.map((x) => x.jan).sort(), [J1, J3].sort());
});

test('棚卸確定（0とみなす・全体）: 未カウントで在庫のあるものが0になり、履歴に残る', () => {
  const env = stockSetup();
  const r = env.post('stocktakeSave', { name: '全数', uncounted: 'zero', counts: [{ jan: J1, actual: 10 }] });
  assert.equal(r.zeroed, 3);
  assert.equal(stockOf(env, J1), 10);
  assert.equal(stockOf(env, J2), 0);
  assert.equal(stockOf(env, J3), 0);
  assert.equal(stockOf(env, J4), 0);
  const st = env.sheet(STK).body();
  assert.equal(st.length, 4);
  const io = env.sheet(IO).body().filter((x) => x[3] === '棚卸調整');
  assert.equal(io.length, 3);
  assert.ok(io.every((x) => /0とみなし/.test(x[6]) && x[5] === 0 && x[4] < 0));
});

test('棚卸確定（0とみなす・ロケ範囲）: 範囲内の未カウントだけ0。範囲外は触らない。範囲外をスキャンしたら印', () => {
  const env = stockSetup();
  const r = env.post('stocktakeSave', {
    name: 'A棚', uncounted: 'zero', scope: { locations: ['ａ-01'] },
    counts: [{ jan: J1, actual: 9 }, { jan: J3, actual: 7 }]
  });
  assert.equal(r.ok, true);
  assert.equal(stockOf(env, J1), 9);
  assert.equal(stockOf(env, J4), 0, 'A-01の未カウントは0');
  assert.equal(stockOf(env, J2), 5, 'A-02は範囲外なのでそのまま');
  assert.equal(stockOf(env, J3), 7);
  const flags = Object.fromEntries(r.rows.map((x) => [x.jan, x.outOfScope]));
  assert.equal(flags[J3], true);
  assert.equal(flags[J1], false);
});

test('棚卸: 未登録JAN・重複・不正な実績数・空は拒否し、何も書かない', () => {
  const env = stockSetup();
  const snap = JSON.stringify(env.sheet(MASTER).dump());
  assert.equal(env.post('stocktakeSave', { name: 'x', counts: [{ jan: EAN8, actual: 1 }] }).error, 'not_in_master');
  assert.equal(env.post('stocktakeSave', { name: 'x', counts: [{ jan: J1, actual: 1 }, { jan: J1, actual: 2 }] }).error, 'bad_request');
  assert.equal(env.post('stocktakeSave', { name: 'x', counts: [{ jan: J1, actual: -1 }] }).error, 'bad_request');
  assert.equal(env.post('stocktakeSave', { name: 'x', counts: [{ jan: J1, actual: '' }] }).error, 'bad_request');
  assert.equal(env.post('stocktakeSave', { name: 'x', counts: [] }).error, 'bad_request');
  assert.equal(env.post('stocktakeSave', { name: '', counts: [{ jan: J1, actual: 1 }] }).error, 'bad_request');
  assert.equal(env.post('stocktakeSave', { name: 'x', uncounted: 'all', counts: [{ jan: J1, actual: 1 }] }).error, 'bad_request');
  assert.equal(JSON.stringify(env.sheet(MASTER).dump()), snap);
  assert.equal(env.sheet(STK).body().length, 0);
});

test('棚卸の確定後に出庫や入荷しても、履歴の「処理後の在庫数」がつながる', () => {
  const env = stockSetup();
  env.post('stocktakeSave', { name: 'T', counts: [{ jan: J1, actual: 4 }] });
  env.post('issue', { reason: 'テスト', jan: J1, qty: 1 });
  const io = env.sheet(IO).body().filter((x) => x[1] === J1);
  const last = io[io.length - 1];
  assert.deepEqual([last[3], last[4], last[5]], ['出庫', 1, 3]);
});

test('GET: masterGet と masterList は使える', () => {
  const env = createEnv();
  seed(env);
  assert.equal(env.get('masterGet', { jan: J1 }).found, true);
  assert.equal(env.get('masterList', { q: '商品' }).count, 2);
});

test('排他制御: 書き込みはロックの中で行い、必ず解放する。ロックが取れなければ busy', () => {
  const env = createEnv();
  seed(env);
  const l0 = env.state.locks;
  env.post('receive', { jan: J1, qty: 1 });
  assert.equal(env.state.locks, l0 + 1);
  assert.equal(env.state.unlocks, env.state.locks);
  env.post('issue', { reason: 'テスト', jan: J1, qty: 100 }); // エラーでも解放される
  assert.equal(env.state.unlocks, env.state.locks);
  env.state.lockFails = true;
  assert.equal(env.post('receive', { jan: J1, qty: 1 }).error, 'busy');
  assert.equal(env.get('masterList').ok, true, '読み取りはロック不要');
});

test('マスタのシート上の重複行・空行があっても動く', () => {
  const env = createEnv();
  seed(env);
  const sh = env.sheet(MASTER);
  sh.getRange(10, 1, 1, 5).setValues([[J1, '重複', 1, 1, 'Z']]);
  assert.equal(env.get('masterList').count, 3);
  assert.equal(env.get('masterGet', { jan: J1 }).item.name, 'サントリー 伊右衛門 600ml');
  const r = env.post('masterUpsert', { jan: J4, name: '新規' });
  assert.equal(r.created, true);
  assert.equal(env.get('masterGet', { jan: J4 }).found, true);
});

test('ロケーションが日付に化けない（"1-2" のような棚番）', () => {
  const env = createEnv();
  env.post('masterUpsert', { jan: J1, name: '1/2', location: '1-2' });
  const it = env.get('masterGet', { jan: J1 }).item;
  assert.equal(it.location, '1-2');
  assert.equal(it.name, '1/2');
  env.post('receive', { jan: J1, qty: 1, location: '3-4' });
  assert.equal(env.get('masterGet', { jan: J1 }).item.location, '3-4');
});

test('大量の棚卸でも書き込み回数が増えすぎない（連続行はまとめて書く）', () => {
  const env = createEnv();
  const items = [];
  for (let i = 0; i < 300; i++) items.push({ jan: withCheck(String(490000000000 + i)), name: 'P' + i, stock: 5, location: 'A-' + (i % 5) });
  const imp = env.post('masterImport', { items });
  assert.equal(imp.added, 300);
  const sh = env.sheet(MASTER);
  const w0 = sh.writeCalls;
  const counts = items.map((it) => ({ jan: it.jan, actual: 4 }));
  const r = env.post('stocktakeSave', { name: '大量', counts });
  assert.equal(r.adjust, 300);
  assert.ok(sh.writeCalls - w0 <= 300 * 5 + 5, `マスタへの書き込みセル数: ${sh.writeCalls - w0}`);
  assert.equal(env.sheet(STK).body().length, 300);
  assert.equal(stockOf(env, items[7].jan), 4);
});
