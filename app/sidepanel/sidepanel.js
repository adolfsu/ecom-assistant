/*
 * 侧边栏主控：导航、路由、当前页面识别、主题。
 * 视图只负责渲染自己的内容，不直接碰 chrome.* 之外的东西（通过 ctx 拿能力）。
 */

import { h, clear, qs } from '../shared/dom.js';
import { icon } from '../shared/icons.js';
import { KEYS, read, write, getFavorites, toggleFavorite, pushRecent, onChange } from '../shared/storage.js';
import { activeTab, onTabsChanged } from '../../core/message-bus.js';
import { detectPlatform } from '../../core/platform-detector.js';
import { getFeature } from '../../core/feature-registry.js';
import { manifestVersion } from '../../core/version.js';
import '../../platforms/index.js';

import { render as renderHome } from './views/home.js';
import { render as renderFeatures } from './views/features.js';
import { render as renderFeatureDetail } from './views/feature-detail.js';
import { render as renderTasks } from './views/tasks.js';
import { render as renderSettings } from './views/settings.js';

/* ---------------- 导航 ---------------- */

const NAV = [
  { key: 'home', label: '首页', icon: 'home', hash: '#/home' },
  { key: 'features', label: '功能', icon: 'grid', hash: '#/features' },
  { key: 'tasks', label: '任务', icon: 'list', hash: '#/tasks' },
  { key: 'favorites', label: '收藏', icon: 'star', hash: '#/favorites' },
  { key: 'settings', label: '设置', icon: 'settings', hash: '#/settings' },
];

const VIEWS = {
  home: renderHome,
  features: renderFeatures,
  favorites: renderFeatures,
  feature: renderFeatureDetail,
  tasks: renderTasks,
  settings: renderSettings,
  notfound: null,
};

/* ---------------- 应用状态 ---------------- */

const state = {
  favorites: [],
  recent: [],
  runningCount: 0,
  theme: 'system',
};

const target = {
  tab: null,
  platform: null,
  page: null,
  url: '',
};

let currentRoute = { name: 'home', params: {} };

/* ---------------- 主题 ---------------- */

const mql = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme(mode) {
  if (mode === 'dark' || mode === 'light') return mode;
  return mql.matches ? 'dark' : 'light';
}

function applyTheme(mode) {
  state.theme = mode || 'system';
  document.documentElement.dataset.theme = resolveTheme(state.theme);
}

mql.addEventListener('change', () => {
  if (state.theme === 'system') applyTheme('system');
});

/* ---------------- 轻提示 ---------------- */

let toastTimer = 0;
function toast(text) {
  let node = qs('#toast');
  if (!node) {
    node = h('div', {
      id: 'toast',
      style: 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);'
        + 'padding:7px 14px;border-radius:999px;background:var(--c-text);color:var(--c-bg);'
        + 'font-size:12px;z-index:9;opacity:0;transition:opacity 180ms ease;pointer-events:none',
    });
    document.body.append(node);
  }
  node.textContent = text;
  node.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.style.opacity = '0'; }, 1800);
}

/* ---------------- 目标页面识别 ---------------- */

async function refreshTarget() {
  const tab = await activeTab();
  target.tab = tab;
  target.url = tab && tab.url ? tab.url : '';
  const detected = detectPlatform(target.url);
  target.platform = detected.platform;
  target.page = detected.page;
  drawTopbar();
}

function drawTopbar() {
  const box = qs('#topbarTarget');
  if (!box) return;
  clear(box);
  const label = target.platform
    ? `${target.platform.name}${target.page ? ` · ${target.page.name}` : ''}`
    : (target.url ? '未识别平台' : '没有活动标签页');
  box.append(
    h('span', { class: `dot ${target.platform ? 'dot-success' : ''}`.trim() }),
    h('span', { class: 'truncate', text: label }),
    target.tab && target.tab.title
      ? h('span', { class: 'truncate muted', text: `· ${target.tab.title}` })
      : null
  );
  box.title = target.url || '没有活动标签页';
}

/* ---------------- 渲染 ---------------- */

