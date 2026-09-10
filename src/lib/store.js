/* 设置读写 + 翻译缓存 (IndexedDB) */

export const PROVIDER_PRESETS = {
  openai:      { label: 'OpenAI',                 baseUrl: 'https://api.openai.com/v1',              model: 'gpt-4o-mini' },
  deepseek:    { label: 'DeepSeek',               baseUrl: 'https://api.deepseek.com/v1',            model: 'deepseek-chat' },
  moonshot:    { label: 'Kimi 开放平台 (按量付费)',  baseUrl: 'https://api.moonshot.cn/v1',             model: 'kimi-k2.6' },
  kimicode:    { label: 'Kimi 会员 (Kimi Code)',    baseUrl: 'https://api.kimi.com/coding/v1',         model: 'kimi-for-coding' },
  zhipu:       { label: '智谱 GLM',                baseUrl: 'https://open.bigmodel.cn/api/paas/v4',   model: 'glm-4-flash' },
  dashscope:   { label: '阿里云百炼 (通义千问)',      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  siliconflow: { label: 'SiliconFlow 硅基流动',     baseUrl: 'https://api.siliconflow.cn/v1',          model: 'Qwen/Qwen2.5-7B-Instruct' },
  openrouter:  { label: 'OpenRouter',             baseUrl: 'https://openrouter.ai/api/v1',           model: 'openai/gpt-4o-mini' },
  ollama:      { label: 'Ollama (本地)',           baseUrl: 'http://localhost:11434/v1',              model: 'qwen2.5:7b' },
  custom:      { label: '自定义 (OpenAI 兼容)',     baseUrl: '',                                       model: '' },
  anthropic:   { label: 'Anthropic Claude',       baseUrl: 'https://api.anthropic.com/v1',           model: 'claude-sonnet-5' },
  gemini:      { label: 'Google Gemini',          baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' }
};

/** provider 归类：除 anthropic / gemini 外都走 OpenAI 兼容协议 */
export function apiFlavor(provider) {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'gemini') return 'gemini';
  return 'openai';
}

export const DEFAULTS = {
  provider: 'deepseek',
  baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
  apiKey: '',
  model: PROVIDER_PRESETS.deepseek.model,
  // 解读/问答可用更强的模型；留空表示与翻译共用
  analysisModel: '',
  targetLang: '简体中文',
  temperature: 0.2,
  concurrency: 5,
  batchChars: 2200,
  autoOpenPdf: true,
  autoTranslate: false,
  translateRefs: false,       // 参考文献默认不翻译，省 token
  fontFamily: '',
  customPrompt: '',           // 附加的翻译要求
  glossary: '',               // 术语表：每行 "src=dst"
  cacheEnabled: true,
  maxContextChars: 90000
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULTS, settings || {});
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

/* ---------------- IndexedDB 缓存 ---------------- */

const DB_NAME = 'paperlens';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tcache')) db.createObjectStore('tcache');
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function hashKey(str) {
  // FNV-1a 32bit + 长度，冲突概率对本用途足够
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36) + '-' + str.length.toString(36);
}

export async function cacheGetMany(keys) {
  if (!keys.length) return new Map();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('tcache', 'readonly');
    const s = t.objectStore('tcache');
    const map = new Map();
    keys.forEach(k => {
      const r = s.get(k);
      r.onsuccess = () => { if (r.result !== undefined) map.set(k, r.result); };
    });
    t.oncomplete = () => resolve(map);
    t.onerror = () => reject(t.error);
  });
}

export async function cacheSetMany(entries) {
  if (!entries.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('tcache', 'readwrite');
    const s = t.objectStore('tcache');
    for (const [k, v] of entries) s.put(v, k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function clearCache() {
  await tx('tcache', 'readwrite', s => s.clear());
  await tx('docs', 'readwrite', s => s.clear());
}

export async function cacheSize() {
  const db = await openDB();
  return new Promise((resolve) => {
    const t = db.transaction('tcache', 'readonly');
    const r = t.objectStore('tcache').count();
    r.onsuccess = () => resolve(r.result);
    t.onerror = () => resolve(0);
  });
}

/* 文档级数据（解读结果、对话）持久化 */
export async function docGet(key) {
  const db = await openDB();
  return new Promise((resolve) => {
    const r = db.transaction('docs', 'readonly').objectStore('docs').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(undefined);
  });
}

export async function docSet(key, value) {
  return tx('docs', 'readwrite', s => s.put(value, key));
}
