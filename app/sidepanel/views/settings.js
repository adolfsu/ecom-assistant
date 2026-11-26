/* 设置：外观、默认启动页、数据清理、版本与使用说明（方案 3.5 第一阶段范围）。 */

import { h } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { KEYS, read, write, ownedKeys, clearOwnedData } from '../../shared/storage.js';
import { probeFrame } from '../../shared/probe.js';
import { copyWithFeedback } from '../../shared/clipboard.js';
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

  /* ---------- 页面结构探测 ---------- */

  const savedProbe = await read(KEYS.probeResult, '');
  const probeOut = h('pre', {
    class: 'diag-box',
    style: `max-height:420px;margin-top:10px${savedProbe ? '' : ';display:none'}`,
    text: savedProbe || '',
  });
  const copyProbeBtn = h('button', {
    class: 'btn btn-sm btn-ghost',
    onclick: () => copyWithFeedback(copyProbeBtn, probeOut.textContent || ''),
  }, '复制结果');
  copyProbeBtn.hidden = !savedProbe;

  const probeBtn = h('button', {
    class: 'btn',
    onclick: async () => {
      probeBtn.disabled = true;
      probeOut.style.display = 'block';
      probeOut.textContent = '正在读取当前页面结构…';
      copyProbeBtn.hidden = true;
      try {
        // 侧边栏不是标签页，所以要自己挑目标：优先当前窗口的活动页，其次最近聚焦窗口
        const usable = (tabs) => tabs.filter(tab => tab.url && !/^(chrome|edge)-extension:/.test(tab.url));
        let tabs = usable(await chrome.tabs.query({ active: true, currentWindow: true }));
        if (!tabs.length) tabs = usable(await chrome.tabs.query({ active: true, lastFocusedWindow: true }));
        if (!tabs.length) tabs = usable(await chrome.tabs.query({ active: true }));
        const tab = tabs[0];
        if (!tab) throw new Error('没有找到可探测的网页，请先切到抖店的商品编辑页');
        if (!/^https:\/\/[^/]*\.(jinritemai|douyin)\.com\//.test(tab.url)) {
          throw new Error(`当前标签页不是抖店页面：${tab.url}`);
        }

        // allFrames：素材库若是内嵌 iframe，也一并读到；跨域无法注入的会被跳过
        const frames = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: probeFrame,
        });
        const parts = frames.map(item => item.result).filter(text => typeof text === 'string' && text.trim());
        const head = [
          `标签页：${tab.title || '（无标题）'}`,
          `地址：${tab.url}`,
          `响应 frame：${parts.length} 个（共注入 ${frames.length} 个）`,
        ].join('\n');
        probeOut.textContent = parts.length
          ? `${head}\n\n${parts.join('\n\n')}`
          : `${head}\n\n没有任何 frame 返回内容：页面可能没加载完，或素材库来自未授权的域名。`;
        copyProbeBtn.hidden = false;
        await write(KEYS.probeResult, probeOut.textContent);
      } catch (error) {
        probeOut.textContent = `探测失败：${error.message}\n\n请确认：① 当前标签页是抖店页面；② 素材库弹窗已经打开；③ 页面已加载完成。`;
        copyProbeBtn.hidden = false;
        await write(KEYS.probeResult, probeOut.textContent);
      } finally {
        probeBtn.disabled = false;
      }
    },
  }, ['探测当前页面', h('span', { html: icon('search') })]);

  const probeCard = h('div', { class: 'card', style: 'margin-bottom:12px' }, [
    h('div', { class: 'setting-title', text: '页面结构探测' }),
    h('div', { class: 'setting-desc' }, [
      '给新功能读取页面结构用。用法：打开商品编辑页 → 点主图的「上传 / 选择图片」→ 等素材列表出来 → 回到这里点「探测当前页面」。',
    ]),
    h('div', { class: 'tool-row' }, [probeBtn, copyProbeBtn]),
    probeOut,
  ]);

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
        '阶段一保留，用于回退到旧版的完整操作界面',
        h('button', { class: 'btn', onclick: () => ctx.openLegacyPanel() }, ['打开', h('span', { html: icon('external') })])
      ),
    ]),

    h('div', { class: 'card', style: 'margin-bottom:12px' }, [
      settingRow('版本', '当前扩展版本（读自 manifest）', h('span', { class: 'badge', text: `v${manifestVersion()}` })),
      settingRow('架构', '2.0 骨架：注册中心 + 侧边栏工作区', h('span', { class: 'badge', text: '阶段一' })),
    ]),

    probeCard,

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
