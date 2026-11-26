/**
 * 「Excel 表头 → 内部字段」的识别规则。
 * 抽成独立模块，既能被 popup 使用，也能在 Node 里用真实表头做回归验证。
 *
 * 匹配优先级：先找与表头**完全相同**的同义词，再找被表头**包含**的同义词。
 * loadHeader 会遍历所有列取第一个命中的，所以同义词越具体、越靠前越好。
 */
(function (root) {
  'use strict';

  const fields = ['skuName', 'code', 'price', 'specValue', 'specUnit', 'quantity', 'quantityUnit'];

  const fieldLabels = {
    skuName: 'SKU 名称',
    code: '商品编码',
    price: '价格',
    specValue: '规格数值',
    specUnit: '规格单位',
    quantity: '数量',
    quantityUnit: '数量量词'
  };

  // 顺序有意义：越具体的词越靠前，避免「规格」抢在「规格数值」之前
  const synonyms = {
    skuName: ['组合名称', 'sku名称', 'sku名', '规格名称', '款式名称', '完整名称', '商品名称'],
    code: ['商品编码', '商家编码', 'sku编码', '编码', '货号'],
    price: ['售价', 'sku售价', '销售价', '价格'],
    specValue: ['规格数值', '规格重量', '净含量', '规格'],
    specUnit: ['规格单位', '单位'],
    quantity: ['数量', '件数'],
    quantityUnit: ['数量单位', '数量量词', '件数单位']
  };

  /** 表头单元格是否像某个字段 */
  function guessColumn(header, field) {
    const normalized = String(header || '').trim().toLocaleLowerCase();
    if (!normalized) return undefined;
    return synonyms[field].find(word => normalized === word.toLocaleLowerCase())
      || synonyms[field].find(word => normalized.includes(word.toLocaleLowerCase()));
  }

  /** 给一行打分：该行有几列能对上字段，用于自动挑选表头行 */
  function headerScore(headerRow) {
    const names = (headerRow || []).map(value => String(value ?? '').trim().toLocaleLowerCase());
    return fields.reduce((score, field) => score + Number(
      names.some(name => name && synonyms[field].some(word => name.includes(word.toLocaleLowerCase())))
    ), 0);
  }

  const api = { fields, fieldLabels, synonyms, guessColumn, headerScore };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ColumnMap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
