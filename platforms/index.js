/*
 * 平台/功能装配入口。
 * 新增一个平台只需要：建 platform.js + features/*.js，然后在这里 import 一行。
 * 公共导航与功能中心不需要任何改动。
 */

import './douyin/platform.js';
import './douyin/features/sku-fill.js';
import './douyin/features/similar-publish.js';
import './douyin/features/copy-variants.js';

export const REGISTRY_READY = true;
