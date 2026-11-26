/*
 * 向导公用零件：步骤条、区块标题、底部固定操作区、状态行。
 * 两个功能页共用，避免各写一套导致间距/交互不一致。
 */

import { h } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';

/**
 * 顶部步骤条。已完成/已到达的步骤可点回去，未到达的步骤不可点。
 * @param {{steps: {title:string,hint?:string}[], current: number, onJump: (index:number)=>void, locked?: boolean}} options
 */
export function stepper({ steps, current, onJump, locked = false }) {
  return h('ol', { class: 'steps-bar' }, (steps || []).map((step, index) => {
    const done = index < current;
    const active = index === current;
    const reachable = !locked && index <= current;
    return h('li', {
      class: `step-pill ${active ? 'is-active' : ''} ${done ? 'is-done' : ''} ${reachable ? 'is-reachable' : ''}`.trim(),
    }, [
      h('button', {
        class: 'step-pill-btn',
        type: 'button',
        title: step.hint || step.title,
        disabled: !reachable || active,
        onclick: () => onJump(index),
      }, [
        h('span', { class: 'step-pill-no', html: done ? icon('check') : String(index + 1) }),
        h('span', { class: 'step-pill-label truncate', text: step.title }),
      ]),
    ]);
  }));
}

export function sectionTitle(title, desc) {
  return h('div', { class: 'wizard-section' }, [
    h('div', { class: 'section-title', text: title }),
    desc ? h('div', { class: 'setting-desc', text: desc }) : null,
  ]);
}

/** 底部固定操作区（复用详情页的 sticky 样式） */
export function wizardFoot(buttons) {
  return h('div', { class: 'detail-footer' }, (buttons || []).filter(Boolean));
}

/**
 * 一行状态提示。tone: '' | 'ok' | 'warn' | 'error'
 * 用纯文本节点更新，不重建 DOM，方便执行中刷新。
 */
export function statusLine(text, tone = '') {
  return h('div', { class: `status-line ${tone ? `is-${tone}` : ''}`.trim(), text: text || '' });
}

export function setStatus(node, text, tone = '') {
  if (!node) return;
  node.textContent = text || '';
  node.className = `status-line ${tone ? `is-${tone}` : ''}`.trim();
}

/** 键值对行：目标页、条数这类信息 */
export function kvRow(label, value, extra) {
  return h('div', { class: 'kv-row' }, [
    h('span', { class: 'kv-label', text: label }),
    h('span', { class: 'kv-value grow', text: String(value ?? '') }),
    extra || null,
  ]);
}

/** 空数据提示（保持和全局 empty 一致的语气，不扮演出「有数据」） */
export function inlineEmpty(text) {
  return h('div', { class: 'inline-empty', text });
}
