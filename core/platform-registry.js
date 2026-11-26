/*
 * 平台注册中心。
 * 每个平台只描述「自己是谁、覆盖哪些域名、有哪些页面」，
 * 不负责功能逻辑，也不被任何公共 UI 硬编码。
 */

const platforms = new Map();

export function registerPlatform(platform) {
  if (!platform || !platform.platformId) {
    throw new Error('registerPlatform 需要 platformId');
  }
  if (platforms.has(platform.platformId)) {
    throw new Error(`平台 ID 重复：${platform.platformId}`);
  }
  const normalized = {
    platformId: platform.platformId,
    name: platform.name || platform.platformId,
    // 域名匹配用后缀，例如 'jinritemai.com'
    domains: Array.isArray(platform.domains) ? platform.domains : [],
    icon: platform.icon || 'package',
    status: platform.status || 'available', // available | beta | planned
    supportedPages: Array.isArray(platform.supportedPages) ? platform.supportedPages : [],
    note: platform.note || '',
  };
  platforms.set(normalized.platformId, normalized);
  return normalized;
}

export function getPlatform(platformId) {
  return platforms.get(platformId) || null;
}

export function listPlatforms() {
  return [...platforms.values()];
}

/** 只列真实可用的平台（计划中的平台不参与筛选器展示） */
export function usablePlatforms() {
  return listPlatforms().filter(item => item.status !== 'planned');
}

export function resetPlatforms() {
  platforms.clear();
}
