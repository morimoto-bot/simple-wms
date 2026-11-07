/**
 * 簡易WMS — GAS（倉庫）  v0.3.0
 *
 * 画面（index.html）からのJSONを受けて、スプレッドシート4枚（商品マスタ／入出荷履歴／検品履歴／棚卸履歴）を更新・参照する。
 * GASには画面を持たせない（HtmlServiceのiframeではカメラが使えないため）。
 *
 * 設定は次の2か所だけ。
 *   1. このファイル先頭の CONFIG（スプレッドシートIDなど）
 *   2. スクリプトプロパティ APP_TOKEN（合言葉。コードには書かない）
 *
 * デプロイ: ウェブアプリ / 次のユーザーとして実行=自分 / アクセスできるユーザー=全員
 */

var CONFIG = {
  // 使うスプレッドシートのID（各自の環境で入れる。公開リポジトリには入れない）。空にすると、このスクリプトが紐づいているスプレッドシートを使う
  SPREADSHEET_ID: '',
  SHEETS: {
    MASTER: '商品マスタ',
    IO: '入出荷履歴',
    INSPECTION: '検品履歴',
    STOCKTAKE: '棚卸履歴',
    PLAN: '入荷予定',
    PLAN_LINES: '入荷予定明細',
    SLIP: '出荷伝票',
    SLIP_LINES: '出荷伝票明細',
    SKU: '対応表'
  },
  // 以前の名前（シートの名前を変えた時に、古い名前のシートがあれば、中身を残したまま新しい名前にする）
  LEGACY_SHEETS: { SKU: ['商品対応表'] },
  // true にすると、在庫を超える出荷（マイナス在庫）を許す
  ALLOW_NEGATIVE_STOCK: false,
  // 合言葉（APP_TOKEN）の最低文字数。短いと拒否する（/exec のURLを知れば誰でも叩けるため、実質の防御は合言葉だけ）
  MIN_TOKEN_LENGTH: 16,
  // true: 送り状番号が無い伝票は検品済みにできない（既定は、送り状番号がある伝票だけ送り状検品を求める）
  REQUIRE_TRACKING: false,
  // true: JANのチェックデジットが合わないものは受け付けない
  STRICT_CHECK_DIGIT: true,
  MAX_QTY: 100000,
  MAX_IMPORT_ROWS: 5000,
  LOCK_WAIT_MS: 20000,
  TIMEZONE: 'Asia/Tokyo',
  VERSION: '0.5.1',
  APP_NAME: 'simple-wms'
};

// シートごとの見出し・文字列として保存する列（1始まり）
var SHEET_DEF = {
  MASTER:     { headers: ['JAN', '商品名', '価格', '現在庫', 'ロケーション'],                         textCols: [1, 2, 5] },
  IO:         { headers: ['日時', 'JAN', '商品名', '区分', '数量', '処理後の在庫数', 'メモ'],         textCols: [1, 2, 3, 4, 7] },
  INSPECTION: { headers: ['日時', '検品名', 'JAN', '商品名', '予定数', '実績数', '差異'],             textCols: [1, 2, 3, 4] },
  STOCKTAKE:  { headers: ['日時', '棚卸名', 'JAN', '商品名', '帳簿在庫', '実績数', '差異'],           textCols: [1, 2, 3, 4] },
  PLAN:       { headers: ['予定ID', '予定名', '仕入先名', '状態', '作成日時', '完了日時', 'メモ'],     textCols: [1, 2, 3, 4, 5, 6, 7] },
  PLAN_LINES: { headers: ['予定ID', 'JAN', '商品名', '予定数', '検品済数', '入荷済数', '状態', '備考'], textCols: [1, 2, 3, 7, 8] },
  SLIP:       { headers: ['伝票ID', '伝票番号', '出所', '状態', '作成日時', '検品日時', '出荷日時', 'メモ', '送り状番号', '配送業者', '作業グループ', '作業開始日時'], textCols: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  SLIP_LINES: { headers: ['伝票ID', 'JAN', '商品名', '数量', '検品済数', '元コード'],                 textCols: [1, 2, 3, 6] },
  SKU:        { headers: ['SKU', 'JAN', 'EC側の名称'],                                              textCols: [1, 2, 3] }
};

/* ============================== エントリーポイント ============================== */

function doGet(e) {
  return handle_('GET', (e && e.parameter) || {});
}

function doPost(e) {
  var body;
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    body = JSON.parse(raw);
  } catch (err) {
    return json_(fail_('bad_request', 'JSONを読み取れません'));
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json_(fail_('bad_request', 'JSONのオブジェクトを送ってください'));
  }
  return handle_('POST', body);
}

/** 手動で1回実行すると、4つのシートと見出しを作る（実行しなくても、最初のリクエストで自動作成される） */
function setupSheets() {
  ['MASTER', 'IO', 'INSPECTION', 'STOCKTAKE', 'PLAN', 'PLAN_LINES', 'SLIP', 'SLIP_LINES', 'SKU'].forEach(function (k) { sheet_(k); });
}

/* ============================== ルーティング ============================== */

var READ_ACTIONS = {
  masterGet: masterGet_, masterList: masterList_, stocktakePreview: stocktakePreview_,
  planList: planList_, planGet: planGet_, slipList: slipList_, slipGet: slipGet_, slipPicking: slipPicking_,
  skuList: skuList_, historyList: historyList_, exportData: exportData_
};
var WRITE_ACTIONS = {
  masterUpsert: masterUpsert_,
  masterImport: masterImport_,
  skuLink: skuLink_,
  skuDelete: skuDelete_,
  receive: receive_,
  issue: issue_,
  move: move_,
  receiveBatch: receiveBatch_,
  planCreate: planCreate_,
  planInspect: planInspect_,
  planReceive: planReceive_,
  planClose: planClose_,
  planCancel: planCancel_,
  slipCreate: slipCreate_,
  slipImport: slipImport_,
  slipInspect: slipInspect_,
  slipShip: slipShip_,
  slipVoid: slipVoid_,
  slipGroupStart: slipGroupStart_,
  slipGroupRelease: slipGroupRelease_,
  slipTracking: slipTracking_,
  slipTrackingImport: slipTrackingImport_,
  inspectionSave: inspectionSave_,
  stocktakeSave: stocktakeSave_
};
// GETで受け付ける読み取りだけ（プレビューはPOSTのみ）
var GET_OK = { masterGet: true, masterList: true, planList: true, planGet: true, slipList: true, slipGet: true, skuList: true, historyList: true, exportData: true };

function handle_(method, req) {
  try {
    var action = String(req.action || '');
    if (action === 'ping') {
      return json_({ ok: true, app: CONFIG.APP_NAME, version: CONFIG.VERSION, method: method });
    }
    checkToken_(req.token);
    setupSheets(); // 4枚のシートが無ければ作る（あれば何もしない）

    if (READ_ACTIONS[action]) {
      if (method === 'GET' && !GET_OK[action]) throw new AppError('bad_request', action + ' はPOSTで呼んでください');
      return json_(READ_ACTIONS[action](req));
    }
    if (WRITE_ACTIONS[action]) {
      if (method !== 'POST') throw new AppError('bad_request', action + ' はPOSTで呼んでください');
      return json_(withLock_(function () { return WRITE_ACTIONS[action](req); }));
    }
    throw new AppError('bad_request', '不明な action: ' + action);
  } catch (err) {
    if (err instanceof AppError) return json_(fail_(err.code, err.message, err.extra));
    try { Logger.log(err && err.stack ? err.stack : err); } catch (ignore) {}
    return json_(fail_('server_error', String((err && err.message) || err)));
  }
}

function AppError(code, message, extra) {
  this.code = code;
  this.message = message;
  this.extra = extra || null;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function fail_(code, message, extra) {
  var o = { ok: false, error: code, message: message };
  if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
  return o;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (!expected) {
    throw new AppError('server_not_configured', 'スクリプトプロパティ APP_TOKEN が未設定です');
  }
  if (expected.length < CONFIG.MIN_TOKEN_LENGTH) {
    throw new AppError('server_not_configured', 'APP_TOKEN が短すぎます（' + CONFIG.MIN_TOKEN_LENGTH + '文字以上の長いランダムな文字列にしてください）');
  }
  if (String(given || '') !== expected) {
    throw new AppError('unauthorized', '合言葉（token）が違います');
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) throw new AppError('busy', '他の処理中です。少し待ってやり直してください');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ============================== 値の正規化・検証 ============================== */

function nfkc_(s) {
  s = String(s == null ? '' : s);
  return typeof s.normalize === 'function' ? s.normalize('NFKC') : s;
}

function str_(v) { return v == null ? '' : String(v); }

/** メモ・理由などの自由入力: 改行や連続する空白を1つの空白にし、500文字までにする */
function cleanMemo_(v) {
  return nfkc_(v == null ? '' : v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 500);
}

/** 送り状番号: 全角→半角、空白とハイフンを除き、英字は大文字 */
function normTracking_(v) {
  return nfkc_(v == null ? '' : v).replace(/[\s\-]/g, '').toUpperCase();
}

/** 数字だけを取り出す（全角数字・ハイフン・空白・先頭のアポストロフィを許す） */
function janDigits_(v) {
  return nfkc_(v).replace(/\D/g, '');
}

/** 先頭の0を除いた比較用キー（EAN-13の先頭0がUPC-A 12桁として読まれる対策） */
function janKey_(digits) {
  var k = String(digits).replace(/^0+/, '');
  return k === '' ? '0' : k;
}

function checkDigitOk_(d) {
  var sum = 0;
  var n = d.length;
  for (var i = n - 2, w = 3; i >= 0; i--, w = (w === 3 ? 1 : 3)) sum += Number(d.charAt(i)) * w;
  return ((10 - (sum % 10)) % 10) === Number(d.charAt(n - 1));
}

/** 正しいJAN（8/12/13桁）なら数字列を返す。だめなら AppError(invalid_jan) */
function requireJan_(v) {
  var d = janDigits_(v);
  if (!d) throw new AppError('invalid_jan', 'JANが空です');
  if (d.length !== 8 && d.length !== 12 && d.length !== 13) {
    throw new AppError('invalid_jan', 'JANは8・12・13桁の数字です: ' + d, { jan: d });
  }
  if (CONFIG.STRICT_CHECK_DIGIT && !checkDigitOk_(d)) {
    throw new AppError('invalid_jan', 'JANのチェックデジットが合いません: ' + d, { jan: d });
  }
  return d;
}

function normLocation_(v) {
  var s = nfkc_(v).replace(/[‐-―−－]/g, '-').toUpperCase();
  return s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}

function normName_(v) {
  return nfkc_(v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}

/** 価格: 空→''、数値→数、それ以外は AppError */
function parsePrice_(v) {
  if (v === undefined || v === null) return '';
  var s = nfkc_(v).replace(/[¥円,\s]/g, '');
  if (s === '') return '';
  var n = Number(s);
  if (!isFinite(n) || n < 0) throw new AppError('bad_request', '価格が数値ではありません: ' + v);
  return n;
}

function parseQty_(v, label) {
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > CONFIG.MAX_QTY) {
    throw new AppError('bad_request', (label || '数量') + 'は1〜' + CONFIG.MAX_QTY + 'の整数にしてください: ' + v);
  }
  return n;
}

function parseCount_(v, label) {
  var n = Number(v);
  if (v === '' || v === null || v === undefined || !isFinite(n) || Math.floor(n) !== n || n < 0 || n > CONFIG.MAX_QTY) {
    throw new AppError('bad_request', (label || '数') + 'は0〜' + CONFIG.MAX_QTY + 'の整数にしてください: ' + v);
  }
  return n;
}

function toInt_(v) {
  var n = Number(v);
  return isFinite(n) ? Math.round(n) : 0;
}

function toPrice_(v) {
  if (v === '' || v === null || v === undefined) return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}

function now_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm:ss');
}

/* ============================== シート入出力 ============================== */

function ss_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var a = SpreadsheetApp.getActiveSpreadsheet();
  if (!a) throw new AppError('server_not_configured', 'CONFIG.SPREADSHEET_ID を設定してください');
  return a;
}

