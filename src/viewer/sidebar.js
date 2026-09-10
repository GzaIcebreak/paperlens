/* 侧栏：论文解读 / 提问 / 大纲 */

import { renderMarkdown } from '../lib/md.js';
import { stream as llmStream, complete as llmComplete } from '../lib/llm.js';
import { docGet, docSet } from '../lib/store.js';
import {
  analysisSystem, analysisUser, chunkNoteUser, reduceUser,
  chatSystem, explainSelectionUser
} from '../lib/prompts.js';

const $ = (id) => document.getElementById(id);

export function initSidebar(api) {
  const S = {
    analysisMd: '',
    analyzing: false,
    abort: null,
    chat: [],          // {role, content}
    chatAbort: null,
    quote: '',
    outlineBuilt: false
  };

  /* ---------- tabs ---------- */
  document.querySelectorAll('.sb-tab').forEach(t => {
    t.onclick = () => showTab(t.dataset.tab);
  });
  function showTab(name) {
    document.querySelectorAll('.sb-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
    document.querySelectorAll('.sb-panel').forEach(x => x.classList.toggle('active', x.dataset.panel === name));
  }
  function openSidebar(tab) {
    const sb = $('sidebar');
    if (sb.classList.contains('hidden')) $('btn-sidebar').click();
    if (tab) showTab(tab);
  }

  function settingsFor(kind) {
    const s = Object.assign({}, api.getSettings());
    if (kind === 'analysis' && s.analysisModel) s.model = s.analysisModel;
    return s;
  }

  function needKey() {
    const s = api.getSettings();
    if (!s || (!s.apiKey && s.provider !== 'ollama')) {
      api.toast('请先在设置中配置 API Key');
      chrome.runtime.openOptionsPage();
      return true;
    }
    return false;
  }

  /* ---------- 解读 ---------- */
  const statusEl = () => $('analysis-status');
  function setStatus(t, err) {
    statusEl().textContent = t || '';
    statusEl().classList.toggle('err', !!err);
  }

  function renderAnalysis() {
    $('analysis-body').innerHTML = renderMarkdown(S.analysisMd);
  }

  function buildNav() {
    const nav = $('analysis-nav');
    nav.innerHTML = '';
    const hs = $('analysis-body').querySelectorAll('h2');
    hs.forEach((h, i) => {
      h.id = 'sec-' + i;
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = h.textContent;
      b.onclick = () => h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      nav.appendChild(b);
    });
  }

  function splitChunks(text, size) {
    const paras = text.split(/\n{2,}/);
    const out = [];
    let cur = '';
    for (const p of paras) {
      if (cur.length + p.length > size && cur) { out.push(cur); cur = ''; }
      if (p.length > size) {
        for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
        continue;
      }
      cur += (cur ? '\n\n' : '') + p;
    }
    if (cur) out.push(cur);
    return out;
  }

  async function analyze(force) {
    if (S.analyzing) { if (S.abort) S.abort.abort(); return; }
    if (needKey()) return;
    await api.reloadSettings();
    const s = settingsFor('analysis');
    const lang = s.targetLang || '简体中文';
    const cacheKey = api.getDocId() + ':analysis:' + s.model + ':' + lang;

    if (!force) {
      const cached = await docGet(cacheKey);
      if (cached) {
        S.analysisMd = cached;
        renderAnalysis(); buildNav();
        setStatus('已加载上次的解读结果（点「重新生成」可刷新）');
        return;
      }
    }

    setStatus('正在提取全文…');
    await api.ensureText();
    const full = api.getFullText();
    if (!full || full.length < 200) {
      setStatus('没有提取到文本，可能是扫描版 PDF（需要 OCR）。', true);
      return;
    }

    S.analyzing = true;
    S.abort = new AbortController();
    $('btn-analyze').textContent = '停止';
    S.analysisMd = '';
    renderAnalysis();

    try {
      const budget = Number(s.maxContextChars) || 90000;
      let sourceText = full;

      if (full.length > budget) {
        // 长论文：先分段做笔记，再汇总
        const chunks = splitChunks(full, Math.max(12000, Math.floor(budget / 6)));
        setStatus('论文较长（' + full.length + ' 字符），正在分 ' + chunks.length + ' 段提取要点…');
        const notes = [];
        for (let i = 0; i < chunks.length; i++) {
          setStatus('提取要点 ' + (i + 1) + '/' + chunks.length + '…');
          const n = await llmComplete(s, {
            system: '你是论文精读助手，只提取要点，不做发挥。',
            messages: [{ role: 'user', content: chunkNoteUser(chunks[i], i + 1, chunks.length) }],
            signal: S.abort.signal,
            maxTokens: 1500,
            temperature: 0.1
          });
          notes.push('### 第 ' + (i + 1) + ' 部分\n' + n);
        }
        sourceText = notes.join('\n\n');
        setStatus('正在综合生成解读…');
      } else {
        setStatus('正在生成解读…');
      }

      let last = 0;
      await llmStream(s, {
        system: analysisSystem(lang),
        messages: [{
          role: 'user',
          content: full.length > budget ? reduceUser(sourceText, lang) : analysisUser(sourceText, lang)
        }],
        maxTokens: 8192,
        temperature: 0.3,
        signal: S.abort.signal,
        onDelta: (d) => {
          S.analysisMd += d;
          const now = Date.now();
          if (now - last > 150) { last = now; renderAnalysis(); }
        }
      });
      renderAnalysis();
      buildNav();
      setStatus('解读完成');
      docSet(cacheKey, S.analysisMd).catch(() => {});
    } catch (e) {
      if (e.name === 'AbortError') setStatus('已停止');
      else { setStatus('生成失败：' + e.message, true); }
    } finally {
      S.analyzing = false;
      S.abort = null;
      $('btn-analyze').textContent = '生成解读';
    }
  }

  $('btn-analyze').onclick = () => analyze(false);
  $('btn-analyze-refresh').onclick = () => analyze(true);
  $('btn-copy-analysis').onclick = () => {
    if (!S.analysisMd) return api.toast('还没有解读内容');
    navigator.clipboard.writeText(S.analysisMd);
    api.toast('已复制 Markdown');
  };
  $('btn-export-analysis').onclick = () => {
    if (!S.analysisMd) return api.toast('还没有解读内容');
    const name = (api.getTitle() || 'paper').replace(/[\\/:*?"<>|\n]/g, '_').slice(0, 60);
    const blob = new Blob(['# ' + api.getTitle() + '\n\n' + S.analysisMd], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  /* ---------- 问答 ---------- */
  function addMsg(role, content) {
    const list = $('chat-list');
    const empty = list.querySelector('.chat-empty');
    if (empty) empty.remove();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const r = document.createElement('div');
    r.className = 'role';
    r.textContent = role === 'user' ? '我' : 'PaperLens';
    const b = document.createElement('div');
    b.className = 'bubble md-body';
    if (role === 'user') b.textContent = content;
    else b.innerHTML = renderMarkdown(content);
    wrap.appendChild(r); wrap.appendChild(b);
    list.appendChild(wrap);
    list.scrollTop = list.scrollHeight;
    return b;
  }

  /* 从全文里挑与问题最相关的段落，控制上下文长度 */
  function selectContext(question, full, budget) {
    if (full.length <= budget) return full;
    const head = full.slice(0, Math.min(6000, budget * 0.25));
    const rest = full.slice(head.length);
    const paras = rest.split(/\n{2,}/);
    const q = new Set(String(question).toLowerCase().match(/[a-z0-9一-鿿]{2,}/g) || []);
    const scored = paras.map((p, i) => {
      const w = p.toLowerCase().match(/[a-z0-9一-鿿]{2,}/g) || [];
      let hit = 0;
      const seen = new Set();
      for (const t of w) if (q.has(t) && !seen.has(t)) { seen.add(t); hit++; }
      return { i, p, score: hit / Math.sqrt(w.length + 8) };
    }).sort((a, b) => b.score - a.score);
    const picked = [];
    let size = head.length;
    for (const it of scored) {
      if (size + it.p.length > budget) continue;
      picked.push(it); size += it.p.length;
      if (size > budget * 0.95) break;
    }
    picked.sort((a, b) => a.i - b.i);
    return head + '\n\n…\n\n' + picked.map(x => x.p).join('\n\n');
  }

  async function send(text) {
    if (!text.trim()) return;
    if (needKey()) return;
    await api.reloadSettings();
    const s = settingsFor('analysis');
    const lang = s.targetLang || '简体中文';

    let userContent = text.trim();
    if (S.quote) {
      userContent = '针对论文中的这段内容：\n"""\n' + S.quote + '\n"""\n\n' + userContent;
      S.quote = '';
      $('chat-quote').hidden = true;
      $('chat-quote').textContent = '';
    }

    addMsg('user', userContent);
    $('chat-text').value = '';

    const msgs = [];
    const withFull = $('chat-fulltext').checked;
    if (withFull && !S.chat.length) {
      await api.ensureText();
      const full = api.getFullText();
      const budget = Number(s.maxContextChars) || 90000;
      const ctx = selectContext(userContent, full, budget);
      msgs.push({ role: 'user', content: '以下是论文全文（可能有抽取噪声）：\n\n' + ctx + '\n\n请基于以上内容回答后续问题。' });
      msgs.push({ role: 'assistant', content: '好的，我已经读完这篇论文，请提问。' });
    }
    for (const m of S.chat) msgs.push(m);
    msgs.push({ role: 'user', content: userContent });

    const bubble = addMsg('assistant', '');
    bubble.innerHTML = '<p class="muted">思考中…</p>';
    S.chatAbort = new AbortController();
    $('btn-chat-stop').hidden = false;
    $('btn-chat-send').disabled = true;

    let acc = '';
    let last = 0;
    try {
      await llmStream(s, {
        system: chatSystem(lang, api.getTitle()),
        messages: msgs,
        maxTokens: 4096,
        temperature: 0.4,
        signal: S.chatAbort.signal,
        onDelta: (d) => {
          acc += d;
          const now = Date.now();
          if (now - last > 120) {
            last = now;
            bubble.innerHTML = renderMarkdown(acc);
            $('chat-list').scrollTop = $('chat-list').scrollHeight;
          }
        }
      });
      bubble.innerHTML = renderMarkdown(acc);
      S.chat.push({ role: 'user', content: userContent });
      S.chat.push({ role: 'assistant', content: acc });
      if (S.chat.length > 16) S.chat.splice(0, S.chat.length - 16);
    } catch (e) {
      if (e.name === 'AbortError') bubble.innerHTML = renderMarkdown(acc + '\n\n_（已停止）_');
      else bubble.innerHTML = '<p class="err">出错了：' + e.message + '</p>';
    } finally {
      S.chatAbort = null;
      $('btn-chat-stop').hidden = true;
      $('btn-chat-send').disabled = false;
      $('chat-list').scrollTop = $('chat-list').scrollHeight;
    }
  }

  $('btn-chat-send').onclick = () => send($('chat-text').value);
  $('btn-chat-stop').onclick = () => { if (S.chatAbort) S.chatAbort.abort(); };
  $('chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('chat-text').value); }
  });
  const sug = $('chat-suggest');
  if (sug) sug.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') send(e.target.textContent);
  });

  function setQuote(t) {
    S.quote = t;
    const q = $('chat-quote');
    q.hidden = false;
    q.textContent = t.length > 300 ? t.slice(0, 300) + '…' : t;
    const x = document.createElement('button');
    x.textContent = '×';
    x.onclick = () => { S.quote = ''; q.hidden = true; };
    q.prepend(x);
  }

  /* ---------- 大纲 ---------- */
  async function buildOutline() {
    if (S.outlineBuilt) return;
    const body = $('outline-body');
    const pages = api.getPages();
    const items = [];
    for (const p of pages) {
      if (!p.layout) continue;
      for (const b of p.layout.blocks) {
        if (!b.isHeading) continue;
        if (b.text.length > 90) continue;
        const m = b.text.match(/^\s*(\d{1,2})(\.\d{1,2})?(\.\d{1,2})?/);
        const lv = m ? (m[3] ? 3 : m[2] ? 2 : 1) : (b.fh > 12 ? 1 : 2);
        items.push({ page: p.num, text: b.text.trim(), lv });
      }
    }
    S.outlineBuilt = true;
    if (!items.length) { body.innerHTML = '<p class="muted">没有识别到章节标题。</p>'; return; }
    body.innerHTML = '';
    for (const it of items) {
      const a = document.createElement('a');
      a.className = 'lv' + it.lv;
      a.textContent = it.text;
      a.title = '第 ' + it.page + ' 页';
      a.onclick = () => api.gotoPage(it.page);
      body.appendChild(a);
    }
  }

  /* ---------- 对外接口 ---------- */
  return {
    onDocReady() {
      $('outline-body').innerHTML = '<p class="muted">正在解析全文…</p>';
      S.outlineBuilt = false;
      S.chat = [];
      S.analysisMd = '';
      $('analysis-body').innerHTML = '<p class="muted">点击「生成解读」，将自动提取全文并总结：创新点、技术核心方案、实验指标、优缺点、改进方案与复现要点。</p>';
      $('analysis-nav').innerHTML = '';
      setStatus('');
    },
    onTextReady() { buildOutline(); },
    handleSelection(act, text) {
      openSidebar('chat');
      if (act === 'ask') { setQuote(text); $('chat-text').focus(); return; }
      const lang = (api.getSettings() || {}).targetLang || '简体中文';
      if (act === 'translate') {
        S.quote = '';
        send('请把下面这段论文原文翻译成' + lang + '，只输出译文：\n"""\n' + text + '\n"""');
      } else if (act === 'explain') {
        S.quote = '';
        send(explainSelectionUser(text, lang));
      }
    },
    showTab
  };
}
