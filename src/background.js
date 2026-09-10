/* PaperLens — background service worker
 * 负责：PDF 自动接管（declarativeNetRequest 动态规则）、右键菜单、打开阅读器。 */

const RULE_IDS = [1001, 1002, 1003];

function viewerUrl(fileUrl) {
  // file 参数放在最后，viewer 端取 '?file=' 之后的原始子串还原，
  // 因此原始 URL 里的 ? 与 & 都不会被破坏。
  return chrome.runtime.getURL('src/viewer/viewer.html') + '?file=' + fileUrl;
}

function buildRules() {
  const base = chrome.runtime.getURL('src/viewer/viewer.html') + '?file=';
  // 整个 URL 用一个捕获组包起来，再用 \1 回填；\0（整段匹配）并非所有 Chrome 版本都支持。
  const sub = base + '\\1';
  return [
    {
      id: RULE_IDS[0],
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: sub } },
      condition: {
        regexFilter: '^(https?://[^?#]+\\.pdf(?:[?#].*)?)$',
        resourceTypes: ['main_frame']
      }
    },
    {
      id: RULE_IDS[1],
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: sub } },
      condition: {
        // arXiv 新式链接没有 .pdf 后缀：https://arxiv.org/pdf/2401.01234v2
        regexFilter: '^(https?://(?:[a-z0-9-]+\\.)?arxiv\\.org/pdf/[^?#]*)$',
        resourceTypes: ['main_frame']
      }
    },
    {
      id: RULE_IDS[2],
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: sub } },
      condition: {
        regexFilter: '^(https?://(?:[a-z0-9-]+\\.)?openreview\\.net/(?:pdf|attachment)\\?.*)$',
        resourceTypes: ['main_frame']
      }
    }
  ];
}

async function syncRules() {
  const { settings } = await chrome.storage.local.get('settings');
  const enabled = !settings || settings.autoOpenPdf !== false;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: RULE_IDS,
      addRules: enabled ? buildRules() : []
    });
  } catch (e) {
    console.warn('[PaperLens] 更新 PDF 接管规则失败:', e);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await syncRules();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'paperlens-open-link',
      title: '用 PaperLens 打开此 PDF 链接',
      contexts: ['link']
    });
    chrome.contextMenus.create({
      id: 'paperlens-open-page',
      title: '用 PaperLens 打开当前页面 (PDF)',
      contexts: ['page']
    });
  });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/options.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(syncRules);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    const oldV = changes.settings.oldValue || {};
    const newV = changes.settings.newValue || {};
    if (oldV.autoOpenPdf !== newV.autoOpenPdf) syncRules();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const target = info.menuItemId === 'paperlens-open-link' ? info.linkUrl : info.pageUrl;
  if (!target) return;
  chrome.tabs.create({ url: viewerUrl(target), index: tab ? tab.index + 1 : undefined });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'open-viewer' && msg.url) {
    chrome.tabs.create({ url: viewerUrl(msg.url) });
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'sync-rules') {
    syncRules().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
