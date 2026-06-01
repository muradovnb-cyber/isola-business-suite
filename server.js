const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT       = process.env.PORT || 3000;
const DIR        = __dirname;
const GH_TOKEN   = process.env.GH_TOKEN || '';
const GH_REPO    = 'muradovnb-cyber/isola-business-suite';
const GH_FILE    = 'data.json';

const MIME = {
  '.html':        'text/html;charset=utf-8',
  '.js':          'application/javascript',
  '.json':        'application/json',
  '.png':         'image/png',
  '.ico':         'image/x-icon',
  '.css':         'text/css',
  '.svg':         'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// ── In-memory DB ────────────────────────────────────────────────────────
let DB     = null;
let ghSHA  = null;     // SHA of data.json on GitHub (needed for updates)
let saving = false;
let saveQueue = false;

// ── GitHub helpers ──────────────────────────────────────────────────────
function ghRequest(method, path2, body, cb) {
  const opts = {
    hostname: 'api.github.com',
    path:     '/repos/' + GH_REPO + '/contents/' + path2,
    method:   method,
    headers: {
      'Authorization': 'token ' + GH_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'ISOLA-Server/1.0'
    }
  };
  const req = https.request(opts, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try { cb(null, JSON.parse(data)); }
      catch(e) { cb(e, null); }
    });
  });
  req.on('error', cb);
  if (body) req.write(JSON.stringify(body));
  req.end();
}

function loadFromGitHub(cb) {
  ghRequest('GET', GH_FILE, null, (err, data) => {
    if (err || data.message) {
      console.log('GitHub load failed (first run?):', err || data.message);
      cb(null, null); return;
    }
    try {
      ghSHA = data.sha;
      const decoded = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      cb(null, decoded);
    } catch(e) { cb(e, null); }
  });
}

function saveToGitHub(dbData, cb) {
  const content = Buffer.from(JSON.stringify(dbData)).toString('base64');
  const body = { message: 'auto: sync DB', content };
  if (ghSHA) body.sha = ghSHA;
  ghRequest('PUT', GH_FILE, body, (err, res) => {
    if (!err && res.content) {
      ghSHA = res.content.sha;
      console.log('Saved to GitHub OK, SHA:', ghSHA.slice(0,7));
    } else {
      console.log('GitHub save error:', err || res.message);
    }
    if (cb) cb(err);
  });
}

function saveDB() {
  if (saving) { saveQueue = true; return; }
  saving = true;
  saveToGitHub(DB, () => {
    saving = false;
    if (saveQueue) { saveQueue = false; saveDB(); }
  });
}

// ── Startup: load DB from GitHub ────────────────────────────────────────
function startServer() {
  console.log('Loading DB from GitHub...');
  loadFromGitHub((err, data) => {
    DB = data || { users:[], cps:[], txs:[], orders:[], petty:[], deals:[], accruals:[], rates:{}, products:[] };
    console.log('DB loaded. Txs:', (DB.txs||[]).length, 'Orders:', (DB.orders||[]).length);
    http.createServer(handler).listen(PORT, '0.0.0.0', () => {
      console.log('ISOLA Business Suite running on port ' + PORT);
    });
  });
}

// ── Body parser ─────────────────────────────────────────────────────────
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if(body.length > 10*1024*1024) { body=''; req.destroy(); } });
  req.on('end', () => {
    try { cb(null, JSON.parse(body)); }
    catch(e) { cb(e, null); }
  });
}

function json(res, data, code) {
  const s = JSON.stringify(data);
  res.writeHead(code||200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
  res.end(s);
}

// ── Request handler ─────────────────────────────────────────────────────
function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Service-Worker-Allowed', '/');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── API: get full DB ──────────────────────────────────────────────────
  if (url === '/api/data' && req.method === 'GET') {
    json(res, { ok:true, data: DB });
    return;
  }

  // ── API: save full DB (from browser) ─────────────────────────────────
  if (url === '/api/data' && req.method === 'POST') {
    readBody(req, (err, body) => {
      if (err || !body) { json(res, {ok:false, err:'bad json'}, 400); return; }
      DB = body;
      saveDB();
      json(res, { ok:true });
    });
    return;
  }

  // ── API: add expense from n8n bot ─────────────────────────────────────
  if (url === '/api/expense' && req.method === 'POST') {
    readBody(req, (err, body) => {
      if (err || !body) { json(res, {ok:false, err:'bad json'}, 400); return; }
      if (!DB.txs) DB.txs = [];
      const newId = DB.txs.length ? Math.max.apply(null, DB.txs.map(t=>t.id||0)) + 1 : 1;
      const tx = {
        id:    newId,
        date:  body.date || new Date().toISOString().slice(0,10),
        type:  'expense',
        acc:   body.account || 'cash',
        iid:   body.iid || 15,
        cpid:  body.cpid || null,
        oid:   body.oid  || null,
        amt:   body.amount || 0,
        cur:   body.currency || 'UZS',
        rate:  1,
        uzs:   body.amount || 0,
        note:  '[ТГ] ' + (body.description || ''),
        by:    body.by || 3,
        debt:  false,
        fromTg: true
      };
      DB.txs.push(tx);
      saveDB();
      json(res, { ok:true, tx });
    });
    return;
  }

  // ── API: health check ─────────────────────────────────────────────────
  if (url === '/api/health') {
    json(res, {
      ok:       true,
      status:   'running',
      txs:      (DB.txs||[]).length,
      orders:   (DB.orders||[]).length,
      users:    (DB.users||[]).length,
      uptime:   Math.round(process.uptime()) + 's',
      ghSHA:    ghSHA ? ghSHA.slice(0,7) : 'none'
    });
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────
  let filePath = path.normalize(path.join(DIR, url === '/' ? '/index.html' : url));
  if (!filePath.startsWith(DIR)) { res.writeHead(403); res.end(); return; }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIR, 'index.html');
  }

  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return; }

  const ext = path.extname(filePath).toLowerCase();
  const ct  = MIME[ext] || 'application/octet-stream';
  const cc  = ['.png','.ico','.svg'].includes(ext) ? 'max-age=604800' : 'no-cache, no-store, must-revalidate';
  res.writeHead(200, {'Content-Type':ct,'Cache-Control':cc});
  res.end(fs.readFileSync(filePath));
}

startServer();
