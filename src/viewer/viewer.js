/* PaperLens 阅读器主程序 */

import { getDocument, GlobalWorkerOptions, TextLayer } from '../../vendor/pdfjs/pdf.mjs';
import { analyzePage } from '../lib/layout.js';
import { getSettings } from '../lib/store.js';
import { translateUnits } from '../lib/translate.js';
import { createOverlayEl, layoutOverlay, sampleBg, computeExtraBelow } from './overlay.js';
import { initSidebar } from './sidebar.js';

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
const CMAP_URL = chrome.runtime.getURL('vendor/pdfjs/cmaps/');
const FONT_URL = chrome.runtime.getURL('vendor/pdfjs/standard_fonts/');

const $ = (id) => document.getElementById(id);
const DPR = Math.min(2.5, window.devicePixelRatio || 1);

const state = {
  pdf: null,
  numPages: 0,
  scale: 1,
  zoomMode: 'page-width',
  pages: [],
  settings: null,
  docId: '',
  title: '',
  fileName: '',
  showTranslation: true,
  docOpen: false,
  translating: false,
  abort: null,
  translations: new Map(),   // blockId -> 译文
  extractPromise: null,
  extracted: 0
};

/* ---------------- 基础 UI ---------------- */
let toastTimer = 0;
function toast(msg, ms) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2600);
}
function setLoading(on, text) {
  $('loading').hidden = !on;
  if (text) $('loading-text').textContent = text;
}
function setProgress(p) {
  const wrap = $('progress');
  if (p === null || p === undefined) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('progress-bar').style.width = Math.max(0, Math.min(100, p * 100)) + '%';
}

/* ---------------- 文档加载 ---------------- */
function paramFile() {
  const href = location.href;
  const i = href.indexOf('?file=');
  if (i < 0) return '';
  let raw = href.slice(i + 6);
  // 若被编码过则解码，否则直接使用（DNR 重定向时是未编码的原始 URL）
  try {
    if (/%[0-9A-Fa-f]{2}/.test(raw) && !/^https?:\/\/[^?#]*\?/.test(raw)) raw = decodeURIComponent(raw);
  } catch (e) { /* ignore */ }
  return raw;
}

async function loadFromUrl(url) {
  state.fileName = decodeURIComponent((url.split('#')[0].split('?')[0].split('/').pop()) || 'document.pdf');
  document.title = state.fileName + ' · PaperLens';
  $('doc-title').textContent = state.fileName;
  $('doc-title').title = url;
  setLoading(true, '正在下载 PDF…');
  const task = getDocument({
    url,
    withCredentials: true,
    cMapUrl: CMAP_URL, cMapPacked: true,
    standardFontDataUrl: FONT_URL,
    enableXfa: true,
    rangeChunkSize: 262144   // 默认 64KB，高延迟网络下请求数太多
  });
  const t0 = Date.now();
  task.onProgress = (d) => {
    // 文档打开后 pdf.js 仍会在后台继续抓剩余分片，这里必须闸住，
    // 否则回调会把已经关掉的加载框重新打开，一直挂着「正在下载 PDF」。
    if (state.docOpen) return;
    const kb = Math.round((d.loaded || 0) / 1024);
    const sec = Math.round((Date.now() - t0) / 1000);
    setLoading(true, d.total
      ? '正在下载 PDF… ' + Math.round(d.loaded / d.total * 100) + '%（' + kb + ' KB）'
      : '正在下载 PDF… 已接收 ' + kb + ' KB' + (sec > 3 ? '，' + sec + ' 秒' : ''));
  };
  await openDoc(await task.promise, url);
}

async function loadFromFile(file) {
  state.fileName = file.name;
  document.title = file.name + ' · PaperLens';
  $('doc-title').textContent = file.name;
  setLoading(true, '正在解析 PDF…');
  const buf = await file.arrayBuffer();
  const task = getDocument({
    data: new Uint8Array(buf),
    cMapUrl: CMAP_URL, cMapPacked: true,
    standardFontDataUrl: FONT_URL,
    enableXfa: true
  });
  await openDoc(await task.promise, 'file:' + file.name + ':' + file.size);
}

async function openDoc(pdf, idSeed) {
  state.pdf = pdf;
  state.docOpen = true;
  state.numPages = pdf.numPages;
  state.docId = 'doc:' + hashStr(idSeed + ':' + pdf.numPages);
  $('page-count').textContent = String(pdf.numPages);
  $('drop-hint').hidden = true;

  try {
    const meta = await pdf.getMetadata();
    if (meta && meta.info && meta.info.Title) state.title = String(meta.info.Title).trim();
  } catch (e) { /* ignore */ }

  await buildPageShells();
  setLoading(false);
  fitZoom();
  sidebar.onDocReady();
  startExtraction();
  await restoreTranslations();

  // 不 await：后台标签页里 requestAnimationFrame 不触发，画布渲染会一直挂起，
  // 不能让它阻塞抽取正文、恢复译文这些主流程。
  renderVisible();

  const s = state.settings;
  if (s.autoTranslate && s.apiKey) translateAll();
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ---------------- 页面骨架 ---------------- */
async function buildPageShells() {
  const cont = $('pages');
  cont.innerHTML = '';
  state.pages = [];

  // 并行取页对象：逐页 await 在高延迟网络上会把首屏拖得很慢
  const handles = [];
  const BATCH = 16;
  for (let start = 1; start <= state.numPages; start += BATCH) {
    const end = Math.min(state.numPages, start + BATCH - 1);
    const jobs = [];
    for (let i = start; i <= end; i++) jobs.push(state.pdf.getPage(i));
    const got = await Promise.all(jobs);
    handles.push.apply(handles, got);
    if (state.numPages > BATCH) setLoading(true, '正在解析页面 ' + end + '/' + state.numPages + '…');
  }

  for (let i = 1; i <= state.numPages; i++) {
    const page = handles[i - 1];
    const vp1 = page.getViewport({ scale: 1 });
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = String(i);
    const ph = document.createElement('div');
    ph.className = 'page-ph';
    ph.textContent = '第 ' + i + ' 页';
    div.appendChild(ph);
    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = String(i);
    div.appendChild(label);
    // 覆盖层与画布解耦：译文只要算出版面就能显示，不必等画布渲染完
    const ov = document.createElement('div');
    ov.className = 'ovLayer';
    div.appendChild(ov);
    cont.appendChild(div);

    state.pages.push({
      num: i, page, vp1, div, ph,
      canvas: null, textLayerDiv: null, ovLayer: ov,
      renderTask: null, rendered: false, renderedScale: 0,
      textContent: null, layout: null, extracting: null
    });
  }
  observePages();
}

let io = null;
function observePages() {
  if (io) io.disconnect();
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const num = Number(e.target.dataset.page);
      const p = state.pages[num - 1];
      if (!p) continue;
      if (e.isIntersecting) renderPage(p);
      else if (Math.abs(num - currentPage()) > 4) releasePage(p);
    }
  }, { root: $('pages'), rootMargin: '600px 0px' });
  state.pages.forEach(p => io.observe(p.div));
}

