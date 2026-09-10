/* 翻译调度：批量打包 → 并发 → 缓存 → 校验 → 失败降级为逐段重试 */

import { complete } from './llm.js';
import { hashKey, cacheGetMany, cacheSetMany } from './store.js';

const MARK = (i) => '【#' + i + '】';           // 【#1】
const MARK_RE = /【#(\d+)】/g;

function sysPrompt(settings, glossaryLines) {
  const lang = settings.targetLang || '简体中文';
  let p = [
    '你是专业的学术论文翻译引擎，负责把论文正文片段翻译成' + lang + '。',
    '严格遵守以下规则：',
    '1. 只输出译文，不要任何解释、前言或补充说明。',
    '2. 输入由「【#序号】」分隔的多个片段组成，输出必须原样保留每个「【#序号】」标记，并且序号、数量、顺序完全一致。',
    '3. 逐段独立翻译，不要合并或拆分片段，不要漏译。',
    '4. 数学符号、公式、变量名、算法名、数据集名、指标名（如 BLEU、mAP、F1）、模型名、代码标识符、URL 保持原样。',
    '5. 引用与编号（如 [12]、(3)、Eq. (5)、Figure 2、Table 1、Section 3.2）保持原样，不要翻译成中文序号。',
    '6. 专业术语采用领域通用译法；首次出现的关键术语可用「中文（English）」形式，其余处只用中文。',
    '7. 译文要精炼准确，长度尽量接近原文，避免堆砌修饰词——译文会按原文排版回填，过长会影响版面。',
    '8. 如果某个片段是乱码、纯符号或无法翻译，原样返回该片段内容。'
  ].join('\n');
  if (glossaryLines && glossaryLines.length) {
    p += '\n\n必须遵守的术语对照表：\n' + glossaryLines.join('\n');
  }
  if (settings.customPrompt) p += '\n\n补充要求：\n' + settings.customPrompt;
  return p;
}

function parseGlossary(text) {
  if (!text) return [];
  return text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && /[=:：]/.test(l))
    .slice(0, 200)
    .map(l => {
      const m = l.split(/[=:：]/);
      return { src: m[0].trim(), dst: m.slice(1).join('=').trim() };
    })
    .filter(g => g.src && g.dst);
}

function pickGlossary(glossary, text) {
  if (!glossary.length) return [];
  const low = text.toLowerCase();
  return glossary
    .filter(g => low.indexOf(g.src.toLowerCase()) >= 0)
    .slice(0, 40)
    .map(g => '- ' + g.src + ' → ' + g.dst);
}

/** 把待翻译单元打包成若干批 */
function makeBatches(units, maxChars) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const u of units) {
    const len = u.text.length;
    if (cur.length && (size + len > maxChars || cur.length >= 20)) {
      batches.push(cur); cur = []; size = 0;
    }
    if (len > maxChars) { batches.push([u]); continue; }   // 超长段单独一批
    cur.push(u); size += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function buildUserMsg(batch) {
  return batch.map((u, i) => MARK(i + 1) + '\n' + u.text).join('\n\n');
}

function parseResult(out, n) {
  const idx = [];
  let m;
  MARK_RE.lastIndex = 0;
  while ((m = MARK_RE.exec(out)) !== null) idx.push({ i: parseInt(m[1], 10), s: m.index, e: MARK_RE.lastIndex });
  if (!idx.length) return null;
  const map = new Map();
  for (let k = 0; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1].s : out.length;
    map.set(idx[k].i, out.slice(idx[k].e, end).trim());
  }
  const res = [];
  for (let i = 1; i <= n; i++) {
    const v = map.get(i);
    if (v === undefined || v === '') return null;
    res.push(v);
  }
  return res;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 鉴权失败、额度用尽这类错误重试多少次都没用，应当立刻停掉整轮翻译 */
function isFatal(e) {
  const m = String((e && e.message) || '');
  if (/请求失败 (401|402|403)\b/.test(m)) return true;
  return /usage limit|quota|out of credit|insufficient|额度|余额|欠费/i.test(m);
}

async function callWithRetry(settings, messages, system, signal, tries) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      return await complete(settings, { messages, system, signal, temperature: 0.1, maxTokens: 4096 });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      const msg = String(e.message || '');
      const retriable = /429|5\d\d|timeout|network|fetch|限流/i.test(msg);
      if (!retriable || i === tries - 1) break;
      await sleep(800 * Math.pow(2, i) + Math.random() * 400);
    }
  }
  throw lastErr;
}

