/*
 * 功能正文视图表：feature.component → 渲染函数。
 *
 * 这里只登记「界面长什么样」，功能是否出现、叫什么名字、归属哪个平台，
 * 一律来自功能注册中心（platforms/<平台>/features/*.js）。
 * 新增功能如果复用已有界面形态，不需要改这里；只有新形态才加一条。
 */

import { render as skuFill } from './feature-sku-fill.js';
import { render as similarPublish } from './feature-similar-publish.js';
import { render as copyVariants } from './feature-copy-variants.js';

export const featureViews = {
  'sku-fill': skuFill,
  'similar-publish': similarPublish,
  'copy-variants': copyVariants,
};
