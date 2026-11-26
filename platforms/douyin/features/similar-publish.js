/* 抖店 · 批量发布相似品
 * 阶段一：同上，只登记元数据；队列仍跑在列表页脚本里（阶段二搬到后台任务系统）。
 */

import { registerFeature, CAP } from '../../../core/feature-registry.js';

export default registerFeature({
  featureId: 'douyin.similar-publish',
  name: '批量发布相似品',
  platformId: 'douyin',
  category: 'publish',
  categoryLabel: '发布',
  description: '按商品 ID 逐条搜索 → 发布相似品 → 确认 → 新标签页自动发布，失败原因可一键复制。',
  icon: 'copy',
  status: 'available',
  legacyPanel: true,
  order: 20,
  tags: ['商品ID', '相似品', '批量发布'],
  supportedPages: ['product-list'],
  component: 'similar-publish',
  // 队列可停，但暂停/续跑没有实现，能力声明按真实情况给
  caps: [CAP.START, CAP.CANCEL, CAP.STATUS],
  steps: [
    { key: 'ids', title: '输入商品 ID', hint: '每行一个，也可从表格某列读取' },
    { key: 'confirm', title: '确认任务', hint: '核对条数，确认当前标签页是商品列表' },
    { key: 'run', title: '执行与结果', hint: '逐条执行，失败项记录原因并汇总' },
  ],
});
