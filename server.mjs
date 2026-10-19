// Minimal static file server for local development. Unlike `python -m http.server` it honours HTTP Range
// requests, which PMTiles needs. Serves ./docs, plus ./data under /data/ so a freshly built tileset can be tried
// without copying it.
//
//   node server.mjs [port]
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const port = Number(process.argv[2] || process.env.PORT || 8080);
const roots = [resolve('docs'), resolve('.')];
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.pmtiles': 'application/octet-stream',
};

async function locate(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  // docs/ first; /data/* may also come from ./data (build output)
  const candidates = [join(roots[0], rel || 'index.html')];
  if (rel.startsWith('data/') || rel.startsWith('data\\')) candidates.push(join(roots[1], rel));
  for (const file of candidates) {
    if (!roots.some((root) => file.startsWith(root))) continue;
    try {
      const info = await stat(file);
      if (info.isFile()) return { file, size: info.size };
    } catch { /* try next */ }
  }
  return null;
}

createServer(async (req, res) => {
  const found = await locate(new URL(req.url, 'http://x').pathname);
  if (!found) {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = {
    'Content-Type': types[extname(found.file)] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] === '' ? found.size - Number(range[2]) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? found.size - 1 : Math.min(Number(range[2]), found.size - 1);
    if (start > end || start >= found.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${found.size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${found.size}`, 'Content-Length': end - start + 1 });
    createReadStream(found.file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': found.size });
    createReadStream(found.file).pipe(res);
  }
}).listen(port, () => console.log(`http://localhost:${port}/`));