function applyPageSize(p) {
  const w = Math.floor(p.vp1.width * state.scale);
  const h = Math.floor(p.vp1.height * state.scale);
  p.div.style.width = w + 'px';
  p.div.style.height = h + 'px';
  p.div.style.setProperty('--scale-factor', String(state.scale));
  p.div.style.setProperty('--total-scale-factor', String(state.scale));
  // 先把旧画布按 CSS 拉伸到新尺寸（会糊一下），等重绘完成再换成清晰的，
  // 避免缩放后出现「大页框里贴着一张小图」。__cssWidth 保持渲染时的值，取色换算才不会错。
  if (p.canvas) {
    p.canvas.style.width = w + 'px';
    p.canvas.style.height = h + 'px';
  }
  if (p.textLayerDiv) {
    p.textLayerDiv.style.width = w + 'px';
    p.textLayerDiv.style.height = h + 'px';
  }
}

/* ---------------- 渲染 ---------------- */
async function renderPage(p) {
  // 记录本次实际使用的缩放：渲染过程中用户可能又缩放了
  const scale = state.scale;
  if (p.rendered && p.renderedScale === scale) return;
  if (p.renderTask) { try { p.renderTask.cancel(); } catch (e) {} p.renderTask = null; }

  const vp = p.page.getViewport({ scale });
  let canvas = p.canvas;
  if (!canvas) {
    canvas = document.createElement('canvas');
    p.canvas = canvas;
    p.div.insertBefore(canvas, p.div.firstChild);
  }
  canvas.width = Math.floor(vp.width * DPR);
  canvas.height = Math.floor(vp.height * DPR);
  canvas.style.width = Math.floor(vp.width) + 'px';
  canvas.style.height = Math.floor(vp.height) + 'px';
  canvas.__cssWidth = Math.floor(vp.width);
  canvas.__ctx = null;

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const task = p.page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' });
  p.renderTask = task;
  try {
    await task.promise;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    console.warn('render page ' + p.num, e);
    return;
  }
  p.renderTask = null;
  p.rendered = true;
  p.renderedScale = scale;
  if (p.ph) p.ph.style.display = 'none';

  // 渲染期间缩放变了 → 用新比例重画
  if (state.scale !== scale) return renderPage(p);

  await ensureText(p);

  // 文本层（用于选中/查找）
  if (!p.textLayerDiv) {
    p.textLayerDiv = document.createElement('div');
    p.textLayerDiv.className = 'textLayer';
    p.div.appendChild(p.textLayerDiv);
  }
  p.textLayerDiv.innerHTML = '';
  if (p.textContent) {
    try {
      const tl = new TextLayer({ textContentSource: p.textContent, container: p.textLayerDiv, viewport: vp });
      await tl.render();
      const eoc = document.createElement('div');
      eoc.className = 'endOfContent';
      p.textLayerDiv.appendChild(eoc);
    } catch (e) { /* 文本层失败不影响阅读 */ }
  }

  if (!p.ovLayer) {
    p.ovLayer = document.createElement('div');
    p.ovLayer.className = 'ovLayer';
    p.div.appendChild(p.ovLayer);
  }
  renderOverlays(p, true);
}

