/* 视图公用片段：功能卡片、状态徽标等。集中一处，避免首页/功能中心各写一份。 */

import { h } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { getPlatform } from '../../../core/platform-registry.js';

const STATUS_TEXT = {
  available: '可用',
  beta: '测试中',
  migrating: '迁移中',
  planned: '规划中',
};

const STATUS_CLASS = {
  available: 'badge-success',
  beta: 'badge-primary',
  migrating: 'badge-warn',
  planned: '',
};

export function platformName(platformId) {
  const platform = getPlatform(platformId);
  return platform ? platform.name : (platformId === 'common' ? '通用' : platformId);
}

export function statusBadge(status) {
  return h('span', {
    class: `badge ${STATUS_CLASS[status] || ''}`.trim(),
    text: STATUS_TEXT[status] || status,
  });
}

export function sectionHead(title, desc, action) {
  return h('div', { class: 'section-head' }, [
    h('div', {}, [
      h('h2', { class: 'section-title', text: title }),
      desc ? h('p', { class: 'section-desc', text: desc }) : null,
    ]),
    action || null,
  ]);
}

/**
 * 功能卡片：整块可点，右上角是收藏按钮。
 * 卡片内容严格来自注册表，没有任何硬编码的功能名。
 */
export function featureCard(feature, ctx) {
  const favorite = ctx.state.favorites.includes(feature.featureId);
  const favBtn = h('button', {
    class: `fav-btn ${favorite ? 'is-on' : ''}`.trim(),
    title: favorite ? '取消收藏' : '收藏',
    'aria-label': favorite ? '取消收藏' : '收藏',
    onclick: async event => {
      event.stopPropagation();
      await ctx.toggleFavorite(feature.featureId);
    },
  });
  favBtn.innerHTML = icon('star');

  const card = h('div', {
    class: 'feature-card',
    role: 'button',
    tabindex: '0',
    onclick: () => ctx.navigate(`#/feature/${encodeURIComponent(feature.featureId)}`),
    onkeydown: event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        ctx.navigate(`#/feature/${encodeURIComponent(feature.featureId)}`);
      }
    },
  }, [
    h('div', { class: 'feature-card-top' }, [
      h('span', { class: 'feature-icon', html: icon(feature.icon) }),
      h('span', { class: 'feature-name truncate', text: feature.name }),
      favBtn,
    ]),
    h('p', { class: 'feature-desc', text: feature.description }),
    h('div', { class: 'feature-meta' }, [
      h('span', { class: 'badge', text: platformName(feature.platformId) }),
      h('span', { class: 'badge', text: feature.categoryLabel }),
      statusBadge(feature.status),
    ]),
  ]);
  return card;
}

export function emptyState(iconName, title, desc) {
  return h('div', { class: 'empty' }, [
    h('span', { html: icon(iconName, 'i') }),
    h('div', { class: 'empty-title', text: title }),
    desc ? h('p', { text: desc }) : null,
  ]);
}
