import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBridge } from '../ai-bridge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const screenshots = process.env.GONGJI_SCREENSHOT_DIR && path.resolve(process.env.GONGJI_SCREENSHOT_DIR);
if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
const app = path.join(root, fs.readdirSync(root).find(name => name.endsWith('.html')));
const html = fs.readFileSync(app, 'utf8');
for (const [index, script] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
  new vm.Script(script[1], { filename: `inline-${index + 1}.js` });
}
assert.equal(typeof WebSocket, 'function', 'Run with Node.js 22 or newer.');
const browser = [
  process.env.GONGJI_BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(candidate => candidate && fs.existsSync(candidate));
assert.ok(browser, 'Set GONGJI_BROWSER_PATH to a Chrome or Edge executable.');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gongji-regression-'));
const downloads = path.join(scratch, 'downloads');
fs.mkdirSync(downloads);
const child = spawn(browser, [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--window-size=1440,1000',
  `--user-data-dir=${path.join(scratch, 'profile')}`, 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const exited = new Promise(resolve => child.once('exit', resolve));
const pending = new Map();
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, sessionId, sequence = 0, passed = 0;
let aiBridge, aiUpstream;

function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    pending.set(id, {
      resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function waitFor(check, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(80);
  }
  throw new Error(`Timeout: ${label}`);
}

async function click(selector) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
    el.click();
  })()`);
}

async function fill(values) {
  await evaluate(`(() => {
    for (const [selector, value] of ${JSON.stringify(values)}) {
      const el = document.querySelector(selector);
      if (!el) throw new Error('Missing field: ' + selector);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
}

async function navigate(view) {
  await click(`.nav-item[data-view="${view}"]`);
}

async function capture(name) {
  if (!screenshots) return;
  await evaluate(`document.querySelector('#toast-root').innerHTML = '';
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(screenshots, name + '.png'), Buffer.from(data, 'base64'));
}

async function reload() {
  await send('Page.reload');
  await waitFor(() => evaluate("document.readyState === 'complete' && typeof blob !== 'undefined' && blob !== null"), 'initialization');
}

async function register(user) {
  await fill([
    ['#reg-user', user], ['#reg-display', user],
    ['#reg-pass', 'qa-password'], ['#reg-pass2', 'qa-password']
  ]);
  await evaluate("document.querySelector('#register-form').requestSubmit()");
  await waitFor(() => evaluate(`currentUser === ${JSON.stringify(user)} && !!document.querySelector('#wc-later')`), 'registration');
  await click('#wc-later');
}

async function login(user) {
  await fill([['#login-user', user], ['#login-pass', 'qa-password']]);
  await evaluate("document.querySelector('#login-form').requestSubmit()");
  await waitFor(() => evaluate(`currentUser === ${JSON.stringify(user)} && !document.querySelector('#app-shell').classList.contains('hidden')`), 'login');
}

async function logout() {
  await click('#logout-btn');
  await waitFor(() => evaluate("currentUser === null && !document.querySelector('#auth-screen').classList.contains('hidden')"), 'logout');
}

async function installFileHandle(data = '') {
  await evaluate(`(() => {
    const state = { name: 'qa-data.json', data: ${JSON.stringify(typeof data === 'string' ? data : JSON.stringify(data))}, fail: false, permission: 'granted', writes: 0 };
    const handle = {
      name: state.name,
      async queryPermission() { return state.permission; },
      async requestPermission() { return state.permission; },
      async getFile() { return new File([state.data], state.name); },
      async createWritable() {
        if (state.fail) throw new Error('Injected write failure');
        return {
          async write(data) { state.data = data; state.writes++; },
          async close() {}
        };
      }
    };
    window.qaFile = state;
    window.qaHandle = handle;
    if (!window.qaBindings) window.qaBindings = new Map();
    window.idbSet = async (key, value) => { qaBindings.set(key, value); };
    window.idbGet = async key => qaBindings.get(key);
    window.showSaveFilePicker = async () => handle;
    window.showOpenFilePicker = async () => [handle];
  })()`);
}

async function withFreshDevice(run) {
  const original = sessionId;
  const { browserContextId } = await send('Target.createBrowserContext', {}, null);
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId }, null);
    ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: pathToFileURL(app).href });
    await waitFor(() => evaluate("document.readyState === 'complete' && typeof blob !== 'undefined' && blob !== null"), 'fresh device');
    return await run();
  } finally {
    await send('Target.disposeBrowserContext', { browserContextId }, null);
    sessionId = original;
    await send('Page.bringToFront');
  }
}

async function importData(data) {
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(JSON.stringify(data))}], 'qa.json', { type: 'application/json' }));
    const input = document.querySelector('#import-file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(() => evaluate("!!document.querySelector('#imp-merge')"), 'import dialog');
}

async function test(name, run) {
  await run();
  assert.deepEqual(errors, [], `${name}: browser errors`);
  passed++;
  console.log(`PASS ${name}`);
}

try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser startup timeout')), 20000);
    let output = '';
    child.stderr.on('data', data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited: ${code}`)); });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map(arg => arg.value || arg.description || '').join(' '));
    }
  });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }, null);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: pathToFileURL(app).href });
  await waitFor(() => evaluate("document.readyState === 'complete' && typeof blob !== 'undefined' && blob !== null"), 'initialization');

  await test('registration and remembered login persist', async () => {
    await register('qa_alpha');
    await reload();
    assert.equal(await evaluate('currentUser'), 'qa_alpha');
    assert.equal(await evaluate("!!JSON.parse(localStorage.getItem(LS_KEY)).accounts.qa_alpha.hash"), true);
  });

  await test('AI works from a file URL through the local bridge, including models and both protocols', async () => {
    const calls = [];
    aiUpstream = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ url: req.url, body });
      // No CORS headers: this reproduces the actual provider's browser restriction.
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/models')) {
        res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'other-model' }, { id: 'test-model' }] }));
      } else if (req.url.includes('/auth/')) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { message: 'Invalid qa-ai-key' } }));
      } else if (req.url.includes('/root/v1/') || (req.url.includes('/responses/') && req.url.endsWith('/chat/completions'))) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: { message: 'Unsupported endpoint' } }));
      } else if (req.url.endsWith('/responses')) {
        if (req.url.includes('/stream/')) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.end('data: {"type":"response.output_text.delta","delta":"Stream result"}\n\ndata: [DONE]\n\n');
        } else {
          res.end(JSON.stringify({ output: [{ type: 'reasoning', summary: [] },
            { type: 'message', content: [{ type: 'output_text', text: 'Responses result' }] }] }));
        }
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: 'Chat result' } }] }));
      }
    });
    aiBridge = createBridge();
    aiUpstream.listen(0, '127.0.0.1');
    aiBridge.listen(0, '127.0.0.1');
    await Promise.all([once(aiUpstream, 'listening'), once(aiBridge, 'listening')]);
    const bridgeBase = `http://127.0.0.1:${aiBridge.address().port}`;
    const apiBase = `http://127.0.0.1:${aiUpstream.address().port}`;
    await withFreshDevice(async () => {
      await evaluate(`window.qaRealFetch = fetch; window.fetch = (url, init) => qaRealFetch(
        String(url).replace('http://127.0.0.1:17654', ${JSON.stringify(bridgeBase)}), init);
        window.qaBridgeFetch = window.fetch`);
      await register('qa_ai');
      await navigate('settings');
      await fill([['#ai-base', apiBase + '/responses/v1'], ['#ai-key', 'qa-ai-key'], ['#ai-model', 'test-model']]);
      await click('#btn-ai-models');
      await waitFor(() => evaluate("!document.querySelector('#btn-ai-models').disabled"), 'AI model list');
      assert.equal(await evaluate("document.querySelector('#ai-model-list-field').hidden"), false);
      assert.equal(await evaluate("document.querySelector('#ai-model-list').options.length"), 3);
      for (const width of [1440, 390]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
        await evaluate("document.querySelector('#ai-base').closest('section').scrollIntoView({ block:'start' })");
        await capture(`ai-settings-${width}`);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, `AI settings at ${width}px`);
        assert.equal(await evaluate(`['ai-base','ai-key','ai-model','btn-ai-models','ai-model-list','ai-protocol','ai-transport','btn-ai-start'].every(id => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
        })`), true, `AI controls at ${width}px`);
      }
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await fill([['#ai-model-list', 'other-model']]);
      assert.equal(await evaluate("document.querySelector('#ai-model').value"), 'other-model');
      await click('#btn-ai-test');
      await waitFor(() => evaluate("!document.querySelector('#btn-ai-test').disabled"), 'Responses connection test');
      assert.match(await evaluate("document.querySelector('#ai-test-status').textContent"), /Responses result/);
      const attempts = calls.filter(call => !call.url.endsWith('/models'));
      assert.deepEqual(attempts.map(call => call.url), ['/responses/v1/chat/completions', '/responses/v1/responses']);
      assert.equal(attempts[1].body.model, 'other-model');
      assert.equal(attempts[1].body.temperature, undefined);
      assert.equal(attempts[1].body.store, false);
      for (const [base, protocol, expected] of [
        ['/chat/v1/chat/completions', 'auto', 'Chat result'],
        ['/root/v1', 'chat', 'Chat result'],
        ['/stream/v1/responses', 'auto', 'Stream result']
      ]) {
        await fill([['#ai-base', apiBase + base], ['#ai-protocol', protocol]]);
        await click('#btn-ai-test');
        await waitFor(() => evaluate("!document.querySelector('#btn-ai-test').disabled"), 'AI endpoint compatibility');
        assert.match(await evaluate("document.querySelector('#ai-test-status').textContent"), new RegExp(expected));
      }
      const beforeAuth = calls.length;
      await fill([['#ai-base', apiBase + '/auth/v1'], ['#ai-protocol', 'auto']]);
      await click('#btn-ai-test');
      await waitFor(() => evaluate("!document.querySelector('#btn-ai-test').disabled"), 'authentication error');
      const error = await evaluate("document.querySelector('#ai-test-status').textContent");
      assert.match(error, /HTTP 401/);
      assert.equal(error.includes('qa-ai-key'), false);
      assert.equal(calls.length - beforeAuth, 1, 'Do not retry authorization failures');
      await fill([['#ai-base', apiBase + '/responses/v1'], ['#ai-protocol', 'responses'], ['#ai-transport', 'local']]);
      await click('#ai-toggle');
      await click('#btn-ai-save');
      assert.equal(await evaluate('currentSettings().ai.protocol'), 'responses');
      assert.equal(await evaluate('currentSettings().ai.transport'), 'local');
      await navigate('daily');
      await fill([['#f-content', 'AI report source']]);
      await click('#btn-add');
      await navigate('weekly');
      await click('#w-ai');
      await waitFor(() => evaluate("document.querySelector('#w-report').textContent === 'Responses result'"), 'weekly AI report');
      await click('#w-toggle');
      assert.match(await evaluate("document.querySelector('#w-report').textContent"), /AI report source/);
      await navigate('monthly');
      await click('#mm-ai');
      await waitFor(() => evaluate("document.querySelector('#mm-report').textContent === 'Responses result'"), 'monthly AI report');
      await navigate('settings');
      await evaluate(`window.qaAiOnline = false;
        window.qaAiLaunches = 0;
        window.qaAiDropNextRequest = false;
        window.aiOpenLauncher = () => {
          qaAiLaunches++;
          setTimeout(() => { qaAiOnline = true; }, 80);
        };
        window.fetch = (url, init) => {
          if (String(url).startsWith('http://127.0.0.1:17654')) {
            if (qaAiOnline && qaAiDropNextRequest && String(url).endsWith('/request')) {
              qaAiDropNextRequest = false;
              qaAiOnline = false;
            }
            if (!qaAiOnline) return Promise.reject(new TypeError('offline'));
          }
          return qaBridgeFetch(url, init);
        };
        refreshAIServiceStatus()`);
      assert.equal(await evaluate("document.querySelector('#btn-ai-start').disabled"), false);
      await click('#btn-ai-start');
      await waitFor(() => evaluate("document.querySelector('#ai-service-status').textContent.includes('\\u5df2\\u5c31\\u7eea')"), 'web AI service launch');
      assert.equal(await evaluate('qaAiLaunches'), 1);
      await evaluate('qaAiOnline = false');
      await click('#btn-ai-test');
      await waitFor(() => evaluate("!document.querySelector('#btn-ai-test').disabled"), 'missing bridge error');
      assert.equal(await evaluate("!!document.querySelector('#ai-launch-confirm')"), true);
      await click('#ai-launch-cancel');
      assert.equal(await evaluate('qaAiLaunches'), 1, 'Cancel must not launch a native application');
      await click('#btn-ai-test');
      await waitFor(() => evaluate("!!document.querySelector('#ai-launch-confirm')"), 'start and resume dialog');
      await click('#ai-launch-confirm');
      await waitFor(() => evaluate("document.querySelector('#ai-test-status').textContent.includes('Responses result')"), 'automatic connection retry');
      assert.equal(await evaluate('qaAiLaunches'), 2);
      await evaluate('qaAiOnline = false');
      await click('#btn-ai-models');
      await waitFor(() => evaluate("!!document.querySelector('#ai-launch-confirm')"), 'model list startup dialog');
      await click('#ai-launch-confirm');
      await waitFor(() => evaluate("!document.querySelector('#ai-model-list-field').hidden"), 'automatic model list retry');
      assert.equal(await evaluate('qaAiLaunches'), 3);
      await navigate('weekly');
      await evaluate('qaAiOnline = false');
      await click('#w-ai');
      await waitFor(() => evaluate("!!document.querySelector('#ai-launch-confirm')"), 'report startup dialog');
      await click('#ai-launch-confirm');
      await waitFor(() => evaluate("!document.querySelector('#ai-launch-confirm') && !document.querySelector('#w-ai').disabled"), 'automatic report retry');
      assert.equal(await evaluate("document.querySelector('#w-report').textContent"), 'Responses result');
      assert.equal(await evaluate('qaAiLaunches'), 4);
      await navigate('settings');
      await evaluate('qaAiDropNextRequest = true');
      await click('#btn-ai-test');
      await waitFor(() => evaluate("!document.querySelector('#btn-ai-test').disabled"), 'bridge stops after health check');
      assert.equal(await evaluate("!!document.querySelector('#ai-launch-confirm')"), true,
        'A bridge that stops after health succeeds must offer to restart');
      await click('#ai-launch-confirm');
      await waitFor(() => evaluate("!document.querySelector('#ai-launch-confirm') && !document.querySelector('#btn-ai-test').disabled"), 'restart interrupted bridge and retry');
      assert.match(await evaluate("document.querySelector('#ai-test-status').textContent"), /Responses result/);
      assert.equal(await evaluate('qaAiLaunches'), 5);
      const launchError = await evaluate(`(async () => {
        qaAiOnline = false;
        window.aiOpenLauncher = () => { qaAiLaunches++; };
        try { await aiStartBridge(350); return ''; } catch(error) { return error.message; }
      })()`);
      assert.match(launchError, /首次使用/);
      assert.equal(await evaluate('aiBridgeStartTask'), null, 'Failed startup must allow another attempt');
      await navigate('settings');
      await fill([['#ai-transport', 'direct']]);
      await evaluate("window.fetch = () => Promise.reject(new TypeError('offline'))");
      await click('#btn-ai-test');
      await waitFor(() => evaluate("!document.querySelector('#btn-ai-test').disabled"), 'direct connection error');
      assert.equal(await evaluate("!!document.querySelector('#ai-launch-confirm')"), false, 'Direct mode must not start native software');
    });
    await Promise.all([new Promise(resolve => aiBridge.close(resolve)), new Promise(resolve => aiUpstream.close(resolve))]);
    aiBridge = aiUpstream = null;
  });

  await test('old browser drafts migrate into the unified personal JSON', async () => {
    await evaluate(`(() => {
      const settings = currentSettings();
      delete settings.draft; delete settings.draftUpdatedAt;
      saveLS();
      localStorage.setItem(dailyDraftKey(), JSON.stringify({
        date:todayStr(), category:CATEGORIES[0], content:'Old browser-only draft'
      }));
    })()`);
    await reload();
    assert.equal(await evaluate('personalBlob().settings.users.qa_alpha.draft.content'), 'Old browser-only draft');
    await evaluate("clearDailyDraft(); persistUserState(); buildDaily()");
  });

  await test('empty weekly reports support navigation and custom dates', async () => {
    await navigate('weekly');
    for (const action of ['w-prev', 'w-next', 'w-now']) await click(`[data-nav="${action}"]`);
    await fill([['#wr-start', '2025-01-01'], ['#wr-end', '2025-01-07']]);
    await click('[data-nav="wr-apply"]');
    await click('[data-nav="w-prev"]');
    await click('[data-nav="w-next"]');
    assert.equal(await evaluate("!!document.querySelector('#view-root .empty')"), true);
    assert.equal(await evaluate("document.querySelector('#wr-start').value"), '2025-01-01');
  });

  await test('empty monthly reports support month and year boundaries', async () => {
    await navigate('monthly');
    await fill([['#m-month', '2025-01']]);
    await click('[data-nav="m-prev"]');
    assert.equal(await evaluate("document.querySelector('#m-month').value"), '2024-12');
    await click('[data-nav="m-next"]');
    await click('[data-nav="m-now"]');
    assert.equal(await evaluate("!!document.querySelector('#view-root .empty')"), true);
  });

  await test('draft fields survive navigation and reload', async () => {
    await navigate('daily');
    const today = await evaluate('todayStr()');
    const expected = [today, 'QA project', '\u6d4b\u8bd5', '2.5', 'Draft survives'];
    await fill(['f-date', 'f-project', 'f-category', 'f-hours', 'f-content'].map((id, index) => [`#${id}`, expected[index]]));
    await click('#f-status button:nth-child(2)');
    await waitFor(() => evaluate("JSON.parse(localStorage.getItem(dailyDraftKey())).status === segVal('f-status')"), 'draft status');
    for (const view of ['weekly', 'monthly', 'settings']) {
      await navigate(view);
      await navigate('daily');
      assert.deepEqual(await evaluate("['f-date','f-project','f-category','f-hours','f-content'].map(id => document.getElementById(id).value)"), expected);
    }
    await reload();
    assert.equal(await evaluate("document.querySelector('#f-content').value"), 'Draft survives');
    assert.equal(await evaluate("document.querySelector('#f-status button:nth-child(2)').classList.contains('active')"), true);
  });

  await test('accounts keep separate drafts and records', async () => {
    await logout();
    await click('#auth-tabs button[data-tab="register"]');
    await register('qa_beta');
    assert.equal(await evaluate("document.querySelector('#f-content').value"), '');
    await fill([['#f-content', 'Beta draft']]);
    await logout();
    await login('qa_alpha');
    assert.equal(await evaluate("document.querySelector('#f-content').value"), 'Draft survives');
    await click('#btn-add');
    assert.equal(await evaluate('localStorage.getItem(dailyDraftKey())'), null);
    await reload();
    assert.equal(await evaluate('myRecords().length'), 1);
    assert.equal(await evaluate("document.querySelector('#f-content').value"), '');
  });

  await test('weekly editing and deleting the last record render correctly', async () => {
    await navigate('weekly');
    assert.match(await evaluate("document.querySelector('#w-report').textContent"), /Draft survives/);
    await click('[data-act="edit"]');
    await fill([['#m-content', 'Edited report record']]);
    await click('#m-save');
    assert.match(await evaluate("document.querySelector('#w-report').textContent"), /Edited report record/);
    await click('[data-act="del"]');
    await click('#confirm-ok');
    assert.equal(await evaluate("!!document.querySelector('#view-root .empty')"), true);
  });

  await test('monthly report modes and deleting the last record work', async () => {
    await navigate('daily');
    await fill([['#f-content', 'Monthly report record']]);
    await click('#btn-add');
    await navigate('monthly');
    await click('#m-mode button:nth-child(2)');
    assert.match(await evaluate("document.querySelector('#mm-report').textContent"), /Monthly report record/);
    await click('#m-mode button:first-child');
    await click('[data-act="del"]');
    await click('#confirm-ok');
    assert.equal(await evaluate("!!document.querySelector('#view-root .empty')"), true);
    await navigate('daily');
    await fill([['#f-content', 'Persistent backup record']]);
    await click('#btn-add');
  });

  await test('custom categories can be temporary or saved to the current account', async () => {
    assert.equal(await evaluate("Array.from(document.querySelector('#f-category').options).some(option => option.value === 'BUG \\u4fee\\u590d')"), true);
    for (const [name, remember] of [['One-off category', false], ['My category', true]]) {
      await fill([['#f-category', '\u5176\u4ed6'], ['#f-category-name', name], ['#f-content', `Record for ${name}`]]);
      if (remember) await click('#f-category-remember');
      await click('#btn-add');
      assert.equal(await evaluate('myRecords().at(-1).category'), name);
      assert.equal(await evaluate(`currentSettings().categories.includes(${JSON.stringify(name)})`), remember);
      assert.equal(await evaluate(`Array.from(document.querySelector('#filter-category').options).some(option => option.value === ${JSON.stringify(name)})`), true);
      const id = await evaluate('myRecords().at(-1).id');
      await click(`[data-id="${id}"] [data-act="del"]`);
      await click('#confirm-ok');
    }
    await navigate('settings');
    assert.match(await evaluate("document.querySelector('#my-categories-list').textContent"), /My category/);
    await navigate('daily');
    assert.equal(await evaluate("Array.from(document.querySelector('#f-category').options).some(option => option.value === 'My category')"), true);
    assert.equal(await evaluate("Array.from(document.querySelector('#f-category').options).some(option => option.value === 'One-off category')"), false);
    assert.equal(await evaluate('myRecords().length'), 1);
  });

  await test('saved categories do not appear in another account', async () => {
    await logout();
    await login('qa_beta');
    assert.equal(await evaluate("currentSettings().categories.includes('My category')"), false);
    assert.equal(await evaluate("Array.from(document.querySelector('#f-category').options).some(option => option.value === 'My category')"), false);
    assert.deepEqual(await evaluate('Object.keys(personalBlob().accounts)'), ['qa_beta']);
    await logout();
    await login('qa_alpha');
    assert.equal(await evaluate("currentSettings().categories.includes('My category')"), true);
  });

  await test('editing supports custom categories and preserves historical filtering', async () => {
    await click('[data-act="edit"]');
    await fill([['#m-category', '\u5176\u4ed6'], ['#m-category-name', 'Edited category']]);
    await click('#m-save');
    assert.equal(await evaluate('myRecords()[0].category'), 'Edited category');
    await click('[data-act="edit"]');
    assert.equal(await evaluate("document.querySelector('#m-category').value"), 'Edited category');
    await click('#m-cancel');
    assert.equal(await evaluate("Array.from(document.querySelector('#filter-category').options).some(option => option.value === 'Edited category')"), true);
  });

  await test('removing a saved category preserves existing records and their filter', async () => {
    await click('[data-act="edit"]');
    await fill([['#m-category', '\u5176\u4ed6'], ['#m-category-name', 'Removable personal category']]);
    await click('#m-category-remember');
    await click('#m-save');
    await navigate('settings');
    await click('[data-remove-category="Removable personal category"]');
    assert.equal(await evaluate("currentSettings().categories.includes('Removable personal category')"), false);
    await navigate('daily');
    assert.equal(await evaluate('myRecords()[0].category'), 'Removable personal category');
    assert.equal(await evaluate("Array.from(document.querySelector('#f-category').options).some(option => option.value === 'Removable personal category')"), false);
    assert.equal(await evaluate("Array.from(document.querySelector('#filter-category').options).some(option => option.value === 'Removable personal category')"), true);
  });

  await test('JSON binding and automatic writes preserve accounts and records', async () => {
    await navigate('settings');
    await installFileHandle();
    await click('#btn-file-new');
    await waitFor(() => evaluate("!!document.querySelector('#btn-file-unbind')"), 'binding');
    assert.equal(await evaluate('JSON.parse(qaFile.data).records.qa_alpha.length'), 1);
    assert.deepEqual(await evaluate('Object.keys(JSON.parse(qaFile.data).accounts)'), ['qa_alpha']);
    assert.deepEqual(await evaluate('Object.keys(JSON.parse(qaFile.data).settings.users)'), ['qa_alpha']);
    assert.equal(await evaluate("!!document.querySelector('#ds-status .green')"), true);
    await navigate('daily');
    await fill([['#f-content', 'Automatically saved record']]);
    await click('#btn-add');
    await waitFor(() => evaluate('JSON.parse(qaFile.data).records.qa_alpha.length === 2'), 'automatic write');
  });

  await test('switching accounts restores separate JSON bindings without leaking data', async () => {
    await evaluate('window.qaAlphaFile = qaFile; window.qaAlphaHandle = qaHandle');
    await logout();
    await login('qa_beta');
    assert.equal(await evaluate('fileHandle'), null);
    await installFileHandle();
    await navigate('settings');
    await click('#btn-file-new');
    await waitFor(() => evaluate('fileConnected'), 'beta file binding');
    assert.deepEqual(await evaluate('Object.keys(JSON.parse(qaFile.data).accounts)'), ['qa_beta']);
    await logout();
    await login('qa_alpha');
    assert.equal(await evaluate('fileHandle === qaAlphaHandle && fileOwner === "qa_alpha" && fileConnected'), true);
    assert.deepEqual(await evaluate('Object.keys(JSON.parse(qaAlphaFile.data).accounts)'), ['qa_alpha']);
    await evaluate(`window.qaFile = qaAlphaFile; window.qaHandle = qaAlphaHandle;
      window.showSaveFilePicker = async () => qaHandle; window.showOpenFilePicker = async () => [qaHandle]`);
  });

  await test('unbind and existing-file binding update the status controls', async () => {
    await navigate('settings');
    await click('#btn-file-unbind');
    await waitFor(() => evaluate('fileHandle === null'), 'unbind');
    assert.equal(await evaluate("!!document.querySelector('#btn-file-unbind')"), false);
    await click('#btn-file-open');
    await waitFor(() => evaluate('fileConnected && !!document.querySelector("#btn-file-unbind")'), 'existing-file binding');
    assert.equal(await evaluate("!!document.querySelector('#ds-status .green')"), true);
  });

  await test('failed writes keep the reconnect warning and never claim success', async () => {
    await evaluate("qaFile.fail = true; qaFile.data = ''; clearTimeout(fwTimer); document.querySelector('#toast-root').innerHTML = ''");
    await click('#btn-file-new');
    await waitFor(() => evaluate('!fileConnected && !!document.querySelector("#ds-reconnect")'), 'failed binding');
    assert.equal(await evaluate("document.querySelector('#toast-root').textContent.includes('Injected write failure')"), true);
    assert.equal(await evaluate("document.querySelector('#toast-root').textContent.includes('\\u5df2\\u7ed1\\u5b9a')"), false);
    assert.equal(await evaluate("!!document.querySelector('#bn-reconnect')"), true);
    await click('#ds-reconnect');
    await waitFor(() => evaluate('!fileConnected && !!document.querySelector("#ds-reconnect")'), 'failed reconnection');
    assert.equal(await evaluate("document.querySelector('#toast-root').textContent.includes('\\u5df2\\u91cd\\u65b0\\u8fde\\u63a5')"), false);
    await evaluate("qaFile.fail = false; qaFile.data = ''");
    await click('#ds-reconnect');
    await waitFor(() => evaluate('fileConnected && !!document.querySelector("#ds-status .green")'), 'reconnection');
    assert.equal(await evaluate('JSON.parse(qaFile.data).records.qa_alpha.length'), 2);
    await evaluate("qaFile.fail = true; currentAccount().displayName = 'Changed while file unavailable'; currentAccount().updatedAt = Date.now(); commit()");
    await waitFor(() => evaluate('!fileConnected'), 'automatic write failure');
    assert.equal(await evaluate("!!document.querySelector('#ds-reconnect')"), true);
    await click('#btn-file-unbind');
    await waitFor(() => evaluate('fileHandle === null'), 'unbind failed file');
  });

  await test('export downloads valid JSON and preserves unsaved settings', async () => {
    await fill([['#ai-base', 'https://pending.example/v1'], ['#ai-model', 'unsaved-model']]);
    await click('#btn-export');
    await waitFor(async () => fs.readdirSync(downloads).some(name => name.endsWith('.json')), 'backup download');
    const filename = fs.readdirSync(downloads).find(name => name.endsWith('.json'));
    const backup = JSON.parse(fs.readFileSync(path.join(downloads, filename), 'utf8'));
    assert.equal(backup.records.qa_alpha.length, 2);
    assert.ok(backup.accounts.qa_alpha.hash);
    assert.deepEqual(Object.keys(backup.accounts), ['qa_alpha']);
    assert.deepEqual(Object.keys(backup.settings.users), ['qa_alpha']);
    assert.ok(backup.settings.users.qa_alpha.categories.includes('My category'));
    assert.equal(backup.settings.session, null);
    assert.equal(await evaluate("document.querySelector('#ai-model').value"), 'unsaved-model');
    assert.equal(await evaluate("document.querySelector('#last-export').textContent === lastExportText()"), true);
    assert.ok(await evaluate('JSON.parse(localStorage.getItem(LS_KEY)).settings.lastExportAt'));
  });

  let portableSnapshot;
  await test('personal JSON includes account, preferences, categories and unsaved drafts', async () => {
    await fill([['#ai-base', 'https://example.invalid/v1'], ['#ai-model', 'portable-model'], ['#ai-key', 'qa-fake-key']]);
    await click('#btn-ai-save');
    await click('#s-theme button[data-v="dark"]');
    await navigate('daily');
    await fill([['#f-category', '\u5176\u4ed6'], ['#f-category-name', 'Portable draft category'], ['#f-content', 'Draft for another computer']]);
    await click('#f-category-remember');
    portableSnapshot = await evaluate('personalBlob()');
    assert.ok(portableSnapshot.accounts.qa_alpha.hash);
    assert.ok(portableSnapshot.accounts.qa_alpha.salt);
    assert.equal(portableSnapshot.accounts.qa_alpha.password, undefined);
    assert.equal(portableSnapshot.settings.users.qa_alpha.draft.content, 'Draft for another computer');
    assert.equal(portableSnapshot.settings.users.qa_alpha.draft.customCategory, 'Portable draft category');
    assert.equal(portableSnapshot.settings.users.qa_alpha.ai.model, 'portable-model');
    assert.equal(portableSnapshot.settings.users.qa_alpha.theme, 'dark');
    assert.equal(portableSnapshot.records.qa_alpha.length, 2);
  });

  await test('a fresh computer imports before login and requires the original password', async () => {
    await withFreshDevice(async () => {
      assert.equal(await evaluate('Object.keys(blob.accounts).length'), 0);
      await capture('login-import');
      assert.equal(await evaluate("document.querySelector('#auth-import').hidden"), false);
      await importData(portableSnapshot);
      await click('#imp-merge');
      assert.equal(await evaluate('currentUser'), null);
      assert.equal(await evaluate("document.querySelector('#login-user').value"), 'qa_alpha');
      await fill([['#login-pass', 'wrong-password']]);
      await evaluate("document.querySelector('#login-form').requestSubmit()");
      await waitFor(() => evaluate("document.querySelector('#toast-root').textContent.includes('\\u5bc6\\u7801\\u9519\\u8bef')"), 'password rejection');
      assert.equal(await evaluate('currentUser'), null);
      await login('qa_alpha');
      assert.equal(await evaluate('myRecords().length'), 2);
      assert.equal(await evaluate("currentSettings().categories.includes('My category')"), true);
      assert.equal(await evaluate("document.querySelector('#f-content').value"), 'Draft for another computer');
      assert.equal(await evaluate("document.querySelector('#f-category-name').value"), 'Portable draft category');
      assert.equal(await evaluate("document.querySelector('#f-category-remember').checked"), true);
      assert.equal(await evaluate('currentSettings().ai.model'), 'portable-model');
      assert.equal(await evaluate("document.documentElement.classList.contains('dark')"), true);
    });
  });

  await test('a fresh computer can bind its existing JSON directly from the login screen', async () => {
    await withFreshDevice(async () => {
      await installFileHandle(portableSnapshot);
      await click('#auth-open');
      await waitFor(() => evaluate('!!blob.accounts.qa_alpha'), 'account restore');
      assert.equal(await evaluate('currentUser'), null);
      await login('qa_alpha');
      assert.equal(await evaluate('fileConnected && fileOwner === "qa_alpha"'), true);
      assert.deepEqual(await evaluate('Object.keys(JSON.parse(qaFile.data).accounts)'), ['qa_alpha']);
    });
    await navigate('settings');
  });

  await test('legacy JSON import normalizes accounts, deduplicates and updates', async () => {
    const data = await evaluate(`({
      backup: {
        accounts: { ' LegacyUser ': { ...blob.accounts.qa_alpha, name: 'LegacyUser' } },
        records: { ' LegacyUser ': [{
          date: todayStr(), content: 'Legacy record', project: 'Imported',
          category: CATEGORIES[0], status: '\\u5df2\\u5b8c\\u6210', createdAt: 123
        }] },
        settings: { users: { ' LegacyUser ': { marker: 'kept' } } }
      }
    })`);
    for (let index = 0; index < 2; index++) {
      await importData(data);
      await click('#imp-merge');
    }
    assert.equal(await evaluate('blob.records.legacyuser.length'), 1);
    assert.equal(await evaluate('blob.settings.users.legacyuser.marker'), 'kept');
    const update = await evaluate("({ accounts: {}, records: { legacyuser: [{ ...blob.records.legacyuser[0], content: 'Updated legacy record', updatedAt: 999 }] } })");
    await importData(update);
    await click('#imp-merge');
    assert.equal(await evaluate('blob.records.legacyuser.length'), 1);
    assert.equal(await evaluate('blob.records.legacyuser[0].content'), 'Updated legacy record');
    assert.equal(await evaluate(`[null, [], {}, {accounts: []}, {accounts: {}, records: []}].every(data => {
      try { normalizeImportData(data); return false; } catch { return true; }
    })`), true);
  });

  await test('replacement import refreshes the active account', async () => {
    const data = await evaluate("({ accounts: { qa_alpha: blob.accounts.qa_alpha }, records: { qa_alpha: myRecords() }, settings: { theme: 'dark', lastUser: 'qa_alpha', users: {} } })");
    await importData(data);
    await click('#imp-replace');
    await click('#confirm-ok');
    assert.equal(await evaluate('currentUser'), 'qa_alpha');
    assert.equal(await evaluate('view'), 'daily');
    assert.equal(await evaluate('myRecords().length'), 2);
    assert.equal(await evaluate("document.documentElement.classList.contains('dark')"), true);
  });

  await test('startup restores browser data before initializing an empty bound file', async () => {
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      document.addEventListener('DOMContentLoaded', () => {
        window.qaStartupWrites = [];
        window.idbGet = async () => ({
          name: 'empty-data.json',
          async queryPermission() { return 'granted'; },
          async getFile() { return new File([''], 'empty-data.json'); },
          async createWritable() {
            return {
              async write(data) { qaStartupWrites.push(JSON.parse(data)); },
              async close() {}
            };
          }
        });
      }, { once: true });
    ` });
    await reload();
    await waitFor(() => evaluate('window.qaStartupWrites?.length > 0'), 'startup file write');
    assert.equal(await evaluate('qaStartupWrites[0].records.qa_alpha.length'), 2);
    assert.equal(await evaluate('qaStartupWrites[0].accounts.qa_alpha.name'), 'qa_alpha');
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await evaluate('clearTimeout(fwTimer); fileHandle = null; fileConnected = false');
  });

  await test('two devices retain independent new records when the shared JSON changes', async () => {
    const snapshot = await evaluate('personalBlob()');
    await installFileHandle(snapshot);
    await navigate('settings');
    await click('#btn-file-open');
    await waitFor(() => evaluate('fileConnected'), 'sync file binding');
    const remote = await withFreshDevice(async () => {
      await installFileHandle(snapshot);
      await click('#auth-open');
      await waitFor(() => evaluate('!!blob.accounts.qa_alpha'), 'remote account');
      await login('qa_alpha');
      await fill([['#f-content', 'Record added on the other computer']]);
      await click('#btn-add');
      assert.equal(await evaluate('writeToFileNow()'), true);
      return evaluate('JSON.parse(qaFile.data)');
    });
    await navigate('daily');
    await fill([['#f-content', 'Record added on this computer']]);
    await click('#btn-add');
    assert.equal(await evaluate(`(async () => {
      clearTimeout(fwTimer);
      qaFile.data = ${JSON.stringify(JSON.stringify(remote))};
      return syncFromFile();
    })()`), true);
    assert.equal(await evaluate("myRecords().some(record => record.content === 'Record added on the other computer')"), true);
    assert.equal(await evaluate("myRecords().some(record => record.content === 'Record added on this computer')"), true);
    assert.equal(await evaluate('JSON.parse(qaFile.data).records.qa_alpha.length'), 4);
  });

  await test('changed preferences, custom categories and drafts synchronize between devices', async () => {
    const snapshot = await evaluate('personalBlob()');
    const remote = await withFreshDevice(async () => {
      await installFileHandle(snapshot);
      await click('#auth-open');
      await waitFor(() => evaluate('!!blob.accounts.qa_alpha'), 'remote account');
      await login('qa_alpha');
      await click('[data-act="edit"]');
      await fill([['#m-category', '\u5176\u4ed6'], ['#m-category-name', 'Category from another device']]);
      await click('#m-category-remember');
      await click('#m-save');
      await navigate('settings');
      await fill([['#ai-model', 'model-from-another-device']]);
      await click('#btn-ai-save');
      await click('#s-theme button[data-v="light"]');
      await navigate('daily');
      await fill([['#f-content', 'Unfinished draft from another device']]);
      assert.equal(await evaluate('writeToFileNow()'), true);
      return evaluate('JSON.parse(qaFile.data)');
    });
    assert.equal(await evaluate(`(async () => {
      qaFile.data = ${JSON.stringify(JSON.stringify(remote))};
      return syncFromFile();
    })()`), true);
    assert.equal(await evaluate("currentSettings().categories.includes('Category from another device')"), true);
    assert.equal(await evaluate('currentSettings().ai.model'), 'model-from-another-device');
    assert.equal(await evaluate('currentTheme()'), 'light');
    assert.equal(await evaluate("document.querySelector('#f-content').value"), 'Unfinished draft from another device');
  });

  await test('remote deletions propagate and stale files cannot resurrect deleted records', async () => {
    const snapshot = await evaluate('personalBlob()');
    const removed = snapshot.records.qa_alpha[0].id;
    const remote = await withFreshDevice(async () => {
      await installFileHandle(snapshot);
      await click('#auth-open');
      await waitFor(() => evaluate('!!blob.accounts.qa_alpha'), 'remote account');
      await login('qa_alpha');
      await click(`[data-id="${removed}"] [data-act="del"]`);
      await click('#confirm-ok');
      assert.equal(await evaluate('writeToFileNow()'), true);
      return evaluate('JSON.parse(qaFile.data)');
    });
    for (const data of [remote, snapshot]) {
      assert.equal(await evaluate(`(async () => {
        qaFile.data = ${JSON.stringify(JSON.stringify(data))};
        return syncFromFile();
      })()`), true);
      assert.equal(await evaluate(`myRecords().some(record => record.id === ${JSON.stringify(removed)})`), false);
      assert.equal(await evaluate(`JSON.parse(qaFile.data).records.qa_alpha.some(record => record.id === ${JSON.stringify(removed)})`), false);
    }
  });

  await test('returning to the window automatically loads external file updates', async () => {
    await evaluate(`(() => {
      const data = personalBlob();
      data.records.qa_alpha.push({
        id:'focus-arrival', date:todayStr(), content:'Arrived through file synchronization',
        project:'Synced', category:CATEGORIES[0], status:'\\u5df2\\u5b8c\\u6210',
        createdAt:Date.now(), updatedAt:Date.now()
      });
      qaFile.data = JSON.stringify(data);
      window.dispatchEvent(new Event('focus'));
    })()`);
    await waitFor(() => evaluate("myRecords().some(record => record.id === 'focus-arrival')"), 'focus synchronization');
  });

  await test('malformed and foreign-account files are never overwritten', async () => {
    const valid = await evaluate('qaFile.data');
    const foreign = await evaluate(`({
      accounts:{ someone_else:{ ...currentAccount(), name:'someone_else' } },
      records:{ someone_else:[] }, settings:{ users:{} }
    })`);
    for (const data of ['{ broken JSON', JSON.stringify(foreign)]) {
      const result = await evaluate(`(async () => {
        qaFile.data = ${JSON.stringify(data)};
        fileConnected = true;
        return syncFromFile();
      })()`);
      assert.equal(result, false);
      assert.equal(await evaluate('qaFile.data'), data);
      assert.equal(await evaluate('fileConnected'), false);
      assert.ok(await evaluate('myRecords().length > 0'));
    }
    await evaluate(`qaFile.data = ${JSON.stringify(valid)}`);
    await evaluate('reconnectFile()');
    assert.equal(await evaluate('fileConnected'), true);
  });

  await test('read-only files require write permission before binding', async () => {
    await navigate('settings');
    await click('#btn-file-unbind');
    await waitFor(() => evaluate('fileHandle === null'), 'unbind before permission test');
    await evaluate("qaFile.permission = 'denied'");
    await click('#btn-file-open');
    await waitFor(() => evaluate("document.querySelector('#toast-root').textContent.includes('\\u672a\\u83b7\\u5f97\\u6587\\u4ef6\\u8bfb\\u5199\\u6743\\u9650')"), 'permission denial');
    assert.equal(await evaluate('fileHandle'), null);
    await evaluate("qaFile.permission = 'granted'");
  });

  await test('legacy multi-account JSON retains other accounts while personal export stays isolated', async () => {
    const legacy = await evaluate(`(() => {
      const data = personalBlob();
      data.accounts.legacy_peer = { ...currentAccount(), name:'legacy_peer' };
      data.records.legacy_peer = [{
        id:'peer-record', date:todayStr(), content:'Keep this other account',
        category:CATEGORIES[0], createdAt:123, updatedAt:123
      }];
      data.settings.users.legacy_peer = { categories:['Private peer category'] };
      return data;
    })()`);
    await installFileHandle(legacy);
    await navigate('settings');
    await click('#btn-file-open');
    await waitFor(() => evaluate('fileConnected && fileLegacy'), 'legacy binding');
    const saved = await evaluate('JSON.parse(qaFile.data)');
    assert.deepEqual(saved.accounts.legacy_peer, legacy.accounts.legacy_peer);
    assert.deepEqual(saved.records.legacy_peer, legacy.records.legacy_peer);
    assert.deepEqual(await evaluate('Object.keys(personalBlob().accounts)'), ['qa_alpha']);
  });

  await test('replacement import stays replaced when an older bound file is merged', async () => {
    const data = await evaluate(`(() => {
      const data = personalBlob();
      data.records.qa_alpha = data.records.qa_alpha.slice(0, 1);
      data.settings.users.qa_alpha.categories = ['Replacement-only category'];
      data.settings.users.qa_alpha.updatedAt = 0;
      data.settings.users.qa_alpha.draft = null;
      return data;
    })()`);
    await importData(data);
    await click('#imp-replace');
    await click('#confirm-ok');
    assert.equal(await evaluate('writeToFileNow()'), true);
    assert.equal(await evaluate('myRecords().length'), 1);
    assert.deepEqual(await evaluate('currentSettings().categories'), ['Replacement-only category']);
    assert.equal(await evaluate('JSON.parse(qaFile.data).records.qa_alpha.length'), 1);
  });

  await test('all views fit desktop and mobile widths without runtime errors', async () => {
    for (const width of [1440, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
      for (const view of ['daily', 'weekly', 'monthly', 'settings']) {
        await navigate(view);
        if (view === 'daily') {
          await fill([['#f-category', '\u5176\u4ed6']]);
          await capture(`daily-${width}`);
          assert.equal(await evaluate("document.querySelector('#f-category-custom').hidden"), false);
        }
        if (view === 'settings') await capture(`settings-${width}`);
        assert.equal(await evaluate("document.querySelector('#view-root h1') !== null"), true, `${view} heading`);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, `${view} at ${width}px`);
      }
    }
  });
  console.log(`${passed} checks passed; no browser runtime errors. File pickers use simulated handles; export downloads a real JSON file.`);
} catch (error) {
  console.error('Browser errors:', errors);
  throw error;
} finally {
  if (aiBridge) await new Promise(resolve => aiBridge.close(resolve));
  if (aiUpstream) await new Promise(resolve => aiUpstream.close(resolve));
  if (socket?.readyState === WebSocket.OPEN) {
    await send('Browser.close', {}, null).catch(() => {});
    socket.close();
  }
  if (child.exitCode === null) await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null) { child.kill(); await Promise.race([exited, delay(3000)]); }
  for (const request of pending.values()) request.reject(new Error('Browser closed'));
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('gongji-regression-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
