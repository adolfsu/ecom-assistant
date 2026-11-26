/*
 * 后台服务：发布相似品流程的「接线员」
 * 自身不保存队列，只做四件事：
 *   1. 记住列表页标签 id
 *   2. 列表页点「确认」前先登记任务，之后盯住**新出现**的发布页
 *   3. 发布页加载完成后通知它点「发布商品」
 *   4. 发布页报告结果后关闭该标签页，并把结果信号转给列表页
 * 队列状态存 chrome.storage，弹窗关掉、后台休眠都不会中断流程。
 */

const LIST_TAB_KEY = 'similarListTabId';
const PENDING_KEY = 'similarPending';
const LOG_KEY = 'similarDebug';
const PENDING_TTL = 180000;

/**
 * 注入到页面「主世界」的钩子：记录平台自己调 window.open 的结果。
 * 用户的点击是脚本合成的（isTrusted=false），浏览器不给"用户激活"，平台的
 * window.open 很可能直接被弹窗拦截（返回 null）。这时弹窗会被平台关掉，
 * 新标签页却一个都没有 —— 表现就是"弹窗闪一下没了"。
 * 记下 URL 和是否成功，被拦时由扩展自己 chrome.tabs.create 补开。
 */
const OPEN_HOOK = () => {
  if (window.__similarOpenPatched) return;
  window.__similarOpenPatched = true;
  window.__similarOpenedUrls = [];
  const rawOpen = window.open.bind(window);
  window.open = function patchedOpen(url, ...rest) {
    let handle = null;
    try {
      handle = rawOpen(url, ...rest);
    } catch (error) {
      handle = null;
    }
    try {
      window.__similarOpenedUrls.push({ url: String(url || ''), opened: Boolean(handle) });
    } catch (error) {
      /* 忽略 */
    }
    return handle;
  };
};

/** 记录一条运行日志，面板里可以查看，便于定位“卡在哪一步” */
function log(text, channel = '') {
  const stamp = new Date().toTimeString().slice(0, 8);
  // 两个功能各看各的日志，别混在一起
  const key = channel === 'variant' ? 'variantDebug' : LOG_KEY;
  chrome.storage.local.get([key])
    .then(data => {
      const list = Array.isArray(data[key]) ? data[key] : [];
      list.push(`${stamp} ${text}`);
      // 避免日志无限增长：超过 60 条只保留最近 60 条
      return chrome.storage.local.set({ [key]: list.slice(-60) });
    })
    .catch(() => {});
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => null);
}

/** 把「这一条的结果」转回列表页，由列表页继续下一条 */
async function notifyList(payload) {
  const data = await chrome.storage.local.get([LIST_TAB_KEY]);
  const listTabId = data[LIST_TAB_KEY];
  if (!listTabId) return false;
  const sent = await sendToTab(listTabId, { type: 'SIMILAR_NEXT', ...payload });
  return Boolean(sent);
}

async function ensureSimilar(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'SIMILAR_PING' });
    if (pong && pong.version) return true;
  } catch {
    /* 尚未注入 */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['similar.js'] });
    return true;
  } catch (error) {
    log(`注入发布页脚本失败：${error.message}`);
    return false;
  }
}

async function triggerPublish(tabId, attempt = 0) {
  const ready = await ensureSimilar(tabId);
  if (ready) {
    // 变体任务要在发布前先填标题、换主图；普通相似品没有这一步
    const data = await chrome.storage.local.get([PENDING_KEY]);
    const pending = data[PENDING_KEY] || {};
    const result = await sendToTab(tabId, { type: 'SIMILAR_PUBLISH', variant: Boolean(pending.variant) });
    if (result && result.ok) {
      log(result.filled
        ? `标签 ${tabId} 已填好两个标题与主图（本版不发布）`
        : `标签 ${tabId} 已开始点击「发布商品」`);
      return;
    }
    // 页面自己会回报失败原因，这里不重复触发
    if (result && result.error) {
      log(`标签 ${tabId} 自动发布失败：${result.error}`);
      return;
    }
  }
  if (attempt < 3) {
    log(`标签 ${tabId} 尚未就绪，1.5 秒后重试（${attempt + 1}/3）`);
    setTimeout(() => triggerPublish(tabId, attempt + 1), 1500);
  } else {
    log(`标签 ${tabId} 始终无法建立脚本连接，请手动刷新该页后重试`);
    // 明确回报失败，别让列表页干等 4 分钟超时
    notifyList({ ok: false, reason: '发布页脚本没能注入，可能是该页加载异常' });
  }
}

