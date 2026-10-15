import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createBridge } from '../ai-bridge.mjs';

test('local bridge forwards authenticated AI requests and enforces its boundary', async () => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: raw && JSON.parse(raw) });
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"response.output_text.delta","delta":"ready"}\n\n');
    } else if (req.url === '/v1/chat/completions') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid test key' } }));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    }
  });
  const bridge = createBridge();
  upstream.listen(0, '127.0.0.1');
  bridge.listen(0, '127.0.0.1');
  await Promise.all([once(upstream, 'listening'), once(bridge, 'listening')]);
  const base = `http://127.0.0.1:${bridge.address().port}`;
  const target = `http://127.0.0.1:${upstream.address().port}`;
  try {
    const health = await fetch(base + '/health', { headers: { Origin: 'null' } });
    assert.equal(health.headers.get('access-control-allow-origin'), 'null');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const info = await health.json();
    assert.equal(info.app, 'gongji-ai-bridge');
    assert.equal(info.token.length, 64);
    const headers = { 'Content-Type': 'application/json', 'X-Gongji-Token': info.token, Origin: 'null' };
    const forward = (url, body) => fetch(base + '/request', {
      method: 'POST', headers, body: JSON.stringify({ url, apiKey: 'qa-key', body })
    });
    let response = await forward(target + '/v1/models');
    assert.deepEqual(await response.json(), { data: [{ id: 'test-model' }] });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].authorization, 'Bearer qa-key');
    response = await forward(target + '/v1/responses', { model: 'test-model', input: 'hello' });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.match(await response.text(), /response.output_text.delta/);
    assert.deepEqual(calls[1].body, { model: 'test-model', input: 'hello' });
    response = await forward(target + '/v1/chat/completions', { model: 'test-model', messages: [] });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.message, 'Invalid test key');
    response = await fetch(base + '/request', {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-gongji-token' }
    });
    assert.equal(response.status, 204);
    assert.match(response.headers.get('access-control-allow-headers'), /X-Gongji-Token/);
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
    response = await fetch(base + '/health', { headers: { Origin: 'https://unrelated.example' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    response = await fetch(base + '/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target + '/v1/models', apiKey: 'qa-key' })
    });
    assert.equal(response.status, 403);
    for (const url of ['file:///etc/models', target + '/private', target + '/v1/models?key=secret', 'https://name:pass@example.com/models']) {
      response = await forward(url);
      assert.equal(response.status, 400, url);
    }
    assert.equal(calls.length, 3, 'Rejected requests must never reach an upstream');
  } finally {
    await Promise.all([new Promise(resolve => bridge.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});
