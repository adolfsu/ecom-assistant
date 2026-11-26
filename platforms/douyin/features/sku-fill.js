/* 抖店 · 批量填充 SKU
 * 阶段一：只登记元数据与页面骨架；真正的执行仍由旧面板调用 content.js 完成，
 * 因此标记 legacyPanel，详情页会给出「打开旧版面板」的回退入口。
 */

import { registerFeature, CAP } from '../../../core/feature-registry.js';

export default registerFeature({
  featureId: 'douyin.sku-fill',
  name: '批量填充 SKU',
  platformId: 'douyin',
  category: 'product',
  categoryLabel: '商品',
  description: '读 Excel 逐条创建规格值并填写价格、商家编码，支持从完整 SKU 名自动拆分规格。',
  icon: 'package',
  status: 'available',
  legacyPanel: true,
  order: 10,
  tags: ['Excel', 'SKU', '价格', '编码'],
  supportedPages: ['product-create'],
  component: 'sku-fill',
  caps: [CAP.START, CAP.CANCEL],
  steps: [
    { key: 'import', title: '导入 Excel', hint: '选择 .xlsx，指定工作表与表头行' },
    { key: 'mapping', title: '字段匹配', hint: '确认名称、编码、价格三列，其余可交给自动拆分' },
    { key: 'preview', title: '数据预览', hint: '核对条数与首条内容，处理不完整的行' },
    { key: 'run', title: '执行任务', hint: '在商品编辑页逐条创建并回填价格与编码' },
  ],
});
