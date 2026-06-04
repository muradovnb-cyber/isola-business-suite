const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT       = process.env.PORT || 3000;
const DIR        = __dirname;
const GH_TOKEN   = (process.env.GH_TOKEN || '').replace(/^"|"$/g,'').replace(/^'|'$/g,'').trim();
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

// ── Security: blocked IPs + event log ──────────────────────────────────────
const blockedIPs = new Set();
const securityLog = [];
const MAX_LOG = 200;

function logSecurity(ip, event, detail) {
  const entry = { ts: new Date().toISOString(), ip, event, detail };
  securityLog.unshift(entry);
  if (securityLog.length > MAX_LOG) securityLog.pop();
  console.log('[SECURITY]', JSON.stringify(entry));
}

function checkBlocked(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (blockedIPs.has(ip)) {
    res.writeHead(403, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:false,err:'blocked'}));
    return null;
  }
  return ip;
}

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
function checkApiKey(req) {
  const validKey = (process.env.API_SECRET || '').replace(/^"|"$/g,'').trim();
  if (!validKey) return true; // If no secret set, allow all (backwards compat)
  return req.headers['x-api-key'] === validKey;
}

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
    const ip_data = checkBlocked(req, res); if (!ip_data) return;
    if (!checkApiKey(req)) {
      logSecurity(ip_data, 'UNAUTHORIZED_WRITE', '/api/data POST');
      json(res,{ok:false,err:'unauthorized'},401); return;
    }
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
    if (!checkApiKey(req)) { json(res,{ok:false,err:'unauthorized'},401); return; }
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
  // ── API: add income ─────────────────────────────────────────────────────
  if (url === '/api/income' && req.method === 'POST') {
    if (!checkApiKey(req)) { logSecurity(checkBlocked(req,res)||'?','UNAUTH','/api/income'); json(res,{ok:false,err:'unauthorized'},401); return; }
    readBody(req, (err, body) => {
      if (err || !body) { json(res,{ok:false},400); return; }
      if (!DB.txs) DB.txs = [];
      const id = DB.txs.length ? Math.max(...DB.txs.map(t=>t.id||0))+1 : 1;
      const tx = { id, date: body.date||new Date().toISOString().slice(0,10),
        type:'income', acc: body.acc||'cash', iid: body.iid||1,
        cpid: body.cpid||null, oid: body.oid||null,
        amt: body.amt||0, cur: body.cur||'UZS', rate:1, uzs: body.amt||0,
        note: body.note||'', by: body.by||1, payType: body.payType||'payment', fromBot:true };
      DB.txs.push(tx); saveDB(); json(res,{ok:true,tx});
    }); return;
  }

  // ── API: create order ────────────────────────────────────────────────────
  if (url === '/api/order' && req.method === 'POST') {
    if (!checkApiKey(req)) { json(res,{ok:false,err:'unauthorized'},401); return; }
    readBody(req, (err, body) => {
      if (err || !body) { json(res,{ok:false},400); return; }
      if (!DB.orders) DB.orders = [];
      const id = DB.orders.length ? Math.max(...DB.orders.map(o=>o.id||0))+1 : 1;
      const order = { id, num:'#'+id, name: body.name||'Новый заказ',
        cpid: body.cpid||null, mid: body.mid||4, status: body.status||'new',
        total: body.total||0, paid:0, date: body.date||new Date().toISOString().slice(0,10),
        deadline: body.deadline||null, note: body.note||'', fromBot:true };
      DB.orders.push(order); saveDB(); json(res,{ok:true,order});
    }); return;
  }

  // ── API: create deal (CRM) ───────────────────────────────────────────────
  if (url === '/api/deal' && req.method === 'POST') {
    if (!checkApiKey(req)) { json(res,{ok:false,err:'unauthorized'},401); return; }
    readBody(req, (err, body) => {
      if (err || !body) { json(res,{ok:false},400); return; }
      if (!DB.deals) DB.deals = [];
      const id = DB.deals.length ? Math.max(...DB.deals.map(d=>d.id||0))+1 : 1;
      const deal = { id, name: body.name||'Новая сделка',
        cpid: body.cpid||null, mid: body.mid||4, stage: body.stage||'lead',
        amt: body.amt||0, date: body.date||new Date().toISOString().slice(0,10),
        note: body.note||'', fromBot:true };
      DB.deals.push(deal); saveDB(); json(res,{ok:true,deal});
    }); return;
  }

  // ── API: petty cash issue/report ─────────────────────────────────────────
  if (url === '/api/petty' && req.method === 'POST') {
    if (!checkApiKey(req)) { json(res,{ok:false,err:'unauthorized'},401); return; }
    readBody(req, (err, body) => {
      if (err || !body) { json(res,{ok:false},400); return; }
      if (!DB.petty) DB.petty = [];
      const id = DB.petty.length ? Math.max(...DB.petty.map(p=>p.id||0))+1 : 1;
      const entry = { id, empId: body.empId||3, type: body.type||'issued',
        amt: body.amt||0, date: body.date||new Date().toISOString().slice(0,10),
        note: body.note||'', status: body.status||'open',
        iid: body.iid||null, oid: body.oid||null, fromBot:true };
      DB.petty.push(entry); saveDB(); json(res,{ok:true,entry});
    }); return;
  }

  // ── API: salary accrual ──────────────────────────────────────────────────
  if (url === '/api/salary' && req.method === 'POST') {
    if (!checkApiKey(req)) { json(res,{ok:false,err:'unauthorized'},401); return; }
    readBody(req, (err, body) => {
      if (err || !body) { json(res,{ok:false},400); return; }
      if (!DB.accruals) DB.accruals = [];
      const id = DB.accruals.length ? Math.max(...DB.accruals.map(a=>a.id||0))+1 : 1;
      const acc = { id, empId: body.empId, amt: body.amt||0,
        month: body.month||new Date().getMonth()+1,
        year: body.year||new Date().getFullYear(),
        type: body.type||'salary', paid: body.paid||false,
        date: body.date||new Date().toISOString().slice(0,10), fromBot:true };
      DB.accruals.push(acc); saveDB(); json(res,{ok:true,accrual:acc});
    }); return;
  }

  // ── Security log (только с правильным ключом) ───────────────────────────
  if (url === '/api/security' && req.method === 'GET') {
    if (!checkApiKey(req)) { json(res,{ok:false,err:'unauthorized'},401); return; }
    json(res, { ok:true, blocked: Array.from(blockedIPs), log: securityLog.slice(0,50) });
    return;
  }

  // ── Block IP manually ────────────────────────────────────────────────────
  if (url === '/api/block' && req.method === 'POST') {
    if (!checkApiKey(req)) { json(res,{ok:false,err:'unauthorized'},401); return; }
    readBody(req, (err,body) => {
      if(err||!body) { json(res,{ok:false},400); return; }
      if(body.ip) { blockedIPs.add(body.ip); logSecurity(body.ip,'MANUALLY_BLOCKED','admin action'); }
      if(body.unblock) blockedIPs.delete(body.unblock);
      json(res, {ok:true, blocked: Array.from(blockedIPs)});
    });
    return;
  }

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
