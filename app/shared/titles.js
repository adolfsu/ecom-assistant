/*
 * 标题派生：从商品标题算出「导购短标题」。
 *
 * 抖店发布页有两个标题输入框：
 *   - 商品标题：整条标题（截图里 58/60）；
 *   - 导购短标题：24 字上限，用户实测标题里带英文或数字时只能填 23 个，
 *     否则会顶格溢出（平台按显示宽度算，不是单纯字符数）。
 *
 * 这里只做纯函数，供侧边栏预览和内容脚本各用一份：
 * 内容脚本 similar.js 不能 import，所以那边有一份自包含实现，
 * tests/check-variants.js 会拿同一组输入比对两边的结果，防止改一处忘另一处。
 */

export const SHORT_TITLE_LIMIT = 24;
export const SHORT_TITLE_LIMIT_MIXED = 23;

/** 英文、半角数字、全角数字/字母都算「窄字符但占位更宽」的那一类 */
const MIXED_RE = /[0-9０-９A-Za-zＡ-Ｚａ-ｚ]/;

/** 截断后末尾常见的分隔标点：留着会显得断在半句上，去掉不影响字数上限 */
const TAIL_RE = /[\s,，、;；:：!！?？.。/／|｜·]+$/;

/**
 * 商品标题 → 导购短标题。
 * 含英文/数字取前 23 个字符，否则取前 24 个；不足则原样返回。
 * 用 Array.from 按 code point 切，避免把 emoji 的代理对切一半。
 */
export function shortTitleOf(title) {
  const chars = Array.from(String(title ?? '').trim());
  if (!chars.length) return '';
  const limit = MIXED_RE.test(chars.join('')) ? SHORT_TITLE_LIMIT_MIXED : SHORT_TITLE_LIMIT;
  const cut = chars.slice(0, limit).join('');
  const trimmed = cut.replace(TAIL_RE, '').trim();
  return trimmed || cut.trim();
}

/** 字数（按用户看到的字符算，不是 UTF-16 长度） */
export function charCount(text) {
  return Array.from(String(text ?? '')).length;
}
