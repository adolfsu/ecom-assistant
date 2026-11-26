/* 首页：只做「现在能干什么」的概览，不做数据大屏（方案 3.1）。 */

import { h, timeAgo } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { listFeatures, getFeature } from '../../../core/feature-registry.js';
import { listTasks } from '../../shared/tasks.js';
import { featureCard, sectionHead, emptyState, platformName } from './components.js';

const STATUS_TEXT = {
  running: '执行中',
  completed: '已完成',
  completed_with_errors: '部分失败',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export async function render(ctx) {
  const all = listFeatures({});
  const favorites = listFeatures({ favoriteIds: ctx.state.favorites }).slice(0, 4);
  const quick = favorites.length ? favorites : all.slice(0, 4);
  const recent = ctx.state.recent
    .map(id => getFeature(id))
    .filter(Boolean)
    .slice(0, 4);

  const target = ctx.target;
  const platformText = target.platform ? target.platform.name : '未识别平台';
  const pageText = target.page ? target.page.name : (target.url ? '未识别页面' : '没有活动标签页');
  const detectable = Boolean(target.platform);
  const supported = target.page
    ? all.some(feature => feature.supportedPages.includes(target.page.key))
    : false;

  // 首页的任务概览读真实任务记录，没有就显示没有，不编数字
  const tasks = await listTasks();
  const runningCount = tasks.filter(task => task.status === 'running').length;
  ctx.state.runningCount = runningCount;
  const recentTasks = tasks.slice(0, 3);

  return h('div', {}, [
    h('div', { class: 'page-head' }, [
      h('div', { class: 'grow' }, [
        h('h1', { class: 'page-title', text: '首页' }),
        h('p', { class: 'page-sub', text: '从常用功能开始，或到功能中心查看全部能力。' }),
      ]),
    ]),

    h('div', { class: 'card', style: 'margin-bottom:12px' }, [
      h('div', { class: 'row row-between' }, [
        h('div', { class: 'row' }, [
          h('span', {
            class: 'feature-icon',
            html: icon(detectable ? target.platform.icon : 'info'),
          }),
          h('div', {}, [
            h('div', { class: 'list-item-title', text: platformText }),
            h('div', { class: 'list-item-sub', text: pageText }),
          ]),
        ]),
        h('span', {
          class: `badge ${supported ? 'badge-success' : (detectable ? 'badge-warn' : '')}`.trim(),
          text: supported ? '当前页可用' : (detectable ? '当前页无匹配功能' : '请切到商家后台'),
        }),
      ]),
      detectable
        ? null
        : h('p', { class: 'section-desc', style: 'margin-top:8px' },
          '切到抖店后台任意页面后，这里会自动显示平台与页面类型。'),
    ]),

    h('div', { class: 'stat-row', style: 'margin-bottom:16px' }, [
      h('div', { class: 'stat' }, [
        h('div', { class: 'stat-value', text: String(all.length) }),
        h('div', { class: 'stat-label', text: '已注册功能' }),
      ]),
      h('div', { class: 'stat' }, [
        h('div', { class: 'stat-value', text: String(runningCount) }),
        h('div', { class: 'stat-label', text: '进行中任务' }),
      ]),
    ]),

    sectionHead(
      favorites.length ? '收藏的功能' : '常用功能',
      favorites.length ? '来自收藏列表' : '按注册顺序展示，可在功能中心收藏',
      h('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => ctx.navigate('#/features'),
      }, ['全部功能', h('span', { html: icon('chevronRight') })])
    ),
    quick.length
      ? h('div', { class: 'grid', style: 'margin-bottom:16px' }, quick.map(item => featureCard(item, ctx)))
      : emptyState('grid', '还没有可用的功能', '在 platforms/ 下注册功能后会出现在这里'),

    recent.length ? [
      sectionHead('最近使用', '按最近打开排序'),
      h('div', { class: 'card', style: 'margin-bottom:16px' }, recent.map(feature =>
        h('div', {
          class: 'list-item',
          style: 'cursor:pointer',
          onclick: () => ctx.navigate(`#/feature/${encodeURIComponent(feature.featureId)}`),
        }, [
          h('span', { class: 'feature-icon', style: 'width:26px;height:26px', html: icon(feature.icon) }),
          h('div', { class: 'list-item-main' }, [
            h('div', { class: 'list-item-title truncate', text: feature.name }),
            h('div', { class: 'list-item-sub', text: platformName(feature.platformId) }),
          ]),
          h('span', { class: 'i', html: icon('chevronRight') }),
        ])
      )),
    ] : null,

    sectionHead('最近任务', recentTasks.length ? '按开始时间倒序' : '执行一次功能后会自动记录',
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => ctx.navigate('#/tasks') }, '任务中心')),
    recentTasks.length
      ? h('div', { class: 'card' }, recentTasks.map(task => {
        const feature = getFeature(task.featureId);
        const total = Number(task.progress?.total || 0);
        const done = Number(task.progress?.done || 0);
        return h('div', {
          class: 'list-item',
          style: 'cursor:pointer',
          onclick: () => ctx.navigate(`#/feature/${encodeURIComponent(task.featureId)}`),
        }, [
          h('span', { class: 'feature-icon', style: 'width:26px;height:26px', html: icon(feature ? feature.icon : 'inbox') }),
          h('div', { class: 'list-item-main' }, [
            h('div', { class: 'list-item-title truncate', text: task.name || (feature ? feature.name : task.featureId) }),
            h('div', { class: 'list-item-sub truncate' },
              `${timeAgo(task.createdAt)}${total ? ` · ${done}/${total} 条` : ''}`),
          ]),
          h('span', { class: 'badge', text: STATUS_TEXT[task.status] || task.status }),
        ]);
      }))
      : emptyState('inbox', '还没有任务记录', '跑一次批量填充 SKU 或批量发布相似品，这里就会出现记录'),
  ]);
}