async function handleReleaseTab(tabId) {
  const data = await chrome.storage.local.get([PENDING_KEY]);
  const pending = data[PENDING_KEY];
  if (!pending) {
    log(`忽略标签 ${tabId}：当前没有待处理的发布任务`);
    return;
  }
  if (Date.now() - Number(pending.at || 0) > PENDING_TTL) {
    chrome.storage.local.remove(PENDING_KEY).catch(() => {});
    log('发布任务已超时，清理登记');
    return;
  }
  if (pending.sent && pending.tabId === tabId) return;
  if (pending.tabId && pending.tabId !== tabId) return;

  // 点「确认」之前就存在的标签页不算本次新开的发布页（防止误碰手动开着的创建页）；
  // 但由本次点击新建的标签（onCreated 记录过）即使出现在快照里也要放行。
  const knownBefore = Array.isArray(pending.before) && pending.before.includes(tabId);
  const createdNow = Array.isArray(pending.created) && pending.created.includes(tabId);
  if (knownBefore && !createdNow) {
    log(`忽略标签 ${tabId}：它在点击「确认」前就已存在`);
    return;
  }

  await chrome.storage.local.set({ [PENDING_KEY]: { ...pending, tabId, sent: true } });
  log(`接管发布页标签 ${tabId}，通知它点击「发布商品」`);
  await triggerPublish(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const senderTabId = sender.tab ? sender.tab.id : null;

  if (message.type === 'SIMILAR_REGISTER_LIST') {
    chrome.storage.local.set({ [LIST_TAB_KEY]: senderTabId });
    log(`列表页已登记：标签 ${senderTabId}`);
    reply({ ok: true });
    return;
  }

  if (message.type === 'SIMILAR_OPENED') {
    // 此时还没点「确认」，快照里不会有即将新建的发布页
    (async () => {
      const tabs = await chrome.tabs.query({});
      await chrome.storage.local.set({
        [PENDING_KEY]: {
          id: message.id || '',
          variant: Boolean(message.variant),
          at: Date.now(),
          tabId: null,
          sent: false,
          created: [],
          before: tabs.map(tab => tab.id)
        }
      });
      // 点确认之前装上 window.open 钩子，才能知道平台到底有没有尝试打开新页
      try {
        await chrome.scripting.executeScript({ target: { tabId: senderTabId }, world: 'MAIN', func: OPEN_HOOK });
      } catch (error) {
        log(`安装 window.open 钩子失败：${error.message}`);
      }
      log(`已登记商品 ${message.id || ''}，等待新标签页出现`);
      reply({ ok: true });
    })().catch(() => reply({ ok: false }));
    return true;
  }

  if (message.type === 'SIMILAR_GRAB_URL') {
    // 平台调了 window.open 但被弹窗拦截（返回 null）时，由扩展自己把发布页开出来
    (async () => {
      let list = [];
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: senderTabId },
          world: 'MAIN',
          func: () => window.__similarOpenedUrls || []
        });
        list = (results && results[0] && results[0].result) || [];
      } catch (error) {
        log(`读取 window.open 记录失败：${error.message}`);
      }
      const blocked = list.filter(item => item && item.url && !item.opened);
      const last = blocked[blocked.length - 1];
      if (!last) {
        reply({ ok: true, opened: false, captured: list.length, succeeded: list.filter(item => item && item.opened).length });
        return;
      }
      try {
        const tab = await chrome.tabs.create({ url: last.url, active: true });
        log(`平台弹窗被浏览器拦截，已由扩展打开发布页：${last.url}`);
        reply({ ok: true, opened: true, url: last.url, tabId: tab ? tab.id : null });
      } catch (error) {
        log(`扩展代打开发布页失败：${error.message}`);
        reply({ ok: false, opened: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === 'SIMILAR_CANCEL') {
    // 点了确认却没成功，撤销登记，避免误接管别的页面
    chrome.storage.local.remove(PENDING_KEY);
    log('发布页未成功打开，已撤销登记');
    reply({ ok: true });
    return;
  }

  if (message.type === 'SIMILAR_LOG') {
    // 页面脚本的步骤日志，和后台日志写在同一处，面板里一起看
    log(String(message.text || ''), message.channel || '');
    reply({ ok: true });
    return;
  }

  if (message.type === 'SIMILAR_PUBLISH_DONE') {
    const publishTabId = senderTabId;
    chrome.storage.local.remove(PENDING_KEY).catch(() => {});
    log(`发布页回报：${message.ok ? (message.filled ? '已填好（未发布）' : '成功') : `失败（${message.reason || '无原因'}）`}`);
    (async () => {
      const data = await chrome.storage.local.get([LIST_TAB_KEY]);
      const listTabId = data[LIST_TAB_KEY];
      // 成功才关闭发布页；失败保留页面，方便人工看校验提示。
      // 裂变链接一次会开十几二十个，失败页全留着反而看不到重点，
      // 失败原因已经随结果回传，所以变体模式下成败都关。
      // 只填不发（keepTab）时不关：用户要自己核对标题和主图。
      if (publishTabId && !message.keepTab && (message.ok || message.variant) && publishTabId !== listTabId) {
        await chrome.tabs.remove(publishTabId).catch(() => {});
      }
      if (!listTabId) {
        reply({ ok: false, error: '列表页标签已关闭' });
        return;
      }
      if (message.keepTab) {
        // 只填模式：发布页留在那里，把列表页切回前台，
        // 否则列表页一直在后台，定时器被节流、平台的 window.open 也更容易被拦
        await chrome.tabs.update(listTabId, { active: true }).catch(() => {});
      }
      const forwarded = await notifyList({
        ok: Boolean(message.ok),
        filled: Boolean(message.filled),
        reason: message.reason || '',
        issues: Array.isArray(message.issues) ? message.issues : []
      });
      log(forwarded ? '结果已转回列表页' : '列表页没有响应，可能已被刷新');
      reply({ ok: true, forwarded });
    })();
    return true;
  }
});

// 记录本次点击新建的标签页，作为「它是新开的」的凭据
chrome.tabs.onCreated.addListener(tab => {
  chrome.storage.local.get([PENDING_KEY])
    .then(data => {
      const pending = data[PENDING_KEY];
      if (!pending || pending.sent) return;
      if (Date.now() - Number(pending.at || 0) > PENDING_TTL) return;
      const created = Array.isArray(pending.created) ? pending.created : [];
      if (created.includes(tab.id)) return;
      created.push(tab.id);
      return chrome.storage.local.set({ [PENDING_KEY]: { ...pending, created } });
    })
    .catch(() => {});
});

// 新标签页（或同页跳转）打开商品发布页后，等它加载完再通知它点发布
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = tab && tab.url ? tab.url : '';
  if (!/jinritemai\.com/i.test(url)) return;
  // 发布页路径各版本不一致（create / create-v2 / edit 都可能），只排除列表页，
  // 由页面脚本自己确认有没有「发布商品」按钮
  if (url.indexOf('/list') >= 0) return;
  handleReleaseTab(tabId);
});

/** 让扩展图标直接打开侧边栏（面板不会因切换标签页而关闭）；浏览器不支持时静默跳过 */
function setupSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

setupSidePanel();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['similarRun', PENDING_KEY]).catch(() => {});
  setupSidePanel();
});

chrome.runtime.onStartup.addListener(setupSidePanel);
