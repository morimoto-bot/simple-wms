'use strict';
// v0.7: 宛先（CS対応用）を伝票に任意で保存し、保持期間（7・14・21・30・60・90日）が過ぎたら消す
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, withCheck } = require('./gas-fake');

const J1 = '4901777300446';
const SLIP = '出荷伝票';
const COL = { toName: 12, toZip: 13, toAddr: 14, toTel: 15, doneAt: 16, cleared: 17 };

function setup() {
  const env = createEnv();
  env.post('masterUpsert', { jan: J1, name: '商品A', price: 100 });
  env.post('receive', { jan: J1, qty: 50 });
  return env;
}
const slip = (env, no) => env.post('slipCreate', { no, items: [{ code: J1, qty: 1 }] });
const shipSlip = (env, no) => { slip(env, no); env.post('slipInspect', { no, items: [{ jan: J1, count: 1 }] }); return env.post('slipShip', { no }); };
const row = (env, no) => env.sheet(SLIP).dump().find((r) => r[1] === no);
const addr = (no, extra = {}) => Object.assign({ no, name: '山田 太郎', zip: '〒100-0001', address: '東京都千代田区千代田1-1', phone: '090-1234-5678' }, extra);
/** シートの完了日時を、n日前に書き換える（時間を進める代わり） */
function ago(env, no, days) {
  const d = new Date(Date.now() - days * 86400000 - 60000);
  const p = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const sh = env.sheet(SLIP);
  const rows = sh.dump();
  const i = rows.findIndex((r) => r[1] === no);
  sh.getRange(i + 1, COL.doneAt + 1, 1, 1).setValues([[`${p.year}/${p.month}/${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`]]);
}

test('宛先を伝票に保存する: 4列に入る。郵便番号は数字だけ・電話は数字とハイフンだけ。伝票の一覧には宛先を出さず、1件の詳細にだけ出す', () => {
  const env = setup(); slip(env, 'A1');
  const r = env.post('slipAddress', { items: [addr('A1')] });
  assert.equal(r.ok, true); assert.equal(r.saved, 1); assert.deepEqual(r.skipped, []); assert.equal(r.days, 30);
  const x = row(env, 'A1');
  assert.deepEqual([x[12], x[13], x[14], x[15]], ['山田 太郎', '1000001', '東京都千代田区千代田1-1', '090-1234-5678']);
  assert.equal(env.get('slipList').slips.find((s) => s.no === 'A1').hasAddr, true);
  assert.ok(!JSON.stringify(env.get('slipList')).includes('山田'), '一覧に宛先を出さない');
  assert.deepEqual(env.get('slipGet', { no: 'A1' }).addr, { name: '山田 太郎', zip: '1000001', address: '東京都千代田区千代田1-1', phone: '090-1234-5678' });
  assert.ok(!JSON.stringify(env.get('exportData', { kind: 'slips' })).includes('山田'), 'CSV出力に宛先を出さない');
});

test('保存できないもの: 伝票が無い・宛先が空は、理由つきで飛ばす。GETでは呼べない。件数の上限', () => {
  const env = setup(); slip(env, 'A1');
  const r = env.post('slipAddress', { items: [addr('ZZZ'), { no: 'A1', name: '', zip: '', address: '', phone: '' }, addr('A1')] });
  assert.equal(r.saved, 1);
  assert.deepEqual(r.skipped.map((x) => x.reason), ['伝票がありません', '宛先が空です']);
  assert.equal(env.get('slipAddress', { items: [] }).error, 'bad_request');
  assert.equal(env.post('slipAddress', { items: [] }).error, 'bad_request');
  assert.equal(env.post('slipAddress', { items: Array.from({ length: 501 }, (_, i) => addr('X' + i)) }).error, 'bad_request');
});

test('数式になる文字列は、そのまま文字として保存される（先頭が = など）', () => {
  const env = setup(); slip(env, 'A1');
  env.post('slipAddress', { items: [addr('A1', { name: '=1+1', address: '@SUM(A1)' })] });
  const x = row(env, 'A1');
  assert.equal(x[12], '=1+1'); assert.equal(x[14], '@SUM(A1)');
});

