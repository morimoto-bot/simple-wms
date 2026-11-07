'use strict';
// 送り状発行用CSV（配送方法で振り分け → 各社の取り込みCSV）。宛先は画面のメモリ上だけで扱うことも確認する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\* <logic> \*\/([\s\S]*?)\/\* <\/logic> \*\//);
assert.ok(m, 'logic区間が見つからない');
const L = new Function(m[1] + '; return Logic;')();

// Shopify標準エクスポートの形: 宛先は注文の先頭行だけ。2行目以降は商品行のみ。住所の中に改行があるケースも含める
const SHOP = [
  'Name,Email,Shipping Method,Shipping Name,Shipping Zip,Shipping Province,Shipping Province Name,Shipping City,Shipping Address1,Shipping Address2,Shipping Phone,Lineitem name,Lineitem quantity,配送希望日,配送希望時間帯',
  '#1001,a@example.com,ヤマト宅急便,山田 太郎,\'1000001,JP-13,Tokyo,千代田区,千代田1-1,"ビル\n3F",+81 90-1234-5678,商品A,1,2026-11-10,14〜16時',
  '#1001,,,,,,,,,,,商品B,2,',
  '#1002,b@example.com,クリックポスト,佐藤 花子,5300001,JP-27,大阪府,大阪市北区,梅田1-1,,09012345678,商品C,1,',
  '#1003,c@example.com,佐川急便（飛脚宅配便）,鈴木 一郎,"060-0001",,北海道,札幌市中央区,北1条西1,,0112345678,商品D,1,',
  '#1004,d@example.com,ゆうパック,高橋 次郎,8100001,JP-40,Fukuoka,福岡市中央区,天神1-1,,0921234567,商品E,1,',
  '#1005,e@example.com,謎の配送,田中 三郎,1500001,JP-13,Tokyo,渋谷区,神宮前1-1,,0312345678,商品F,1,'
].join('\r\n');

