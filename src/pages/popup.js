const $ = (id) => document.getElementById(id);
const viewerUrl = (u) => chrome.runtime.getURL('src/viewer/viewer.html') + (u ? '?file=' + u : '');

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  const url = tab && tab.url ? tab.url : '';
  const btn = $('open-current');
  const isPdfish = /\.pdf($|[?#])/i.test(url) || /arxiv\.org\/pdf\//i.test(url) || /openreview\.net\/(pdf|attachment)\?/i.test(url);
  const isViewer = url.indexOf(chrome.runtime.getURL('src/viewer/viewer.html')) === 0;

  if (isViewer) {
    btn.textContent = '当前已在 PaperLens 中';
    btn.disabled = true;
  } else if (isPdfish) {
    btn.disabled = false;
    btn.onclick = () => {
      chrome.tabs.update(tab.id, { url: viewerUrl(url) });
      window.close();
    };
  } else if (/^https?:/i.test(url)) {
    btn.textContent = '当前页面不是 PDF';
    btn.disabled = true;
  } else if (/^file:/i.test(url)) {
    btn.textContent = '本地文件：请用「打开本地 PDF」';
    btn.disabled = true;
  }
});

$('open-blank').onclick = () => {
  chrome.tabs.create({ url: viewerUrl('') });
  window.close();
};
$('open-options').onclick = () => {
  chrome.runtime.openOptionsPage();
  window.close();
};

chrome.storage.local.get('settings', ({ settings }) => {
  const s = settings || {};
  const el = $('status');
  const hasKey = !!s.apiKey || s.provider === 'ollama';
  if (!hasKey) {
    el.innerHTML = '<span class="warn">还没有配置 API Key</span> —— 点上面的「设置」填入模型服务信息后即可翻译与解读。';
  } else {
    el.textContent = '服务：' + (s.provider || 'deepseek') + ' · 模型：' + (s.model || '默认')
      + (s.autoOpenPdf === false ? ' · 未接管 PDF 链接' : ' · 已接管 PDF 链接');
  }
});
