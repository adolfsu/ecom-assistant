/* 设置：外观、默认启动页、数据清理、版本与使用说明（方案 3.5 第一阶段范围）。 */

import { h } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { KEYS, read, write, ownedKeys, clearOwnedData } from '../../shared/storage.js';
import { manifestVersion } from '../../../core/version.js';

const THEMES = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const START_PAGES = [
  { value: '#/home', label: '首页' },
  { value: '#/features', label: '功能中心' },
  { value: '#/tasks', label: '任务中心' },
];

function settingRow(title, desc, control) {
  return h('div', { class: 'setting' }, [
    h('div', { class: 'setting-main' }, [
      h('div', { class: 'setting-title', text: title }),
      desc ? h('div', { class: 'setting-desc', text: desc }) : null,
    ]),
    control,
  ]);
}

export async function render(ctx) {
  const currentTheme = await read(KEYS.theme, 'system');
  const currentStart = await read(KEYS.startPage, '#/home');
  const keys = await ownedKeys();

  const themeSelect = h('select', {
    class: 'input',
    onchange: async event => {
      await write(KEYS.theme, event.target.value);
      ctx.applyTheme(event.target.value);
    },
  }, THEMES.map(item => h('option', { value: item.value, text: item.label, selected: item.value === currentTheme })));

  const startSelect = h('select', {
    class: 'input',
    onchange: async event => {
      await write(KEYS.startPage, event.target.value);
    },
  }, START_PAGES.map(item => h('option', { value: item.value, text: item.label, selected: item.value === currentStart })));

  const cleanBtn = h('button', {
    class: 'btn',
    onclick: async () => {
      const ok = confirm(`将清理本扩展自己的 ${keys.length} 项数据（表格缓存、进度、日志、偏好）。\n不会影响抖店页面里的任何内容。继续？`);
      if (!ok) return;
      const count = await clearOwnedData();
      ctx.toast(`已清理 ${count} 项数据`);
      ctx.refresh();
    },
  }, ['清理数据', h('span', { html: icon('trash') })]);

  return h('div', {}, [
    h('div', { class: 'page-head' }, [
      h('div', { class: 'grow' }, [
        h('h1', { class: 'page-title', text: '设置' }),
        h('p', { class: 'page-sub', text: '偏好存在本地，不上传任何服务器。' }),
      ]),
    ]),

    h('div', { class: 'card', style: 'margin-bottom:12px' }, [
      settingRow('外观主题', '深色主题已预留变量，切换即时生效', themeSelect),
      settingRow('默认启动页', '打开侧边栏时先显示的页面', startSelect),
    ]),

    h('div', { class: 'card', style: 'margin-bottom:12px' }, [
      settingRow(
        '数据清理',
        `当前有 ${keys.length} 项本地数据（表格缓存、进度、日志、偏好）`,
        cleanBtn
      ),
      settingRow(
        '旧版面板',
        '阶段一保留，用于回退到 0.9.0 的完整操作界面',
        h('button', { class: 'btn', onclick: () => ctx.openLegacyPanel() }, ['打开', h('span', { html: icon('external') })])
      ),
    ]),

    h('div', { class: 'card', style: 'margin-bottom:12px' }, [
      settingRow('版本', '当前扩展版本（读自 manifest）', h('span', { class: 'badge', text: `v${manifestVersion()}` })),
      settingRow('架构', '2.0 骨架：注册中心 + 侧边栏工作区', h('span', { class: 'badge', text: '阶段一' })),
    ]),

    h('div', { class: 'card' }, [
      h('div', { class: 'setting-title', style: 'margin-bottom:6px', text: '使用说明' }),
      h('ol', { style: 'margin:0;padding-left:18px;color:var(--c-muted);font-size:12px;line-height:1.8' }, [
        h('li', { text: '先在浏览器里打开抖店后台（商品列表或商品编辑页）。' }),
        h('li', { text: '点扩展图标 → 「打开完整面板」，或在侧边栏里直接操作。' }),
        h('li', { text: '功能执行始终发生在抖店页面内，本面板只负责配置与展示。' }),
        h('li', { text: '阶段一功能界面仍在迁移，完整操作请用「旧版面板」。' }),
      ]),
    ]),
  ]);
}
