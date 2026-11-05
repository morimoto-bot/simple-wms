// ブラウザでの動作確認用: getUserMedia を、canvasに描いたバーコードの映像に差し替える。
// 実機のカメラの代わりに「映像→切り出し→ZXing→画面」の経路を通せる（iPhoneの実機確認の代わりにはならない）。
(function () {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const R = L.map((s) => s.split('').map((c) => (c === '0' ? '1' : '0')).join(''));
  const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  function mods(code) {
    const d = code.split('').map(Number); let s = '101';
    for (let i = 1; i <= 6; i++) s += (PAR[d[0]][i - 1] === 'L' ? L : G)[d[i]];
    s += '01010';
    for (let i = 7; i <= 12; i++) s += R[d[i]];
    return s + '101';
  }
  const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
  const ctx = cv.getContext('2d');
  window.__fakeDraw = function (code, opt) {
    opt = opt || {};
    ctx.fillStyle = '#e8e8e8'; ctx.fillRect(0, 0, 1280, 720);
    if (!code) return;
    const bars = mods(code.length === 12 ? '0' + code : code), m = opt.m || 5, x0 = (1280 - bars.length * m) / 2;
    ctx.fillStyle = '#111';
    for (let i = 0; i < bars.length; i++) if (bars[i] === '1') ctx.fillRect(x0 + i * m, opt.y || 250, m, opt.h || 220);
  };

  // Code 39（ロケ・伝票番号のバーコード）を描く
  const C39 = { '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn', K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn',
    N: 'nnnnwnnww', O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn', U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn', Z: 'nwwnwnnnn',
    '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn' };
  window.__fakeDraw39 = function (text) {
    ctx.fillStyle = '#e8e8e8'; ctx.fillRect(0, 0, 1280, 720);
    if (!text) return;
    const m = 4, wide = 12, full = '*' + text + '*', widths = [];
    for (let ci = 0; ci < full.length; ci++) { const pat = C39[full[ci]]; for (let k = 0; k < 9; k++) widths.push(pat[k] === 'w' ? wide : m); if (ci < full.length - 1) widths.push(m); }
    const total = widths.reduce((a, b) => a + b, 0);
    let x = (1280 - total) / 2; ctx.fillStyle = '#111';
    widths.forEach((w, i) => { if (i % 2 === 0) ctx.fillRect(x, 250, w, 220); x += w; });
  };
  window.__fakeDraw(null);
  const stream = cv.captureStream(15);
  window.__gumCalls = 0;
  navigator.mediaDevices.getUserMedia = async function () { window.__gumCalls++; return stream; };
})();
