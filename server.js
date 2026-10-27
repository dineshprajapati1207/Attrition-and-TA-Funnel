// Live Attrition + TA Funnel dashboard server.
// Serves public/ and proxies the two Google Sheets through a service account
// (no npm dependencies; needs Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// Optional .env file (KEY=value per line); real environment variables take precedence
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
} catch (e) {}

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const KEY_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'service-account.json');
const CACHE_SECONDS = +process.env.CACHE_SECONDS || 30;

// Only these spreadsheets can be read through /api/sheet/:key
const SHEETS = {
  attrition: process.env.ATTRITION_SHEET_ID || '1jT8Lo0SAdCnkhbg6oeqi-bVOIhEAIO1wrt2P1nakhwI',
  ta: process.env.TA_SHEET_ID || '1JELHBP1rJym7rxwgDGLzN45GzgULmrHZ15JhijXWtu8',
};
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------- Google auth (service-account JWT -> access token) ----------
let KEY = null, TOKEN = null;
function loadKey() {
  if (KEY) return KEY;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) KEY = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  else if (fs.existsSync(KEY_FILE)) KEY = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  else throw httpErr(500, 'Service account key not found. Put it at ' + KEY_FILE + ' or set GOOGLE_APPLICATION_CREDENTIALS.');
  if (!KEY.client_email || !KEY.private_key) throw httpErr(500, 'Service account key file is missing client_email / private_key.');
  return KEY;
}
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function token() {
  if (TOKEN && TOKEN.exp > Date.now() + 60e3) return TOKEN.v;
  const k = loadKey(), now = Math.floor(Date.now() / 1000);
  const claim = { iss: k.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64u(sig) }),
  });
  const j = await r.json();
  if (!r.ok) throw httpErr(502, 'Google sign-in failed: ' + (j.error_description || j.error || r.status));
  TOKEN = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return TOKEN.v;
}
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
async function gget(url) {
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + await token() } });
  if (r.ok) return r.json();
  let m = ''; try { m = (await r.json()).error.message; } catch (e) {}
  if (r.status == 403 || r.status == 404) m = 'No access to the sheet (share it with ' + loadKey().client_email + ' as Viewer). ' + m;
  throw httpErr(r.status == 403 || r.status == 404 ? r.status : 502, m || 'Google API error ' + r.status);
}

// ---------- Sheet reader: every grid tab as raw values ----------
// Dates come back as spreadsheet serial numbers, which the page already understands.
async function readSpreadsheet(id) {
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + id;
  const meta = await gget(base + '?fields=properties.title,properties.timeZone,sheets.properties(title,sheetType,hidden)');
  const tabs = meta.sheets.map(s => s.properties).filter(p => p.sheetType == 'GRID' && !p.hidden).map(p => p.title);
  const out = [];
  for (let i = 0; i < tabs.length; i += 40) {
    const q = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER', majorDimension: 'ROWS' });
    tabs.slice(i, i + 40).forEach(t => q.append('ranges', "'" + t.replace(/'/g, "''") + "'"));
    const j = await gget(base + '/values:batchGet?' + q);
    j.valueRanges.forEach((vr, k) => out.push({ name: tabs[i + k], rows: vr.values || [] }));
  }
  return { title: meta.properties.title, fetchedAt: Date.now(), sheets: out };
}

// Sheets are re-read in the background every CACHE_SECONDS, so requests are answered from memory.
const CACHE = {}, INFLIGHT = {};
function refresh(key) {
  if (INFLIGHT[key]) return INFLIGHT[key];
  const t = Date.now();
  return INFLIGHT[key] = readSpreadsheet(SHEETS[key]).then(d => {
    CACHE[key] = { at: Date.now(), gz: zlib.gzipSync(JSON.stringify(d)) };
    console.log(new Date().toISOString(), 'synced', key, (Date.now() - t) + 'ms');
  }).finally(() => { delete INFLIGHT[key]; });
}
async function cached(key, force) {
  const c = CACHE[key];
  // "fresh" waits for Google only if the copy in memory is more than 10 s old
  if (c && !(force && Date.now() - c.at > 10e3)) return c.gz;
  try { await refresh(key); } catch (e) { if (!c) throw e; console.error(new Date().toISOString(), key, e.message); }
  return CACHE[key].gz;
}
function warm() { Object.keys(SHEETS).forEach(k => refresh(k).catch(e => console.error(new Date().toISOString(), k, e.message))); }
warm();
setInterval(warm, CACHE_SECONDS * 1000);

// ---------- HTTP ----------
function send(res, status, body, type, extra) {
  res.writeHead(status, { 'content-type': type || 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(body);
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    let m;
    if (u.pathname == '/api/health') return send(res, 200, JSON.stringify({ ok: true, sheets: Object.keys(SHEETS) }));
    if ((m = u.pathname.match(/^\/api\/sheet\/(\w+)$/))) {
      if (!SHEETS[m[1]]) return send(res, 404, JSON.stringify({ error: 'Unknown sheet' }));
      const gz = await cached(m[1], u.searchParams.has('fresh'));
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return send(res, 200, gz, 'application/json', { 'content-encoding': 'gzip' });
      return send(res, 200, zlib.gunzipSync(gz));
    }
    if (u.pathname.startsWith('/api/')) return send(res, 404, '');
    const f = path.normalize(path.join(PUBLIC, decodeURIComponent(u.pathname == '/' ? '/index.html' : u.pathname)));
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
  } catch (e) {
    console.error(new Date().toISOString(), req.url, e.message);
    send(res, e.status || 500, JSON.stringify({ error: e.message }));
  }
}).listen(PORT, HOST, () => console.log(`Dashboard running at http://${HOST == '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
