/* 抖店 · 批量填充 SKU
 * 2.0 阶段一：四步向导已在侧边栏实现（app/sidepanel/views/feature-sku-fill.js），
 * 执行仍由 content.js 的 BATCH_FILL 完成——本文件只声明元数据与真实能力。
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
  // 旧面板仍作为回退入口保留（详情页底部有入口），等阶段二任务系统接管后再摘
  legacyPanel: true,
  order: 10,
  tags: ['Excel', 'SKU', '价格', '编码'],
  supportedPages: ['product-create'],
  component: 'sku-fill',
  // 页面里跑的是「一条消息跑完整个队列」，没有暂停/停止协议，能力声明按真实情况给
  caps: [CAP.START],
  executor: { kind: 'page-message', page: 'product-create', script: 'content.js', start: 'BATCH_FILL' },
  steps: [
    { key: 'import', title: '导入 Excel', hint: '选择 .xlsx，指定工作表与表头行' },
    { key: 'mapping', title: '字段匹配', hint: '确认名称、编码、价格三列，其余可交给自动拆分' },
    { key: 'preview', title: '数据预览', hint: '核对条数与首条内容，处理不完整的行' },
    { key: 'run', title: '执行任务', hint: '在商品编辑页逐条创建并回填价格与编码' },
  ],
});
