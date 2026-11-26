/*
 * 平台识别：把「当前标签页 URL」翻译成「哪个平台、哪个页面」。
 * 侧边栏与弹窗都调用这里，保证两边判断一致。
 */

import { listPlatforms } from './platform-registry.js';

/** URL 是否属于该平台的域名（后缀匹配，允许子域） */
export function matchDomain(url, domains) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some(domain => {
    const target = String(domain || '').toLowerCase().replace(/^\*\.?/, '');
    return host === target || host.endsWith(`.${target}`);
  });
}

/**
 * 页面匹配：平台的 supportedPages 形如
 *   { key:'product-list', name:'商品列表', test:/\/(product\/)?list/ }
 * 没声明 supportedPages 时返回 null（只识别到平台，不细分页面）。
 */
export function matchPage(url, pages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  for (const page of pages) {
    const rule = page.test;
    if (rule instanceof RegExp && rule.test(url)) return page;
    if (typeof page.pattern === 'string' && url.includes(page.pattern)) return page;
  }
  return null;
}

/**
 * @returns {{platform: object|null, page: object|null, url: string}}
 */
export function detectPlatform(url) {
  const target = String(url || '');
  if (!target) return { platform: null, page: null, url: '' };
  for (const platform of listPlatforms()) {
    if (matchDomain(target, platform.domains)) {
      return { platform, page: matchPage(target, platform.supportedPages), url: target };
    }
  }
  return { platform: null, page: null, url: target };
}

/** 展示用文案 */
export function describeTarget(detected) {
  if (!detected || !detected.platform) return { label: '未识别平台', tone: 'muted' };
  const name = detected.platform.name;
  const page = detected.page ? detected.page.name : '未识别页面';
  return { label: `${name} · ${page}`, tone: detected.page ? 'primary' : 'warn' };
}
