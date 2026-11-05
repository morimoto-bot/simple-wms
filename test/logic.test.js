'use strict';
// index.html に埋め込んだロジック（/* <logic> */ 〜 /* </logic> */）を取り出して検証する。
// ZXing-js は実際のライブラリ（UMD）を使い、生成したバーコード画像を復号できるかも確認する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { withCheck } = require('./gas-fake');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\* <logic> \*\/([\s\S]*?)\/\* <\/logic> \*\//);
assert.ok(m, 'logic区間が見つからない');
const Logic = new Function(m[1] + '; return Logic;')();

function loadZXing() {
  const cands = [process.env.ZXING_UMD, path.join(__dirname, 'node_modules/@zxing/library/umd/index.min.js')].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) { const mod = { exports: {} }; vm.runInNewContext(fs.readFileSync(c, 'utf8'), { module: mod, exports: mod.exports, self: {}, window: undefined, TextDecoder, TextEncoder, console }); return mod.exports.BarcodeFormat ? mod.exports : null; }
  return null;
}

test('index.html の全スクリプトが構文として正しい', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  assert.ok(scripts.length >= 1);
  for (const s of scripts) new vm.Script(s);
});

test('index.html: プレースホルダが残っていない・PWAのmetaがある・APIキー類を直書きしていない', () => {
  assert.ok(!/__ICON_B64__|__ZXING_SRI__/.test(html));
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /@zxing\/library@0\.23\.0/);
  assert.match(html, /integrity="sha384-/);
  assert.ok(!/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/.test(html), 'GASのURLを直書きしていない');
  assert.ok(!/appid\s*[:=]\s*['"][A-Za-z0-9]{10,}/i.test(html));
});

const J1 = '4901777300446', J2 = withCheck('490123456789'), UPCA = withCheck('01234567890'), EAN8 = withCheck('4912345');

test('validateJan: 桁数・チェックデジット・全角・ハイフン', () => {
  assert.equal(Logic.validateJan(J1).ok, true);
  assert.equal(Logic.validateJan(' 4901-7773-00446 ').jan, J1);
  assert.equal(Logic.validateJan(J1.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)))).ok, true);
  assert.equal(Logic.validateJan(UPCA).ok, true);
  assert.equal(Logic.validateJan(EAN8).ok, true);
  assert.equal(Logic.validateJan('4901777300447').ok, false);
  assert.equal(Logic.validateJan('12345').ok, false);
  assert.equal(Logic.validateJan('').ok, false);
  assert.equal(Logic.validateJan('abc').ok, false);
});

test('janKey: 12桁と先頭0つき13桁が同じキーになる', () => {
  assert.equal(Logic.janKey(UPCA), Logic.janKey('0' + UPCA));
  assert.notEqual(Logic.janKey(J1), Logic.janKey(J2));
  assert.equal(Logic.janKey('0000'), '0');
});

test('normLocation: 全角・小文字・各種ハイフン・空白', () => {
  assert.equal(Logic.normLocation(' ａ－０１ '), 'A-01');
  assert.equal(Logic.normLocation('b‐2'), 'B-2');
  assert.equal(Logic.normLocation('a  01'), 'A 01');
  assert.equal(Logic.normLocation(''), '');
});

test('speechText / yen', () => {
  assert.equal(Logic.speechText({ name: '【新】伊右衛門 600ml', price: 120 }), '新 伊右衛門 600ml、120円');
  assert.equal(Logic.speechText({ name: 'A', price: null }), 'A');
  assert.equal(Logic.speechText({ name: 'あ'.repeat(60), price: 1 }).length, 40 + '、1円'.length);
  assert.equal(Logic.yen(1200), '¥1,200');
  assert.equal(Logic.yen(null), '');
});

