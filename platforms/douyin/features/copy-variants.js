/* 抖店 · 裂变链接
 *
 * 与「旧链上新」的区别：
 *   - 旧链上新每一行是一个商品 ID，各自搜一次；
 *   - 裂变链接是同一个源商品连点 N 次「发布相似品」，每次换一份标题和一张主图。
 *
 * 因为只搜一次源商品，搜索环节的串位风险只出现一次，单条耗时也更短。
 * 执行体仍在 similar.js（变体模式），这里只登记元数据与步骤。
 *
 * 当前版本（2.1.1）只做到「填商品标题 + 导购短标题 + 换主图」，
 * 不点发布、不关页面，先把这一段验证稳再放开发布。
 */

import { registerFeature, CAP } from '../../../core/feature-registry.js';

export default registerFeature({
  featureId: 'douyin.copy-variants',
  name: '裂变链接',
  platformId: 'douyin',
  category: 'publish',
  categoryLabel: '发布',
  description: '对同一个商品连续复制相似品，每条换一个标题和一张主图；当前版本填完不发，留页核对。',
  icon: 'sparkles',
  status: 'beta',
  order: 30,
  tags: ['同款多链接', '标题', '主图', '批量'],
  supportedPages: ['product-list'],
  component: 'copy-variants',
  caps: [CAP.START, CAP.CANCEL, CAP.STATUS],
  steps: [
    { key: 'source', title: '源商品', hint: '填一个商品 ID，整批只搜索这一次' },
    { key: 'variants', title: '变体列表', hint: '粘贴标题、选择本地图片文件夹，按数量少的配对' },
    { key: 'confirm', title: '任务确认', hint: '核对配对结果与条数，确认当前是商品列表页' },
    { key: 'run', title: '执行与结果', hint: '逐条复制、填两个标题、换主图（本版不发布）' },
  ],
});
