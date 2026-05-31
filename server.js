const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = process.env.PORT || 3000;
const DIR  = __dirname;

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Service-Worker-Allowed', '/');

  if (req.url === '/api/info') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok', port:PORT}));
    return;
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = path.normalize(path.join(DIR, urlPath));
  if (!filePath.startsWith(DIR)) { res.writeHead(403); res.end(); return; }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const idx = path.join(DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, {'Content-Type':MIME['.html'],'Cache-Control':'no-cache'});
      res.end(fs.readFileSync(idx));
    } else { res.writeHead(404); res.end('Not Found'); }
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const ct  = MIME[ext] || 'application/octet-stream';
  const cc  = ['.png','.ico','.svg'].includes(ext) ? 'max-age=604800' : 'no-cache';
  res.writeHead(200, {'Content-Type':ct,'Cache-Control':cc});
  res.end(fs.readFileSync(filePath));
}

http.createServer(handler).listen(PORT, '0.0.0.0', () => {
  console.log('ISOLA Business Suite running on port ' + PORT);
});