test('parsePlanText: JAN,予定数 / タブ / 空白 / 見出し / 商品名つき / 重複は合算', () => {
  const t = ['JAN,予定数', `${J1},3`, `${J2}\t2\t商品B`, `${UPCA} 4`, `${J1},1`, '# メモ', ''].join('\n');
  const p = Logic.parsePlanText(t, 1);
  assert.equal(p.errors.length, 0);
  assert.deepEqual(p.rows.map((r) => [r.jan, r.planned]), [[J1, 4], [J2, 2], [UPCA, 4]]);
  assert.equal(p.rows[1].name, '商品B');
});

test('parsePlanText: 「JAN,商品名」の一覧は予定数=既定値として使える（サンプルをそのまま予定にできる）', () => {
  const p = Logic.parsePlanText(`${J1},伊右衛門 600ml\n${J2},商品B,120`, 2);
  assert.deepEqual(p.rows.map((r) => [r.jan, r.planned]), [[J1, 2], [J2, 2]]);
});

test('parsePlanText: 不正なJAN・負の数・0は行番号つきでエラー、他の行は生かす', () => {
  const p = Logic.parsePlanText(`${J1},2\n123,1\n${J2},-1\n${UPCA},0`, 1);
  assert.deepEqual(p.rows.map((r) => r.jan), [J1]);
  assert.deepEqual(p.errors.map((e) => e.line), [2, 3, 4]);
});

test('planFromMaster → parsePlanText の往復', () => {
  const items = [{ jan: J1, name: 'A, B' }, { jan: J2, name: 'C' }];
  const t = Logic.planFromMaster(items, 3);
  const p = Logic.parsePlanText(t, 1);
  assert.deepEqual(p.rows.map((r) => [r.jan, r.planned]), [[J1, 3], [J2, 3]]);
  assert.equal(p.errors.length, 0);
});

test('decodeBytes: UTF-8・BOMつき・Shift_JIS', () => {
  assert.equal(Logic.decodeBytes(new TextEncoder().encode('商品名,価格')), '商品名,価格');
  assert.equal(Logic.decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('JAN')])), 'JAN');
  assert.equal(Logic.decodeBytes(new Uint8Array([143, 164, 149, 105, 150, 188, 44, 137, 191, 138, 105])), '商品名,価格');
});

test('parseFragment / gasUrlProblem', () => {
  assert.deepEqual(Logic.parseFragment('#gas=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2FAB%2Fexec&token=t%20k'), { gas: 'https://script.google.com/macros/s/AB/exec', token: 't k' });
  assert.equal(Logic.parseFragment(''), null);
  assert.equal(Logic.parseFragment('#foo=1'), null);
  assert.equal(Logic.gasUrlProblem('https://script.google.com/macros/s/AKfy_x-1/exec'), '');
  assert.match(Logic.gasUrlProblem('https://script.google.com/macros/s/AKfy/dev'), /\/dev/);
  assert.match(Logic.gasUrlProblem('http://example.com'), /形式/);
  assert.match(Logic.gasUrlProblem(''), /未入力/);
});

test('検品の色判定と「検品OK」', () => {
  const st = (p, a) => Logic.inspStatus({ planned: p, actual: a });
  assert.deepEqual([st(3, 3), st(3, 1), st(3, 5), st(0, 2), st(0, 0), st(3, 0)], ['match', 'short', 'over', 'extra', 'none', 'short']);
  const ok = Logic.inspSummary([{ planned: 2, actual: 2 }, { planned: 1, actual: 1 }]);
  assert.equal(ok.allOk, true);
  assert.deepEqual([ok.total, ok.match, ok.planned, ok.actual], [2, 2, 3, 3]);
  const ng = Logic.inspSummary([{ planned: 2, actual: 2 }, { planned: 1, actual: 0 }, { planned: 1, actual: 2 }, { planned: 0, actual: 1 }]);
  assert.equal(ng.allOk, false);
  assert.deepEqual([ng.match, ng.short, ng.over, ng.extra], [1, 1, 1, 1]);
  assert.equal(Logic.inspSummary([{ planned: 1, actual: 1 }, { planned: 0, actual: 1 }]).allOk, false, '予定外があればOKにならない');
  assert.equal(Logic.inspSummary([]).allOk, false, '空はOKにならない');
  assert.equal(Logic.inspSummary([{ planned: 0, actual: 0 }]).allOk, false);
});

