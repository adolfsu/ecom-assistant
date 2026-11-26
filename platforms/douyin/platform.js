/* 抖店平台定义：域名、页面识别规则。不包含任何功能逻辑。 */

import { registerPlatform } from '../../core/platform-registry.js';

export const DOUYIN = registerPlatform({
  platformId: 'douyin',
  name: '抖店',
  domains: ['jinritemai.com', 'douyin.com'],
  icon: 'package',
  status: 'available',
  note: '抖店商家后台（商品管理、发布、规格编辑）',
  supportedPages: [
    {
      key: 'product-list',
      name: '商品列表',
      // 后台列表页 URL 含 /list；发布页/编辑页另有特征，先排前面
      test: /\/(product\/)?(list|manage)(\?|$|\/)/,
    },
    {
      key: 'product-create',
      name: '商品发布/编辑',
      test: /\/(create|create-v2|edit)(\?|$|\/)/,
    },
  ],
});

export default DOUYIN;
