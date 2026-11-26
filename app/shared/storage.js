/*
 * 存储封装。
 * 只做三件事：统一前缀、默认值、批量读。任务数据（tasks）留到阶段二接入，
 * 这里先给好读写口子，避免以后各处直接裸调 chrome.storage。
 */

export const KEYS = {
  theme: 'ui.theme',
  startPage: 'ui.startPage',
  favorites: 'ui.favorites',
  recent: 'ui.recent',
  pendingFeature: 'ui.pendingFeature',
  panelState: 'ui.panelState',
  tasks: 'tasks',

  // 批量填充 SKU：沿用旧面板的键名，两个入口看到的是同一份数据
  skuWorkbook: 'doudianBatchWorkbook',
  skuWorkbookName: 'doudianBatchWorkbookName',
  skuState: 'doudianBatchState',
  skuRun: 'skuFillRun',

  // 批量发布相似品：键名由 similar.js / background.js 写入，这里只读
  similarIds: 'similarIds',
  similarRun: 'similarRun',
  similarProgress: 'similarProgress',
  similarDebug: 'similarDebug',
  similarListTabId: 'similarListTabId',
};

/** 清理数据时只动这些前缀，绝不 unshift 整个 storage.local */
export const OWNED_PREFIXES = ['ui.', 'doudianBatch', 'similar', 'skuFillRun'];

const local = () => chrome.storage.local;

export async function read(key, fallback = null) {
  const data = await local().get(key);
  return data && data[key] !== undefined ? data[key] : fallback;
}

export async function write(key, value) {
  await local().set({ [key]: value });
}

export async function readMany(keys) {
  return local().get(keys);
}

/** 一次写多个键（表格 + 映射这种成组数据，少一次往返） */
export async function writeMany(values) {
  await local().set(values || {});
}

export async function removeMany(keys) {
  await local().remove(keys);
}

/** 列出本扩展自有的存储键（设置页「数据清理」要显示清什么） */
export async function ownedKeys() {
  const all = await local().get(null);
  return Object.keys(all || {}).filter(key =>
    OWNED_PREFIXES.some(prefix => key.startsWith(prefix))
  );
}

/** 只清理自有键，返回清掉的个数 */
export async function clearOwnedData() {
  const keys = await ownedKeys();
  if (keys.length) await removeMany(keys);
  return keys.length;
}

/** 订阅存储变化，返回取消函数 */
export function onChange(callback) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    callback(changes);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/* ---------- 收藏 / 最近使用 ---------- */

export async function getFavorites() {
  const list = await read(KEYS.favorites, []);
  return Array.isArray(list) ? list : [];
}

export async function toggleFavorite(featureId) {
  const list = await getFavorites();
  const next = list.includes(featureId)
    ? list.filter(id => id !== featureId)
    : [featureId, ...list];
  await write(KEYS.favorites, next);
  return next;
}

export async function pushRecent(featureId, limit = 6) {
  const list = await read(KEYS.recent, []);
  const next = [featureId, ...(Array.isArray(list) ? list : []).filter(id => id !== featureId)]
    .slice(0, limit);
  await write(KEYS.recent, next);
  return next;
}