function sheet_(key) {
  var def = SHEET_DEF[key];
  var ss = ss_();
  var name = CONFIG.SHEETS[key];
  var sh = ss.getSheetByName(name);
  if (!sh) {
    var olds = (CONFIG.LEGACY_SHEETS && CONFIG.LEGACY_SHEETS[key]) || [];
    for (var i = 0; i < olds.length && !sh; i++) {
      var old = ss.getSheetByName(olds[i]);
      if (old) { old.setName(name); sh = old; }
    }
  }
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sh.setFrozenRows(1);
  } else {
    // 後から増えた列の見出しだけを補う（空の見出しセルのみ。入力済みの見出しは書き換えない）
    var cur = sh.getRange(1, 1, 1, def.headers.length).getValues()[0];
    for (var i = 0; i < def.headers.length; i++) {
      if (str_(cur[i]) === '') sh.getRange(1, i + 1, 1, 1).setValues([[def.headers[i]]]);
    }
  }
  return sh;
}

/** 2次元配列を書く。文字列で持つ列は先にテキスト形式にして、数字の先頭0や日付への自動変換を防ぐ */
function writeRows_(sh, row, col, values, textMask) {
  var n = values.length;
  if (!n) return;
  var w = values[0].length;
  for (var j = 0; j < w; j++) {
    if (textMask[j]) sh.getRange(row, col + j, n, 1).setNumberFormat('@');
  }
  sh.getRange(row, col, n, w).setValues(values);
}

function textMask_(key, startCol, width) {
  var def = SHEET_DEF[key];
  var m = [];
  for (var j = 0; j < width; j++) m.push(def.textCols.indexOf(startCol + j) >= 0);
  return m;
}

function appendRows_(key, values) {
  if (!values.length) return;
  var sh = sheet_(key);
  var start = sh.getLastRow() + 1;
  writeRows_(sh, start, 1, values, textMask_(key, 1, values[0].length));
}

/* ----- 商品マスタ ----- */

function loadMaster_() {
  var sh = sheet_('MASTER');
  var last = sh.getLastRow();
  var rows = [];
  var byKey = {};
  var bySku = {};
  if (last >= 2) {
    var v = sh.getRange(2, 1, last - 1, 5).getValues();
    for (var i = 0; i < v.length; i++) {
      var jan = janDigits_(v[i][0]);
      if (!jan) continue;
      var key = janKey_(jan);
      if (byKey[key]) continue; // シート上の重複は最初の行だけ使う
      var r = {
        row: i + 2, jan: jan, key: key,
        name: str_(v[i][1]), price: toPrice_(v[i][2]),
        stock: toInt_(v[i][3]), location: str_(v[i][4]),
        skus: [], sku: '',
        dirty: false, isNew: false
      };
      rows.push(r);
      byKey[key] = r;
    }
  }
  var m = { sh: sh, rows: rows, byKey: byKey, bySku: bySku, skuNote: {}, skuOrphans: [], skuDirty: false, nextRow: Math.max(last, 1) + 1 };
  loadSkuTable_(m);
  return m;
}

function addMasterRow_(m, data) {
  var r = {
    row: m.nextRow++, jan: data.jan, key: janKey_(data.jan),
    name: data.name, price: data.price === undefined ? '' : data.price,
    stock: data.stock || 0, location: data.location || '',
    skus: [], sku: '',
    dirty: true, isNew: true
  };
  m.rows.push(r);
  m.byKey[r.key] = r;
  return r;
}

function masterValues_(r) {
  return [r.jan, r.name, r.price, r.stock, r.location];
}

/** 変更のあった行だけを書き戻す（連続した行はまとめて書く） */
function commitMaster_(m) {
  var sh = m.sh;
  var mask = textMask_('MASTER', 1, 5);
  var news = m.rows.filter(function (r) { return r.isNew; }).sort(function (a, b) { return a.row - b.row; });
  if (news.length) {
    writeRows_(sh, news[0].row, 1, news.map(masterValues_), mask);
  }
  var dirty = m.rows.filter(function (r) { return r.dirty && !r.isNew; }).sort(function (a, b) { return a.row - b.row; });
  var i = 0;
  while (i < dirty.length) {
    var j = i;
    while (j + 1 < dirty.length && dirty[j + 1].row === dirty[j].row + 1) j++;
    var run = dirty.slice(i, j + 1).map(function (r) { return [r.name, r.price, r.stock, r.location]; });
    writeRows_(sh, dirty[i].row, 2, run, mask.slice(1));
    i = j + 1;
  }
  m.rows.forEach(function (r) { r.dirty = false; r.isNew = false; });
  if (m.skuDirty) { writeSkuSheet_(m); m.skuDirty = false; }
}

/* ----- 対応表（SKU↔JAN） ----- */

function loadSkuTable_(m) {
  var sh = sheet_('SKU');
  var last = sh.getLastRow();
  if (last >= 2) {
    var v = sh.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < v.length; i++) {
      var sku = parseSkus_(v[i][0])[0];
      if (!sku) continue;
      var jan = janDigits_(v[i][1]);
      var k = skuKey_(sku);
      var r = jan ? m.byKey[janKey_(jan)] : null;
      if (!r) { m.skuOrphans.push({ sku: sku, jan: jan, note: str_(v[i][2]) }); continue; }
      if (m.bySku[k]) continue;
      r.skus.push(sku);
      m.bySku[k] = r;
      m.skuNote[k] = str_(v[i][2]);
    }
  }
  m.rows.forEach(function (r) { r.sku = r.skus.join(' | '); });
}

function writeSkuSheet_(m) {
  var sh = sheet_('SKU');
  var last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, 3).clearContent();
  var rows = [];
  m.rows.forEach(function (r) { r.skus.forEach(function (x) { rows.push([x, r.jan, m.skuNote[skuKey_(x)] || '']); }); });
  m.skuOrphans.forEach(function (o) { rows.push([o.sku, o.jan, o.note]); });
  writeRows_(sh, 2, 1, rows, textMask_('SKU', 1, 3));
}

function pub_(r) {
  return { jan: r.jan, name: r.name, price: r.price === '' ? null : r.price, stock: r.stock, location: r.location, sku: r.sku };
}

function ioRow_(ts, r, kubun, qty, memo) {
  return [ts, r.jan, r.name, kubun, qty, r.stock, memo || ''];
}

/* ============================== アクション: 参照 ============================== */

function masterGet_(req) {
  var jan = requireJan_(req.jan);
  var m = loadMaster_();
  var r = m.byKey[janKey_(jan)];
  return { ok: true, found: !!r, jan: jan, item: r ? pub_(r) : null };
}

function masterList_(req) {
  var m = loadMaster_();
  var q = nfkc_(req.q || '').toLowerCase().replace(/^\s+|\s+$/g, '');
  var loc = req.location === undefined || req.location === null || req.location === '' ? null : normLocation_(req.location);
  var locSet = {};
  var items = [];
  var total = 0;
  m.rows.forEach(function (r) {
    if (r.location) locSet[r.location] = true;
    if (loc !== null && normLocation_(r.location) !== loc) return;
    if (q) {
      var hay = (nfkc_(r.name) + ' ' + r.jan + ' ' + nfkc_(r.location) + ' ' + nfkc_(r.sku)).toLowerCase();
      if (hay.indexOf(q) < 0) return;
    }
    items.push(pub_(r));
    total += r.stock;
  });
  return { ok: true, items: items, count: items.length, totalStock: total, locations: Object.keys(locSet).sort() };
}

/* ============================== アクション: マスタ ============================== */

function masterUpsert_(req) {
  var jan = requireJan_(req.jan);
  var m = loadMaster_();
  var r = m.byKey[janKey_(jan)];
  var ts = now_();
  var created = false;
  var ioRows = [];

  var name = req.name === undefined ? undefined : normName_(req.name);
  var price = req.price === undefined ? undefined : parsePrice_(req.price);
  var location = req.location === undefined ? undefined : normLocation_(req.location);
  var skus = req.sku === undefined ? undefined : parseSkus_(req.sku);
  if (skus !== undefined) checkSkusFree_(m, skus, r || null);

  if (!r) {
    if (!name) throw new AppError('bad_request', '新しい商品には商品名が必要です');
    var stock = 0;
    if (req.stock !== undefined && req.stock !== null && req.stock !== '') stock = parseCount_(req.stock, '現在庫');
    r = addMasterRow_(m, { jan: jan, name: name, price: price === undefined ? '' : price, location: location || '', stock: stock });
    created = true;
    if (skus !== undefined) setSkus_(m, r, skus);
    if (stock > 0) ioRows.push(ioRow_(ts, r, '入荷', stock, '初期登録'));
  } else {
    if (name) { r.name = name; r.dirty = true; }
    if (price !== undefined) { r.price = price; r.dirty = true; }
    if (location !== undefined) { r.location = location; r.dirty = true; }
    if (skus !== undefined) setSkus_(m, r, skus);
  }
  commitMaster_(m);
  appendRows_('IO', ioRows);
  return { ok: true, created: created, item: pub_(r) };
}

