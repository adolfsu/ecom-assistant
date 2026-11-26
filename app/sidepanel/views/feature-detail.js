/*
 * 功能详情页：统一外壳（返回 / 名称 / 平台 / 收藏 / 步骤 / 配置区 / 底部固定操作区）。
 * 阶段一所有功能都还是「旧面板承载」，因此配置区显示提示 + 回退入口，
 * 不伪造任何功能表单（方案 11.7：不允许用模拟进度/假界面替代真实能力）。
 */

import { h } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { getFeature } from '../../../core/feature-registry.js';
import { getPlatform } from '../../../core/platform-registry.js';
import { platformName, statusBadge, emptyState } from './components.js';

export function render(ctx) {
  const featureId = decodeURIComponent(ctx.route.params.featureId || '');
  const feature = getFeature(featureId);
  if (!feature) {
    return h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('button', { class: 'btn btn-icon', onclick: () => ctx.navigate('#/features'), html: icon('arrowLeft') }),
        h('h1', { class: 'page-title', text: '功能不存在' }),
      ]),
      emptyState('alert', '找不到这个功能', `ID：${featureId || '（空）'}`),
    ]);
  }

  const platform = getPlatform(feature.platformId);
  const favorite = ctx.state.favorites.includes(feature.featureId);
  const pageKey = feature.supportedPages[0];
  const page = platform && Array.isArray(platform.supportedPages)
    ? platform.supportedPages.find(item => item.key === pageKey)
    : null;
  const onRightPage = Boolean(ctx.target.page && feature.supportedPages.includes(ctx.target.page.key));

  const favBtn = h('button', {
    class: `fav-btn ${favorite ? 'is-on' : ''}`.trim(),
    title: favorite ? '取消收藏' : '收藏',
    onclick: async () => {
      await ctx.toggleFavorite(feature.featureId);
    },
  });
  favBtn.innerHTML = icon('star');

  return h('div', {}, [
    h('div', { class: 'page-head' }, [
      h('button', {
        class: 'btn btn-icon',
        title: '返回功能中心',
        onclick: () => ctx.navigate('#/features'),
        html: icon('arrowLeft'),
      }),
      h('div', { class: 'grow' }, [
        h('h1', { class: 'page-title', text: feature.name }),
        h('div', { class: 'row', style: 'margin-top:5px;gap:6px' }, [
          h('span', { class: 'badge badge-primary', text: platformName(feature.platformId) }),
          h('span', { class: 'badge', text: feature.categoryLabel }),
          statusBadge(feature.status),
        ]),
      ]),
      favBtn,
    ]),

    h('p', { class: 'page-sub', style: 'margin:-6px 0 12px' , text: feature.description }),

    h('div', { class: 'notice', style: 'margin-bottom:12px' }, [
      h('span', { html: icon('info') }),
      h('div', {}, [
        h('div', { text: '当前为 2.0 骨架版本，这个功能的操作界面还没迁过来。' }),
        h('div', { style: 'margin-top:2px;opacity:.85' },
          '阶段一先确认导航、平台识别与视觉规范；迁移完成后这里会换成四步/三步操作流，已验证的执行逻辑不变。'),
      ]),
    ]),

    page
      ? h('div', { class: 'card', style: 'margin-bottom:12px' }, [
        h('div', { class: 'row row-between' }, [
          h('div', {}, [
            h('div', { class: 'setting-title', text: '适用页面' }),
            h('div', { class: 'setting-desc', text: page.name }),
          ]),
          h('span', {
            class: `badge ${onRightPage ? 'badge-success' : 'badge-warn'}`.trim(),
            text: onRightPage ? '当前页匹配' : '请切到对应页面',
          }),
        ]),
      ])
      : null,

    feature.steps.length ? h('div', { class: 'card', style: 'margin-bottom:12px' }, [
      h('div', { class: 'section-title', style: 'margin-bottom:4px', text: '操作步骤' }),
      h('ol', { class: 'steps' }, feature.steps.map((step, index) =>
        h('li', { class: 'step' }, [
          h('span', { class: 'step-no', text: String(index + 1) }),
          h('div', { class: 'step-body' }, [
            h('div', { class: 'step-title', text: step.title }),
            step.hint ? h('div', { class: 'step-hint', text: step.hint }) : null,
          ]),
        ])
      )),
    ]) : null,

    h('div', { class: 'card' }, [
      h('div', { class: 'setting-title', text: '功能配置' }),
      h('div', { class: 'setting-desc', text: '迁移中：配置表单将在阶段一后续提交接入。' }),
    ]),

    h('div', { class: 'detail-footer' }, [
      h('button', {
        class: 'btn',
        onclick: () => ctx.openLegacyPanel(),
      }, ['打开旧版面板', h('span', { html: icon('external') })]),
      h('button', {
        class: 'btn btn-primary',
        disabled: true,
        title: '功能界面迁移中',
        text: '开始（迁移中）',
      }),
    ]),
  ]);
}
