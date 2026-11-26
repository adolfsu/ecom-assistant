/*
 * 标题派生：从商品标题算出「导购短标题」。
 *
 * 抖店发布页有两个标题输入框：
 *   - 商品标题：整条标题（截图里 58/60）；
 *   - 导购短标题：**24 个字符位**上限，中文/全角按 2 位算、英文数字按 1 位算。
 *     所以纯中文最多 12 个汉字；24 个汉字等于 48 位，平台会判超限。
 *     标题里含英文或数字时再留 1 位余量（23 位），用户实测这样才不会被顶格拦。
 *
 * 这里只做纯函数，供侧边栏预览和内容脚本各用一份：
 * 内容脚本 similar.js 不能 import，所以那边有一份自包含实现，
 * tests/check-variants.js 会拿同一组输入比对两边的结果，防止改一处忘另一处。
 */

export const SHORT_TITLE_LIMIT = 24;
export const SHORT_TITLE_LIMIT_MIXED = 23;

/** 英文、半角数字、全角数字/字母：标题里出现就算「混合」 */
const MIXED_RE = /[0-9０-９A-Za-zＡ-Ｚａ-ｚ]/;

/** 截断后末尾常见的分隔标点：留着会显得断在半句上，去掉不影响字符位上限 */
const TAIL_RE = /[\s,，、;；:：!！?？.。/／|｜·]+$/;

/** 一个字符占几个字符位：半角可打印 ASCII 算 1，其余（汉字/全角/emoji）算 2 */
export function charWidth(ch) {
  const code = String(ch ?? '').codePointAt(0) || 0;
  return code >= 0x20 && code <= 0x7e ? 1 : 2;
}

/** 整串占多少个字符位（用于预览里显示「12 字 / 24 位」） */
export function textWidth(text) {
  return Array.from(String(text ?? '')).reduce((sum, ch) => sum + charWidth(ch), 0);
}

/**
 * 商品标题 → 导购短标题。
 * 按字符位累计：纯中文到 24 位（12 个汉字），含英文/数字到 23 位；不足则原样返回。
 * 用 Array.from 按 code point 切，避免把 emoji 的代理对切一半。
 */
export function shortTitleOf(title) {
  const chars = Array.from(String(title ?? '').trim());
  if (!chars.length) return '';
  const limit = MIXED_RE.test(chars.join('')) ? SHORT_TITLE_LIMIT_MIXED : SHORT_TITLE_LIMIT;
  let width = 0;
  let cut = '';
  for (const ch of chars) {
    const next = width + charWidth(ch);
    if (next > limit) break;
    width = next;
    cut += ch;
  }
  const trimmed = cut.replace(TAIL_RE, '').trim();
  return trimmed || cut.trim();
}

/** 字数（按用户看到的字符算，不是 UTF-16 长度，也不是字符位） */
export function charCount(text) {
  return Array.from(String(text ?? '')).length;
}