function masterImport_(req) {
  var src;
  if (Array.isArray(req.items)) {
    src = req.items.map(function (it, i) {
      return { line: i + 1, jan: it.jan, name: it.name, price: it.price, stock: it.stock, location: it.location, sku: it.sku };
    });
  } else if (typeof req.text === 'string') {
    src = parseImportText_(req.text);
  } else {
    throw new AppError('bad_request', 'items または text を送ってください');
  }
  if (src.length > CONFIG.MAX_IMPORT_ROWS) {
    throw new AppError('bad_request', '一度に取り込めるのは' + CONFIG.MAX_IMPORT_ROWS + '行までです');
  }

  var m = loadMaster_();
  var ts = now_();
  var errors = [];
  var seen = {};
  var added = 0, updated = 0, unchanged = 0;
  var ioRows = [];

  src.forEach(function (it) {
    var jan;
    try {
      jan = requireJan_(it.jan);
    } catch (e) {
      errors.push({ line: it.line, jan: str_(it.jan), reason: e instanceof AppError ? e.message : String(e) });
      return;
    }
    var key = janKey_(jan);
    if (seen[key]) {
      errors.push({ line: it.line, jan: jan, reason: '重複（ファイル内の先の行を採用）' });
      return;
    }
    var name = it.name === undefined || it.name === null ? '' : normName_(it.name);
    var price, stock, location;
    try {
      price = (it.price === undefined || it.price === null || it.price === '') ? undefined : parsePrice_(it.price);
      stock = (it.stock === undefined || it.stock === null || it.stock === '') ? undefined : parseCount_(it.stock, '現在庫');
    } catch (e2) {
      errors.push({ line: it.line, jan: jan, reason: e2 instanceof AppError ? e2.message : String(e2) });
      return;
    }
    location = (it.location === undefined || it.location === null) ? '' : normLocation_(it.location);
    var r = m.byKey[key];
    var skus;
    try {
      skus = (it.sku === undefined || it.sku === null || String(it.sku).replace(/\s/g, '') === '') ? undefined : parseSkus_(it.sku);
      if (skus !== undefined) checkSkusFree_(m, skus, r || null);
    } catch (e3) {
      errors.push({ line: it.line, jan: jan, reason: e3 instanceof AppError ? e3.message : String(e3) });
      return;
    }
    if (!r) {
      if (!name) {
        errors.push({ line: it.line, jan: jan, reason: '商品名がありません' });
        return;
      }
      seen[key] = true;
      r = addMasterRow_(m, { jan: jan, name: name, price: price === undefined ? '' : price, location: location, stock: stock || 0 });
      added++;
      if (skus !== undefined) setSkus_(m, r, skus);
      if (stock > 0) ioRows.push(ioRow_(ts, r, '入荷', stock, '初期登録'));
    } else {
      seen[key] = true;
      var changed = false;
      if (name && name !== r.name) { r.name = name; changed = true; }
      if (price !== undefined && price !== r.price) { r.price = price; changed = true; }
      if (location && location !== r.location) { r.location = location; changed = true; }
      if (skus !== undefined && skus.join(' | ') !== r.sku) { setSkus_(m, r, skus); changed = true; }
      // 既存商品の現在庫は取り込みでは変えない
      if (changed) { r.dirty = true; updated++; } else { unchanged++; }
    }
  });

  commitMaster_(m);
  appendRows_('IO', ioRows);
  return { ok: true, total: src.length, added: added, updated: updated, unchanged: unchanged, skipped: errors.length, errors: errors };
}

/** 取り込みテキスト: 1行1商品。JAN,商品名[,価格[,現在庫[,ロケーション]]]（カンマ／タブ／ダブルクォート対応） */
function parseImportText_(text) {
  var s = String(text || '').replace(/^﻿/, '');
  var lines = splitLines_(s);
  var out = [];
  var first = true;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*$/.test(line.text)) continue;
    if (/^\s*#/.test(line.text)) continue;
    var cells = splitCells_(line.text);
    if (first) {
      first = false;
      var head = nfkc_(cells[0]).replace(/\s/g, '');
      if (!/^'?\d+$/.test(head)) continue; // 見出し行
    }
    out.push({
      line: line.no,
      jan: cells[0],
      name: cells.length > 1 ? cells[1] : '',
      price: cells.length > 2 ? cells[2] : '',
      stock: cells.length > 3 ? cells[3] : '',
      location: cells.length > 4 ? cells[4] : '',
      sku: cells.length > 5 ? cells[5] : ''
    });
  }
  return out;
}

/** 改行で分割（ダブルクォート内の改行は同じ行として扱う） */
function splitLines_(s) {
  var lines = [];
  var cur = '';
  var inQ = false;
  var no = 1, startNo = 1;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '"') inQ = !inQ;
    if (!inQ && (c === '\n' || c === '\r')) {
      if (c === '\r' && s.charAt(i + 1) === '\n') i++;
      lines.push({ text: cur, no: startNo });
      cur = '';
      no++;
      startNo = no;
    } else {
      if (c === '\n') no++;
      cur += c;
    }
  }
  if (cur !== '') lines.push({ text: cur, no: startNo });
  return lines;
}

