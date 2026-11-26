/*
 * 版本单一来源。
 *
 * 以前版本号在 4 个地方手写（manifest / popup 两个常量 / content.js / similar.js），
 * 拆成多文件后必然漏同步。这里改为运行时读 manifest.version。
 *
 * 过渡期：content.js 与 similar.js 目前仍硬编码 0.9.0 并用它做握手，
 * 所以比对时允许「manifest 版本」或「过渡常量」二者之一，等阶段二把
 * 内容脚本改成上报 manifest.version 后，删除 LEGACY 常量即可。
 */

export const LEGACY_SCRIPT_VERSION = '0.9.0';

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