test('棚卸ビュー: 帳簿との差異・範囲・未カウント・範囲外・並び', () => {
  const items = [
    { jan: J1, name: 'A', location: 'A-01', stock: 10 },
    { jan: J2, name: 'B', location: 'A-02', stock: 5 },
    { jan: UPCA, name: 'C', location: 'B-01', stock: 7 }
  ];
  const s = { scope: ['A-01', 'A-02'], counts: { [Logic.janKey(J1)]: { jan: J1, actual: 8 }, [Logic.janKey(UPCA)]: { jan: UPCA, actual: 7 } }, order: [Logic.janKey(UPCA), Logic.janKey(J1)] };
  const v = Logic.stkView(s, items);
  assert.deepEqual(v.counted.map((r) => [r.name, r.book, r.actual, r.diff, r.outOfScope]), [['C', 7, 7, 0, true], ['A', 10, 8, -2, false]]);
  assert.deepEqual(v.uncounted.map((i) => i.name), ['B'], '範囲外のCは未カウントに出ない');
  const all = Logic.stkView({ scope: [], counts: {}, order: [] }, items);
  assert.equal(all.uncounted.length, 3);
  const unknown = Logic.stkView({ scope: [], counts: { x: { jan: J2, actual: 1 } }, order: ['x'] }, []);
  assert.equal(unknown.counted[0].name, '（マスタ未登録）');
});

test('在庫一覧の絞り込みと並び替え（ロケは自然順。未設定は最後）', () => {
  const items = [
    { jan: '1', name: 'りんご', location: 'A-10', stock: 3 },
    { jan: '2', name: 'みかん', location: 'A-2', stock: 9 },
    { jan: '3', name: 'ぶどう', location: '', stock: 0 },
    { jan: '4', name: 'バナナ', location: 'B-1', stock: 3 }
  ];
  const names = (o) => Logic.filterStock(items, o).map((i) => i.name);
  assert.deepEqual(names({ sort: 'loc' }), ['みかん', 'りんご', 'バナナ', 'ぶどう']);
  assert.deepEqual(names({ sort: 'stockAsc' }), ['ぶどう', 'りんご', 'バナナ', 'みかん']);
  assert.deepEqual(names({ sort: 'stockDesc' }), ['みかん', 'りんご', 'バナナ', 'ぶどう']);
  assert.deepEqual(names({ loc: 'ａ-2' }), ['みかん']);
  assert.deepEqual(names({ q: 'A-' }), ['みかん', 'りんご']);
  assert.deepEqual(names({ q: 'ばなな' }), []);
  assert.deepEqual(names({ q: 'バナナ', loc: 'B-1' }), ['バナナ']);
  assert.equal(names({ sort: 'name' }).length, 4);
});

test('rgbaToGray / cropRegion', () => {
  const g = Logic.rgbaToGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]), 3, 1);
  assert.deepEqual(Array.from(g), [255, 0, 76]);
  // 箱と映像が同じ比率なら、全体の92%×56%
  assert.deepEqual(Logic.cropRegion(1000, 500, 400, 200), { x: 40, y: 110, w: 920, h: 280 });
  // 縦長の映像（iPhone縦持ち）を横長の箱にcoverで入れる → 見えているのは中央の帯
  const r = Logic.cropRegion(720, 1280, 400, 200);
  assert.ok(r.w === Math.round(720 * 0.92));
  assert.ok(r.y > 1280 * 0.3 && r.y + r.h < 1280 * 0.7);
  // 横長の映像を縦長の箱に入れる → 左右が切れる
  const r2 = Logic.cropRegion(1280, 720, 300, 600);
  assert.ok(r2.x > 400 && r2.x + r2.w < 880);
});