function releasePage(p) {
  if (p.renderTask) { try { p.renderTask.cancel(); } catch (e) {} p.renderTask = null; }
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
  if (p.textLayerDiv) { p.textLayerDiv.remove(); p.textLayerDiv = null; }
  // 覆盖层节点保留（只清空内容），滚回来时无需等画布就能重排译文
  if (p.ovLayer) p.ovLayer.innerHTML = '';
  if (p.ph) p.ph.style.display = '';
  p.rendered = false;
  p.renderedScale = 0;
}

async function renderVisible() {
  const jobs = [];
  const cur = currentPage();
  for (let i = Math.max(1, cur - 1); i <= Math.min(state.numPages, cur + 2); i++) {
    jobs.push(renderPage(state.pages[i - 1]));
  }
  await Promise.all(jobs);
}

/* ---------------- 文本抽取与版面分析 ---------------- */
function ensureText(p) {
  if (p.layout) return Promise.resolve(p.layout);
  if (p.extracting) return p.extracting;
  p.extracting = (async () => {
    const tc = await p.page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
    p.textContent = tc;
    p.layout = analyzePage(tc, p.vp1, p.num);
    p.layout.blocks.forEach(b => { b._extra = computeExtraBelow(p.layout.blocks, b.index); });
    return p.layout;
  })();
  return p.extracting;
}

function startExtraction() {
  if (state.extractPromise) return state.extractPromise;
  state.extractPromise = (async () => {
    for (const p of state.pages) {
      await ensureText(p);
      state.extracted = p.num;
      if (state.translations.size) renderOverlays(p);
    }
    markReferenceZone();
    sidebar.onTextReady();
  })();
  return state.extractPromise;
}

/** 标记参考文献区之后的块，翻译时可跳过 */
function markReferenceZone() {
  let hit = false;
  for (const p of state.pages) {
    if (!p.layout) continue;
    for (const b of p.layout.blocks) {
      if (!hit && /^\s*(\d+\.?\s*)?(references|bibliography|reference|参考文献)\s*$/i.test(b.text)) hit = true;
      if (hit && b.kind === 'text' && b.index > 0) b.kind = b.isHeading ? 'text' : 'ref';
      if (hit) b.inRefZone = true;
    }
  }
}

export function getFullText() {
  const parts = [];
  for (const p of state.pages) {
    if (!p.layout) continue;
    const txt = p.layout.blocks
      .filter(b => b.kind !== 'skip')
      .map(b => b.text)
      .join('\n');
    if (txt.trim()) parts.push('[第 ' + p.num + ' 页]\n' + txt);
  }
  return parts.join('\n\n');
}

function guessTitle() {
  if (state.title && state.title.length > 6) return state.title;
  const p = state.pages[0];
  if (p && p.layout) {
    const cand = p.layout.blocks
      .filter(b => b.top < p.layout.height * 0.35 && b.text.length > 12 && b.text.length < 220)
      .sort((a, b) => b.fh - a.fh)[0];
    if (cand) return cand.text;
  }
  return state.fileName || '未知标题';
}

