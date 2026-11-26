/*
 * SKU 表格 → 可导入记录。
 *
 * 规则全部沿用旧面板（popup.js 的 loadHeader / updateRecords）：
 *   1. 表头行可手工指定，默认按 headerScore 自动挑最像表头的一行；
 *   2. 每个字段找「第一个像它的列」，没有就留空交给名称自动拆分；
 *   3. 只把「有名称 + 有编码或价格」的行当候选，表尾说明行直接忽略；
 *   4. 必填七项（名称/规格值/规格单位/数量/量词/编码/价格）缺一即跳过。
 *
 * 识别与拆分算法仍来自根目录的 columns.js / parser.js（旧面板与离线测试共用同一份），
 * 这里只做「读全局 + 组织流程」，不复制规则，避免两份实现跑偏。
 */

const REQUIRED = ['skuName', 'specValue', 'specUnit', 'quantity', 'quantityUnit', 'code', 'price'];

function columnApi() {
  const api = globalThis.ColumnMap;
  if (!api || !Array.isArray(api.fields)) {
    throw new Error('表头识别模块没有加载（columns.js），请重新加载扩展');
  }
  return api;
}

export function fields() {
  return columnApi().fields.slice();
}

export function fieldLabel(field) {
  const labels = columnApi().fieldLabels || {};
  return labels[field] || field;
}

export function guessColumn(header, field) {
  return columnApi().guessColumn(header, field);
}

/** 自动挑表头行：命中字段最多的一行 */
export function bestHeaderIndex(rows) {
  const { headerScore } = columnApi();
  const list = Array.isArray(rows) ? rows : [];
  return list.reduce((best, row, index) => (headerScore(row) > headerScore(list[best] || []) ? index : best), 0);
}

/** 按表头重新认列（与 loadHeader 一致：先猜，猜不到再沿用同列号） */
export function mapColumns(headerRow, previous = {}) {
  const header = Array.isArray(headerRow) ? headerRow : [];
  const columns = {};
  for (const field of fields()) {
    const guess = header.findIndex(name => guessColumn(name, field));
    const prev = previous[field];
    if (guess >= 0) columns[field] = String(guess);
    else if (prev !== undefined && prev !== '' && Number(prev) < header.length) columns[field] = String(prev);
    else columns[field] = '';
  }
  return columns;
}

/**
 * 恢复上次保存的映射（与 restoreState 一致）：
 * 旧列号指向的列必须仍然像这个字段才沿用，否则保留新表头猜出来的结果。
 */
export function mergeColumns(headerRow, saved = {}) {
  const header = Array.isArray(headerRow) ? headerRow : [];
  const columns = mapColumns(header);
  for (const field of fields()) {
    const value = saved[field];
    if (value === undefined) continue;
    if (value === '') { columns[field] = ''; continue; }
    if (guessColumn(header[Number(value)], field)) columns[field] = String(value);
  }
  return columns;
}

/**
 * 生成可导入记录。
 * @returns {{
 *   records: object[], scanned: number, skipped: number, invalidPrice: number,
 *   splitCount: number, splitErrors: {row:number, reason:string}[], warnings: string[]
 * }}
 */
export function buildRecords({ rows, headerIndex, columns, autoSplit = true }) {
  const list = Array.isArray(rows) ? rows : [];
  const start = Math.max(0, Number(headerIndex) || 0);
  const mapping = columns || {};
  const parser = globalThis.SkuNameParser || null;
  const splitErrors = [];
  let splitCount = 0;

  const candidates = list.slice(start + 1).map((row, index) => {
    const record = { sourceRow: start + index + 2 };
    for (const field of fields()) {
      const column = mapping[field];
      record[field] = column === '' || column === undefined || column === null
        ? ''
        : String(row[Number(column)] ?? '').trim();
    }
    return record;
  }).filter(record => {
    const hasName = String(record.skuName ?? '').trim();
    const hasCodeOrPrice = String(record.code ?? '').trim() || String(record.price ?? '').trim();
    return Boolean(hasName && hasCodeOrPrice);
  });

  const mapped = candidates.map(record => {
    if (!autoSplit) return record;
    if (!parser) {
      splitErrors.push({ row: record.sourceRow, reason: '拆分模块没有加载（parser.js）' });
      return record;
    }
    const result = parser.applyToRecord(record);
    if (result.error) splitErrors.push({ row: record.sourceRow, reason: result.error });
    else if (result.split) splitCount++;
    return result.record;
  });

  const records = mapped.filter(record => REQUIRED.every(field => String(record[field] ?? '').trim()));
  const skipped = mapped.length - records.length;
  const invalidPrice = records.filter(record => !Number.isFinite(Number(record.price)) || Number(record.price) <= 0).length;

  const warnings = [];
  if (skipped) warnings.push(`已跳过 ${skipped} 行字段不全`);
  if (invalidPrice) warnings.push(`${invalidPrice} 行售价为 0 或无效`);

  return { records, scanned: candidates.length, skipped, invalidPrice, splitCount, splitErrors, warnings };
}

/** 首条预览文案（与旧面板一致，便于对照排查） */
export function previewText(record) {
  if (!record) return '请检查表头和列映射：名称、编码、价格必须有值，规格与数量可由名称自动拆分。';
  return `首条预览：${record.skuName}｜${record.specValue || '—'} ${record.specUnit || ''} × ${record.quantity || '—'} ${record.quantityUnit || ''}｜编码 ${record.code}｜价格 ${record.price}`;
}

/** 从表格某列读值（发布相似品取 ID 用） */
export function columnValues(rows, headerIndex, columnIndex) {
  const start = Math.max(0, Number(headerIndex) || 0);
  const column = Number(columnIndex);
  if (!Number.isFinite(column) || column < 0) return [];
  return (Array.isArray(rows) ? rows : []).slice(start + 1)
    .map(row => String(row[column] ?? '').trim())
    .filter(Boolean);
}