// ------------------------------------------------------------------ バーコード画像の生成と復号
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = L.map((s) => s.split('').map((c) => (c === '0' ? '1' : '0')).join(''));
const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
function ean13Modules(code) {
  const d = code.split('').map(Number); let s = '101';
  for (let i = 1; i <= 6; i++) s += (PAR[d[0]][i - 1] === 'L' ? L : G)[d[i]];
  s += '01010';
  for (let i = 7; i <= 12; i++) s += R[d[i]];
  return s + '101';
}
function ean8Modules(code) {
  const d = code.split('').map(Number); let s = '101';
  for (let i = 0; i < 4; i++) s += L[d[i]];
  s += '01010';
  for (let i = 4; i < 8; i++) s += R[d[i]];
  return s + '101';
}
function modulesFor(code) {
  if (code.length === 13) return ean13Modules(code);
  if (code.length === 12) return ean13Modules('0' + code);
  return ean8Modules(code);
}
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function render(code, o = {}) {
  const mod = o.module || 3, quiet = 10, bars = modulesFor(code);
  const w = (bars.length + quiet * 2) * mod + (o.padX || 0) * 2, h = o.height || 90, padY = o.padY || 0;
  const W = w, H = h + padY * 2;
  const g = new Uint8ClampedArray(W * H).fill(o.bg === undefined ? 235 : o.bg);
  for (let y = padY; y < padY + h; y++) {
    for (let i = 0; i < bars.length; i++) {
      if (bars[i] === '1') for (let k = 0; k < mod; k++) g[y * W + (o.padX || 0) + (quiet + i) * mod + k] = 25;
    }
  }
  return { g, W, H };
}
function blur(img, r) {
  const { g, W, H } = img; const out = new Uint8ClampedArray(g.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dx = -r; dx <= r; dx++) { const xx = Math.min(W - 1, Math.max(0, x + dx)); s += g[y * W + xx]; n++; }
    out[y * W + x] = s / n;
  }
  return { g: out, W, H };
}
function noise(img, amp) {
  const g = img.g.map((v) => Math.max(0, Math.min(255, v + (rnd() - 0.5) * 2 * amp)));
  return { g: new Uint8ClampedArray(g), W: img.W, H: img.H };
}
function rotate(img, deg) {
  const rad = (deg * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const { g, W, H } = img; const out = new Uint8ClampedArray(W * H).fill(235);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - W / 2, dy = y - H / 2;
    const sx = Math.round(c * dx + s * dy + W / 2), sy = Math.round(-s * dx + c * dy + H / 2);
    if (sx >= 0 && sy >= 0 && sx < W && sy < H) out[y * W + x] = g[sy * W + sx];
  }
  return { g: out, W, H };
}
function rotate90(img) {
  const { g, W, H } = img; const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[x * H + (H - 1 - y)] = g[y * W + x];
  return { g: out, W: H, H: W };
}

const ZX = loadZXing();
const zxTest = ZX ? test : test.skip;

zxTest('ZXing: EAN-13 を倍率・ぼけ・ノイズ・傾きがあっても復号できる', () => {
  const decode = Logic.createDecoder(ZX);
  const codes = [J1, J2, withCheck('454913150001'), withCheck('490000000002'), withCheck('456789012345'), withCheck('491234567890')];
  let n = 0;
  for (const code of codes) {
    for (const mod of [2, 3, 4, 5]) {
      const base = render(code, { module: mod, height: 80 });
      const variants = {
        clean: base,
        ...(mod >= 5 ? { blur: blur(base, 1), blurNoise: noise(blur(base, 1), 20) } : {}),
        ...(mod >= 3 ? { noise: noise(base, 30) } : {}),
        tilt5: rotate(base, 5),
        tiltNeg4: rotate(base, -4)
      };
      for (const [name, v] of Object.entries(variants)) {
        const got = decode(v.g, v.W, v.H);
        assert.equal(got, code, `code=${code} module=${mod} ${name}`);
        n++;
      }
    }
  }
  assert.ok(n >= 100);
});