/* ---------------- 译文覆盖 ---------------- */
function blockBg(p, b, resample) {
  if (!resample && b._bg) return b._bg;
  if (!p.canvas || !p.rendered) return b._bg || '#ffffff';
  b._bg = sampleBg(p.canvas, b, p.renderedScale || state.scale);
  return b._bg;
}

function renderOverlays(p, resample) {
  if (!p.ovLayer || !p.layout) return;
  p.ovLayer.innerHTML = '';
  p.ovLayer.classList.toggle('off', !state.showTranslation);
  if (!state.showTranslation) return;
  const fam = state.settings && state.settings.fontFamily ? state.settings.fontFamily : '';
  for (const b of p.layout.blocks) {
    const t = state.translations.get(b.id);
    if (!t) continue;
    const el = createOverlayEl(b);
    el.firstChild.textContent = t;
    p.ovLayer.appendChild(el);
    layoutOverlay(el, b, state.scale, {
      bg: blockBg(p, b, resample),
      extraBelow: b._extra || 0,
      fontFamily: fam
    });
  }
}

/** 缩放后立即重排覆盖层：不依赖画布重绘（后台标签页里画布可能迟迟不重绘） */
function repositionOverlays() {
  const fam = state.settings && state.settings.fontFamily ? state.settings.fontFamily : '';
  for (const p of state.pages) {
    if (!p.ovLayer || !p.layout || !state.showTranslation) continue;
    const els = p.ovLayer.children;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const b = p.layout.blocks[Number(el.dataset.id.split(':')[1])];
      if (!b) continue;
      layoutOverlay(el, b, state.scale, {
        bg: b._bg || '#ffffff',
        extraBelow: b._extra || 0,
        fontFamily: fam
      });
    }
  }
}

function updateOverlay(blockId) {
  const pnum = Number(String(blockId).split(':')[0]);
  const p = state.pages[pnum - 1];
  if (!p || !p.ovLayer || !p.layout || !state.showTranslation) return;
  const b = p.layout.blocks.find(x => x.id === blockId);
  if (!b) return;
  const t = state.translations.get(blockId);
  if (!t) return;
  let el = p.ovLayer.querySelector('[data-id="' + CSS.escape(blockId) + '"]');
  if (!el) {
    el = createOverlayEl(b);
    p.ovLayer.appendChild(el);
  }
  el.firstChild.textContent = t;
  layoutOverlay(el, b, state.scale, {
    bg: blockBg(p, b, false),
    extraBelow: b._extra || 0,
    fontFamily: (state.settings && state.settings.fontFamily) || ''
  });
}

/* ---------------- 翻译全文 ---------------- */
async function translateAll() {
  if (state.translating) { cancelTranslate(); return; }
  state.settings = await getSettings();
  if (!state.settings.apiKey && state.settings.provider !== 'ollama') {
    toast('请先在设置中填写 API Key');
    chrome.runtime.openOptionsPage();
    return;
  }
  setLoading(true, '正在提取文本…');
  await startExtraction();
  setLoading(false);

  // 收集待翻译单元，按「当前页优先」排序；相同文本去重
  const cur = currentPage();
  const order = [];
  for (let i = 0; i < state.numPages; i++) {
    order.push(state.pages[(cur - 1 + i) % state.numPages]);
  }
  const byText = new Map();
  for (const p of order) {
    if (!p.layout) continue;
    for (const b of p.layout.blocks) {
      const ok = b.kind === 'text' || (b.kind === 'ref' && state.settings.translateRefs);
      if (!ok) continue;
      if (state.translations.has(b.id)) continue;
      if (!byText.has(b.text)) byText.set(b.text, []);
      byText.get(b.text).push(b.id);
    }
  }
  const units = [];
  for (const e of byText) units.push({ id: e[1][0], text: e[0], all: e[1] });
  if (!units.length) { toast('没有需要翻译的正文（可能是扫描版 PDF，无文本层）'); return; }

  state.translating = true;
  state.abort = new AbortController();
  $('tr-label').textContent = '停止翻译';
  $('btn-translate').classList.add('on');
  setProgress(0);
  state.showTranslation = true;
  $('btn-toggle-tr').classList.remove('on');

  // 先放占位骨架，让用户看到进度
  for (const p of state.pages) if (p.ovLayer) p.ovLayer.classList.remove('off');

  let errShown = false;
  try {
    const res = await translateUnits(state.settings, units, {
      signal: state.abort.signal,
      onProgress: (done, total) => {
        setProgress(done / total);
        $('tr-label').textContent = '停止 (' + done + '/' + total + ')';
      },
      onUnit: (id, text) => {
        const u = units.find(x => x.id === id);
        const ids = u ? u.all : [id];
        for (const bid of ids) {
          state.translations.set(bid, text);
          updateOverlay(bid);
        }
      },
      onError: (e) => {
        if (!errShown) { errShown = true; toast('翻译出错：' + e.message, 6000); }
      }
    });
    if (res.failed) toast('完成，但有 ' + res.failed + ' 段失败，可再次点击翻译重试', 4000);
    else toast('翻译完成：' + res.total + ' 段');
    persistTranslations();
  } catch (e) {
    if (e.name !== 'AbortError') toast('翻译失败：' + e.message, 6000);
  } finally {
    state.translating = false;
    state.abort = null;
    $('tr-label').textContent = state.translations.size ? '继续翻译' : '翻译全文';
    $('btn-translate').classList.remove('on');
    setProgress(null);
  }
}

