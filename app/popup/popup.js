/*
 * 弹窗：只负责「品牌 + 当前平台 + 常用功能 + 打开完整面板」。
 * 任何配置、日志、执行控制都不放这里（方案 2.1）。
 */

import { h, clear, qs } from '../shared/dom.js';
import { icon } from '../shared/icons.js';
import { KEYS, read, write, getFavorites } from '../shared/storage.js';
import { activeTab } from '../../core/message-bus.js';
import { detectPlatform } from '../../core/platform-detector.js';
import { listFeatures, getFeature } from '../../core/feature-registry.js';
import { manifestVersion } from '../../core/version.js';
import '../../platforms/index.js';

const SIDE_PANEL_URL = 'app/sidepanel/index.html';

async function applyTheme() {
  const mode = await read(KEYS.theme, 'system');
  const dark = mode === 'dark'
    || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/**
 * 记录「面板该落在哪一页」。
 * 必须在点击之前写好（用 pointerdown），因为 chrome.sidePanel.open 要求用户手势，
 * 点击回调里一旦 await 存储写入，手势就失效、面板打不开。
 */
function remember(hash) {
  if (!hash) return;
  write(KEYS.panelState, hash).catch(() => {});
}

/**
 * 打开侧边栏。
 * 用回调式的 windows.getCurrent，避免 await 打断用户手势；
 * 侧边栏不可用时退回独立小窗，保证入口永远可用。
 */
function openSidePanel() {
  const fallback = () => {
    chrome.windows.create({
      url: chrome.runtime.getURL(SIDE_PANEL_URL),
      type: 'popup',
      width: 440,
      height: 720,
    }).catch(() => {}).finally(() => window.close());
  };

  try {
    chrome.windows.getCurrent(win => {
      if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function' && win && win.id) {
        chrome.sidePanel.open({ windowId: win.id }).then(() => window.close(), fallback);
      } else {
        fallback();
      }
    });
  } catch {
    fallback();
  }
}

async function renderTarget() {
  const box = qs('#targetCard');
  const sub = qs('#brandSub');
  clear(box);

  const tab = await activeTab();
  const detected = detectPlatform(tab && tab.url ? tab.url : '');
  const platform = detected.platform;

  if (!platform) {
    sub.textContent = tab ? '未识别平台' : '没有活动标签页';
    box.append(h('div', { class: 'empty-mini' },
      '切到抖店后台的任意页面，这里会显示平台与页面类型。功能入口照常可用。'));
    return { platform: null, page: null };
  }

  const page = detected.page;
  sub.textContent = `${platform.name}${page ? ` · ${page.name}` : ''}`;
  box.append(h('div', { class: 'target-row' }, [
    h('span', { class: 'quick-icon', html: icon(platform.icon) }),
    h('div', { class: 'grow' }, [
      h('div', { class: 'target-name', text: platform.name }),
      h('div', { class: 'target-desc', text: page ? page.name : '未识别页面类型' }),
    ]),
    h('span', {
      class: `badge ${page ? 'badge-success' : 'badge-warn'}`.trim(),
      text: page ? '已就绪' : '请切到列表/编辑页',
    }),
  ]));
  return { platform, page };
}

async function renderQuick(current) {
  const box = qs('#quickBox');
  clear(box);

  const favorites = await getFavorites();
  const all = listFeatures({});
  const preferred = all.filter(item => favorites.includes(item.featureId));
  const rest = all.filter(item => !favorites.includes(item.featureId));
  const items = [...preferred, ...rest].slice(0, 3);

  box.append(h('div', { class: 'quick-head' }, [
    h('span', { class: 'quick-title', text: favorites.length ? '常用功能' : '功能' }),
    h('button', {
      class: 'btn btn-ghost btn-sm',
      onpointerdown: () => remember('#/features'),
      onclick: () => openSidePanel(),
    }, ['全部', h('span', { html: icon('chevronRight') })]),
  ]));

  if (!items.length) {
    box.append(h('div', { class: 'empty-mini' }, '还没有注册任何功能'));
    return;
  }

  const list = h('div', { class: 'quick-list' });
  for (const feature of items) {
    const ready = current.page && feature.supportedPages.includes(current.page.key);
    const hash = `#/feature/${encodeURIComponent(feature.featureId)}`;
    list.append(h('button', {
      class: 'quick-item',
      onpointerdown: () => remember(hash),
      onclick: () => openSidePanel(),
    }, [
      h('span', { class: 'quick-icon', html: icon(feature.icon) }),
      h('div', { class: 'quick-main' }, [
        h('div', { class: 'quick-name truncate', text: feature.name }),
        h('div', { class: 'quick-desc truncate', text: feature.description }),
      ]),
      ready ? h('span', { class: 'dot dot-success', title: '当前页面可用' }) : null,
      h('span', { class: 'i', html: icon('chevronRight') }),
    ]));
  }
  box.append(list);
}

async function bootstrap() {
  await applyTheme();

  const settingsBtn = qs('#openSettings');
  settingsBtn.innerHTML = icon('settings');
  settingsBtn.addEventListener('pointerdown', () => remember('#/settings'));
  settingsBtn.addEventListener('click', () => openSidePanel());

  qs('#openPanel').addEventListener('click', () => openSidePanel());

  const current = await renderTarget();
  await renderQuick(current);

  document.title = `电商小助手 v${manifestVersion()}`;
}

bootstrap().catch(error => {
  const sub = qs('#brandSub');
  if (sub) sub.textContent = `加载失败：${error.message}`;
});

// 供调试时确认注册表已加载
window.__ecomPopupReady = () => Boolean(getFeature('douyin.sku-fill'));