zxTest('ZXing: 縦向きのバーコードは、そのままでは読めず、90度回すと読める（写真から読む機能は両方試す）', () => {
  const decode = Logic.createDecoder(ZX);
  const v = rotate90(render(J1, { module: 3, height: 90 }));
  assert.equal(decode(v.g, v.W, v.H), null, '縦向きはそのままでは読めない（カメラ読み取りは横向きで使う前提）');
  assert.equal(decode(Logic.rotate90Gray(v.g, v.W, v.H), v.H, v.W), J1);
});

zxTest('ZXing: EAN-8 と UPC-A（12桁）。結果は validateJan を通り、DBのキーと一致する', () => {
  const decode = Logic.createDecoder(ZX);
  const a = render(EAN8, { module: 3 });
  assert.equal(decode(a.g, a.W, a.H), EAN8);
  const b = render(UPCA, { module: 3 });
  const got = decode(b.g, b.W, b.H);
  assert.ok(got === UPCA || got === '0' + UPCA, `UPC-Aの復号結果: ${got}`);
  assert.equal(Logic.validateJan(got).key, Logic.janKey(UPCA));
});

zxTest('ZXing: 先頭が0のEAN-13（日本では稀）も、12桁/13桁どちらで返っても同じキーになる', () => {
  const decode = Logic.createDecoder(ZX);
  const code = '0' + withCheck('12345678901'); // 13桁
  const img = render(code, { module: 3 });
  const got = decode(img.g, img.W, img.H);
  assert.equal(Logic.validateJan(got).key, Logic.janKey(code));
});

zxTest('ZXing: 余白の中にバーコードがある画像（枠で切り出した想定）。バーコードが無い画像・ノイズだけの画像は null', () => {
  const decode = Logic.createDecoder(ZX);
  const img = render(J1, { module: 2, height: 70, padX: 120, padY: 60 });
  assert.equal(decode(img.g, img.W, img.H), J1);
  const blank = new Uint8ClampedArray(400 * 200).fill(200);
  assert.equal(decode(blank, 400, 200), null);
  const noisy = noise({ g: new Uint8ClampedArray(400 * 200).fill(128), W: 400, H: 200 }, 120);
  assert.equal(decode(noisy.g, noisy.W, noisy.H), null);
});

zxTest('ZXing: 1フレームの処理時間（スマホで約10fps出る目安として、PCで10ms台〜数十ms）', () => {
  const decode = Logic.createDecoder(ZX);
  const img = noise(render(J1, { module: 3, height: 280, padX: 100, padY: 100 }), 25);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) decode(img.g, img.W, img.H);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  console.log(`  バーコードあり 1回あたり ${ms.toFixed(1)} ms（${img.W}x${img.H}）`);
  assert.ok(ms < 200);
  // 実際のカメラでは大半のフレームにバーコードが無い。その場合（全探索になる）の時間
  const miss = noise({ g: new Uint8ClampedArray(960 * 400).fill(150), W: 960, H: 400 }, 60);
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) decode(miss.g, miss.W, miss.H);
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6 / 10;
  console.log(`  バーコードなし(960x400のノイズ) 1回あたり ${ms2.toFixed(1)} ms`);
  assert.ok(ms2 < 400);
});

