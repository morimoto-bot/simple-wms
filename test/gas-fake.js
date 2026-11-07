'use strict';
// GAS（SpreadsheetApp など）の最小の模擬環境。Code.gs をそのまま読み込んで動かすために使う。
// Sheets の「文字列を数値や日付に自動変換する」挙動も真似て、列を文字列指定し忘れるバグを検出できるようにしてある。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeRange {
  constructor(sheet, row, col, nrows, ncols) {
    Object.assign(this, { sheet, row, col, nrows, ncols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nrows; r++) {
      const line = [];
      for (let c = 0; c < this.ncols; c++) line.push(this.sheet._get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.nrows || values.some((v) => v.length !== this.ncols)) {
      throw new Error(`setValues: 範囲(${this.nrows}x${this.ncols})と値の形が違う`);
    }
    for (let r = 0; r < this.nrows; r++) {
      for (let c = 0; c < this.ncols; c++) this.sheet._set(this.row + r, this.col + c, values[r][c]);
    }
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.nrows; r++) for (let c = 0; c < this.ncols; c++) this.sheet.cells.delete(`${this.row + r},${this.col + c}`);
    return this;
  }
  setNumberFormat(fmt) {
    for (let r = 0; r < this.nrows; r++) {
      for (let c = 0; c < this.ncols; c++) this.sheet.formats.set(`${this.row + r},${this.col + c}`, fmt);
    }
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map();
    this.formats = new Map();
    this.frozen = 0;
    this.writeCalls = 0;
  }
  _get(r, c) {
    const v = this.cells.get(`${r},${c}`);
    return v === undefined ? '' : v;
  }
  _set(r, c, v) {
    this.writeCalls++;
    const fmt = this.formats.get(`${r},${c}`);
    let val = v;
    if (fmt !== '@' && typeof v === 'string') {
      if (/^-?\d+(\.\d+)?$/.test(v)) val = Number(v); // "0123" → 123
      else if (/^\d{1,2}[-/]\d{1,2}$/.test(v)) val = { fakeDate: v }; // "1-2" → 日付
      else if (/^[=+@]/.test(v) || /^-[A-Za-z(]/.test(v)) val = { fakeFormula: v }; // "=1+1" → 数式として評価される
      else if (/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) val = { fakeDate: v };
    }
    if (val === '' || val === null || val === undefined) this.cells.delete(`${r},${c}`);
    else this.cells.set(`${r},${c}`, val);
  }
  getLastRow() {
    let max = 0;
    for (const k of this.cells.keys()) max = Math.max(max, Number(k.split(',')[0]));
    return max;
  }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  setFrozenRows(n) { this.frozen = n; }
  setName(n) { const ss = this.ss; if (!ss) throw new Error('no spreadsheet'); if (ss.sheets.has(n)) throw new Error('同名のシートがあります: ' + n); ss.sheets.delete(this.name); this.name = n; ss.sheets.set(n, this); return this; }
  dump() {
    const last = this.getLastRow();
    let maxc = 0;
    for (const k of this.cells.keys()) maxc = Math.max(maxc, Number(k.split(',')[1]));
    const out = [];
    for (let r = 1; r <= last; r++) {
      const line = [];
      for (let c = 1; c <= maxc; c++) line.push(this._get(r, c));
      out.push(line);
    }
    return out;
  }
  body() { return this.dump().slice(1); }
}

class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(n) { return this.sheets.get(n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); s.ss = this; this.sheets.set(n, s); return s; }
}

function createEnv(options = {}) {
  const ss = new FakeSpreadsheet();
  const props = options.props === undefined ? { APP_TOKEN: 'dev-token-0123456789abcdef' } : options.props;
  const state = { lockFails: false, locks: 0, unlocks: 0, logs: [] };
  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (state.lockFails) return false; state.locks++; return true; },
        releaseLock: () => { state.unlocks++; }
      })
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: (k) => { delete props[k]; } }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } })
    },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const p = new Intl.DateTimeFormat('ja-JP', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
        const h = p.hour === '24' ? '00' : p.hour;
        if (fmt !== 'yyyy/MM/dd HH:mm:ss') throw new Error('未対応の書式: ' + fmt);
        return `${p.year}/${p.month}/${p.day} ${h}:${p.minute}:${p.second}`;
      }
    },
    Logger: { log: (x) => state.logs.push(String(x)) }
  };
  const ctx = vm.createContext(sandbox);
  const code = fs.readFileSync(process.env.GAS_CODE || path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'Code.gs' });

  const call = (method, payload) => {
    let out;
    if (method === 'GET') {
      out = vm.runInContext('doGet', ctx)({ parameter: payload });
    } else {
      out = vm.runInContext('doPost', ctx)({ postData: { contents: typeof payload === 'string' ? payload : JSON.stringify(payload), type: 'text/plain' } });
    }
    return JSON.parse(out.getContent());
  };
  const token = 'dev-token-0123456789abcdef';
  return {
    ss, state, ctx, props,
    config: vm.runInContext('CONFIG', ctx),
    post: (action, body = {}) => call('POST', Object.assign({ action, token }, body)),
    get: (action, body = {}) => call('GET', Object.assign({ action, token }, body)),
    raw: call,
    sheet: (n) => ss.getSheetByName(n),
    run: (src) => vm.runInContext(src, ctx)
  };
}

// 有効なJAN（チェックデジット付き）を作る
function withCheck(body) {
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return body + ((10 - (sum % 10)) % 10);
}

module.exports = { createEnv, withCheck };