function buildRail() {
  const rail = qs('#rail');
  clear(rail);
  rail.append(h('div', { class: 'rail-logo', text: 'EC' }));
  for (const item of NAV) {
    rail.append(h('button', {
      class: `rail-item ${currentRoute.name === item.key ? 'is-active' : ''}`.trim(),
      onclick: () => navigate(item.hash),
      title: item.label,
    }, [
      h('span', { html: icon(item.icon) }),
      h('span', { text: item.label }),
    ]));
  }
  rail.append(h('div', { class: 'rail-foot' }, [
    h('button', {
      class: 'rail-item',
      title: `v${manifestVersion()}`,
      onclick: () => navigate('#/settings'),
    }, [
      h('span', { html: icon('info') }),
      h('span', { text: '关于' }),
    ]),
  ]));
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return { name: 'start', params: {} };
  const [head, ...rest] = raw.split('/');
  if (head === 'feature') return { name: 'feature', params: { featureId: rest[0] || '' } };
  if (VIEWS[head]) return { name: head, params: {} };
  return { name: 'notfound', params: {} };
}

const ctx = {
  get route() { return currentRoute; },
  get target() { return target; },
  state,
  navigate,
  refresh: () => draw(),
  applyTheme,
  toast,
  async toggleFavorite(featureId) {
    state.favorites = await toggleFavorite(featureId);
    draw();
  },
  openLegacyPanel() {
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 430,
      height: 700,
    }).catch(error => toast(`打不开旧版面板：${error.message}`));
  },
};

async function draw() {
  const view = qs('#view');
  if (!view) return;

  // 默认启动页
  if (currentRoute.name === 'start') {
    const start = await read(KEYS.startPage, '#/home');
    location.hash = start || '#/home';
    return;
  }

  const renderer = VIEWS[currentRoute.name];
  clear(view);
  if (!renderer) {
    view.append(h('div', { class: 'empty' }, [
      h('div', { class: 'empty-title', text: '页面不存在' }),
      h('p', { text: location.hash }),
    ]));
    return;
  }

  buildRail();
  try {
    const node = await renderer(ctx);
    view.append(node);
    view.scrollTop = 0;
  } catch (error) {
    view.append(h('div', { class: 'notice' }, [
      h('span', { html: icon('alert') }),
      h('div', {}, [
        h('div', { text: '页面渲染失败' }),
        h('div', { style: 'margin-top:2px;opacity:.85', text: error.message }),
      ]),
    ]));
  }
}

function navigate(hash) {
  if (!hash) return;
  if (location.hash === hash) {
    draw();
    return;
  }
  location.hash = hash;
}

/* ---------------- 启动 ---------------- */

async function bootstrap() {
  applyTheme(await read(KEYS.theme, 'system'));
  state.favorites = await getFavorites();
  state.recent = await read(KEYS.recent, []);

  const refreshBtn = qs('#refreshTarget');
  if (refreshBtn) refreshBtn.innerHTML = icon('refresh');

  await refreshTarget();

  // 从 Popup 跳过来时，直接落到它指定的页面/功能。
  // Popup 在 pointerdown 时写入、click 时打开面板，两者几乎同时发生，
  // 所以这里补一次短暂重试，避免面板启动比写入更快而读不到。
  let requested = await read(KEYS.panelState, '');
  if (!requested) {
    await new Promise(resolve => setTimeout(resolve, 120));
    requested = await read(KEYS.panelState, '');
  }
  if (requested) {
    await write(KEYS.panelState, '');
    location.hash = requested;
  }

  const pending = await read(KEYS.pendingFeature, '');
  if (pending) {
    await write(KEYS.pendingFeature, '');
    const feature = getFeature(pending);
    if (feature) {
      await pushRecent(pending);
      location.hash = `#/feature/${encodeURIComponent(pending)}`;
    }
  }

  currentRoute = location.hash ? parseRoute() : { name: 'start', params: {} };
  if (!location.hash) {
    location.hash = await read(KEYS.startPage, '#/home');
    return;
  }
  await draw();
}

window.addEventListener('hashchange', async () => {
  const previous = currentRoute.name;
  currentRoute = parseRoute();
  // 打开功能详情时记一笔「最近使用」
  if (currentRoute.name === 'feature' && previous !== 'feature') {
    const id = decodeURIComponent(currentRoute.params.featureId || '');
    if (getFeature(id)) {
      state.recent = await pushRecent(id);
    }
  }
  draw();
});

qs('#refreshTarget')?.addEventListener('click', async () => {
  await refreshTarget();
  toast('已刷新当前页面信息');
});

onTabsChanged(async () => {
  await refreshTarget();
  if (currentRoute.name === 'home' || currentRoute.name === 'feature') draw();
});

// 收藏/任务数变化时同步界面
onChange(changes => {
  if (changes[KEYS.favorites]) state.favorites = changes[KEYS.favorites].newValue || [];
});

bootstrap().catch(error => {
  const view = qs('#view');
  if (view) {
    view.textContent = `启动失败：${error.message}。请在 edge://extensions 重新加载扩展。`;
  }
});
