/*
 * 商品 ID 文本解析：换行 / 逗号 / 空格 / 顿号都能当分隔符，粘贴时常带的首尾引号去掉。
 * 规则来自旧面板 popup.js（stripQuotes + parseIds），行为保持不变。
 */

const QUOTES = String.fromCharCode(34, 39, 96);

export function stripQuotes(value) {
  let text = String(value || '').trim();
  while (text && QUOTES.includes(text[0])) text = text.slice(1);
  while (text && QUOTES.includes(text[text.length - 1])) text = text.slice(0, -1);
  return text.trim();
}

/** 去空、去重，保留输入顺序 */
export function parseIds(text) {
  const seen = new Set();
  const ids = [];
  for (const raw of String(text || '').split(/[\s,，;；、]+/)) {
    const id = stripQuotes(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
