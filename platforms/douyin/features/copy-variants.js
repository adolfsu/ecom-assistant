/* 抖店 · 批量复制变体
 *
 * 与「批量发布相似品」的区别：
 *   - 相似品的每一行是一个商品 ID，各自搜一次；
 *   - 变体是同一个源商品连点 N 次「发布相似品」，每次换一份标题和一张主图。
 *
 * 因为只搜一次源商品，搜索环节的串位风险只出现一次，单条耗时也更短。
 * 执行体仍在 similar.js（变体模式），这里只登记元数据与步骤。
 */

import { registerFeature, CAP } from '../../../core/feature-registry.js';

export default registerFeature({
  featureId: 'douyin.copy-variants',
  name: '批量复制变体',
  platformId: 'douyin',
  category: 'publish',
  categoryLabel: '发布',
  description: '对同一个商品连续复制相似品，每条换一个标题和一张主图后自动发布。',
  icon: 'sparkles',
  status: 'beta',
  order: 30,
  tags: ['同款多链接', '标题', '主图', '批量发布'],
  supportedPages: ['product-list'],
  component: 'copy-variants',
  caps: [CAP.START, CAP.CANCEL, CAP.STATUS],
  steps: [
    { key: 'source', title: '源商品', hint: '填一个商品 ID，整批只搜索这一次' },
    { key: 'variants', title: '变体列表', hint: '粘贴标题、选择本地图片文件夹，按数量少的配对' },
    { key: 'confirm', title: '任务确认', hint: '核对配对结果与条数，确认当前是商品列表页' },
    { key: 'run', title: '执行与结果', hint: '逐条复制、填标题、换主图、发布' },
  ],
});
