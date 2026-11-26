/*
 * 消息总线：把「发消息」这件事收敛到一个地方。
 * 阶段一只做两件事：给现有协议套一层超时与错误归一化；为后续任务协议留好出口。
 * 注意：现有 content.js / similar.js 的协议名**不改**，否则等于重写执行链路。
 */

/** 现有协议名集中登记，避免各处散落字符串字面量 */
export const MSG = {
  // SKU 填充（content.js）
  PING: 'PING',
  DIAGNOSE: 'DIAGNOSE',
  BATCH_FILL: 'BATCH_FILL',
  // 发布相似品（similar.js）
  SIMILAR_PING: 'SIMILAR_PING',
  SIMILAR_DIAG: 'SIMILAR_DIAG',
  SIMILAR_RUN: 'SIMILAR_RUN',
  SIMILAR_NEXT: 'SIMILAR_NEXT',
  SIMILAR_STOP: 'SIMILAR_STOP',
  SIMILAR_PUBLISH: 'SIMILAR_PUBLISH',
  SIMILAR_PUBLISH_DONE: 'SIMILAR_PUBLISH_DONE',
  SIMILAR_OPENED: 'SIMILAR_OPENED',
  SIMILAR_CANCEL: 'SIMILAR_CANCEL',
  SIMILAR_LOG: 'SIMILAR_LOG',
  SIMILAR_REGISTER_LIST: 'SIMILAR_REGISTER_LIST',
  SIMILAR_GRAB_URL: 'SIMILAR_GRAB_URL',
  // 批量复制变体（同一个 similar.js，走变体队列分支）
  VARIANT_RUN: 'VARIANT_RUN',
  VARIANT_STOP: 'VARIANT_STOP',
  VARIANT_QUICK_CHECK: 'VARIANT_QUICK_CHECK',
};

export class MessageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'MessageError';
    if (cause) this.cause = cause;
  }
}

function withTimeout(promise, timeout, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MessageError(`${label}超时（${timeout}ms）`)), timeout);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

/** 发给后台（service worker） */
export async function toBackground(message, timeout = 8000) {
  try {
    return await withTimeout(chrome.runtime.sendMessage(message), timeout, '后台响应');
  } catch (error) {
    if (error instanceof MessageError) throw error;
    throw new MessageError(`无法连接后台：${error.message}`, error);
  }
}

/** 发给指定标签页的内容脚本 */
export async function toTab(tabId, message, timeout = 60000) {
  if (!tabId) throw new MessageError('没有可用的标签页');
  try {
    return await withTimeout(chrome.tabs.sendMessage(tabId, message), timeout, '页面响应');
  } catch (error) {
    if (error instanceof MessageError) throw error;
    throw new MessageError(`页面脚本没有响应：${error.message}`, error);
  }
}

/**
 * 探测页面脚本版本。
 * 返回 null 表示没注入；返回字符串表示页面里跑的是哪个版本。
 * 版本比对统一交给调用方，用 manifest.version 做基准（见 core/version.js）。
 */
export async function probeVersion(tabId, pingType) {
  try {
    const pong = await toTab(tabId, { type: pingType }, 2500);
    return pong && pong.version ? String(pong.version) : null;
  } catch {
    return null;
  }
}

/** 取当前活动标签页；侧边栏里 currentWindow 可能解析不到，退回最后聚焦窗口 */
export async function activeTab() {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].id) {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  return tabs[0] || null;
}

/** 订阅标签页切换/更新，用于刷新「当前关联页面」 */
export function onTabsChanged(callback) {
  const onActivated = () => callback();
  const onUpdated = (tabId, info) => { if (info.status === 'complete' || info.url) callback(); };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  return () => {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
}