function cancelTranslate() {
  if (state.abort) state.abort.abort();
  toast('已停止翻译');
}

async function persistTranslations() {
  try {
    const { docSet } = await import('../lib/store.js');
    await docSet(state.docId + ':tr', Array.from(state.translations.entries()));
  } catch (e) { /* ignore */ }
}

async function restoreTranslations() {
  try {
    const { docGet } = await import('../lib/store.js');
    const arr = await docGet(state.docId + ':tr');
    if (arr && arr.length) {
      state.translations = new Map(arr);
      state.pages.forEach(p => renderOverlays(p));
      $('tr-label').textContent = '继续翻译';
      toast('已恢复上次的译文');
    }
  } catch (e) { /* ignore */ }
}

/* ---------------- 缩放与导航 ---------------- */
function currentPage() {
  const cont = $('pages');
  const top = cont.scrollTop + 80;
  let best = 1;
  for (const p of state.pages) {
    if (p.div.offsetTop <= top) best = p.num; else break;
  }
  return best;
}

function fitZoom() {
  const p = state.pages[0];
  if (!p) return;
  const cont = $('pages');
  const availW = cont.clientWidth - 32;
  const availH = cont.clientHeight - 32;
  if (state.zoomMode === 'page-width') state.scale = availW / p.vp1.width;
  else if (state.zoomMode === 'page-fit') state.scale = Math.min(availW / p.vp1.width, availH / p.vp1.height);
  else state.scale = Number(state.zoomMode) || 1;
  state.scale = Math.max(0.2, Math.min(5, state.scale));
  state.pages.forEach(applyPageSize);
}

let rerenderTimer = 0;
function applyZoom() {
  const cont = $('pages');
  const cur = currentPage();
  fitZoom();
  const p = state.pages[cur - 1];
  if (p) cont.scrollTop = p.div.offsetTop - 12;
  repositionOverlays();
  state.pages.forEach(x => { if (x.rendered) x.renderedScale = -1; });
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    state.pages.forEach(x => { if (x.rendered) renderPage(x); });
    renderVisible();
  }, 60);
}

function zoomStep(dir) {
  const steps = [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  let i = 0;
  while (i < steps.length && steps[i] <= state.scale + 0.001) i++;
  const next = dir > 0 ? steps[Math.min(steps.length - 1, i)] : steps[Math.max(0, i - 2)];
  state.zoomMode = String(next);
  $('zoom-select').value = String(next);
  applyZoom();
}

function goPage(n) {
  n = Math.max(1, Math.min(state.numPages, n));
  const p = state.pages[n - 1];
  if (p) $('pages').scrollTo({ top: p.div.offsetTop - 12, behavior: 'smooth' });
}

export function scrollToPage(n) { goPage(n); }

/* ---------------- 选中文本操作 ---------------- */
function setupSelection() {
  const pop = $('sel-pop');
  let lastText = '';
  const hide = () => { pop.hidden = true; };

  $('pages').addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? String(sel).trim() : '';
      if (!text || text.length < 2) { hide(); return; }
      const range = sel.getRangeAt(0);
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) { hide(); return; }
      lastText = text.replace(/\s+/g, ' ');
      pop.hidden = false;
      const x = Math.min(window.innerWidth - pop.offsetWidth - 10, Math.max(8, r.left + r.width / 2 - pop.offsetWidth / 2));
      pop.style.left = x + 'px';
      pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + 'px';
    }, 10);
  });

  document.addEventListener('mousedown', (e) => { if (!pop.contains(e.target)) hide(); });

  pop.addEventListener('click', async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    hide();
    if (act === 'copy') { navigator.clipboard.writeText(lastText); toast('已复制'); return; }
    sidebar.handleSelection(act, lastText);
  });
}