/**
 * @param {object} settings
 * @param {Array<{id:string,text:string}>} units 待翻译单元
 * @param {object} opts { onProgress(done,total), onUnit(id, translated), signal }
 */
export async function translateUnits(settings, units, opts) {
  opts = opts || {};
  const lang = settings.targetLang || '简体中文';
  const model = settings.model || '';
  const glossary = parseGlossary(settings.glossary);
  const gloKey = glossary.map(g => g.src + '>' + g.dst).join(';');

  const keyOf = (t) => hashKey(model + '|' + lang + '|' + gloKey + '|' + t);

  // 1) 查缓存
  let pending = units;
  const total = units.length;
  let done = 0;
  const report = () => opts.onProgress && opts.onProgress(done, total);

  if (settings.cacheEnabled !== false) {
    const keys = units.map(u => keyOf(u.text));
    const hit = await cacheGetMany(Array.from(new Set(keys)));
    pending = [];
    units.forEach((u, i) => {
      const v = hit.get(keys[i]);
      if (v) { done++; opts.onUnit && opts.onUnit(u.id, v, true); }
      else pending.push(u);
    });
    report();
  }
  if (!pending.length) return { total, translated: 0, failed: 0 };

  // 2) 分批 + 并发
  const batches = makeBatches(pending, Number(settings.batchChars) || 2200);
  const conc = Math.max(1, Math.min(12, Number(settings.concurrency) || 5));
  const toCache = [];
  let failed = 0;
  let translated = 0;
  let cursor = 0;
  let fatalErr = null;

  const runBatch = async (batch) => {
    const text = buildUserMsg(batch);
    const system = sysPrompt(settings, pickGlossary(glossary, text));
    let results = null;
    try {
      const out = await callWithRetry(settings, [{ role: 'user', content: text }], system, opts.signal, 3);
      results = parseResult(out, batch.length);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 额度用尽/鉴权失败时不再逐段重试，否则会白白再打几百个必失败的请求
      if (isFatal(e)) { fatalErr = e; return; }
      results = null;
      opts.onError && opts.onError(e);
    }

    if (!results) {
      // 降级：逐段翻译（标记丢失或数量不符时）
      for (const u of batch) {
        if (opts.signal && opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
        try {
          const sys = sysPrompt(settings, pickGlossary(glossary, u.text));
          const out = await callWithRetry(settings,
            [{ role: 'user', content: MARK(1) + '\n' + u.text }], sys, opts.signal, 2);
          const one = parseResult(out, 1);
          const v = one ? one[0] : out.replace(MARK_RE, '').trim();
          if (v) {
            translated++;
            toCache.push([keyOf(u.text), v]);
            opts.onUnit && opts.onUnit(u.id, v, false);
          } else failed++;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          if (isFatal(e)) { fatalErr = e; return; }
          failed++;
          opts.onError && opts.onError(e);
        }
        done++; report();
      }
      return;
    }

    batch.forEach((u, i) => {
      const v = results[i];
      translated++;
      toCache.push([keyOf(u.text), v]);
      opts.onUnit && opts.onUnit(u.id, v, false);
      done++;
    });
    report();
  };

  const worker = async () => {
    while (cursor < batches.length && !fatalErr) {
      if (opts.signal && opts.signal.aborted) return;
      const b = batches[cursor++];
      await runBatch(b);
      if (toCache.length >= 40) {
        const chunk = toCache.splice(0, toCache.length);
        if (settings.cacheEnabled !== false) cacheSetMany(chunk).catch(() => {});
      }
    }
  };

  const workers = [];
  for (let i = 0; i < conc; i++) workers.push(worker());
  await Promise.all(workers);

  if (toCache.length && settings.cacheEnabled !== false) {
    await cacheSetMany(toCache).catch(() => {});
  }
  // 已翻译的部分保留在页面上，把致命错误抛给调用方提示用户
  if (fatalErr) throw fatalErr;
  return { total, translated, failed };
}