test('出荷・キャンセルで「完了日時」が入る。出荷前は入らない', () => {
  const env = setup();
  slip(env, 'S1'); slip(env, 'V1'); slip(env, 'P1');
  env.post('slipInspect', { no: 'S1', items: [{ jan: J1, count: 1 }] });
  env.post('slipShip', { no: 'S1' }); env.post('slipVoid', { no: 'V1' });
  assert.match(row(env, 'S1')[16], /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/);
  assert.match(row(env, 'V1')[16], /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/);
  assert.equal(row(env, 'P1')[16], '');
});

test('保持日数: 既定30日。7・14・21・30・60・90・0だけ受け付ける', () => {
  const env = setup();
  assert.equal(env.get('piiStatus').days, 30);
  assert.deepEqual(env.get('piiStatus').options, [0, 7, 14, 21, 30, 60, 90]);
  for (const d of [7, 14, 21, 60, 90, 0]) assert.equal(env.post('piiSettings', { days: d }).days, d);
  assert.equal(env.post('piiSettings', { days: 10 }).error, 'bad_request');
  assert.equal(env.post('piiSettings', { days: 'x' }).error, 'bad_request');
  assert.equal(env.get('piiStatus').days, 0, '拒否された値では変わらない');
  env.props.PII_RETENTION_DAYS = '999';
  assert.equal(env.get('piiStatus').days, 30, '壊れた設定は既定に戻る');
});

test('削除: 期間を過ぎた「出荷済・キャンセル」の宛先4列だけを空白にし、削除日時を残す。伝票番号・送り状番号・明細は残る。出荷前は消さない', () => {
  const env = setup(); env.post('piiSettings', { days: 14 });
  slip(env, 'OLD'); env.post('slipTracking', { no: 'OLD', tracking: '123456789012', carrier: 'ヤマト運輸' });
  env.post('slipInspect', { no: 'OLD', items: [{ jan: J1, count: 1 }], tracking: '123456789012' }); env.post('slipShip', { no: 'OLD' });
  shipSlip(env, 'NEW'); slip(env, 'VOID'); env.post('slipVoid', { no: 'VOID' }); slip(env, 'OPEN');
  env.post('slipAddress', { items: ['OLD', 'NEW', 'VOID', 'OPEN'].map((n) => addr(n)) });
  ago(env, 'OLD', 15); ago(env, 'VOID', 20); ago(env, 'NEW', 13);
  const pre = env.post('piiPurge', { dryRun: true });
  assert.equal(pre.dryRun, true); assert.equal(pre.due, 2); assert.equal(pre.cleared, 0);
  assert.deepEqual(pre.nos.sort(), ['OLD', 'VOID']);
  assert.equal(row(env, 'OLD')[12], '山田 太郎', 'プレビューでは何も消さない');
  const r = env.post('piiPurge', {});
  assert.equal(r.cleared, 2);
  for (const n of ['OLD', 'VOID']) {
    const x = row(env, n);
    assert.deepEqual([x[12], x[13], x[14], x[15]], ['', '', '', '']);
    assert.match(x[17], /^\d{4}\/\d\d\/\d\d /);
  }
  assert.equal(row(env, 'OLD')[1], 'OLD'); assert.equal(row(env, 'OLD')[8], '123456789012');
  assert.equal(env.get('slipGet', { no: 'OLD' }).lines.length, 1);
  assert.equal(env.get('slipGet', { no: 'OLD' }).addr, null);
  assert.equal(row(env, 'NEW')[12], '山田 太郎', '期間内は残る');
  assert.equal(row(env, 'OPEN')[12], '山田 太郎', '出荷前は消さない');
  const st = env.get('piiStatus');
  assert.equal(st.stored, 2); assert.equal(st.due, 0);
  assert.equal(st.last.count, 2); assert.equal(st.last.mode, 'manual'); assert.equal(st.last.days, 14);
  assert.ok(!JSON.stringify(env.props.PII_LOG).includes('OLD'), 'ログに伝票番号や宛先を残さない');
});