function splitCells_(line) {
  var delim = line.indexOf('\t') >= 0 ? '\t' : ',';
  var cells = [];
  var cur = '';
  var inQ = false;
  for (var i = 0; i < line.length; i++) {
    var c = line.charAt(i);
    if (inQ) {
      if (c === '"') {
        if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else { inQ = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === delim) {
      cells.push(cur.replace(/^\s+|\s+$/g, ''));
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur.replace(/^\s+|\s+$/g, ''));
  return cells;
}

/* ============================== アクション: 入荷・出荷 ============================== */

function receive_(req) {
  var jan = requireJan_(req.jan);
  var qty = parseQty_(req.qty);
  var m = loadMaster_();
  var r = m.byKey[janKey_(jan)];
  if (!r) throw new AppError('not_in_master', '商品マスタにないJANです: ' + jan, { jan: jan });
  var memoParts = [];
  if (req.memo) memoParts.push(cleanMemo_(req.memo));
  if (req.location !== undefined && req.location !== null) {
    var loc = normLocation_(req.location);
    if (loc && loc !== r.location) {
      memoParts.push('ロケ変更: ' + (r.location || '(未設定)') + '→' + loc);
      r.location = loc;
    }
  }
  r.stock += qty;
  r.dirty = true;
  var ts = now_();
  var memo = memoParts.join(' / ');
  commitMaster_(m);
  appendRows_('IO', [ioRow_(ts, r, '入荷', qty, memo)]);
  return { ok: true, item: pub_(r), history: { ts: ts, kubun: '入荷', qty: qty, after: r.stock, memo: memo } };
}

/** 検品の取り込みなど、複数商品の入荷を一括で行う。keyが履歴メモに既にあれば二重取り込みとして拒否 */
function receiveBatch_(req) {
  var key = String(req.key || '').replace(/^\s+|\s+$/g, '');
  if (!key) throw new AppError('bad_request', 'key（取り込みの識別名）が必要です');
  if (!Array.isArray(req.items) || !req.items.length) throw new AppError('bad_request', 'items が空です');

  var merged = {};
  var order = [];
  req.items.forEach(function (it) {
    var jan = requireJan_(it.jan);
    var qty = parseQty_(it.qty);
    var k = janKey_(jan);
    if (!merged[k]) { merged[k] = { jan: jan, qty: 0 }; order.push(k); }
    merged[k].qty += qty;
  });

  var m = loadMaster_();
  var missing = [];
  order.forEach(function (k) { if (!m.byKey[k]) missing.push(merged[k].jan); });
  if (missing.length) {
    throw new AppError('not_in_master', '商品マスタにないJANがあります: ' + missing.join(', '), { missing: missing });
  }

  var io = sheet_('IO');
  var last = io.getLastRow();
  if (last >= 2) {
    var memos = io.getRange(2, 7, last - 1, 1).getValues();
    for (var i = 0; i < memos.length; i++) {
      var mm = str_(memos[i][0]);
      if (mm === key || mm.indexOf(key + ' | ') === 0) {
        throw new AppError('already_imported', 'この取り込みは済んでいます: ' + key, { key: key });
      }
    }
  }

  var ts = now_();
  var memo = key + (req.memo ? ' | ' + cleanMemo_(req.memo) : '');
  var ioRows = [];
  var total = 0;
  order.forEach(function (k) {
    var r = m.byKey[k];
    r.stock += merged[k].qty;
    r.dirty = true;
    total += merged[k].qty;
    ioRows.push(ioRow_(ts, r, '入荷', merged[k].qty, memo));
  });
  commitMaster_(m);
  appendRows_('IO', ioRows);
  return {
    ok: true, key: key, lines: order.length, totalQty: total,
    items: order.map(function (k) { return pub_(m.byKey[k]); })
  };
}

/* ============================== アクション: 検品 ============================== */

function inspectionSave_(req) {
  var name = normName_(req.name);
  if (!name) throw new AppError('bad_request', '検品名が必要です');
  if (!Array.isArray(req.items) || !req.items.length) throw new AppError('bad_request', 'items が空です');

  var m = loadMaster_();
  var rows = [];
  var seen = {};
  var matched = 0, short = 0, over = 0, unplanned = 0;
  req.items.forEach(function (it) {
    var jan = requireJan_(it.jan);
    var k = janKey_(jan);
    if (seen[k]) throw new AppError('bad_request', 'JANが重複しています: ' + jan);
    seen[k] = true;
    var planned = parseCount_(it.planned === undefined ? 0 : it.planned, '予定数');
    var actual = parseCount_(it.actual === undefined ? 0 : it.actual, '実績数');
    if (planned === 0 && actual === 0) return;
    var r = m.byKey[k];
    var pname = r ? r.name : normName_(it.name || '');
    var diff = actual - planned;
    if (planned === 0) unplanned++;
    else if (diff === 0) matched++;
    else if (diff < 0) short++;
    else over++;
    rows.push({ jan: jan, name: pname, planned: planned, actual: actual, diff: diff });
  });
  if (!rows.length) throw new AppError('bad_request', '保存する行がありません');

  var ts = now_();
  appendRows_('INSPECTION', rows.map(function (x) { return [ts, name, x.jan, x.name, x.planned, x.actual, x.diff]; }));
  return {
    ok: true, saved: rows.length, matched: matched, short: short, over: over, unplanned: unplanned,
    allOk: short === 0 && over === 0 && unplanned === 0
  };
}

/* ============================== アクション: 棚卸 ============================== */

/**
 * 棚卸の差異を計算する（書き込みはしない）。
 * counts: [{jan, actual}]  uncounted: 'keep'|'zero'  scope: {locations:[…]}（空なら全体）
 */
function stocktakeCompute_(req) {
  if (!Array.isArray(req.counts) || !req.counts.length) throw new AppError('bad_request', '数えた商品がありません');
  var uncounted = req.uncounted === undefined || req.uncounted === null || req.uncounted === '' ? 'keep' : String(req.uncounted);
  if (uncounted !== 'keep' && uncounted !== 'zero') throw new AppError('bad_request', 'uncounted は keep か zero です');
  var scopeLocs = [];
  if (req.scope && Array.isArray(req.scope.locations)) {
    req.scope.locations.forEach(function (l) { var n = normLocation_(l); if (n) scopeLocs.push(n); });
  }
  var inScope = function (loc) { return scopeLocs.length === 0 || scopeLocs.indexOf(normLocation_(loc)) >= 0; };

  var m = loadMaster_();
  var counted = {};
  var missing = [];
  var rows = [];
  req.counts.forEach(function (c) {
    var jan = requireJan_(c.jan);
    var k = janKey_(jan);
    if (counted[k]) throw new AppError('bad_request', 'JANが重複しています: ' + jan);
    var actual = parseCount_(c.actual, '実績数');
    var r = m.byKey[k];
    if (!r) { missing.push(jan); return; }
    counted[k] = true;
    rows.push({
      jan: r.jan, name: r.name, location: r.location, book: r.stock, actual: actual, diff: actual - r.stock,
      counted: true, zeroed: false, outOfScope: scopeLocs.length > 0 && !inScope(r.location)
    });
  });
  if (missing.length) throw new AppError('not_in_master', '商品マスタにないJANがあります: ' + missing.join(', '), { missing: missing });

  var keptUncounted = 0;
  var zeroed = 0;
  m.rows.forEach(function (r) {
    if (counted[r.key] || !inScope(r.location)) return;
    if (uncounted === 'zero') {
      if (r.stock > 0) {
        rows.push({ jan: r.jan, name: r.name, location: r.location, book: r.stock, actual: 0, diff: -r.stock, counted: false, zeroed: true, outOfScope: false });
        zeroed++;
      }
    } else {
      keptUncounted++;
    }
  });
  var adjust = rows.filter(function (x) { return x.diff !== 0; }).length;
  return { m: m, rows: rows, adjust: adjust, zeroed: zeroed, keptUncounted: keptUncounted, uncounted: uncounted };
}

function stocktakePreview_(req) {
  var c = stocktakeCompute_(req);
  return { ok: true, rows: c.rows, adjust: c.adjust, zeroed: c.zeroed, keptUncounted: c.keptUncounted, uncounted: c.uncounted };
}

function stocktakeSave_(req) {
  var name = normName_(req.name);
  if (!name) throw new AppError('bad_request', '棚卸名が必要です');
  var c = stocktakeCompute_(req);
  var m = c.m;
  var ts = now_();
  var ioRows = [];
  var stRows = [];
  var changed = [];
  c.rows.forEach(function (x) {
    var r = m.byKey[janKey_(x.jan)];
    stRows.push([ts, name, x.jan, x.name, x.book, x.actual, x.diff]);
    if (x.diff !== 0) {
      r.stock = x.actual;
      r.dirty = true;
      ioRows.push(ioRow_(ts, r, '棚卸調整', x.diff, '棚卸:' + name + (x.zeroed ? ' (未カウントを0とみなし)' : '')));
      changed.push(pub_(r));
    }
  });
  commitMaster_(m);
  appendRows_('IO', ioRows);
  appendRows_('STOCKTAKE', stRows);
  return { ok: true, rows: c.rows, adjust: c.adjust, zeroed: c.zeroed, keptUncounted: c.keptUncounted, uncounted: c.uncounted, items: changed };
}

/* ============================================================================
 * v0.4: SKU・出庫・棚移動・入荷予定・出荷伝票
 * ============================================================================ */

/* ---------- SKU ---------- */

/** SKUの比較用キー（全角→半角・空白整理・英字は大文字） */
function skuKey_(v) {
  return nfkc_(v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').toUpperCase();
}

/** `A | B` や改行区切りのSKUを配列にする（重複は除く） */
function parseSkus_(v) {
  var out = [], seen = {};
  nfkc_(v == null ? '' : v).split(/[|\n]/).forEach(function (x) {
    var s = x.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!s) return;
    var k = skuKey_(s);
    if (seen[k]) return;
    seen[k] = true;
    out.push(s);
  });
  return out;
}

/** SKUが他の商品で使われていないか確認（self は自分自身の行。null なら新規） */
function checkSkusFree_(m, skus, self) {
  skus.forEach(function (s) {
    var other = m.bySku[skuKey_(s)];
    if (other && other !== self) {
      throw new AppError('sku_conflict', 'SKU「' + s + '」は別の商品（' + other.name + ' / ' + other.jan + '）に登録済みです', { sku: s, jan: other.jan });
    }
  });
}

function setSkus_(m, r, skus) {
  checkSkusFree_(m, skus, r);
  r.skus.forEach(function (x) { if (m.bySku[skuKey_(x)] === r) delete m.bySku[skuKey_(x)]; });
  r.skus = skus.slice();
  r.sku = skus.join(' | ');
  skus.forEach(function (x) { m.bySku[skuKey_(x)] = r; });
  r.dirty = true;
  m.skuDirty = true;
}

/** コード（SKUまたはJAN）から商品を探す。①SKU一致 ②JANとして解釈してマスタにあれば */
function resolveCode_(m, code) {
  var raw = str_(code);
  var k = skuKey_(raw);
  if (!k) return { row: null, reason: 'コードが空です' };
  if (m.bySku[k]) return { row: m.bySku[k], via: 'sku' };
  var d = janDigits_(raw);
  if (d && (d.length === 8 || d.length === 12 || d.length === 13)) {
    if (!CONFIG.STRICT_CHECK_DIGIT || checkDigitOk_(d)) {
      var r = m.byKey[janKey_(d)];
      if (r) return { row: r, via: 'jan' };
      return { row: null, reason: 'マスタにないJANです' };
    }
    return { row: null, reason: 'SKUに一致せず、JANとしてもチェックデジットが合いません' };
  }
  return { row: null, reason: 'SKUにもJANにも一致しません' };
}

function skuLink_(req) {
  var jan = requireJan_(req.jan);
  var skus = parseSkus_(req.sku);
  if (!skus.length) throw new AppError('bad_request', 'SKUが空です');
  var m = loadMaster_();
  var r = m.byKey[janKey_(jan)];
  if (!r) throw new AppError('not_in_master', '商品マスタにないJANです: ' + jan, { jan: jan });
  checkSkusFree_(m, skus, r);
  var merged = r.skus.slice();
  skus.forEach(function (s) { if (!merged.some(function (x) { return skuKey_(x) === skuKey_(s); })) merged.push(s); });
  setSkus_(m, r, merged);
  if (req.name) skus.forEach(function (x) { m.skuNote[skuKey_(x)] = String(req.name); });
  commitMaster_(m);
  return { ok: true, item: pub_(r) };
}

/* ---------- 出庫・棚移動 ---------- */

/** 出庫: 伝票に紐づかない払い出し。理由は必須 */
function issue_(req) {
  var jan = requireJan_(req.jan);
  var qty = parseQty_(req.qty);
  var reason = normName_(req.reason);
  if (!reason) throw new AppError('bad_request', '出庫の理由は必須です（廃棄・破損・社内消費など）');
  if (reason.length > 100) throw new AppError('bad_request', '理由は100文字までです');
  var m = loadMaster_();
  var r = m.byKey[janKey_(jan)];
  if (!r) throw new AppError('not_in_master', '商品マスタにないJANです: ' + jan, { jan: jan });
  if (r.stock - qty < 0 && !CONFIG.ALLOW_NEGATIVE_STOCK) {
    throw new AppError('insufficient_stock', '在庫が足りません（現在庫 ' + r.stock + '、出庫 ' + qty + '）', { jan: jan, stock: r.stock, qty: qty });
  }
  r.stock -= qty;
  r.dirty = true;
  var ts = now_();
  var memo = '理由:' + reason + (req.memo ? ' / ' + cleanMemo_(req.memo) : '');
  commitMaster_(m);
  appendRows_('IO', [ioRow_(ts, r, '出庫', qty, memo)]);
  return { ok: true, item: pub_(r), history: { ts: ts, kubun: '出庫', qty: qty, after: r.stock, memo: memo } };
}

/** 棚移動: 在庫数は変えず、ロケーションだけを変えて履歴に残す（数量＝移動した在庫数） */
function move_(req) {
  var jan = requireJan_(req.jan);
  var to = normLocation_(req.to);
  if (!to) throw new AppError('bad_request', '移動先のロケーションを入れてください');
  var m = loadMaster_();
  var r = m.byKey[janKey_(jan)];
  if (!r) throw new AppError('not_in_master', '商品マスタにないJANです: ' + jan, { jan: jan });
  var from = r.location;
  if (from === to) throw new AppError('same_location', '移動先が今のロケーションと同じです: ' + to, { jan: jan });
  r.location = to;
  r.dirty = true;
  var ts = now_();
  var memo = 'ロケ移動: ' + (from || '(未設定)') + '→' + to + (req.memo ? ' / ' + cleanMemo_(req.memo) : '');
  commitMaster_(m);
  appendRows_('IO', [ioRow_(ts, r, '移動', r.stock, memo)]);
  return { ok: true, item: pub_(r), history: { ts: ts, kubun: '移動', qty: r.stock, after: r.stock, memo: memo } };
}

/* ---------- 汎用の行テーブル（入荷予定・出荷伝票） ---------- */

function loadTable_(key, width, mapRow) {
  var sh = sheet_(key);
  var last = sh.getLastRow();
  var rows = [];
  if (last >= 2) {
    var v = sh.getRange(2, 1, last - 1, width).getValues();
    for (var i = 0; i < v.length; i++) {
      var r = mapRow(v[i]);
      if (!r) continue;
      r.row = i + 2; r.dirty = false; r.isNew = false;
      rows.push(r);
    }
  }
  return { sh: sh, key: key, width: width, rows: rows, nextRow: Math.max(last, 1) + 1 };
}

function addTableRow_(t, r) {
  r.row = t.nextRow++; r.isNew = true; r.dirty = true;
  t.rows.push(r);
  return r;
}

/** newVals: 新しい行→全列の配列。dirtyCol: 更新する範囲の先頭列（1始まり）。dirtyVals: 更新範囲の配列 */
function commitTable_(t, newVals, dirtyCol, dirtyVals) {
  var mask = textMask_(t.key, 1, t.width);
  var news = t.rows.filter(function (r) { return r.isNew; }).sort(function (a, b) { return a.row - b.row; });
  if (news.length) writeRows_(t.sh, news[0].row, 1, news.map(newVals), mask);
  var dirty = t.rows.filter(function (r) { return r.dirty && !r.isNew; }).sort(function (a, b) { return a.row - b.row; });
  var i = 0;
  while (i < dirty.length) {
    var j = i;
    while (j + 1 < dirty.length && dirty[j + 1].row === dirty[j].row + 1) j++;
    writeRows_(t.sh, dirty[i].row, dirtyCol, dirty.slice(i, j + 1).map(dirtyVals), mask.slice(dirtyCol - 1));
    i = j + 1;
  }
  t.rows.forEach(function (r) { r.dirty = false; r.isNew = false; });
}

/* ---------- ID採番 ---------- */

function nextId_(t, prefix, field) {
  var max = 0;
  t.rows.forEach(function (r) {
    var m = /(\d+)$/.exec(str_(r[field]));
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + ('0000' + (max + 1)).slice(-4);
}

/* ---------- 入荷予定（ヘッダ＋明細） ---------- */

function loadPlans_() {
  var H = loadTable_('PLAN', 7, function (v) {
    var id = str_(v[0]);
    if (!id) return null;
    return { id: id, name: str_(v[1]), supplier: str_(v[2]), status: str_(v[3]), created: str_(v[4]), finished: str_(v[5]), memo: str_(v[6]) };
  });
  var L = loadTable_('PLAN_LINES', 8, function (v) {
    var id = str_(v[0]);
    if (!id) return null;
    return { pid: id, jan: janDigits_(v[1]), pname: str_(v[2]), planned: toInt_(v[3]), inspected: toInt_(v[4]), received: toInt_(v[5]), state: str_(v[6]), note: str_(v[7]) };
  });
  var p = { H: H, L: L, byName: {}, byId: {}, linesOf: {} };
  H.rows.forEach(function (h) { p.byId[h.id] = h; if (!p.byName[h.name]) p.byName[h.name] = h; });
  L.rows.forEach(function (l) { (p.linesOf[l.pid] = p.linesOf[l.pid] || []).push(l); });
  return p;
}
function commitPlans_(p) {
  commitTable_(p.H,
    function (r) { return [r.id, r.name, r.supplier, r.status, r.created, r.finished, r.memo]; },
    4, function (r) { return [r.status, r.created, r.finished, r.memo]; });
  commitTable_(p.L,
    function (r) { return [r.pid, r.jan, r.pname, r.planned, r.inspected, r.received, r.state, r.note]; },
    3, function (r) { return [r.pname, r.planned, r.inspected, r.received, r.state, r.note]; });
}
function findPlan_(p, req) {
  var h = null;
  if (req.id) h = p.byId[str_(req.id)];
  if (!h && req.name !== undefined) h = p.byName[normName_(req.name)];
  if (!h) throw new AppError('not_found', '入荷予定が見つかりません: ' + str_(req.name || req.id));
  return h;
}

/** 明細の状態: 入荷待ち／検品中／一部入荷／完了／消込 */
function planLineState_(l) {
  if (l.planned > 0 && l.received >= l.planned) return '完了';
  if (l.state === '消込') return '消込';
  if (l.inspected > l.received) return '検品中';
  if (l.received > 0) return l.planned === 0 ? '完了' : '一部入荷';
  return '入荷待ち';
}
/** ヘッダの状態を明細から計算する（キャンセルは変えない） */
function planRefresh_(p, h, ts) {
  var lines = p.linesOf[h.id] || [];
  lines.forEach(function (l) { var st = planLineState_(l); if (st !== l.state) { l.state = st; l.dirty = true; } });
  if (h.status === 'キャンセル') return;
  var unposted = lines.some(function (l) { return l.inspected > l.received; });
  var allDone = lines.every(function (l) { return l.planned === 0 || l.received >= l.planned || l.state === '消込'; });
  var st;
  if (allDone && !unposted) st = '完了';
  else if (unposted) st = '検品中';
  else if (lines.some(function (l) { return l.received > 0; })) st = '一部入荷';
  else st = '入荷待ち';
  var fin = st === '完了' ? (h.finished || ts) : '';
  if (st !== h.status || fin !== h.finished) { h.status = st; h.finished = fin; h.dirty = true; }
}
function planSummary_(p, h) {
  var lines = p.linesOf[h.id] || [];
  var s = { id: h.id, name: h.name, supplier: h.supplier, status: h.status, created: h.created, finished: h.finished, memo: h.memo,
    lines: lines.length, planned: 0, inspected: 0, received: 0, remaining: 0 };
  lines.forEach(function (l) {
    s.planned += l.planned; s.inspected += l.inspected; s.received += l.received;
    if (l.state !== '消込' && l.state !== 'キャンセル') s.remaining += Math.max(0, l.planned - l.received);
  });
  return s;
}

function planList_(req) {
  var p = loadPlans_();
  var status = req.status ? String(req.status) : '';
  var list = [];
  p.H.rows.forEach(function (h) { if (!status || h.status === status) list.push(planSummary_(p, h)); });
  var rank = { '検品中': 0, '一部入荷': 1, '入荷待ち': 2, '完了': 3, 'キャンセル': 4 };
  list.sort(function (a, b) {
    var ra = rank[a.status] === undefined ? 9 : rank[a.status], rb = rank[b.status] === undefined ? 9 : rank[b.status];
    if (ra !== rb) return ra - rb;
    return a.created < b.created ? 1 : (a.created > b.created ? -1 : 0);
  });
  return { ok: true, plans: list };
}

function planGet_(req) {
  var p = loadPlans_();
  var h = findPlan_(p, req);
  var m = loadMaster_();
  return {
    ok: true, plan: planSummary_(p, h),
    lines: (p.linesOf[h.id] || []).map(function (l) {
      var mr = m.byKey[janKey_(l.jan)];
      return { jan: l.jan, name: mr ? mr.name : l.pname, location: mr ? mr.location : '', stock: mr ? mr.stock : 0,
        planned: l.planned, inspected: l.inspected, received: l.received, state: l.state, note: l.note };
    })
  };
}

/** items: [{code, qty}] を商品ごとにまとめる。未解決のコードがあれば AppError(unresolved) */
function resolveItems_(m, items, label) {
  if (!Array.isArray(items) || !items.length) throw new AppError('bad_request', 'items が空です');
  var merged = {}, order = [], unresolved = [];
  items.forEach(function (it, idx) {
    var code = it.code !== undefined ? it.code : it.jan;
    var qty = parseQty_(it.qty, (idx + 1) + '行目の数量');
    var res = resolveCode_(m, code);
    if (!res.row) { unresolved.push({ code: str_(code), reason: res.reason }); return; }
    var k = res.row.key;
    if (!merged[k]) { merged[k] = { row: res.row, qty: 0, code: str_(code) }; order.push(k); }
    merged[k].qty += qty;
  });
  if (unresolved.length) {
    throw new AppError('unresolved', (label || '明細') + 'に、SKUでもJANでも解決できないコードがあります: ' + unresolved.map(function (u) { return u.code; }).join(', '), { unresolved: unresolved });
  }
  return order.map(function (k) { return merged[k]; });
}

function planCreate_(req) {
  var name = normName_(req.name);
  if (!name) throw new AppError('bad_request', '予定名が必要です');
  var m = loadMaster_();
  var p = loadPlans_();
  if (p.byName[name]) throw new AppError('duplicate_plan', '同じ名前の入荷予定があります: ' + name, { name: name });
  var lines = resolveItems_(m, req.items, '入荷予定');
  var ts = now_();
  var h = addTableRow_(p.H, { id: nextId_(p.H, 'IB-', 'id'), name: name, supplier: normName_(req.supplier || ''), status: '入荷待ち', created: ts, finished: '', memo: req.memo ? cleanMemo_(req.memo) : '' });
  p.byId[h.id] = h; p.byName[name] = h; p.linesOf[h.id] = [];
  var total = 0;
  lines.forEach(function (l) {
    total += l.qty;
    var row = addTableRow_(p.L, { pid: h.id, jan: l.row.jan, pname: l.row.name, planned: l.qty, inspected: 0, received: 0, state: '入荷待ち', note: '' });
    p.linesOf[h.id].push(row);
  });
  commitPlans_(p);
  return { ok: true, id: h.id, name: name, lines: lines.length, total: total };
}

function planLinesInput_(req) {
  if (!Array.isArray(req.lines) || !req.lines.length) throw new AppError('bad_request', 'lines が空です');
  var merged = {}, order = [];
  req.lines.forEach(function (l) {
    var jan = requireJan_(l.jan);
    var count = parseCount_(l.count, '検品済数');
    var k = janKey_(jan);
    if (!merged[k]) { merged[k] = { jan: jan, count: 0, location: '' }; order.push(k); }
    merged[k].count = Math.max(merged[k].count, count);
    if (l.location !== undefined && l.location !== null) { var loc = normLocation_(l.location); if (loc) merged[k].location = loc; }
  });
  return { merged: merged, order: order };
}
function planFindLine_(p, h, k, mr, ts) {
  var lines = p.linesOf[h.id];
  var line = null;
  lines.forEach(function (l) { if (!line && janKey_(l.jan) === k) line = l; });
  if (line) return { line: line, extra: line.planned === 0 };
  line = addTableRow_(p.L, { pid: h.id, jan: mr.jan, pname: mr.name, planned: 0, inspected: 0, received: 0, state: '入荷待ち', note: '予定外' });
  lines.push(line);
  return { line: line, extra: true };
}

/** 検品済数（累計）を途中保存する。在庫は動かない。予定外の商品は予定数0の行として追加する */
function planInspect_(req) {
  var p = loadPlans_();
  var h = findPlan_(p, req);
  if (h.status === 'キャンセル') throw new AppError('bad_state', 'キャンセルした予定は検品できません: ' + h.name, { status: h.status });
  var inp = planLinesInput_(req);
  var m = loadMaster_();
  var missing = [];
  inp.order.forEach(function (k) { if (!m.byKey[k]) missing.push(inp.merged[k].jan); });
  if (missing.length) throw new AppError('not_in_master', '商品マスタにないJANがあります: ' + missing.join(', '), { missing: missing });
  var ts = now_();
  inp.order.forEach(function (k) {
    var f = planFindLine_(p, h, k, m.byKey[k], ts), l = f.line, c = inp.merged[k].count;
    if (c < l.received) throw new AppError('bad_request', '検品済数は入荷済数（' + l.received + '）より少なくできません: ' + l.pname, { jan: l.jan });
    l.inspected = c; l.pname = m.byKey[k].name; l.dirty = true;
  });
  planRefresh_(p, h, ts);
  h.dirty = true;
  commitPlans_(p);
  return { ok: true, plan: planSummary_(p, h) };
}

/** 入荷の計上: 検品済数を更新し、検品済数−入荷済数を在庫に加算する */
function planReceive_(req) {
  var p = loadPlans_();
  var h = findPlan_(p, req);
  if (h.status === 'キャンセル') throw new AppError('bad_state', 'キャンセルした予定には計上できません: ' + h.name, { status: h.status });
  var inp = planLinesInput_(req);
  var m = loadMaster_();
  var missing = [];
  inp.order.forEach(function (k) { if (!m.byKey[k]) missing.push(inp.merged[k].jan); });
  if (missing.length) throw new AppError('not_in_master', '商品マスタにないJANがあります: ' + missing.join(', '), { missing: missing });

  var ts = now_();
  var userMemo = req.memo ? cleanMemo_(req.memo) : '';
  var ioRows = [], inspRows = [], items = [], total = 0;
  // 先に全行を検証（書き込み前）
  inp.order.forEach(function (k) {
    var l = (p.linesOf[h.id] || []).filter(function (x) { return janKey_(x.jan) === k; })[0];
    var c = inp.merged[k].count;
    if (l && c < l.received) throw new AppError('bad_request', '検品済数は入荷済数（' + l.received + '）より少なくできません: ' + l.pname, { jan: l.jan });
  });
  inp.order.forEach(function (k) {
    var mr = m.byKey[k], c = inp.merged[k].count;
    var f = planFindLine_(p, h, k, mr, ts), l = f.line;
    var delta = c - l.received;
    l.inspected = c; l.pname = mr.name; l.dirty = true;
    if (delta <= 0) return;
    var before = Math.max(0, l.planned - l.received);
    var overNow = l.planned > 0 ? Math.max(0, c - l.planned) - Math.max(0, l.received - l.planned) : 0;
    var parts = ['入荷予定:' + h.name];
    if (l.planned === 0) parts.push('予定外'); else if (overNow > 0) parts.push('超過+' + overNow);
    if (inp.merged[k].location && inp.merged[k].location !== mr.location) {
      parts.push('ロケ変更: ' + (mr.location || '(未設定)') + '→' + inp.merged[k].location);
      mr.location = inp.merged[k].location;
    }
    if (userMemo) parts.push(userMemo);
    l.received = c;
    mr.stock += delta; mr.dirty = true;
    total += delta;
    ioRows.push(ioRow_(ts, mr, '入荷', delta, parts.join(' / ')));
    inspRows.push([ts, '入荷予定 ' + h.name, mr.jan, mr.name, before, delta, delta - before]);
    items.push(pub_(mr));
  });
  if (!ioRows.length) throw new AppError('nothing_to_receive', '計上できる入荷がありません（検品済数が入荷済数と同じです）');
  planRefresh_(p, h, ts);
  h.dirty = true;
  commitMaster_(m);
  commitPlans_(p);
  appendRows_('IO', ioRows);
  appendRows_('INSPECTION', inspRows);
  return { ok: true, name: h.name, received: total, items: items, plan: planSummary_(p, h) };
}

/** 予定を閉じる（消込）: 入荷待ちの残りをもう来ないものとして閉じる。在庫は動かない */
function planClose_(req) {
  var p = loadPlans_();
  var h = findPlan_(p, req);
  if (h.status === 'キャンセル') throw new AppError('bad_state', 'キャンセルした予定です: ' + h.name, { status: h.status });
  var ts = now_(), closed = 0;
  (p.linesOf[h.id] || []).forEach(function (l) {
    if (l.planned > 0 && l.received < l.planned && l.state !== '消込') { l.state = '消込'; l.note = l.note ? l.note + ' / 消込' : '消込'; l.dirty = true; closed++; }
  });
  planRefresh_(p, h, ts);
  h.dirty = true;
  commitPlans_(p);
  return { ok: true, name: h.name, closed: closed, plan: planSummary_(p, h) };
}

/** 入荷予定のキャンセル（入荷済数がすべて0のときだけ。行は消さない） */
function planCancel_(req) {
  var p = loadPlans_();
  var h = findPlan_(p, req);
  if (h.status === 'キャンセル') return { ok: true, plan: planSummary_(p, h) };
  var lines = p.linesOf[h.id] || [];
  if (lines.some(function (l) { return l.received > 0; })) {
    throw new AppError('bad_state', '入荷済みの明細があるためキャンセルできません。残りは「予定を閉じる（消込）」で閉じてください: ' + h.name, { status: h.status });
  }
  var ts = now_();
  lines.forEach(function (l) { l.state = 'キャンセル'; l.dirty = true; });
  h.status = 'キャンセル'; h.finished = ts; h.dirty = true;
  commitPlans_(p);
  return { ok: true, plan: planSummary_(p, h) };
}

/* ---------- 出荷伝票（ヘッダ＋明細） ---------- */

function slipKey_(no) { return nfkc_(no).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').toUpperCase(); }
function slipNo_(no) { return nfkc_(no).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''); }

function loadSlips_() {
  var H = loadTable_('SLIP', 12, function (v) {
    var id = str_(v[0]);
    if (!id) return null;
    return { id: id, no: str_(v[1]), source: str_(v[2]), status: str_(v[3]), created: str_(v[4]), inspected: str_(v[5]), shipped: str_(v[6]), memo: str_(v[7]), tracking: str_(v[8]), carrier: str_(v[9]), group: str_(v[10]), groupAt: str_(v[11]) };
  });
  var L = loadTable_('SLIP_LINES', 6, function (v) {
    var id = str_(v[0]);
    if (!id) return null;
    return { sid: id, jan: janDigits_(v[1]), pname: str_(v[2]), qty: toInt_(v[3]), done: toInt_(v[4]), code: str_(v[5]) };
  });
  var s = { H: H, L: L, byKey: {}, byId: {}, linesOf: {} };
  H.rows.forEach(function (h) { s.byId[h.id] = h; var k = slipKey_(h.no); if (!s.byKey[k]) s.byKey[k] = h; });
  L.rows.forEach(function (l) { (s.linesOf[l.sid] = s.linesOf[l.sid] || []).push(l); });
  return s;
}
function commitSlips_(s) {
  commitTable_(s.H,
    function (r) { return [r.id, r.no, r.source, r.status, r.created, r.inspected, r.shipped, r.memo, r.tracking, r.carrier, r.group || '', r.groupAt || '']; },
    4, function (r) { return [r.status, r.created, r.inspected, r.shipped, r.memo, r.tracking, r.carrier, r.group || '', r.groupAt || '']; });
  commitTable_(s.L,
    function (r) { return [r.sid, r.jan, r.pname, r.qty, r.done, r.code]; },
    3, function (r) { return [r.pname, r.qty, r.done, r.code]; });
}
function findSlip_(s, req) {
  var h = null;
  if (req.id) h = s.byId[str_(req.id)];
  if (!h && req.no !== undefined) h = s.byKey[slipKey_(req.no)];
  if (!h) throw new AppError('not_found', '出荷伝票が見つかりません: ' + str_(req.no || req.id));
  return h;
}
function slipSummary_(s, h) {
  var lines = s.linesOf[h.id] || [];
  var qty = 0, done = 0;
  lines.forEach(function (l) { qty += l.qty; done += l.done; });
  return { id: h.id, no: h.no, status: h.status, source: h.source, lines: lines.length, qty: qty, inspected: done,
    importedAt: h.created, inspectedAt: h.inspected, shippedAt: h.shipped, memo: h.memo, tracking: h.tracking, carrier: h.carrier,
    group: h.group || '', groupAt: h.groupAt || '' };
}
function addSlip_(s, no, lines, source, memo, ts) {
  var h = addTableRow_(s.H, { id: nextId_(s.H, 'SH-', 'id'), no: no, source: source, status: '未検品', created: ts, inspected: '', shipped: '', memo: memo || '', tracking: '', carrier: '', group: '', groupAt: '' });
  s.byId[h.id] = h; s.byKey[slipKey_(no)] = h; s.linesOf[h.id] = [];
  lines.forEach(function (l) {
    s.linesOf[h.id].push(addTableRow_(s.L, { sid: h.id, jan: l.row.jan, pname: l.row.name, qty: l.qty, done: 0, code: l.code }));
  });
  return h;
}

function slipCreate_(req) {
  var no = slipNo_(req.no);
  if (!no) throw new AppError('bad_request', '伝票番号が必要です');
  var m = loadMaster_();
  var s = loadSlips_();
  if (s.byKey[slipKey_(no)]) throw new AppError('duplicate_slip', '同じ伝票番号があります: ' + no, { no: no });
  var lines = resolveItems_(m, req.items, '伝票');
  var h = addSlip_(s, no, lines, '手入力', req.memo ? cleanMemo_(req.memo) : '', now_());
  commitSlips_(s);
  return { ok: true, slip: slipSummary_(s, h) };
}

var SLIP_HEAD = {
  no: ['伝票番号', '注文番号', '受注番号', '注文id', 'order', 'order number', 'order id', 'order no', 'name', '伝票'],
  code: ['sku', 'jan', 'skuまたはjan', 'sku/jan', 'jan/sku', '商品コード', 'コード', '商品sku', 'lineitem sku', 'バーコード'],
  qty: ['数量', '個数', 'qty', 'quantity', 'lineitem quantity', '注文数']
};

/** 伝票CSV: `伝票番号, SKUまたはJAN, 数量`。見出し行は列名（日本語・英語・Shopifyの列名）から位置を判断 */
function parseSlipText_(text) {
  var lines = splitLines_(String(text || '').replace(/^﻿/, ''));
  var rows = [], errors = [];
  var idx = { no: 0, code: 1, qty: 2 };
  var first = true, lastNo = '';
  lines.forEach(function (ln) {
    if (/^\s*$/.test(ln.text)) return; // 伝票番号が「#1001」のように # で始まるため、コメント行は扱わない
    var cells = splitCells_(ln.text);
    if (first) {
      first = false;
      var third = nfkc_(cells[2] === undefined ? '' : cells[2]).replace(/\s/g, '');
      var isHeader = !/^-?\d+$/.test(third);
      if (isHeader) {
        var low = cells.map(function (c) { return nfkc_(c).toLowerCase().replace(/\s+/g, ' ').trim(); });
        ['no', 'code', 'qty'].forEach(function (k) {
          for (var i = 0; i < low.length; i++) if (SLIP_HEAD[k].indexOf(low[i]) >= 0) { idx[k] = i; break; }
        });
        return;
      }
    }
    var no = slipNo_(cells[idx.no] === undefined ? '' : cells[idx.no]);
    var code = str_(cells[idx.code]).replace(/^\s+|\s+$/g, '');
    var qtyRaw = nfkc_(cells[idx.qty] === undefined ? '' : cells[idx.qty]).replace(/\s/g, '');
    if (!code && !qtyRaw) return;
    if (!no) no = lastNo; else lastNo = no;
    if (!no) { errors.push({ line: ln.no, reason: '伝票番号がありません' }); return; }
    rows.push({ line: ln.no, no: no, code: code, qtyRaw: qtyRaw });
  });
  return { rows: rows, errors: errors };
}

function slipImport_(req) {
  var parsed = parseSlipText_(req.text);
  if (!parsed.rows.length && !parsed.errors.length) throw new AppError('bad_request', '取り込む行がありません');
  var m = loadMaster_();
  var s = loadSlips_();
  var ts = now_();

  var orders = {}, order = [];
  parsed.rows.forEach(function (r) {
    var k = slipKey_(r.no);
    if (!orders[k]) { orders[k] = { no: r.no, rows: [] }; order.push(k); }
    orders[k].rows.push(r);
  });

  var created = 0, lineCount = 0, duplicates = [], errors = parsed.errors.map(function (e) { return { no: '', line: e.line, reason: e.reason }; });
  var unresolvedMap = {}, unresolvedOrder = [];
  order.forEach(function (k) {
    var o = orders[k];
    if (s.byKey[k]) { duplicates.push(o.no); return; }
    var problems = [], items = [];
    o.rows.forEach(function (r) {
      var q = Number(r.qtyRaw);
      if (!/^\d+$/.test(r.qtyRaw) || q < 1 || q > CONFIG.MAX_QTY) { problems.push(r.line + '行目: 数量が1以上の整数ではありません（' + r.qtyRaw + '）'); return; }
      if (!r.code) { problems.push(r.line + '行目: SKU／JANがありません'); return; }
      var res = resolveCode_(m, r.code);
      if (!res.row) {
        problems.push(r.line + '行目: ' + r.code + '（' + res.reason + '）');
        var ck = skuKey_(r.code);
        if (!unresolvedMap[ck]) { unresolvedMap[ck] = { code: r.code, reason: res.reason, orders: [] }; unresolvedOrder.push(ck); }
        if (unresolvedMap[ck].orders.indexOf(o.no) < 0) unresolvedMap[ck].orders.push(o.no);
        return;
      }
      items.push({ code: r.code, qty: q });
    });
    if (problems.length) { errors.push({ no: o.no, reason: problems.join(' / ') }); return; }
    var lines = resolveItems_(m, items, '伝票');
    addSlip_(s, o.no, lines, 'CSV', '', ts);
    created++;
    lineCount += lines.length;
  });
  commitSlips_(s);
  return {
    ok: true, orders: order.length, created: created, lines: lineCount, duplicates: duplicates, errors: errors,
    unresolved: unresolvedOrder.map(function (k) { return unresolvedMap[k]; })
  };
}

function slipList_(req) {
  var s = loadSlips_();
  var status = req.status ? String(req.status) : '';
  var list = [];
  s.H.rows.forEach(function (h) { var x = slipSummary_(s, h); if (!status || x.status === status) list.push(x); });
  list.sort(function (a, b) { return a.importedAt < b.importedAt ? 1 : (a.importedAt > b.importedAt ? -1 : 0); });
  return { ok: true, slips: list };
}

function slipGet_(req) {
  var s = loadSlips_();
  var h = findSlip_(s, req);
  var m = loadMaster_();
  return {
    ok: true, slip: slipSummary_(s, h),
    lines: (s.linesOf[h.id] || []).map(function (l) {
      var mr = m.byKey[janKey_(l.jan)];
      return { jan: l.jan, name: mr ? mr.name : l.pname, location: mr ? mr.location : '', stock: mr ? mr.stock : 0, qty: l.qty, done: l.done, code: l.code };
    })
  };
}

/** 出荷検品: 検品済数（累計）を保存する。全明細で 検品済数＝数量 になると「検品済」。在庫は動かさない */
function slipInspect_(req) {
  var s = loadSlips_();
  var h = findSlip_(s, req);
  if (h.status === '出荷済' || h.status === 'キャンセル') throw new AppError('bad_state', 'この伝票は ' + h.status + ' のため検品できません: ' + h.no, { status: h.status });
  if (!Array.isArray(req.items)) throw new AppError('bad_request', 'items が必要です');
  var lines = s.linesOf[h.id] || [];
  var counts = {};
  req.items.forEach(function (it) {
    var jan = requireJan_(it.jan);
    var k = janKey_(jan);
    counts[k] = Math.max(counts[k] || 0, parseCount_(it.count, '検品済数'));
  });
  var diffs = [], byK = {};
  lines.forEach(function (l) { byK[janKey_(l.jan)] = l; });
  Object.keys(counts).forEach(function (k) {
    var l = byK[k];
    if (!l) { if (counts[k] > 0) diffs.push({ jan: k, name: '', planned: 0, actual: counts[k], diff: counts[k] }); return; }
    if (counts[k] > l.qty) diffs.push({ jan: l.jan, name: l.pname, planned: l.qty, actual: counts[k], diff: counts[k] - l.qty });
  });
  if (diffs.length) throw new AppError('not_matched', '明細にない商品か、数量を超えた検品があります（' + diffs.length + '品）。実物を直してやり直してください', { diffs: diffs });
  if (h.status === '検品済') {
    var same = lines.every(function (l) { return counts[janKey_(l.jan)] === undefined || counts[janKey_(l.jan)] === l.done; });
    if (same) return { ok: true, slip: slipSummary_(s, h) };
    throw new AppError('already_inspected', 'この伝票は検品済みです: ' + h.no, { no: h.no });
  }
  var ts = now_();
  lines.forEach(function (l) { var c = counts[janKey_(l.jan)]; if (c !== undefined && c !== l.done) { l.done = c; l.dirty = true; } });
  var all = lines.length > 0 && lines.every(function (l) { return l.done === l.qty; });
  var any = lines.some(function (l) { return l.done > 0; });
  if (all) checkTracking_(h, req.tracking);
  var st = all ? '検品済' : (any ? '検品中' : '未検品');
  h.status = st; h.dirty = true;
  if (all) {
    h.inspected = ts;
    appendRows_('INSPECTION', lines.map(function (l) { return [ts, '出荷伝票 ' + h.no, l.jan, l.pname, l.qty, l.done, 0]; }));
  }
  commitSlips_(s);
  return { ok: true, slip: slipSummary_(s, h) };
}

/** 送り状検品: 全数一致で検品済みにする時、伝票に送り状番号があれば、スキャンした送り状番号が一致することを求める */
function checkTracking_(h, scanned) {
  if (!h.tracking) {
    if (CONFIG.REQUIRE_TRACKING) throw new AppError('tracking_required', 'この伝票には送り状番号がありません。送り状番号を登録してから検品してください: ' + h.no);
    return;
  }
  var t = normTracking_(scanned);
  if (!t) throw new AppError('tracking_required', '送り状検品が必要です。送り状番号のバーコードを読み取ってください（伝票 ' + h.no + '）', { expected: h.tracking });
  if (t !== normTracking_(h.tracking)) {
    throw new AppError('tracking_mismatch', '送り状番号が伝票と一致しません（読み取り: ' + t + '）。別の伝票の送り状かもしれません', { scanned: t, expected: h.tracking });
  }
}

/** 出荷確定: 検品済の伝票の明細分だけ在庫を減らす。在庫不足が1行でもあれば何も書かない */
function slipShip_(req) {
  var s = loadSlips_();
  var h = findSlip_(s, req);
  if (h.status === '出荷済') throw new AppError('already_shipped', 'この伝票は出荷済みです: ' + h.no, { no: h.no });
  if (h.status !== '検品済') throw new AppError('not_inspected', '検品済みの伝票だけ出荷できます（今: ' + h.status + '）: ' + h.no, { status: h.status });
  var lines = s.linesOf[h.id] || [];
  var m = loadMaster_();
  var short = [], missing = [];
  lines.forEach(function (l) {
    var mr = m.byKey[janKey_(l.jan)];
    if (!mr) { missing.push(l.jan); return; }
    if (mr.stock - l.qty < 0 && !CONFIG.ALLOW_NEGATIVE_STOCK) short.push({ jan: mr.jan, name: mr.name, stock: mr.stock, qty: l.qty });
  });
  if (missing.length) throw new AppError('not_in_master', '商品マスタにないJANがあります: ' + missing.join(', '), { missing: missing });
  if (short.length) throw new AppError('insufficient_stock', '在庫が足りない商品があります（' + short.length + '品）。出荷は確定しません', { short: short });

  var ts = now_();
  var userMemo = req.memo ? ' / ' + cleanMemo_(req.memo) : '';
  var ioRows = [], items = [];
  lines.forEach(function (l) {
    var mr = m.byKey[janKey_(l.jan)];
    mr.stock -= l.qty;
    mr.dirty = true;
    ioRows.push(ioRow_(ts, mr, '出荷', l.qty, '出荷伝票:' + h.no + (h.tracking ? ' / 送り状:' + h.tracking : '') + userMemo));
    items.push(pub_(mr));
  });
  h.status = '出荷済'; h.shipped = ts; h.dirty = true;
  commitMaster_(m);
  commitSlips_(s);
  appendRows_('IO', ioRows);
  return { ok: true, slip: slipSummary_(s, h), items: items };
}

/** 取り込み間違いなどの伝票をキャンセルにする（出荷済みを除く。行は消さず、番号は再利用できない） */
function slipVoid_(req) {
  var s = loadSlips_();
  var h = findSlip_(s, req);
  if (h.status === '出荷済') throw new AppError('bad_state', '出荷済みの伝票はキャンセルできません: ' + h.no, { status: h.status });
  if (h.group && h.status !== 'キャンセル') throw new AppError('grouped', '出荷作業中（' + h.group + '）の伝票です。先に「出荷待ちに戻す」で作業グループから外してください: ' + h.no, { group: h.group });
  if (h.status !== 'キャンセル') { h.status = 'キャンセル'; h.dirty = true; commitSlips_(s); }
  return { ok: true, slip: slipSummary_(s, h) };
}

/* ---------- 出荷作業グループ（LOGILESSの「出荷作業中」）とトータルピッキング ---------- */

/** 出荷待ちの伝票をまとめて「出荷作業中」にする（作業グループに入れる）。中にキャンセルできない伝票があれば何もしない */
function slipGroupStart_(req) {
  var s = loadSlips_();
  var nos = Array.isArray(req.nos) ? req.nos : [];
  if (!nos.length) throw new AppError('bad_request', '伝票を選んでください');
  if (nos.length > 200) throw new AppError('bad_request', '一度にまとめられるのは200伝票までです');
  var ts = now_();
  var name = cleanMemo_(req.name).slice(0, 30);
  if (!name) name = 'G-' + ts.replace(/[^0-9]/g, '').slice(0, 12);
  var hs = [], errors = [], seen = {};
  nos.forEach(function (no) {
    var h = s.byKey[slipKey_(no)];
    if (!h) { errors.push({ no: str_(no), reason: '伝票が見つかりません' }); return; }
    if (seen[h.id]) return;
    seen[h.id] = true;
    if (h.status === '出荷済' || h.status === 'キャンセル') { errors.push({ no: h.no, reason: h.status + 'のため出荷作業に入れられません' }); return; }
    if (h.group && h.group !== name) { errors.push({ no: h.no, reason: 'すでに別の作業グループ（' + h.group + '）に入っています' }); return; }
    hs.push(h);
  });
  if (errors.length) throw new AppError('bad_state', '出荷作業を開始できない伝票があります（' + errors.length + '件）。何も変更していません', { errors: errors });
  hs.forEach(function (h) { if (h.group !== name) { h.group = name; h.groupAt = ts; h.dirty = true; } });
  commitSlips_(s);
  return { ok: true, group: name, started: hs.length, slips: hs.map(function (h) { return slipSummary_(s, h); }) };
}

/** 作業グループから外して「出荷待ち」に戻す（検品の途中経過は消さない。出荷済みは対象外） */
function slipGroupRelease_(req) {
  var s = loadSlips_();
  var targets = [];
  if (req.group) {
    var g = str_(req.group);
    s.H.rows.forEach(function (h) { if (h.group === g) targets.push(h); });
  } else {
    var nos = Array.isArray(req.nos) ? req.nos : [];
    nos.forEach(function (no) { var h = s.byKey[slipKey_(no)]; if (h && h.group) targets.push(h); });
  }
  targets = targets.filter(function (h) { return h.status !== '出荷済'; });
  if (!targets.length) throw new AppError('not_found', '出荷作業中の伝票がありません');
  targets.forEach(function (h) { h.group = ''; h.groupAt = ''; h.dirty = true; });
  commitSlips_(s);
  return { ok: true, released: targets.length };
}

/** トータルピッキングリスト（紙は出さない。画面表示用）: 対象伝票の明細を商品ごとに合計し、ロケーション順に並べる */
function slipPicking_(req) {
  var s = loadSlips_();
  var m = loadMaster_();
  var hs = [];
  if (req.group) {
    var g = str_(req.group);
    s.H.rows.forEach(function (h) { if (h.group === g) hs.push(h); });
  } else {
    (Array.isArray(req.nos) ? req.nos : []).forEach(function (no) { var h = s.byKey[slipKey_(no)]; if (h) hs.push(h); });
  }
  hs = hs.filter(function (h) { return h.status !== '出荷済' && h.status !== 'キャンセル'; });
  if (!hs.length) throw new AppError('not_found', 'ピッキングする伝票がありません（出荷済み・キャンセルは除きます）');
  var by = {}, order = [];
  hs.forEach(function (h) {
    (s.linesOf[h.id] || []).forEach(function (l) {
      var k = janKey_(l.jan);
      if (!by[k]) {
        var mr = m.byKey[k];
        by[k] = { jan: l.jan, name: mr ? mr.name : l.pname, location: mr ? mr.location : '', stock: mr ? mr.stock : 0, qty: 0, orders: 0 };
        order.push(k);
      }
      by[k].qty += l.qty; by[k].orders += 1;
    });
  });
  var lines = order.map(function (k) { return by[k]; });
  lines.sort(function (a, b) {
    var la = a.location || '\uffff', lb = b.location || '\uffff';
    if (la !== lb) return la < lb ? -1 : 1;
    return a.jan < b.jan ? -1 : (a.jan > b.jan ? 1 : 0);
  });
  var total = 0; lines.forEach(function (l) { total += l.qty; });
  return { ok: true, group: str_(req.group), slips: hs.map(function (h) { return slipSummary_(s, h); }), lines: lines, totalQty: total };
}

/* ---------- 送り状番号（伝票への紐づけ） ---------- */

function trackingTaken_(s, tracking, selfHeader) {
  var hit = null;
  s.H.rows.forEach(function (h) { if (h !== selfHeader && h.tracking && normTracking_(h.tracking) === tracking && h.status !== 'キャンセル') hit = h; });
  return hit;
}
function setTracking_(s, h, tracking, carrier) {
  if (h.status === '出荷済') throw new AppError('bad_state', '出荷済みの伝票の送り状番号は変更できません: ' + h.no, { status: h.status });
  if (h.status === 'キャンセル') throw new AppError('bad_state', 'キャンセルした伝票です: ' + h.no, { status: h.status });
  if (tracking) {
    if (tracking.length < 6 || tracking.length > 30 || !/^[0-9A-Z]+$/.test(tracking)) throw new AppError('bad_request', '送り状番号は英数字6〜30文字です: ' + tracking);
    var other = trackingTaken_(s, tracking, h);
    if (other) throw new AppError('duplicate_tracking', '送り状番号 ' + tracking + ' は別の伝票（' + other.no + '）に登録済みです', { no: other.no });
  }
  if (h.status === '検品済' && normTracking_(h.tracking) !== tracking) {
    // 検品済みのあとに送り状を変えると、送り状検品が無効になるため、検品をやり直す
    (s.linesOf[h.id] || []).forEach(function (l) { l.done = 0; l.dirty = true; });
    h.status = '未検品'; h.inspected = '';
  }
  h.tracking = tracking; h.carrier = cleanMemo_(carrier).slice(0, 30); h.dirty = true;
}

/** 伝票に送り状番号を登録・変更・消去する（tracking を空にすると消去）。発行そのものは配送業者側で行い、番号だけを記録する */
function slipTracking_(req) {
  var s = loadSlips_();
  var h = findSlip_(s, req);
  setTracking_(s, h, normTracking_(req.tracking), req.carrier);
  commitSlips_(s);
  return { ok: true, slip: slipSummary_(s, h) };
}

var TRK_HEAD = {
  no: ['伝票番号', '注文番号', '受注番号', '受注コード', '注文id', 'order', 'order number', 'order id', 'order no', 'name', '伝票'],
  trk: ['送り状番号', '追跡番号', 'お問い合わせ番号', 'お問合せ番号', '伝票番号(送り状)', 'tracking', 'tracking number', 'tracking numbers', 'tracking_number'],
  carrier: ['配送業者', '運送会社', '配送会社', 'キャリア', 'carrier', 'tracking company']
};
/** 送り状番号CSV: `伝票番号（受注コード）, 送り状番号[, 配送業者]`。配送業者のソフトが出力する追跡番号CSVの列名にも対応 */
function slipTrackingImport_(req) {
  var lines = splitLines_(String(req.text || '').replace(/^﻿/, ''));
  var idx = { no: 0, trk: 1, carrier: 2 };
  var first = true, rows = [];
  lines.forEach(function (ln) {
    if (/^\s*$/.test(ln.text)) return;
    var cells = splitCells_(ln.text);
    if (first) {
      first = false;
      var low = cells.map(function (c) { return nfkc_(c).toLowerCase().replace(/\s+/g, ' ').trim(); });
      var isHeader = ['no', 'trk', 'carrier'].some(function (k) { return low.some(function (x) { return TRK_HEAD[k].indexOf(x) >= 0; }); });
      if (isHeader) {
        ['no', 'trk', 'carrier'].forEach(function (k) { for (var i = 0; i < low.length; i++) if (TRK_HEAD[k].indexOf(low[i]) >= 0) { idx[k] = i; break; } });
        return;
      }
    }
    rows.push({ line: ln.no, no: str_(cells[idx.no]), trk: str_(cells[idx.trk]), carrier: str_(cells[idx.carrier]) });
  });
  if (!rows.length) throw new AppError('bad_request', '取り込む行がありません');
  var s = loadSlips_();
  var updated = 0, unchanged = 0, errors = [];
  rows.forEach(function (r) {
    var h = s.byKey[slipKey_(r.no)];
    if (!h) { errors.push({ line: r.line, no: r.no, reason: '伝票が見つかりません' }); return; }
    var t = normTracking_(r.trk);
    if (!t) { errors.push({ line: r.line, no: r.no, reason: '送り状番号がありません' }); return; }
    if (normTracking_(h.tracking) === t) { unchanged++; return; }
    try { setTracking_(s, h, t, r.carrier); updated++; }
    catch (e) { errors.push({ line: r.line, no: r.no, reason: e instanceof AppError ? e.message : String(e) }); }
  });
  commitSlips_(s);
  return { ok: true, total: rows.length, updated: updated, unchanged: unchanged, skipped: errors.length, errors: errors };
}

/* ---------- 対応表の参照・削除 ---------- */

function skuList_(req) {
  var m = loadMaster_();
  var q = nfkc_(req.q || '').toLowerCase().replace(/^\s+|\s+$/g, '');
  var out = [];
  m.rows.forEach(function (r) {
    r.skus.forEach(function (x) {
      if (q && (nfkc_(x) + ' ' + r.jan + ' ' + nfkc_(r.name)).toLowerCase().indexOf(q) < 0) return;
      out.push({ sku: x, jan: r.jan, name: r.name, note: m.skuNote[skuKey_(x)] || '' });
    });
  });
  return { ok: true, items: out, count: out.length };
}

function skuDelete_(req) {
  var k = skuKey_(req.sku);
  var m = loadMaster_();
  var r = m.bySku[k];
  if (!r) throw new AppError('not_found', 'SKUが見つかりません: ' + str_(req.sku));
  setSkus_(m, r, r.skus.filter(function (x) { return skuKey_(x) !== k; }));
  commitMaster_(m);
  return { ok: true, item: pub_(r) };
}

/* ---------- 管理ビュー・CSV用 ---------- */

/** 入出荷履歴の検索（新しい順）。q: JAN・商品名・メモの部分一致、kubun: 区分 */
function historyList_(req) {
  var sh = sheet_('IO');
  var last = sh.getLastRow();
  var q = nfkc_(req.q || '').toLowerCase().replace(/^\s+|\s+$/g, '');
  var kubun = req.kubun ? String(req.kubun) : '';
  var limit = Math.min(Math.max(Number(req.limit) || 200, 1), 1000);
  var rows = [], total = 0;
  if (last >= 2) {
    var v = sh.getRange(2, 1, last - 1, 7).getValues();
    for (var i = v.length - 1; i >= 0; i--) {
      var r = v[i];
      if (!str_(r[1])) continue;
      if (kubun && str_(r[3]) !== kubun) continue;
      if (q && (nfkc_(r[1]) + ' ' + nfkc_(r[2]) + ' ' + nfkc_(r[6])).toLowerCase().indexOf(q) < 0) continue;
      total++;
      if (rows.length < limit) rows.push({ ts: str_(r[0]), jan: str_(r[1]), name: str_(r[2]), kubun: str_(r[3]), qty: toInt_(r[4]), after: toInt_(r[5]), memo: str_(r[6]) });
    }
  }
  return { ok: true, rows: rows, count: total, truncated: total > rows.length };
}

var EXPORT_KINDS = { master: '商品マスタ', stock: '在庫一覧', io: '入出荷履歴', plans: '入荷予定', slips: '出荷伝票' };

/** CSV用の表を返す（見出し＋行）。CSVへの変換とダウンロードはブラウザ側 */
function exportData_(req) {
  var kind = String(req.kind || '');
  if (!EXPORT_KINDS[kind]) throw new AppError('bad_request', 'kind は ' + Object.keys(EXPORT_KINDS).join(' / ') + ' のどれかです');
  var header, rows = [];
  if (kind === 'master') {
    var m = loadMaster_();
    header = ['JAN', '商品名', '価格', '現在庫', 'ロケーション', 'SKU'];
    m.rows.forEach(function (r) { rows.push([r.jan, r.name, r.price, r.stock, r.location, r.sku]); });
  } else if (kind === 'stock') {
    var m2 = loadMaster_();
    header = ['ロケーション', 'JAN', '商品名', '現在庫', '価格', '在庫金額'];
    var list = m2.rows.slice().sort(function (a, b) {
      if (!a.location && b.location) return 1; if (a.location && !b.location) return -1;
      return a.location < b.location ? -1 : (a.location > b.location ? 1 : (a.name < b.name ? -1 : 1));
    });
    list.forEach(function (r) { rows.push([r.location, r.jan, r.name, r.stock, r.price, r.price === '' ? '' : r.price * r.stock]); });
  } else if (kind === 'io') {
    var sh = sheet_('IO');
    var last = sh.getLastRow();
    header = SHEET_DEF.IO.headers.slice();
    if (last >= 2) sh.getRange(2, 1, last - 1, 7).getValues().forEach(function (r) { if (str_(r[1])) rows.push([str_(r[0]), str_(r[1]), str_(r[2]), str_(r[3]), r[4], r[5], str_(r[6])]); });
  } else if (kind === 'plans') {
    var p = loadPlans_();
    header = ['予定ID', '予定名', '仕入先名', '状態', '作成日時', '完了日時', 'メモ', 'JAN', '商品名', '予定数', '検品済数', '入荷済数', '明細の状態', '備考'];
    p.H.rows.forEach(function (h) {
      var ls = p.linesOf[h.id] || [];
      if (!ls.length) rows.push([h.id, h.name, h.supplier, h.status, h.created, h.finished, h.memo, '', '', '', '', '', '', '']);
      ls.forEach(function (l) { rows.push([h.id, h.name, h.supplier, h.status, h.created, h.finished, h.memo, l.jan, l.pname, l.planned, l.inspected, l.received, l.state, l.note]); });
    });
  } else {
    var s = loadSlips_();
    header = ['伝票ID', '伝票番号', '出所', '状態', '作成日時', '検品日時', '出荷日時', 'メモ', '送り状番号', '配送業者', 'JAN', '商品名', '数量', '検品済数', '元コード'];
    s.H.rows.forEach(function (h) {
      var ls = s.linesOf[h.id] || [];
      if (!ls.length) rows.push([h.id, h.no, h.source, h.status, h.created, h.inspected, h.shipped, h.memo, h.tracking, h.carrier, '', '', '', '', '']);
      ls.forEach(function (l) { rows.push([h.id, h.no, h.source, h.status, h.created, h.inspected, h.shipped, h.memo, h.tracking, h.carrier, l.jan, l.pname, l.qty, l.done, l.code]); });
    });
  }
  return { ok: true, kind: kind, title: EXPORT_KINDS[kind], header: header, rows: rows };
}
