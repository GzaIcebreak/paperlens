/* 公式排版：按需加载本地 KaTeX，把 md.js 产出的 .pl-math 节点渲染成公式。
 * KaTeX 有 266KB，只有真正出现公式时才加载，不拖慢阅读器启动。 */

let loading = null;

function loadKatex() {
  if (window.katex) return Promise.resolve(window.katex);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('vendor/katex/katex.min.js');
    s.onload = () => (window.katex ? resolve(window.katex) : reject(new Error('KaTeX 未挂载')));
    s.onerror = () => reject(new Error('KaTeX 加载失败'));
    document.head.appendChild(s);
  });
  loading.catch(() => { loading = null; });   // 失败后允许重试
  return loading;
}

/**
 * 渲染容器内尚未处理的公式节点。
 * 流式输出时会被反复调用，已渲染的节点用 data-done 跳过。
 */
export async function typesetMath(root) {
  if (!root) return;
  const nodes = root.querySelectorAll('.pl-math:not([data-done])');
  if (!nodes.length) return;

  let katex;
  try {
    katex = await loadKatex();
  } catch (e) {
    console.warn('[PaperLens]', e.message, '公式将以原始 LaTeX 显示');
    return;
  }

  nodes.forEach(el => {
    const tex = el.getAttribute('data-tex') || '';
    if (!tex) return;
    try {
      katex.render(tex, el, {
        displayMode: el.getAttribute('data-display') === '1',
        throwOnError: false,      // 语法错误时按原样标红显示，不炸整页
        strict: 'ignore',         // 容忍模型偶尔写出的非标准宏
        trust: false,
        maxExpand: 1000
      });
      el.setAttribute('data-done', '1');
    } catch (e) {
      el.setAttribute('data-done', 'err');   // 保留兜底的原始 TeX 文本
    }
  });
}
