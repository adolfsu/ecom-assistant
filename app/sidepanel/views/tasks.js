/*
 * 任务中心。
 * 数据来自 storage 的 tasks 键：每个功能在开始/进度回传/面板重开恢复时补记一条，
 * 同一个 runId 只对应一条，不会重复。没有数据就明确显示「暂无」，绝不伪造进度。
 */

import { h, clear, timeAgo } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { read, KEYS, onChange } from '../../shared/storage.js';
import { clearFinishedTasks, isFinishedTask } from '../../shared/tasks.js';
import { getFeature } from '../../../core/feature-registry.js';
import { emptyState, platformName } from './components.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '进行中', match: ['running', 'paused', 'pending'] },
  { key: 'completed', label: '已完成', match: ['completed'] },
  { key: 'failed', label: '失败', match: ['failed', 'completed_with_errors'] },
  { key: 'cancelled', label: '已取消', match: ['cancelled'] },
  { key: 'interrupted', label: '已中断', match: ['interrupted'] },
];

const STATUS_META = {
  pending: { text: '等待中', cls: '' },
  running: { text: '执行中', cls: 'badge-primary' },
  paused: { text: '已暂停', cls: 'badge-warn' },
  completed: { text: '已完成', cls: 'badge-success' },
  completed_with_errors: { text: '部分失败', cls: 'badge-warn' },
  failed: { text: '失败', cls: 'badge-error' },
  cancelled: { text: '已取消', cls: '' },
  interrupted: { text: '已中断', cls: 'badge-error' },
};

export async function render(ctx) {
  let list = [];
  let active = 'all';

  const listBox = h('div', {});
  const tabs = h('div', { class: 'tabs' });
  // 「清理」两段式：第一次点变成「确认清理 N 条」，4 秒内再点才真删。
  // 侧边栏里没有原生确认框，做成按钮自己确认更稳，也不会误删
  let confirming = false;
  let confirmTimer = 0;
  const cleanBtn = h('button', { class: 'btn btn-sm', type: 'button' });
  const hint = h('p', { class: 'page-hint', text: '' });

  const root = h('div', {}, [
    h('div', { class: 'page-head' }, [
      h('div', { class: 'grow' }, [
        h('h1', { class: 'page-title', text: '任务中心' }),
        h('p', { class: 'page-sub', text: '每次执行都会留下记录，关闭弹窗或侧边栏不影响任务本身。' }),
      ]),
      cleanBtn,
    ]),
    hint,
    tabs,
    listBox,
  ]);

  function drawClean() {
    const removable = list.filter(task => isFinishedTask(task)).length;
    const running = list.length - removable;
    clear(cleanBtn);
    if (confirming) {
      cleanBtn.setAttribute('style', 'color:var(--c-error);border-color:var(--c-error)');
      cleanBtn.append(document.createTextNode(`确认清理 ${removable} 条`));
      return;
    }
    cleanBtn.setAttribute('style', '');
    cleanBtn.disabled = removable === 0;
    cleanBtn.title = removable === 0
      ? '没有可清理的记录'
      : `清除 ${removable} 条已结束的记录${running ? `；进行中的 ${running} 条会保留` : ''}`;
    cleanBtn.append(h('span', { html: icon('trash') }), document.createTextNode('清理'));
  }

  let hintTimer = 0;
  function showHint(text) {
    hint.textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hint.textContent = '';
    }, 5000);
  }

  cleanBtn.addEventListener('click', async () => {
    const removable = list.filter(task => isFinishedTask(task)).length;
    if (!removable) return;
    if (!confirming) {
      confirming = true;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        confirming = false;
        drawClean();
      }, 4000);
      drawClean();
      return;
    }
    clearTimeout(confirmTimer);
    confirming = false;
    const result = await clearFinishedTasks();
    await reload();
    const kept = result && result.kept ? `，保留进行中 ${result.kept} 条` : '';
    showHint(`已清理 ${(result && result.removed) || 0} 条${kept}`);
  });

  function drawTabs() {
    clear(tabs);
    FILTERS.forEach(filter => {
      const count = filter.key === 'all'
        ? list.length
        : list.filter(task => (filter.match || []).includes(task.status)).length;
      tabs.append(h('button', {
        class: `tab ${active === filter.key ? 'is-active' : ''}`.trim(),
        text: count ? `${filter.label} ${count}` : filter.label,
        onclick: () => {
          active = filter.key;
          drawTabs();
          drawList();
        },
      }));
    });
  }

  function drawList() {
    const filter = FILTERS.find(item => item.key === active) || FILTERS[0];
    const rows = active === 'all'
      ? list
      : list.filter(task => (filter.match || []).includes(task.status));

    clear(listBox);
    if (!rows.length) {
      listBox.append(emptyState(
        'inbox',
        active === 'all' ? '还没有任务记录' : '这个状态下没有任务',
        active === 'all'
          ? '跑一次「批量填充 SKU」或「旧链上新」，这里就会出现记录（含成功/失败条数与时间）。'
          : '换个筛选看看，或者先执行一个任务。'
      ));
      return;
    }

    listBox.append(h('div', { class: 'card' }, rows.map(task => {
      const feature = getFeature(task.featureId);
      const meta = STATUS_META[task.status] || { text: task.status, cls: '' };
      const success = Number(task.result?.success || 0);
      const failed = Number(task.result?.failed || 0);
      const done = Number(task.progress?.done || 0);
      const total = Number(task.progress?.total || 0);
      const countText = total
        ? ` · ${done}/${total} 条${success || failed ? `（成功 ${success} / 失败 ${failed}）` : ''}`
        : (success || failed ? ` · 成功 ${success} / 失败 ${failed}` : '');
      const item = h('div', {
        class: 'list-item',
        style: 'cursor:pointer',
        title: feature ? `打开「${feature.name}」` : '',
        onclick: () => {
          if (feature) ctx.navigate(`#/feature/${encodeURIComponent(task.featureId)}`);
        },
      }, [
        h('span', { class: 'feature-icon', style: 'width:26px;height:26px', html: icon(feature ? feature.icon : 'inbox') }),
        h('div', { class: 'list-item-main' }, [
          h('div', { class: 'list-item-title truncate', text: task.name || (feature ? feature.name : task.featureId) }),
          h('div', { class: 'list-item-sub truncate' },
            `${platformName(task.platformId || '')} · ${timeAgo(task.createdAt)}${countText}`),
        ]),
        h('span', { class: `badge ${meta.cls}`.trim(), text: meta.text }),
      ]);
      return item;
    })));
  }

  async function reload() {
    list = await read(KEYS.tasks, []);
    if (!Array.isArray(list)) list = [];
    list.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
    drawClean();
    drawTabs();
    drawList();
  }

  await reload();

  // 任务在跑时进度会不断回传，这里跟着刷新；视图被替换后自动退订
  const off = onChange(changes => {
    if (!changes[KEYS.tasks]) return;
    if (typeof root.isConnected === 'boolean' && !root.isConnected) {
      off();
      return;
    }
    reload().catch(() => {});
  });

  return root;
}
