/*
 * 本地图片文件夹：只读文件名，不读内容、不上传。
 *
 * 用途是「裂变链接」：用户选一个本地文件夹，我们拿到里面的图片文件名，
 * 与标题列表一一配对；真正用到的只是名字，图本身还在店铺素材库里。
 *
 * 为什么不用 File System Access API（showDirectoryPicker）：
 * 那个权限是会话级的，扩展重载或窗口关闭后要重新授权，而且侧边栏重绘会把
 * 手势上下文弄丢。webkitdirectory 的 <input> 一次性给出全部文件名，够用且稳定。
 */

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;

/** 单个文件名是否算图片（浏览器在某些文件夹里会带上 Thumbs.db 之类） */
export function isImageName(name) {
  return IMAGE_RE.test(String(name || '').trim());
}

/** 去掉可能的相对路径，只留文件名（webkitRelativePath 是 a/b/c.jpg 这种） */
export function baseName(name) {
  const text = String(name || '').trim();
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return index >= 0 ? text.slice(index + 1) : text;
}

/** 去掉扩展名，素材库搜不到全名时用主体再搜一次 */
export function stripExt(name) {
  return baseName(name).replace(IMAGE_RE, '');
}

/**
 * 自然排序：把数字块按数值比，避免「图10」排在「图2」前面。
 * 中文用 zh-Hans-CN；Intl 不可用时退回 localeCompare。
 */
export function sortImageNames(names) {
  const list = (Array.isArray(names) ? names : []).map(baseName).filter(Boolean);
  try {
    const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    return list.slice().sort((left, right) => collator.compare(left, right));
  } catch {
    return list.slice().sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }));
  }
}

/**
 * 从文件列表里挑出图片名（已去路径、已去重、已自然排序）。
 * 同一个文件夹里如果有导出的 .DS_Store、说明.txt，会在这里被滤掉。
 */
export function pickImageNames(files) {
  const seen = new Set();
  const names = [];
  for (const file of Array.isArray(files) ? files : []) {
    const name = baseName(file && (file.webkitRelativePath || file.name));
    if (!name || !isImageName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return sortImageNames(names);
}

/**
 * 粘贴的标题：一行一条，去掉空行和「1. 」「1、」「- 」这类行首序号。
 * 只认「数字 + 分隔符」或「项目符号 + 空格」，不会把「3合1除湿袋」的 3 当成序号。
 */
export function parseTitles(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^(?:\d{1,3}\s*[.、)）:：]\s*|[-*•·]\s+)/, '').trim())
    .filter(Boolean);
}

/**
 * 标题 ↔ 图片 一一对应，数量少的为准（23 标题 + 16 图 → 保留 16 条）。
 * 不做名字相似度匹配：用户明确说「暂时没有严格的匹配需求」，按顺序配最好预期。
 */
export function buildVariants(titles, images) {
  const list = (Array.isArray(titles) ? titles : [])
    .map(title => String(title || '').trim())
    .filter(Boolean);
  const pics = (Array.isArray(images) ? images : []).map(baseName).filter(Boolean);
  const used = Math.min(list.length, pics.length);
  const items = [];
  for (let index = 0; index < used; index++) {
    items.push({ no: index + 1, title: list[index], image: pics[index] });
  }
  return {
    items,
    titleCount: list.length,
    imageCount: pics.length,
    used,
    unusedTitles: list.slice(used),
    unusedImages: pics.slice(used),
  };
}
