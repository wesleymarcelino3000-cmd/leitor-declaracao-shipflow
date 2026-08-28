import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = process.env.PORT || 5173;
const root = process.cwd();

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    path = normalize(path).replace(/^\.\.(\/|\\|$)/, '');
    const file = join(root, path);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Arquivo não encontrado');
  }
}).listen(port, () => {
  console.log(`Rodando em http://localhost:${port}`);
});
