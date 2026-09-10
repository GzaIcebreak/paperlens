/* 统一的大模型调用层：OpenAI 兼容 / Anthropic / Gemini
 * 支持流式与非流式，统一错误信息。 */

import { apiFlavor } from './store.js';

function trimSlash(u) { return (u || '').replace(/\/+$/, ''); }

function endpoint(settings, stream) {
  const flavor = apiFlavor(settings.provider);
  const base = trimSlash(settings.baseUrl);
  if (flavor === 'anthropic') return base + '/messages';
  if (flavor === 'gemini') {
    const m = encodeURIComponent(settings.model);
    const method = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
    return `${base}/models/${m}:${method}key=${encodeURIComponent(settings.apiKey)}`;
  }
  return base + '/chat/completions';
}

function headers(settings) {
  const flavor = apiFlavor(settings.provider);
  const h = { 'Content-Type': 'application/json' };
  if (flavor === 'anthropic') {
    h['x-api-key'] = settings.apiKey;
    h['anthropic-version'] = '2023-06-01';
    // 允许从浏览器直连（否则 Anthropic 会拒绝带 CORS 的请求）
    h['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (flavor === 'openai') {
    if (settings.apiKey) h['Authorization'] = 'Bearer ' + settings.apiKey;
  }
  return h;
}

function body(settings, { system, messages, stream, maxTokens, temperature, model }) {
  const flavor = apiFlavor(settings.provider);
  const mdl = model || settings.model;
  const temp = temperature === undefined ? Number(settings.temperature ?? 0.2) : temperature;
  if (flavor === 'anthropic') {
    return {
      model: mdl,
      max_tokens: maxTokens || 8192,
      temperature: temp,
      system: system || undefined,
      messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      stream: !!stream
    };
  }
  if (flavor === 'gemini') {
    return {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: { temperature: temp, maxOutputTokens: maxTokens || 8192 }
    };
  }
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of messages) msgs.push(m);
  return { model: mdl, messages: msgs, temperature: temp, stream: !!stream, max_tokens: maxTokens || undefined };
}

async function readError(res) {
  let detail = '';
  try {
    const txt = await res.text();
    try {
      const j = JSON.parse(txt);
      detail = j.error?.message || j.message || j.error || txt;
    } catch { detail = txt; }
  } catch { /* ignore */ }
  detail = String(detail).slice(0, 400);
  return new Error(`请求失败 ${res.status} ${hintFor(res.status, detail)} ${detail}`);
}

/** 先看服务商返回的正文再看状态码：403 既可能是 Key 无权限，也可能只是额度用尽 */
export function hintFor(status, detail) {
  const d = String(detail || '').toLowerCase();
  if (/usage limit|quota|out of credit|insufficient|balance|arrears|额度|余额|欠费|用量/.test(d)) {
    return '（额度已用尽或余额不足——不是 Key 的问题。请到服务商处充值/升级套餐，或在设置里换一个服务商）';
  }
  if (/rate limit|too many request|限流|频率/.test(d)) return '（触发限流，可在设置里调低并发请求数）';
  if (status === 401) return '（API Key 无效或已过期，请到设置页检查）';
  if (status === 403) return '（没有权限：Key 与 Base URL 可能不是同一套，或该 Key 无权调用这个模型）';
  if (status === 404) return '（接口地址或模型名可能不对，请检查 Base URL 与模型）';
  if (status === 429) return '（触发限流，可在设置里调低并发请求数）';
  if (status >= 500) return '（服务端错误，稍后再试）';
  return '';
}

function pickText(flavor, json) {
  if (flavor === 'anthropic') {
    return (json.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  }
  if (flavor === 'gemini') {
    const cand = (json.candidates || [])[0];
    return ((cand?.content?.parts) || []).map(p => p.text || '').join('');
  }
  const c = (json.choices || [])[0];
  return c?.message?.content ?? c?.text ?? '';
}

/** 非流式调用，返回字符串 */
export async function complete(settings, opts) {
  const flavor = apiFlavor(settings.provider);
  const res = await fetch(endpoint(settings, false), {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify(body(settings, { ...opts, stream: false })),
    signal: opts.signal
  });
  if (!res.ok) throw await readError(res);
  const json = await res.json();
  const text = pickText(flavor, json);
  if (!text) throw new Error('模型返回为空：' + JSON.stringify(json).slice(0, 200));
  return text;
}

/** 流式调用，onDelta(chunk) 增量回调，返回完整文本 */
export async function stream(settings, opts) {
  const flavor = apiFlavor(settings.provider);
  const res = await fetch(endpoint(settings, true), {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify(body(settings, { ...opts, stream: true })),
    signal: opts.signal
  });
  if (!res.ok) throw await readError(res);
  if (!res.body) return complete(settings, opts);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  const emit = (t) => { if (t) { full += t; opts.onDelta && opts.onDelta(t); } };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (flavor === 'anthropic') {
        if (j.type === 'content_block_delta' && j.delta?.text) emit(j.delta.text);
        if (j.type === 'error') throw new Error(j.error?.message || 'Anthropic 流式错误');
      } else if (flavor === 'gemini') {
        emit(((j.candidates?.[0]?.content?.parts) || []).map(p => p.text || '').join(''));
      } else {
        const d = j.choices?.[0]?.delta;
        // 兼容部分服务把内容放在 message 里
        emit(d?.content ?? j.choices?.[0]?.message?.content ?? '');
      }
    }
  }
  if (!full) throw new Error('模型返回为空（流式）');
  return full;
}

/** 连通性测试 */
export async function testConnection(settings) {
  const t0 = performance.now();
  const out = await complete(settings, {
    messages: [{ role: 'user', content: '回复两个字：可用' }],
    maxTokens: 32,
    temperature: 0
  });
  return { ok: true, ms: Math.round(performance.now() - t0), sample: out.trim().slice(0, 40) };
}