/* ---------------- 事件绑定 ---------------- */
function bindUI() {
  $('btn-open').onclick = () => $('file-input').click();
  const o2 = $('btn-open2');
  if (o2) o2.onclick = () => $('file-input').click();
  $('file-input').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFromFile(f).catch(err => toast('打开失败：' + err.message, 5000));
  };

  $('btn-prev').onclick = () => goPage(currentPage() - 1);
  $('btn-next').onclick = () => goPage(currentPage() + 1);
  $('page-num').onchange = (e) => goPage(parseInt(e.target.value, 10) || 1);
  $('btn-zoom-in').onclick = () => zoomStep(1);
  $('btn-zoom-out').onclick = () => zoomStep(-1);
  $('zoom-select').onchange = (e) => { state.zoomMode = e.target.value; applyZoom(); };

  $('btn-translate').onclick = () => translateAll();
  $('btn-toggle-tr').onclick = () => {
    state.showTranslation = !state.showTranslation;
    $('btn-toggle-tr').textContent = state.showTranslation ? '原文' : '译文';
    $('btn-toggle-tr').classList.toggle('on', !state.showTranslation);
    state.pages.forEach(p => renderOverlays(p));
  };
  $('btn-sidebar').onclick = () => {
    const sb = $('sidebar');
    sb.classList.toggle('hidden');
    $('btn-sidebar').classList.toggle('on', !sb.classList.contains('hidden'));
    setTimeout(() => { if (state.zoomMode === 'page-width' || state.zoomMode === 'page-fit') applyZoom(); }, 50);
  };
  $('btn-settings').onclick = () => chrome.runtime.openOptionsPage();

  const cont = $('pages');
  let scrollTimer = 0;
  cont.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { $('page-num').value = String(currentPage()); }, 80);
  }, { passive: true });

  // Ctrl + 滚轮缩放
  cont.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomStep(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  let lastW = 0;
  const refit = () => {
    const w = cont.clientWidth;
    if (Math.abs(w - lastW) < 4) return;
    lastW = w;
    if (state.pages.length && (state.zoomMode === 'page-width' || state.zoomMode === 'page-fit')) applyZoom();
  };
  window.addEventListener('resize', refit);
  if (window.ResizeObserver) new ResizeObserver(refit).observe($('viewer-wrap'));

  // Alt 临时查看原文
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') cont.classList.add('peek');
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { goPage(currentPage() + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { goPage(currentPage() - 1); }
    else if (e.key === '+' || e.key === '=') { zoomStep(1); }
    else if (e.key === '-') { zoomStep(-1); }
    else if (e.key.toLowerCase() === 't') { translateAll(); }
    else if (e.key.toLowerCase() === 's') { $('btn-sidebar').click(); }
    else if (e.key.toLowerCase() === 'o') { $('file-input').click(); }
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') cont.classList.remove('peek'); });
  window.addEventListener('blur', () => cont.classList.remove('peek'));

  // 拖放打开
  ['dragenter', 'dragover'].forEach(t => cont.addEventListener(t, (e) => {
    e.preventDefault(); cont.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(t => cont.addEventListener(t, (e) => {
    e.preventDefault(); cont.classList.remove('dragover');
  }));
  cont.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /pdf$/i.test(f.name)) loadFromFile(f).catch(err => toast('打开失败：' + err.message, 5000));
  });

  setupSelection();
}

/* ---------------- 侧栏桥接 ---------------- */
const sidebar = initSidebar({
  getSettings: () => state.settings,
  reloadSettings: async () => (state.settings = await getSettings()),
  getFullText,
  getTitle: guessTitle,
  getDocId: () => state.docId,
  getPages: () => state.pages,
  isTextReady: () => state.extracted >= state.numPages,
  ensureText: () => startExtraction(),
  gotoPage: goPage,
  toast
});

/* ---------------- 启动 ---------------- */
(async function main() {
  state.settings = await getSettings();
  bindUI();
  $('zoom-select').value = 'page-width';

  const file = paramFile();
  if (!file) {
    $('drop-hint').hidden = false;
    return;
  }
  try {
    await loadFromUrl(file);
  } catch (e) {
    setLoading(false);
    $('drop-hint').hidden = false;
    console.error(e);
    toast('无法打开该 PDF：' + (e.message || e), 6000);
  }
})();
