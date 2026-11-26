/**
 * 从完整 SKU 名称里拆出「规格数值 / 规格单位 / 数量 / 数量量词」。
 *
 * 规则（按业务约定）：
 *   1. 只认**最靠右**的那一组 `数值+单位 * 数量+量词`，其余全部保留为名称；
 *   2. 该组必须**紧贴名称结尾**（`补充装2500g*1袋`），否则视为未识别，不做猜测；
 *   3. 名称里天然带的 `*6`、`*4袋` 不会被误认为规格，因为
 *      - `*6` 后面没有量词；
 *      - `*4袋` 前面没有「数值+单位」。
 *
 * 例（示例中的品名为虚构）：
 *   `收纳袋A*6+收纳盒B*2+补充装2500g*1袋`
 *     → 名称 `收纳袋A*6+收纳盒B*2+补充装`，2500 g × 1 袋
 *   `收纳袋A*4袋+补充装130g*4袋`
 *     → 名称 `收纳袋A*4袋+补充装`，130 g × 4 袋
 */
(function (root) {
  'use strict';

  // 长词要排在短词前面，避免「袋装」被「袋」截断
  const SPEC_UNITS = ['千克', '公斤', '毫克', '毫升', '厘米', '毫米', '克', '升', '斤', '两', '米', '寸', '㎡'];
  const QUANTITY_WORDS = [
    '袋装', '瓶装', '盒装', '支装', '桶装', '箱装', '包装',
    '袋', '瓶', '盒', '个', '支', '包', '罐', '片', '条', '张', '套', '件',
    '对', '双', '只', '卷', '桶', '箱', '组', '斤', '捆', '扎', '块', '抽', '提', '筒', '盘'
  ];

  const SEPARATOR = '[*×x✕]';
  const PATTERN = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*(?:([A-Za-z]{1,4}|${SPEC_UNITS.join('|')}))?\\s*${SEPARATOR}\\s*(\\d+(?:\\.\\d+)?)\\s*(${QUANTITY_WORDS.join('|')})\\s*$`,
    'i'
  );

  /** 全角转半角。逐字符 1:1 替换，长度不变，所以匹配下标仍可用于截断原串。 */
  function toHalfWidth(text) {
    return String(text ?? '')
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ');
  }

  function cleanNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? String(num) : String(value);
  }

  /** 去掉截断后残留在末尾的连接符与空白 */
  function trimTrailingJunk(name) {
    return name.replace(/[\s+＋*×✕·、,，;；:：\-—_/|]+$/u, '').trim();
  }

  /**
   * @param {string} fullName 完整 SKU 名，如 `补充装2500g*1袋`
   * @returns {{ok:true,name:string,specValue:string,specUnit:string,quantity:string,quantityUnit:string,matched:string}
   *          |{ok:false,reason:string,name:string}}
   */
  function parseSkuName(fullName) {
    const raw = String(fullName ?? '').trim();
    if (!raw) return { ok: false, reason: '名称为空', name: '' };

    const text = toHalfWidth(raw);
    const match = PATTERN.exec(text);
    if (!match) {
      return { ok: false, reason: '名称结尾没有「规格+数量」结构（如 2500g*1袋）', name: raw };
    }

    const name = trimTrailingJunk(raw.slice(0, match.index));
    if (!name) return { ok: false, reason: '去掉规格部分后名称为空', name: '' };

    return {
      ok: true,
      name,
      specValue: cleanNumber(match[1]),
      specUnit: match[2] || '',
      quantity: cleanNumber(match[3]),
      quantityUnit: match[4],
      matched: match[0].trim()
    };
  }

  const SPLIT_FIELDS = ['specValue', 'specUnit', 'quantity', 'quantityUnit'];
  const SPLIT_LABELS = { specValue: '规格数值', specUnit: '规格单位', quantity: '数量', quantityUnit: '数量量词' };

  /**
   * 把拆分结果套到一条记录上：缺哪个字段补哪个，名称去掉尾部的规格段。
   * 已经填好的字段一律不动（手工拆过的表格照样兼容）。
   * @returns {{record:object, split:boolean, error?:string}}
   */
  function applyToRecord(record) {
    const missing = SPLIT_FIELDS.filter(field => !String(record[field] ?? '').trim());
    if (!missing.length) return { record, split: false };

    const parsed = parseSkuName(record.skuName);
    if (!parsed.ok) return { record, split: false, error: parsed.reason };

    const next = { ...record, skuName: parsed.name };
    for (const field of missing) next[field] = parsed[field];

    const stillMissing = SPLIT_FIELDS.filter(field => !String(next[field] ?? '').trim());
    if (stillMissing.length) {
      return {
        record: next,
        split: false,
        error: `名称里没有识别到${stillMissing.map(field => SPLIT_LABELS[field]).join('、')}`
      };
    }
    return { record: next, split: true };
  }

  const api = { parseSkuName, applyToRecord, SPLIT_FIELDS, SPEC_UNITS, QUANTITY_WORDS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SkuNameParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
