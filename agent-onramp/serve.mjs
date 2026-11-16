// 只为本地看效果：node serve.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.argv[2] || 4180);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http
  .createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(root, normalize(p === '/' ? '/demo.html' : p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root)) return res.writeHead(403).end('no');
    try {
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404).end('404');
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
