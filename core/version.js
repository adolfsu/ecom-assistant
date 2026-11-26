/*
 * 版本单一来源。
 *
 * 以前版本号在 4 个地方手写（manifest / popup 两个常量 / content.js / similar.js），
 * 拆成多文件后必然漏同步。这里改为运行时读 manifest.version。
 *
 * 过渡期：content.js 与 similar.js 仍硬编码自己的版本号做握手，比对时允许
 * 「manifest 版本」或「当前页面脚本版本」二者之一。
 * 注意 LEGACY_SCRIPT_VERSION 必须跟着页面脚本一起改：它代表"这一版页面脚本"，
 * 留着旧值等于默默接受旧代码 —— 0.9.1 起严格要求，旧副本会直接提示 F5 刷新，
 * 而不是带着旧的搜索判定继续跑。
 */

export const LEGACY_SCRIPT_VERSION = '0.9.7';

export function manifestVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '';
  }
}

/** 页面脚本版本是否与当前扩展匹配 */
export function isScriptVersionCompatible(pageVersion) {
  if (!pageVersion) return false;
  return pageVersion === manifestVersion() || pageVersion === LEGACY_SCRIPT_VERSION;
}

/** 给用户看的提示文案 */
export function staleScriptHint(pageVersion) {
  return `页面里运行的还是旧版脚本（${pageVersion}），请按 F5 刷新抖店页面后再试`;
}
