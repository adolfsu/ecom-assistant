/* 抖店 · 旧链上新
 * 2.0 阶段一：三步向导已在侧边栏实现（app/sidepanel/views/feature-similar-publish.js）。
 * 功能名沿用平台动作「发布相似品」的内部叫法，侧边栏展示名叫「旧链上新」。
 * 队列仍跑在列表页脚本里（similar.js），进度/结果经 storage 回传，
 * 所以关闭侧边栏不会中断任务——这也是能力声明里能给出 STATUS 的原因。
 */

import { registerFeature, CAP } from '../../../core/feature-registry.js';

export default registerFeature({
  featureId: 'douyin.similar-publish',
  name: '旧链上新',
  platformId: 'douyin',
  category: 'publish',
  categoryLabel: '发布',
  description: '按商品 ID 逐条搜索 → 发布相似品 → 确认 → 新标签页自动发布，失败原因可一键复制。一个旧链接批量铺新链接。',
  icon: 'copy',
  status: 'available',
  legacyPanel: true,
  order: 20,
  tags: ['商品ID', '相似品', '批量发布'],
  supportedPages: ['product-list'],
  component: 'similar-publish',
  // 停止是真的（SIMILAR_STOP），进度是真的（storage 里的类似 similarRun）；暂停/续跑没有实现，不声明
  caps: [CAP.START, CAP.CANCEL, CAP.STATUS],
  executor: { kind: 'page-message', page: 'product-list', script: 'similar.js', start: 'SIMILAR_RUN' },
  steps: [
    { key: 'ids', title: '输入商品 ID', hint: '每行一个，也可从表格某列读取' },
    { key: 'confirm', title: '确认任务', hint: '核对条数，确认当前标签页是商品列表' },
    { key: 'run', title: '执行与结果', hint: '逐条执行，失败项记录原因并汇总' },
  ],
});
