import { getSettings, setSettings, DEFAULTS, PROVIDER_PRESETS, clearCache, cacheSize } from '../lib/store.js';
import { testConnection } from '../lib/llm.js';

const $ = (id) => document.getElementById(id);

const FIELDS = [
  'provider', 'baseUrl', 'apiKey', 'model', 'analysisModel', 'targetLang',
  'concurrency', 'batchChars', 'fontFamily', 'glossary', 'maxContextChars', 'customPrompt'
];
const CHECKS = ['autoOpenPdf', 'autoTranslate', 'translateRefs', 'cacheEnabled'];

function fillProviders(cur) {
  const sel = $('provider');
  sel.innerHTML = '';
  for (const key of Object.keys(PROVIDER_PRESETS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = PROVIDER_PRESETS[key].label;
    sel.appendChild(o);
  }
  sel.value = cur;
}

async function load() {
  const s = await getSettings();
  fillProviders(s.provider);
  for (const f of FIELDS) {
    const el = $(f);
    if (el && s[f] !== undefined && s[f] !== null) el.value = s[f];
  }
  for (const c of CHECKS) {
    const el = $(c);
    if (el) el.checked = s[c] === undefined ? !!DEFAULTS[c] : !!s[c];
  }
  refreshCacheInfo();
}

async function refreshCacheInfo() {
  const n = await cacheSize().catch(() => 0);
  $('cache-info').textContent = '已缓存 ' + n + ' 个译文片段';
}

function collect() {
  const patch = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    let v = el.value;
    if (el.type === 'number') v = Number(v);
    patch[f] = typeof v === 'string' ? v.trim() : v;
  }
  for (const c of CHECKS) {
    const el = $(c);
    if (el) patch[c] = el.checked;
  }
  return patch;
}

$('provider').addEventListener('change', (e) => {
  const p = PROVIDER_PRESETS[e.target.value];
  if (!p) return;
  if (p.baseUrl) $('baseUrl').value = p.baseUrl;
  if (p.model) $('model').value = p.model;
});

$('toggle-key').addEventListener('click', () => {
  const el = $('apiKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('toggle-key').textContent = show ? '隐藏' : '显示';
});

$('btn-save').addEventListener('click', async () => {
  await setSettings(collect());
  const r = $('save-result');
  r.textContent = '已保存 ✓';
  r.className = 'hint ok';
  chrome.runtime.sendMessage({ type: 'sync-rules' });
  setTimeout(() => { r.textContent = ''; }, 2500);
});

$('btn-test').addEventListener('click', async () => {
  const r = $('test-result');
  r.textContent = '测试中…';
  r.className = 'hint';
  const s = Object.assign(await getSettings(), collect());
  try {
    const out = await testConnection(s);
    r.textContent = '连接成功（' + out.ms + 'ms）：' + out.sample;
    r.className = 'hint ok';
  } catch (e) {
    r.textContent = '失败：' + e.message;
    r.className = 'hint err';
  }
});

$('btn-clear-cache').addEventListener('click', async () => {
  await clearCache();
  await refreshCacheInfo();
  const r = $('save-result');
  r.textContent = '缓存已清空';
  r.className = 'hint ok';
  setTimeout(() => { r.textContent = ''; }, 2000);
});

if (new URLSearchParams(location.search).has('welcome')) $('welcome').hidden = false;

load();