test('parseCsvRecords: 引用符の中の改行・カンマ・""、BOM、タブ区切り', () => {
  const r = L.parseCsvRecords('﻿a,b,c\r\n1,"x\ny,z","q""r"\r\n');
  assert.deepEqual(r, [['a', 'b', 'c'], ['1', 'x\ny,z', 'q"r']]);
  assert.deepEqual(L.parseCsvRecords('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(L.parseCsvRecords('a,b\n\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('normProvince / cleanZip / cleanPhone', () => {
  assert.equal(L.normProvince('JP-13'), '東京都');
  assert.equal(L.normProvince('Tōkyō'), '東京都');
  assert.equal(L.normProvince('osaka'), '大阪府');
  assert.equal(L.normProvince('北海道'), '北海道');
  assert.equal(L.normProvince('Atlantis'), 'Atlantis');
  assert.equal(L.cleanZip("'100-0001"), '1000001');
  assert.equal(L.cleanZip('１００－０００１'), '1000001');
  assert.equal(L.cleanPhone('+81 90-1234-5678'), '090-1234-5678');
  assert.equal(L.cleanPhone("'0312345678"), '03-1234-5678');
});

test('parseShipOrders: 同じ注文番号の行をまとめ、宛先は先頭行から取る', () => {
  const r = L.parseShipOrders(SHOP);
  assert.equal(r.orders.length, 5);
  assert.deepEqual(r.errors, []);
  const o = r.orders[0];
  assert.equal(o.no, '#1001');
  assert.equal(o.item, '商品A');
  assert.equal(o.zip, '1000001');
  assert.equal(o.province, '東京都');
  assert.equal(o.addr2, 'ビル3F', 'セル内の改行は詰める');
  assert.equal(o.phone, '090-1234-5678');
  assert.equal(o.method, 'ヤマト宅急便');
  assert.equal(r.orders[4].province, '東京都');
  assert.equal(r.orders[3].province, '福岡県');
});

test('parseShipOrders: 注文番号の列が無ければ止まる。宛先の列が無ければ知らせる', () => {
  assert.equal(L.parseShipOrders('a,b\n1,2').orders.length, 0);
  assert.match(L.parseShipOrders('a,b\n1,2').errors[0], /注文番号/);
  const r = L.parseShipOrders('Name,Lineitem name\n#1,x');
  assert.equal(r.orders.length, 1);
  assert.match(r.errors[0], /郵便番号/);
  assert.equal(L.parseShipOrders('').orders.length, 0);
});

test('日本語の列名でも読める', () => {
  const r = L.parseShipOrders('注文番号,配送方法,お届け先氏名,お届け先郵便番号,お届け先都道府県,お届け先市区町村,お届け先住所1,お届け先電話番号,商品名\nA-1,ヤマト,山田,1000001,東京都,千代田区,千代田1-1,0312345678,りんご');
  assert.equal(r.orders[0].toName, '山田');
  assert.equal(r.orders[0].province, '東京都');
  assert.equal(r.orders[0].item, 'りんご');
});

test('parseRoutes / routeOrder: 上から順・キーワード空は全件・分からない出力先はエラー', () => {
  const p = L.parseRoutes(L.DEFAULT_ROUTES);
  assert.deepEqual(p.errors, []);
  assert.equal(L.routeOrder('ヤマト宅急便', p.rules), 'yamato');
  assert.equal(L.routeOrder('佐川急便（飛脚宅配便）', p.rules), 'sagawa');
  assert.equal(L.routeOrder('クリックポスト', p.rules), 'clickpost');
  assert.equal(L.routeOrder('ゆうパック', p.rules), 'yupack');
  assert.equal(L.routeOrder('謎の配送', p.rules), '');
  const q = L.parseRoutes('# メモ\n,日本郵便\n宅急便,ヤマト');
  assert.equal(L.routeOrder('宅急便', q.rules), 'yupack', '空のキーワードが先なら全件がそちらへ');
  const bad = L.parseRoutes('宅急便,ほげ運輸\nなし');
  assert.equal(bad.errors.length, 2);
  assert.equal(L.parseRoutes('宅急便＝ヤマト').rules[0].carrier, 'yamato');
});

test('timeCode / slashDate: 時間帯・日付の表記ゆれ', () => {
  assert.equal(L.timeCode('午前中', 'yamato'), '0812');
  assert.equal(L.timeCode('午前中', 'sagawa'), '1');
  assert.equal(L.timeCode('14〜16時', 'yamato'), '1416');
  assert.equal(L.timeCode('14:00-16:00', 'yupack'), '03');
  assert.equal(L.timeCode('１９～２１時', 'sagawa'), '6');
  assert.equal(L.timeCode('夜', 'yamato'), '');
  assert.equal(L.timeCode('', 'yamato'), '');
  assert.equal(L.slashDate('2026-11-10'), '2026/11/10');
  assert.equal(L.slashDate('2026年11月5日'), '2026/11/05');
  assert.equal(L.slashDate('２０２６/１/２'), '2026/01/02');
  assert.equal(L.slashDate(''), '');
});

const CTX = { shipper: { name: 'サンプル商店', postCode: '150-0001', address: '東京都渋谷区神宮前9-9-9ビル101', phone: '03-0000-0000' }, today: '2026/11/07', ymd: '20261107' };
function build() {
  const orders = L.parseShipOrders(SHOP).orders;
  return L.buildLabelSet(orders, L.parseRoutes(L.DEFAULT_ROUTES).rules, CTX);
}

test('buildLabelSet: 配送方法で振り分け、未分類は出力しない', () => {
  const r = build();
  assert.deepEqual(r.sets.map((s) => s.carrier + ':' + s.count), ['clickpost:1', 'yamato:1', 'sagawa:1', 'yupack:1']);
  assert.deepEqual(r.unrouted.map((o) => o.no), ['#1005']);
});

test('ヤマトB2: 42列、お客様管理番号・お届け先・依頼主・品名・指定日時', () => {
  const f = build().sets.find((s) => s.carrier === 'yamato').files[0];
  assert.equal(f.header.length, 42);
  assert.ok(f.rows.every((r) => r.length === 42));
  const r = f.rows[0];
  assert.equal(r[0], '#1001'); assert.equal(r[4], '2026/11/07'); assert.equal(r[5], '2026/11/10'); assert.equal(r[6], '1416');
  assert.equal(r[8], '090-1234-5678'); assert.equal(r[10], '1000001');
  assert.equal(r[11], '東京都千代田区千代田1-1ビル3F'.slice(0, 21)); assert.equal(r[12], '');
  assert.ok(!f.rows.some((x) => x.some((c) => /[\r\n]/.test(c))), '出力のセルに改行を含めない'); assert.equal(r[15], '山田 太郎');
  assert.equal(r[21], '1500001'); assert.equal(r[24], 'サンプル商店'); assert.equal(r[27], '商品A');
  assert.equal(r[37], '1'); assert.equal(r[38], '1');
  assert.equal(f.name, 'yamato_b2_20261107.csv');
});

test('佐川e飛伝III: 見出しと行が同じ列数、お客様管理番号に注文番号', () => {
  const f = build().sets.find((s) => s.carrier === 'sagawa').files[0];
  assert.equal(f.header.length, 74);
  assert.ok(f.rows.every((r) => r.length === 74));
  const r = f.rows[0];
  assert.equal(r[3], '0600001'); assert.equal(r[9], '#1003'); assert.equal(r[41], '1'); assert.equal(r[24], '商品D');
});

test('ゆうプリR: 見出しと行が同じ列数、品名は最終列', () => {
  const f = build().sets.find((s) => s.carrier === 'yupack').files[0];
  assert.equal(f.header.length, 105);
  assert.ok(f.rows.every((r) => r.length === 105));
  const r = f.rows[0];
  assert.equal(r[0], '#1004'); assert.equal(r[14], '8100001'); assert.equal(r[104], '商品E'); assert.equal(f.header[104], '品名'); assert.equal(r[73], '1');
});

test('クリックポスト: 内容品に注文番号。40件ごとに分割', () => {
  const f = build().sets.find((s) => s.carrier === 'clickpost').files[0];
  assert.equal(f.header.length, 8); assert.equal(f.header[7], '内容品');
  assert.deepEqual(f.rows[0], ['5300001', '佐藤 花子', '様', '大阪府', '大阪市北区梅田1-1', '', '', '#1002']);
  const many = Array.from({ length: 85 }, (_, i) => ({ no: '#' + i, method: 'クリックポスト', toName: 'x', zip: '1000001', province: '東京都', city: 'a', addr1: 'b', addr2: '', phone: '', item: '', attrs: '' }));
  const files = L.buildCarrierCsv('clickpost', many, CTX);
  assert.deepEqual(files.map((x) => x.rows.length), [40, 40, 5]);
  assert.equal(files[0].name, 'clickpost_batch1_of3_20261107.csv');
  assert.equal(L.buildCarrierCsv('clickpost', many.slice(0, 3), CTX)[0].name, 'clickpost_20261107.csv');
});

test('orderProblems: 宛先の不足を知らせる', () => {
  const o = { no: '#9', zip: '123', province: '', city: '', addr1: '', toName: '', phone: '' };
  assert.equal(L.orderProblems(o).length, 4);
  assert.deepEqual(L.orderProblems(L.parseShipOrders(SHOP).orders[0]), []);
  const r = L.buildLabelSet([o].map((x) => Object.assign({ method: 'ヤマト', addr2: '', item: '', attrs: '' }, x)), L.parseRoutes(L.DEFAULT_ROUTES).rules, CTX);
  assert.equal(r.sets[0].problems[0].no, '#9');
});

test('CSV化: 式として解釈される先頭文字は無害化される（toCsv）', () => {
  const csv = L.toCsv(['a'], [['=1+1'], ['山田,太郎']]);
  assert.match(csv, /'=1\+1/);
  assert.match(csv, /"山田,太郎"/);
});

// ---- Shopify以外の注文CSV（列は割り当てで決める） ----
const OTHER = [
  '受注番号,配送会社,送付先氏名,送付先郵便番号,送付先住所,送付先電話番号,商品名,配送希望日,配送希望時間帯',
  'R-1,ヤマト運輸,山田 太郎,100-0001,東京都千代田区千代田1-1 ビルA,03-1111-2222,りんご,2026年11月10日,午前中',
  'R-2,佐川急便,佐藤 花子,530-0001,大阪府大阪市北区梅田1-1,06-1111-2222,みかん,,'
].join('\n');

test('Shopify以外: 住所が1列でも、都道府県を切り出して読める（自動の割り当て）', () => {
  const r = L.parseShipOrders(OTHER);
  assert.deepEqual(r.errors, []);
  assert.equal(r.orders.length, 2);
  const o = r.orders[0];
  assert.equal(o.no, 'R-1'); assert.equal(o.method, 'ヤマト運輸'); assert.equal(o.toName, '山田 太郎');
  assert.equal(o.zip, '1000001'); assert.equal(o.province, '東京都'); assert.equal(o.addr1, '千代田区千代田1-1 ビルA');
  assert.equal(o.date, '2026年11月10日'); assert.equal(o.time, '午前中'); assert.equal(o.item, 'りんご');
  assert.equal(r.orders[1].province, '大阪府');
});

test('Shopify以外: 出力にお届け希望日・時間帯・住所が入る', () => {
  const orders = L.parseShipOrders(OTHER).orders;
  const rules = L.parseRoutes(L.DEFAULT_ROUTES).rules;
  const set = L.buildLabelSet(orders, rules, CTX);
  const y = set.sets.find((s) => s.carrier === 'yamato').files[0].rows[0];
  assert.equal(y[0], 'R-1'); assert.equal(y[5], '2026/11/10'); assert.equal(y[6], '0812'); assert.equal(y[10], '1000001');
  assert.equal(y[11], '東京都千代田区千代田1-1 ビルA'.slice(0, 21)); assert.equal(y[27], 'りんご');
  const s = set.sets.find((x) => x.carrier === 'sagawa').files[0].rows[0];
  assert.equal(s[44], ''); assert.equal(s[45], '');
});

test('列の割り当て: 自動で当たらない列は、割り当てで直せる。範囲外の割り当ては自動に戻る', () => {
  const csv = 'ID,宛先,〒,場所,TEL,運び方\n9,鈴木,1500001,東京都渋谷区神宮前1-1,0312345678,ヤマト';
  const auto = L.parseShipOrders(csv);
  assert.equal(auto.orders.length, 0, '注文番号の列が当たらなければ止まる');
  assert.match(auto.errors[0], /注文番号/);
  const head = L.parseCsvRecords(csv)[0];
  const map = Object.assign(L.guessMapping(head), { no: 0, toName: 1, zip: 2, addr1: 3, phone: 4, method: 5 });
  const r = L.parseShipOrders(csv, map);
  assert.deepEqual(r.errors, []);
  assert.equal(r.orders[0].no, '9'); assert.equal(r.orders[0].province, '東京都'); assert.equal(r.orders[0].method, 'ヤマト');
  const bad = L.fixMapping({ no: 99, zip: -1 }, head);
  assert.equal(bad.no, -1, '範囲外は自動の結果（当たらなければ -1）に戻る');
  assert.equal(bad.zip, -1);
  assert.equal(L.fixMapping({ no: 0 }, head).no, 0);
});

test('headSignature: 見出しの並びだけを印にする（データを含まない）', () => {
  assert.equal(L.headSignature(['a', ' b ', 'c']), 'a|b|c');
  assert.equal(L.headSignature(['a', 'b']), L.headSignature(['a', 'b']));
  assert.notEqual(L.headSignature(['a', 'b']), L.headSignature(['b', 'a']));
});

test('どれにも合わない注文の出力先（配送方法の列が無いCSV向け）', () => {
  const csv = '注文番号,氏名,郵便番号,住所,電話番号\nZ-1,田中,1500001,東京都渋谷区神宮前1-1,0312345678';
  const orders = L.parseShipOrders(csv).orders;
  const rules = L.parseRoutes(L.DEFAULT_ROUTES).rules;
  assert.equal(L.buildLabelSet(orders, rules, CTX).unrouted.length, 1);
  const r = L.buildLabelSet(orders, rules, CTX, 'yamato');
  assert.equal(r.unrouted.length, 0);
  assert.equal(r.sets[0].carrier, 'yamato');
  assert.equal(L.buildLabelSet(orders, rules, CTX, 'ほげ').unrouted.length, 1, '不正な出力先は無視');
});

test('画面: 文言が特定のECサービス前提になっていない（label-ui区間）', () => {
  const ui = html.slice(html.indexOf('/* <label-ui> */'), html.indexOf('/* </label-ui> */'));
  assert.ok(!/Shopify|Note Attributes/.test(ui));
  assert.match(ui, /列の割り当て/);
});

test('個人情報: 宛先を送るのは「宛先を伝票に保存」だけ。CSVの生成・読み込みは通信しない。端末に保存するのは設定だけ', () => {
  const s = html.indexOf('/* <label-ui> */'), e = html.indexOf('/* </label-ui> */');
  assert.ok(s > 0 && e > s, 'label-ui区間が見つからない');
  const ui = html.slice(s, e);
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(ui), '外へ直接送らない');
  const calls = [...ui.matchAll(/\bapi\('([A-Za-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...new Set(calls)].sort(), ['piiPurge', 'piiSettings', 'piiStatus', 'slipAddress'], '通信するのは、保存・保持期間・削除の4つだけ');
  // 宛先を送る slipAddress は、確認ダイアログを経てからだけ
  const save = ui.match(/async function labelSaveAddr\(\) \{([\s\S]*?)\n\}/);
  assert.ok(save, 'labelSaveAddr がある');
  assert.ok(save[1].indexOf('confirmDialog') >= 0 && save[1].indexOf('confirmDialog') < save[1].indexOf("api('slipAddress'"), '保存の前に確認する');
  assert.equal([...ui.matchAll(/api\('slipAddress'/g)].length, 1, '宛先を送る場所は1か所');
  // 振り分け・CSV作成・読み込み（labelRun/lblLoad/labelDownload）は通信しない
  for (const fn of ['labelRun', 'lblLoad', 'labelDownload']) {
    const m = ui.match(new RegExp('function ' + fn + '\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}'));
    assert.ok(m, fn + ' がある');
    assert.ok(!/\bapi\(/.test(m[1]), fn + ' は通信しない');
  }
  const stores = ui.match(/store\.set\([^)]*\)/g) || [];
  assert.ok(stores.length >= 1 && stores.every((x) => /'wms\.label'/.test(x)), '保存するのは設定（wms.label）だけ');
  const cfgDef = ui.match(/const LBL_CFG_KEYS = \[([^\]]*)\]/);
  assert.ok(cfgDef, '保存する設定の項目一覧がある');
  assert.ok(!/orders|text|res|addr|recs/.test(cfgDef[1]), '注文・宛先は設定に含めない');
});

test('保持期間・削除の画面: 保持日数の選択、削除の対象を確認、今すぐ削除（確認つき）がある。分単位の自動消去は無い', () => {
  const ui = html.slice(html.indexOf('/* <label-ui> */'), html.indexOf('/* </label-ui> */'));
  assert.match(ui, /data-in="piiDays"/);
  assert.match(ui, /data-act="piiPreview"/);
  assert.match(ui, /data-act="piiRun"/);
  const run = ui.match(/async function piiPurgeRun\(dry\) \{([\s\S]*?)\n\}/);
  assert.ok(run && /confirmDialog/.test(run[1]) && /danger: true/.test(run[1]), '今すぐ削除は確認してから');
  assert.ok(!/setInterval|ttl|lblTick/.test(ui), '分単位のタイマーは持たない');
  assert.match(ui, /d\.options/, '選べる日数はGASの値（7・14・21・30・60・90・0）を使う');
});