// ------------------------------------------------------------------ v0.4 の画面ロジック
test('parseCodeQtyText: SKUでもJANでも。数量なしは既定値。見出し行・タブ・空白区切り・負の数', () => {
  const p = Logic.parseCodeQtyText(['コード,数量', 'SKU-A,3', '4901777300446', 'sku b\t2\t商品B', '#X-1 5', 'NG,-1', ',2'].join('\n'), 4);
  assert.deepEqual(p.rows.map((r) => [r.code, r.qty]), [['SKU-A', 3], ['4901777300446', 4], ['sku b', 2], ['#X-1', 5]]);
  assert.equal(p.rows[2].name, '商品B');
  assert.deepEqual(p.errors.map((e) => e.line), [6, 7]);
  assert.equal(Logic.parseCodeQtyText('JAN,商品名\n4901777300446,伊右衛門', 2).rows[0].qty, 2, '「JAN,商品名」の一覧は既定の数量になる');
  assert.equal(Logic.parseCodeQtyText('', 1).rows.length, 0);
});

test('出荷の在庫前後プレビュー: 足りない明細を数える', () => {
  const pv = Logic.shipPreview([{ stock: 5, qty: 2 }, { stock: 1, qty: 3 }, { stock: 4, qty: 4 }]);
  assert.deepEqual(pv.rows.map((r) => [r.after, r.short]), [[3, false], [-2, true], [0, false]]);
  assert.deepEqual([pv.short, pv.total], [1, 9]);
});

test('reasonOk: 出庫の理由は1〜100文字', () => {
  assert.equal(Logic.reasonOk('廃棄'), true);
  assert.equal(Logic.reasonOk('  '), false);
  assert.equal(Logic.reasonOk(''), false);
  assert.equal(Logic.reasonOk(null), false);
  assert.equal(Logic.reasonOk('あ'.repeat(101)), false);
});

// Code 39（ロケ・伝票番号のバーコード想定）
const C39 = { '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn', K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn',
  N: 'nnnnwnnww', O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn', U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn', Z: 'nwwnwnnnn',
  '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn' };
function renderCode39(text, o = {}) {
  const m = o.module || 3, wide = o.wide || 3 * m, quiet = 10 * m, h = o.height || 80;
  const widths = [];
  const full = '*' + text + '*';
  for (let ci = 0; ci < full.length; ci++) {
    const pat = C39[full[ci]];
    for (let k = 0; k < 9; k++) widths.push(pat[k] === 'w' ? wide : m);
    if (ci < full.length - 1) widths.push(m); // 文字間
  }
  const W = widths.reduce((a, b) => a + b, 0) + quiet * 2;
  const g = new Uint8ClampedArray(W * h).fill(235);
  let x = quiet;
  widths.forEach((w, i) => { if (i % 2 === 0) for (let y = 0; y < h; y++) for (let k = 0; k < w; k++) g[y * W + x + k] = 25; x += w; });
  return { g, W, H: h };
}

test('Code 39 の符号表の自己確認（各文字は9要素のうち太い要素が3つ）', () => {
  for (const [ch, pat] of Object.entries(C39)) assert.equal(pat.split('').filter((c) => c === 'w').length, 3, ch);
});

zxTest('ZXing: ロケ・伝票番号用の読み取り（Code 39）。商品用の読み取りでは読まない', () => {
  const code = Logic.createDecoder(ZX, 'code');
  const product = Logic.createDecoder(ZX);
  for (const text of ['A-01', 'B-12-3', 'S1001', 'LOC 7', 'SH-0001']) {
    for (const mod of [2, 3, 4]) {
      const img = renderCode39(text, { module: mod });
      assert.equal(code(img.g, img.W, img.H), text, `${text} module=${mod}`);
      assert.equal(product(img.g, img.W, img.H), null, '商品用の読み取りはCode 39を拾わない');
    }
  }
  const noisy = noise(renderCode39('A-01', { module: 3 }), 20);
  assert.equal(code(noisy.g, noisy.W, noisy.H), 'A-01');
});

zxTest('ZXing: コード読み取り（広い対応）でもEAN-13の商品バーコードは読める', () => {
  const code = Logic.createDecoder(ZX, 'code');
  const img = render(J1, { module: 3 });
  assert.equal(code(img.g, img.W, img.H), J1);
});
