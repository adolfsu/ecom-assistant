/*
 * 执行结果 → 可复制的纯文本。
 *
 * 两种结果结构不同（SKU 填充按表格行、发布相似品按商品 ID），但都要满足同一个要求：
 * 失败项必须带上具体原因，复制出来能直接粘进表格对账。
 * 抽成独立模块，视图只负责显示，格式改动只改这里，也便于离线测试。
 */

const SKU_LABELS = { sku: 'SKU', price: '价格', code: '编码', error: '错误' };
const OK_VALUES = ['已填入', '已创建', '已存在'];

/* ---------------- 批量填充 SKU ---------------- */

/** 一条 SKU 结果的明细，例：SKU 已创建；价格 已填入；编码 已填入 */
export function fillDetail(item) {
  const entries = Object.entries(item?.results || {})
    .map(([key, value]) => `${SKU_LABELS[key] || key} ${value}`);
  return entries.join('；') || '无详情';
}

/** 失败原因：优先用页面回报的 error，否则挑出没成功的字段 */
export function fillFailure(item) {
  const results = item?.results || {};
  if (results.error) return String(results.error);
  const bad = Object.entries(results)
    .filter(([, value]) => value && !OK_VALUES.includes(String(value)))
    .map(([key, value]) => `${SKU_LABELS[key] || key}：${value}`);
  return bad.length ? bad.join('；') : '原因未记录';
}

export function fillRunText(run, onlyFailed = false) {
  const results = Array.isArray(run?.results) ? run.results : [];
  const rows = results.filter(item => !onlyFailed || !item.ok);
  if (!rows.length) return '';
  const lines = [onlyFailed ? '行号\tSKU名称\t失败原因' : '行号\tSKU名称\t结果\t说明'];
  for (const item of rows) {
    lines.push(onlyFailed
      ? `${item.row}\t${item.skuName}\t${fillFailure(item)}`
      : `${item.row}\t${item.skuName}\t${item.ok ? '成功' : '失败'}\t${item.ok ? fillDetail(item) : fillFailure(item)}`);
  }
  return lines.join('\n');
}

/* ---------------- 批量发布相似品 ---------------- */

/** 失败原因：优先用采集到的校验提示（多条合并），其次用 reason */
export function similarFailure(item) {
  const issues = Array.isArray(item?.issues) ? item.issues.filter(Boolean) : [];
  const text = issues.length ? issues.join('；') : String(item?.reason || '').trim();
  return text || '原因未记录';
}

export function similarRunText(run, onlyFailed = false) {
  const results = Array.isArray(run?.results) ? run.results : [];
  const rows = results.filter(item => !onlyFailed || !item.ok);
  if (!rows.length) return '';
  const lines = [onlyFailed ? '商品ID\t失败原因' : '商品ID\t状态\t失败原因'];
  for (const item of rows) {
    lines.push(onlyFailed
      ? `${item.id}\t${similarFailure(item)}`
      : `${item.id}\t${item.ok ? '成功' : '失败'}\t${item.ok ? '' : similarFailure(item)}`);
  }
  return lines.join('\n');
}
