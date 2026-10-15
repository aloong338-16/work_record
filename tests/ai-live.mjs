import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../ai-bridge.mjs';

// Optional, billable smoke test. The supplied personal JSON is read without modification.
const configFile = process.argv[2];
if (!configFile) throw new Error('Usage: node tests/ai-live.mjs <personal-json>');
const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const cfg = Object.values(data.settings?.users || {}).map(user => user.ai).find(ai => ai?.apiKey && ai?.baseUrl);
if (!cfg) throw new Error('The supplied JSON has no configured AI service.');
const root = fileURLToPath(new URL('../', import.meta.url));
const html = fs.readFileSync(path.join(root, fs.readdirSync(root).find(name => name.endsWith('.html'))), 'utf8');
const source = html.split('/* ========== AI 润色 ========== */')[1].split('/* ========== 设置页 ========== */')[0];
const bridge = createBridge();
bridge.listen(0, '127.0.0.1');
await once(bridge, 'listening');
const context = vm.createContext({
  URL, AbortSignal, AbortController, TypeError,
  fetch: (url, init) => {
    if (String(url).endsWith('/request')) {
      console.log('Request path: ' + new URL(JSON.parse(init.body).url).pathname);
    }
    return fetch(url, init);
  },
  cfg: { ...cfg, transport: 'local', protocol: process.argv[3] || 'auto' }
});
try {
  new vm.Script(source.replace('http://127.0.0.1:17654', `http://127.0.0.1:${bridge.address().port}`)).runInContext(context);
  const models = await vm.runInContext('aiModels(cfg)', context);
  console.log(`Models returned: ${models.length}; configured model present: ${models.includes(cfg.model)}`);
  const text = await vm.runInContext("aiChat(cfg, '请只回复两个字：正常', '你是连通性测试助手。')", context);
  console.log('AI response: ' + text.split(cfg.apiKey).join('[API Key]').slice(0, 100));
} catch (error) {
  console.error(String(error.message).split(cfg.apiKey).join('[API Key]'));
  process.exitCode = 1;
} finally {
  await new Promise(resolve => bridge.close(resolve));
}
