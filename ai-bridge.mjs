import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const BRIDGE_PORT = 17654;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_REPLY = 8 * 1024 * 1024;

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readLimited(stream, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new Error('Request or response is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createBridge() {
  const token = randomBytes(32).toString('hex');
  return http.createServer(async (req, res) => {
    const host = `127.0.0.1:${req.socket.localPort}`;
    const origin = req.headers.origin;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== host || (origin && origin !== 'null' && origin !== `http://${host}`)) {
      json(res, 403, { error: { message: 'This bridge accepts local application requests only.' } });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Gongji-Token');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { app: 'gongji-ai-bridge', version: 1, token });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/request') {
      json(res, 404, { error: { message: 'Not found.' } });
      return;
    }
    if (req.headers['x-gongji-token'] !== token) {
      json(res, 403, { error: { message: 'Please reconnect to the local AI bridge.' } });
      return;
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      json(res, 415, { error: { message: 'Expected application/json.' } });
      return;
    }
    let input, target;
    try {
      input = JSON.parse((await readLimited(req, MAX_BODY)).toString('utf8'));
      target = new URL(input.url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
          target.search || target.hash || !/\/(models|chat\/completions|responses)$/.test(target.pathname) ||
          typeof input.apiKey !== 'string' || !input.apiKey.trim() || /[\r\n]/.test(input.apiKey) ||
          (!target.pathname.endsWith('/models') && (!input.body || typeof input.body !== 'object'))) {
        throw new Error('Invalid AI endpoint or request.');
      }
    } catch {
      json(res, 400, { error: { message: 'Invalid AI endpoint or request.' } });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const disconnect = () => { if (!res.writableEnded) ctrl.abort(); };
    res.on('close', disconnect);
    try {
      const isModels = target.pathname.endsWith('/models');
      const reply = await fetch(target, {
        method: isModels ? 'GET' : 'POST',
        headers: {
          'Authorization': `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'gongji-ai-bridge/1.0'
        },
        ...(isModels ? {} : { body: JSON.stringify(input.body) }),
        redirect: 'error',
        signal: ctrl.signal
      });
      const body = await readLimited(reply.body, MAX_REPLY);
      res.writeHead(reply.status, { 'Content-Type': reply.headers.get('content-type') || 'application/json' });
      res.end(body);
    } catch (error) {
      const timeout = ctrl.signal.aborted;
      const code = error.cause?.code;
      if (!res.destroyed) {
        json(res, timeout ? 504 : 502, {
          error: {
            message: timeout ? '上游接口请求超时，请稍后重试。'
              : `本机服务无法连接上游接口${code ? `（${code}）` : ''}，请检查网络、代理或接口地址。`
          }
        });
      }
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createBridge();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${BRIDGE_PORT} is in use. Run the launcher to check the existing bridge.`
      : `AI bridge failed: ${error.code || 'unknown error'}`);
    process.exitCode = 1;
  });
  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`Gongji AI bridge ready at http://127.0.0.1:${BRIDGE_PORT}`);
  });
}
