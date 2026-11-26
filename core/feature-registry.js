/*
 * 功能注册中心。
 *
 * 硬性要求（方案第 5.2 / 11.8 条）：功能目录必须由这里动态生成，
 * 公共导航与功能中心**不允许**出现写死的功能或平台列表。
 *
 * 字段约定：
 *   featureId     全局唯一
 *   platformId    归属平台；通用工具用 'common'
 *   category      分类键，用于筛选器（分类也由注册表汇总得出）
 *   component     视图键，侧边栏按它渲染详情页
 *   executor      执行器描述，阶段二接统一任务系统时使用
 *   caps          该功能真实支持的能力，不能默认全都支持
 */

const features = new Map();

export const CAP = {
  START: 'start',
  PAUSE: 'pause',
  RESUME: 'resume',
  CANCEL: 'cancel',
  STATUS: 'status',
};

export function registerFeature(feature) {
  if (!feature || !feature.featureId) throw new Error('registerFeature 需要 featureId');
  if (!feature.name) throw new Error(`功能 ${feature.featureId} 缺少 name`);
  if (features.has(feature.featureId)) throw new Error(`功能 ID 重复：${feature.featureId}`);

  const normalized = {
    featureId: feature.featureId,
    name: feature.name,
    platformId: feature.platformId || 'common',
    category: feature.category || 'general',
    // 分类中文名由功能自己声明，筛选器不维护一份写死的对照表
    categoryLabel: feature.categoryLabel || feature.category || '通用',
    description: feature.description || '',
    icon: feature.icon || 'sparkles',
    status: feature.status || 'available', // available | beta | planned | migrating
    supportedPages: Array.isArray(feature.supportedPages) ? feature.supportedPages : [],
    component: feature.component || feature.featureId,
    // 阶段一：部分功能仍是旧面板承载，详情页据此提示并提供回退入口
    legacyPanel: Boolean(feature.legacyPanel),
    caps: Array.isArray(feature.caps) ? feature.caps : [CAP.START, CAP.CANCEL],
    steps: Array.isArray(feature.steps) ? feature.steps : [],
    executor: feature.executor || null,
    tags: Array.isArray(feature.tags) ? feature.tags : [],
    order: Number.isFinite(feature.order) ? feature.order : 100,
  };
  features.set(normalized.featureId, normalized);
  return normalized;
}

export function getFeature(featureId) {
  return features.get(featureId) || null;
}

/**
 * 列表查询。所有筛选都在这里做，视图层只负责渲染。
 * @param {{platformId?:string, category?:string, keyword?:string, favoriteIds?:string[]}} options
 */
export function listFeatures(options = {}) {
  const { platformId, category, keyword, favoriteIds } = options;
  const text = String(keyword || '').trim().toLowerCase();
  return [...features.values()]
    .filter(item => (platformId ? item.platformId === platformId : true))
    .filter(item => (category ? item.category === category : true))
    .filter(item => (Array.isArray(favoriteIds) ? favoriteIds.includes(item.featureId) : true))
    .filter(item => {
      if (!text) return true;
      const haystack = [item.name, item.description, item.featureId, ...item.tags].join(' ').toLowerCase();
      return haystack.includes(text);
    })
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

/** 分类来自已注册功能，不在 UI 里写死 */
export function listCategories() {
  const seen = new Map();
  for (const item of features.values()) {
    if (!seen.has(item.category)) {
      seen.set(item.category, { category: item.category, label: item.categoryLabel || item.category });
    }
  }
  return [...seen.values()];
}

/** 某个平台下有哪些功能（平台详情/筛选联动用） */
export function featuresOfPlatform(platformId) {
  return listFeatures({ platformId });
}

export function resetFeatures() {
  features.clear();
}
