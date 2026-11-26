/*
 * 任务中心。
 * 阶段一：只读展示，数据来自 storage 的 tasks 键（阶段二由后台任务管理器写入）。
 * 没有数据就明确显示「暂无」，绝不伪造进度条或假任务。
 */

import { h, clear, timeAgo } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { read, KEYS } from '../../shared/storage.js';
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
  const tasks = await read(KEYS.tasks, []);
  const list = Array.isArray(tasks) ? tasks : [];
  let active = 'all';

  const listBox = h('div', {});
  const tabs = h('div', { class: 'tabs' });

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
        '统一任务系统在第二阶段接入：任务会持久化到后台，关闭面板或切换标签页都不会中断。'
      ));
      return;
    }

    listBox.append(h('div', { class: 'card' }, rows.map(task => {
      const feature = getFeature(task.featureId);
      const meta = STATUS_META[task.status] || { text: task.status, cls: '' };
      const success = Number(task.result?.success || 0);
      const failed = Number(task.result?.failed || 0);
      return h('div', { class: 'list-item' }, [
        h('span', { class: 'feature-icon', style: 'width:26px;height:26px', html: icon(feature ? feature.icon : 'inbox') }),
        h('div', { class: 'list-item-main' }, [
          h('div', { class: 'list-item-title truncate', text: task.name || (feature ? feature.name : task.featureId) }),
          h('div', { class: 'list-item-sub truncate' },
            `${platformName(task.platformId || '')} · ${timeAgo(task.createdAt)}`
            + (success || failed ? ` · 成功 ${success} / 失败 ${failed}` : '')),
        ]),
        h('span', { class: `badge ${meta.cls}`.trim(), text: meta.text }),
      ]);
    })));
  }

  drawTabs();
  drawList();

  return h('div', {}, [
    h('div', { class: 'page-head' }, [
      h('div', { class: 'grow' }, [
        h('h1', { class: 'page-title', text: '任务中心' }),
        h('p', { class: 'page-sub', text: '任务由后台统一管理，关闭弹窗或侧边栏都不会中断。' }),
      ]),
    ]),
    tabs,
    listBox,
  ]);
}
