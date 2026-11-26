/*
 * 功能中心：搜索 + 平台筛选 + 分类筛选 + 只看收藏。
 * 所有选项都来自注册表（严格遵循方案 11.8：不许硬编码平台/功能列表）。
 */

import { h, clear, debounce } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { listFeatures, listCategories } from '../../../core/feature-registry.js';
import { usablePlatforms } from '../../../core/platform-registry.js';
import { featureCard, emptyState } from './components.js';

// 筛选状态放模块级：切换页面回来时保留用户刚才的选择
const state = {
  keyword: '',
  platformId: '',
  category: '',
  favoriteOnly: false,
};

export function render(ctx) {
  // 「收藏」导航项复用本视图，只是把筛选条件锁定在收藏上
  const favoritesMode = ctx.route.name === 'favorites';
  if (favoritesMode) {
    state.favoriteOnly = true;
    state.platformId = '';
    state.category = '';
  }

  const grid = h('div', { class: 'grid' });
  const countText = h('div', { class: 'section-desc' });
  const chips = h('div', { class: 'chip-row' });
  const categoryChips = h('div', { class: 'chip-row' });

  function draw() {
    const list = listFeatures({
      platformId: state.platformId || undefined,
      category: state.category || undefined,
      keyword: state.keyword,
      favoriteIds: state.favoriteOnly ? ctx.state.favorites : undefined,
    });

    clear(grid);
    if (!list.length) {
      grid.append(emptyState('search', '没有匹配的功能', '换个关键词，或清空筛选条件'));
    } else {
      list.forEach(feature => grid.append(featureCard(feature, ctx)));
    }
    countText.textContent = `共 ${list.length} 个功能`;

    // 平台 chip
    clear(chips);
    const allPlatforms = [{ platformId: '', name: '全部平台' }, ...usablePlatforms()];
    allPlatforms.forEach(item => {
      chips.append(h('button', {
        class: `chip ${state.platformId === item.platformId ? 'is-active' : ''}`.trim(),
        text: item.name,
        onclick: () => {
          state.platformId = item.platformId;
          draw();
        },
      }));
    });

    // 分类 chip（分类也来自注册表）
    clear(categoryChips);
    const categories = [{ category: '', label: '全部分类' }, ...listCategories()];
    categories.forEach(item => {
      categoryChips.append(h('button', {
        class: `chip ${state.category === item.category ? 'is-active' : ''}`.trim(),
        text: item.label,
        onclick: () => {
          state.category = item.category;
          draw();
        },
      }));
    });
  }

  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: '搜索功能名称、描述或标签',
    value: state.keyword,
    oninput: debounce(event => {
      state.keyword = event.target.value;
      draw();
    }, 160),
  });

  const favToggle = h('button', {
    class: `chip ${state.favoriteOnly ? 'is-active' : ''}`.trim(),
    text: '只看收藏',
    onclick: event => {
      state.favoriteOnly = !state.favoriteOnly;
      event.currentTarget.classList.toggle('is-active', state.favoriteOnly);
      draw();
    },
  });

  draw();

  return h('div', {}, [
    h('div', { class: 'page-head' }, [
      h('div', { class: 'grow' }, [
        h('h1', { class: 'page-title', text: favoritesMode ? '收藏' : '功能中心' }),
        h('p', {
          class: 'page-sub',
          text: favoritesMode
            ? '你收藏的功能会集中显示在这里。'
            : '全部功能由注册中心生成；新增功能不需要改这里。',
        }),
      ]),
    ]),
    h('div', { class: 'filters' }, [
      h('div', { class: 'search-wrap' }, [
        h('span', { html: icon('search') }),
        search,
      ]),
      chips,
      h('div', { class: 'row row-between' }, [categoryChips, favToggle]),
    ]),
    h('div', { class: 'row row-between', style: 'margin:10px 0 8px' }, [countText]),
    grid,
  ]);
}
