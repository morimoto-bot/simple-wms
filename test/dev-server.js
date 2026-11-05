'use strict';
// 画面の動作確認用の開発サーバー。index.html を配信し、/gas/exec で本物の Code.gs（模擬スプレッドシート上）を動かす。
// 使い方: node test/dev-server.js   →  http://localhost:8765/#gas=http%3A%2F%2Flocalhost%3A8765%2Fgas%2Fexec&token=dev-token-0123456789abcdef
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEnv } = require('./gas-fake');

const env = createEnv();
const csv = fs.readFileSync(path.join(__dirname, '..', 'sample', 'sample-master.csv'), 'utf8');
const seeded = env.post('masterImport', { text: csv });
console.log('seed', JSON.stringify({ added: seeded.added, skipped: seeded.skipped }));

function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }); }

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (u.pathname === '/gas/exec') {
    let out;
    if (req.method === 'POST') out = env.raw('POST', await readBody(req));
    else out = env.raw('GET', Object.fromEntries(u.searchParams));
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === '/__dump') { // 確認用: 4シートの中身
    const o = {};
    for (const n of ['商品マスタ', '入出荷履歴', '検品履歴', '棚卸履歴']) { const s = env.sheet(n); o[n] = s ? s.dump() : null; }
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    return res.end(JSON.stringify(o));
  }
  if (u.pathname === '/__fakecam.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'fakecam.js')));
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, '..', 'index.html')));
  }
  res.writeHead(404); res.end('not found');
}).listen(8765, () => console.log('http://localhost:8765/'));
