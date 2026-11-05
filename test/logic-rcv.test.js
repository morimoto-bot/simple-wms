'use strict';
// 入荷予定の消込の判定（検品済数ベース）と、CSV生成。index.html の埋め込みロジックを取り出して検証する
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\* <logic> \*\/([\s\S]*?)\/\* <\/logic> \*\//);
const Logic = new Function(m[1] + '; return Logic;')();

test('入荷予定の消込の判定: 検品済数（保存分＋今回）と予定数の比較。入荷済み・消込・予定外', () => {
  const L = (o) => Object.assign({ extra: false, planned: 5, inspected: 0, received: 0, state: '入荷待ち', now: 0 }, o);
  const st = (o) => Logic.rcvStatus(L(o));
  assert.deepEqual(
    [st({ now: 5 }), st({ now: 2 }), st({ now: 0 }), st({ now: 7 }), st({ inspected: 3, now: 2 }), st({ inspected: 5, received: 5 }), st({ inspected: 5, received: 5, now: 1 }),
      st({ state: '消込', received: 2, inspected: 2 }), st({ extra: true, planned: 0, now: 2 }), st({ extra: true, planned: 0 })],
    ['match', 'short', 'short', 'over', 'match', 'none', 'over', 'none', 'extra', 'none']);
  const sum = Logic.rcvSummary([
    L({ planned: 5, now: 5 }), L({ planned: 4, now: 1 }), L({ planned: 4, inspected: 4, received: 4 }), L({ planned: 2, now: 3 }),
    L({ extra: true, planned: 0, now: 2 }), L({ planned: 3, state: '消込', received: 1, inspected: 1 })]);
  assert.deepEqual([sum.match, sum.short, sum.over, sum.extra], [1, 1, 1, 1]);
  assert.equal(sum.nowTotal, 5 + 1 + 0 + 3 + 2 + 0, '今回計上する数（検品済数−入荷済数）');
  assert.equal(sum.remainAfter, 3, '計上後の残（予定外と消込は除く）');
  assert.equal(Logic.rcvSummary([L({ planned: 5, inspected: 3, received: 1, now: 1 })]).nowTotal, 3, '途中保存した分も計上する数に入る');
});

test('toCsv: 見出し＋行。カンマ・引用符・改行は引用符で囲み、式になる先頭文字は無害化する', () => {
  const csv = Logic.toCsv(['JAN', '商品名', '数'], [['4901777300446', 'A, B "C"', 3], ['1', '=SUM(A1)', null], ['2', '行1\n行2', -3], ['3', '+81', 0]]);
  assert.equal(csv, 'JAN,商品名,数\r\n4901777300446,"A, B ""C""",3\r\n1,\'=SUM(A1),\r\n2,"行1\n行2",-3\r\n3,\'+81,0\r\n');
  assert.equal(Logic.toCsv(['a'], []), 'a\r\n');
});

test('normTracking: 全角・空白・ハイフンのゆれを無視して、英字は大文字にそろえる（GAS側と同じ規則）', () => {
  assert.equal(Logic.normTracking(' ａｂｃ-1234 5678-90 '), 'ABC1234567890');
  assert.equal(Logic.normTracking('1234-5678-9012'), '123456789012');
  assert.equal(Logic.normTracking(''), '');
  assert.equal(Logic.normTracking(null), '');
  assert.equal(Logic.normTracking('ej123456789jp'), 'EJ123456789JP');
});
