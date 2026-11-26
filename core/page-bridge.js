/*
 * 页面桥：把「找到要操作的那个标签页 + 确保脚本已注入」收敛到一处。
 *
 * 两处坑必须保留（都是线上踩过的）：
 *   1. 侧边栏可能被当成独立小窗打开，此时 currentWindow 的活动标签是扩展页自己，
 *      直接拿会报「没有可用的商品编辑页」→ 先排除 *-extension: 标签；
 *   2. 页面里可能还跑着上一版内容脚本，重复注入会让两套脚本同时处理同一次任务
 *      → 先握手，版本不一致就报错让用户刷新，而不是硬注入。
 */

import { probeVersion } from './message-bus.js';
import { isScriptVersionCompatible, staleScriptHint } from './version.js';

const EXTENSION_URL = /^(chrome|edge|moz)-extension:/i;

export function isExtensionTab(tab) {
  return EXTENSION_URL.test(String(tab && tab.url || ''));
}

/**
 * 取「真正要操作的页面」。
 * 顺序：当前窗口活动标签 → 最后聚焦窗口活动标签 → 任意一个抖店标签。
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
export async function resolveTargetTab() {
  const pick = async query => {
    const tabs = await chrome.tabs.query(query);
    return (tabs || []).find(tab => tab && tab.id && !isExtensionTab(tab)) || null;
  };

  let tab = await pick({ active: true, currentWindow: true });
  if (!tab) tab = await pick({ active: true, lastFocusedWindow: true });
  if (!tab) {
    const tabs = await chrome.tabs.query({ url: ['https://*.jinritemai.com/*'] });
    tab = (tabs || []).find(item => item && item.id) || null;
  }
  return tab;
}

/**
 * 确保页面里跑的是当前版本的内容脚本。
 * @param {number} tabId
 * @param {{ping: string, file: string}} options
 */
export async function ensureScript(tabId, { ping, file }) {
  if (!tabId) throw new Error('没有可用的标签页');
  const version = await probeVersion(tabId, ping);
  if (version && !isScriptVersionCompatible(version)) throw new Error(staleScriptHint(version));
  if (version) return version;
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  return '';
}

/** 目标页是否在抖店域名下（发布相似品必须，SKU 填充也建议） */
export function isDouyinUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'jinritemai.com' || host.endsWith('.jinritemai.com')
      || host === 'douyin.com' || host.endsWith('.douyin.com');
  } catch {
    return false;
  }
}