test('0（自動では消さない）なら、削除は何もしない', () => {
  const env = setup(); env.post('piiSettings', { days: 0 });
  shipSlip(env, 'OLD'); env.post('slipAddress', { items: [addr('OLD')] }); ago(env, 'OLD', 400);
  assert.equal(env.post('piiPurge', {}).due, 0);
  assert.equal(row(env, 'OLD')[12], '山田 太郎');
});

test('完了日時が無い古い出荷済の行は、出荷日時から数える。どちらも無ければ作成日時から数える', () => {
  const env = setup(); env.post('piiSettings', { days: 7 });
  shipSlip(env, 'L1');
  env.post('slipAddress', { items: [addr('L1')] });
  const sh = env.sheet(SLIP); const i = sh.dump().findIndex((r) => r[1] === 'L1') + 1;
  sh.getRange(i, 17, 1, 1).setValues([['']]);                        // 完了日時なし
  sh.getRange(i, 7, 1, 1).setValues([['2020/01/01 00:00:00']]);       // 出荷日時は古い
  assert.equal(env.post('piiPurge', { dryRun: true }).due, 1);
});

test('保持期間を過ぎた伝票へ、宛先をもう一度保存しても、保存されず理由が返る', () => {
  const env = setup(); env.post('piiSettings', { days: 7 });
  shipSlip(env, 'OLD'); ago(env, 'OLD', 10);
  const r = env.post('slipAddress', { items: [addr('OLD')] });
  assert.equal(r.saved, 0); assert.match(r.skipped[0].reason, /保持期間（7日）を過ぎた/);
  assert.equal(row(env, 'OLD')[12], '');
});

test('自動の削除: アプリを使った日の最初の通信で1日1回だけ走る。失敗しても依頼された処理は成功する', () => {
  const env = setup(); env.post('piiSettings', { days: 7 });
  shipSlip(env, 'OLD'); env.post('slipAddress', { items: [addr('OLD')] }); ago(env, 'OLD', 10);
  delete env.props.PII_LAST_PURGE;
  assert.equal(env.get('slipList').ok, true);                        // 最初の通信で走る
  assert.equal(row(env, 'OLD')[12], '');
  assert.equal(env.get('piiStatus').last.mode, 'auto');
  assert.match(env.props.PII_LAST_PURGE, /^\d{4}\/\d\d\/\d\d$/);
  shipSlip(env, 'OLD2'); env.post('slipAddress', { items: [addr('OLD2')] }); ago(env, 'OLD2', 10);
  env.get('slipList');
  assert.equal(row(env, 'OLD2')[12], '山田 太郎', '同じ日には、もう走らない');
  env.state.lockFails = true;                                         // ロックが取れない日
  delete env.props.PII_LAST_PURGE;
  assert.equal(env.get('slipList').ok, true, '削除に失敗しても、読み取りは成功する');
  env.state.lockFails = false;
  env.get('slipList');
  assert.equal(row(env, 'OLD2')[12], '', '次の通信で走る');
});

test('時間トリガー用の piiDailyPurge を手で呼んでも消える（mode=trigger）', () => {
  const env = setup(); env.post('piiSettings', { days: 7 });
  shipSlip(env, 'OLD'); env.post('slipAddress', { items: [addr('OLD')] }); ago(env, 'OLD', 10);
  env.run('piiDailyPurge()');
  assert.equal(row(env, 'OLD')[12], '');
  assert.equal(env.get('piiStatus').last.mode, 'trigger');
});

test('認証: 宛先の保存・設定・削除は、合言葉が無いと拒否される', () => {
  const env = setup(); slip(env, 'A1');
  for (const a of ['slipAddress', 'piiSettings', 'piiPurge', 'piiStatus']) {
    assert.equal(env.raw('POST', { action: a, items: [addr('A1')], days: 7 }).error, 'unauthorized', a);
  }
});
