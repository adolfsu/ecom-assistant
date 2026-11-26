# Ecom Assistant 2.0 迁移计划

> 依据 2.0 实施方案第 11 节「强制开发约束」编写：先读源码、先梳理调用关系、再定计划；不一次性重写。
> 本文档基于 0.9.0（提交 `c77731b`）的**实际代码**，不是基于方案设想。

## 一、现状盘点（0.9.0 实测）

### 1.1 文件与规模

| 文件 | 行数 | 角色 |
|---|---|---|
| `manifest.json` | 24 | MV3 清单；`side_panel.default_path = popup.html` |
| `popup.html` | 67 | **同时充当弹窗和侧边栏**（同一份页面） |
| `popup.css` | 33 | 单列布局，`body{min-width:380px}` |
| `popup.js` | 682 | 弹窗逻辑 + Excel 解析 + 两个功能的全部 UI |
| `content.js` | 864 | 商品编辑页脚本（SKU 填充） |
| `similar.js` | 1292 | 列表页脚本（发布相似品队列 + 发布页脚本，同一文件两种角色） |
| `background.js` | 289 | 跨标签页接线员 |
| `parser.js` | 112 | UMD，SKU 名拆分（`window.SkuNameParser`） |
| `columns.js` | 53 | UMD，表头映射（`window.ColumnMap`） |

### 1.2 消息协议（现状）

| 消息 | 方向 | 作用 |
|---|---|---|
| `PING` | popup → content | 版本探测 |
| `DIAGNOSE` | popup → content | 规格框结构自检 |
| `BATCH_FILL` | popup → content | 同步执行整批 SKU，全部跑完才返回 |
| `SIMILAR_PING` | popup/bg → similar | 版本探测 |
| `SIMILAR_DIAG` | popup → similar | 列表页结构自检 |
| `SIMILAR_RUN` | popup → similar | 启动队列（队列跑在**页面**里） |
| `SIMILAR_NEXT` | bg → similar | 把"这一条的结果"转回列表页 |
| `SIMILAR_STOP` | popup → similar | 停止队列 |
| `SIMILAR_PUBLISH` | bg → 发布页 | 通知点「发布商品」 |
| `SIMILAR_PUBLISH_DONE` | 发布页 → bg | 回报结果 |
| `SIMILAR_OPENED` | 列表页 → bg | **点确认前**登记任务（时序关键） |
| `SIMILAR_CANCEL` | 列表页 → bg | 撤销登记 |
| `SIMILAR_LOG` | 页面 → bg | 步骤日志（写 `similarDebug`） |
| `SIMILAR_REGISTER_LIST` | 列表页 → bg | 记住列表页标签 id |
| `SIMILAR_GRAB_URL` | 列表页 → bg | `window.open` 被拦截时代开标签 |

### 1.3 存储键（现状）

| 键 | 写入方 | 内容 |
|---|---|---|
| `doudianBatchWorkbook` / `...Name` / `doudianBatchState` | popup.js | 整份表格数据 + 表头/列映射/开关 |
| `similarIds` | popup.js | 上次输入的 ID 列表 |
| `similarRun` | similar.js | 队列快照（running/ids/index/results） |
| `similarProgress` | similar.js | 进度文案 |
| `similarDebug` | background.js | 最近 60 条日志 |
| `similarListTabId` | background.js | 列表页标签 id |
| `similarPending` | background.js | 待接管发布页的登记（含 `before`/`created`/`sent`） |

## 二、与方案的冲突（必须先决策）

### 冲突 1：侧边栏并不是"独立的"

现状 `side_panel.default_path` 直接指向 `popup.html`，**弹窗和侧边栏是同一份页面、同一段脚本**。方案要求 Popup 只做快速入口、Side Panel 做完整工作空间，两者职责完全不同。

- 影响：必须拆成两个入口文件；`manifest` 的 `side_panel` 改指向新页面。
- 风险：拆分后原「点图标 → 小窗 → 按钮固定到侧边栏」的路径要重新设计（侧边栏有独立入口后，这个按钮可去掉）。
- 结论：**阶段一必须做**，属于"结构性拆分"，不是纯 UI 美化。

### 冲突 2：任务状态在页面里，不在后台

发布相似品的队列 `runQueue()` 跑在**列表页 content script 的内存**里（`runtime` 变量），只把进度镜像写到 `similarRun`。列表页标签一关，队列就没了。

方案第 6 节要求"任务由后台统一管理 + 持久化 + 重启标记 interrupted"。这需要把队列搬到 `background.js`。

- 风险：0.8.2 踩过的坑是**登记必须早于点确认**（`SIMILAR_OPENED` 要在 `clickDialogOk` 之前 await 完成）。搬队列时若打乱这个时序，会退回"新标签页被拒接管"。
- 结论：**放阶段二**，且搬迁时必须保留「先登记、后点击」的顺序，并保留现有 `waitOpenOutcome` 判据。

### 冲突 3：SKU 填充没有任务/进度概念

`BATCH_FILL` 是一次同步请求：content 侧把整批跑完才 `reply`，中途没有任何进度回报。

方案要求任务中心显示"处理进度 / 当前处理对象"，而第 11.7 条又禁止模拟进度。要满足两者，**必须改 content.js 增加进度上报**（如每完成一条发一次 `BATCH_PROGRESS`）。

- 影响：这是对已验证业务代码的改动（虽然只加不改执行逻辑）。
- 结论：**放阶段二**，先加只读上报，不改填充流程本身。

## 三、其他技术判断

1. **版本号有 4 处手写同步**：`manifest.version`、`popup.js` 的 `CONTENT_VERSION`/`SIMILAR_VERSION`、`content.js` 的 `scriptVersion`、`similar.js` 的 `VERSION`。重构拆文件后更容易漏。
   → 建议改为运行时比对 `chrome.runtime.getManifest().version`（content script 内可用），彻底消掉手写同步。
2. **popup 宽度写死 380px**（`body{min-width:380px}`），直接塞进侧边栏会横向受限。
   → 侧边栏必须用独立样式，不能复用 `popup.css`。
3. **Excel 解析可无损抽出**：`columnIndex / unzipXlsx / parseXml / readWorksheet / parseWorkbook`（约 190 行）是纯函数，不碰 DOM，可整体搬到 `app/shared/excel.js`。
4. **`parser.js` / `columns.js` 已是 UMD**，`window.SkuNameParser` / `window.ColumnMap` 挂在全局，侧边栏和弹窗都能直接用，不需要改。
5. **内容脚本暂不搬目录**。方案允许"根据现有项目依赖调整"；移动 `content.js` / `similar.js` 会牵动 `manifest.content_scripts`、`chrome.scripting.executeScript({files:[...]})` 两处注入路径，收益低风险高。**阶段一只搬 UI 层**，内容脚本随阶段三的注册中心一起整理。

## 四、目标结构与实际映射

方案给的是理想结构，下面是**按现有依赖调整后**的落地版本：

```
manifest.json                     # 改：side_panel → app/sidepanel/index.html
background.js                     # 阶段一不动；阶段二改造成任务协调器
content.js                        # 阶段一不动；阶段二加进度上报
similar.js                        # 阶段一不动；阶段二拆出队列
parser.js  columns.js             # 不动（UMD，全局可用）

app/
  popup/index.html + popup.js + popup.css        # 新：快速入口（380×≤520）
  sidepanel/index.html + sidepanel.js + sidepanel.css   # 新：完整工作空间
  sidepanel/views/{home,features,feature-detail,tasks,settings}.js
  shared/{ui.css,dom.js,bus.js,storage.js,excel.js,format.js}
core/
  platform-registry.js            # 阶段一建：注册表 + 查询
  feature-registry.js             # 阶段一建：注册表 + 查询
  task-manager.js                 # 阶段二建
  message-bus.js                  # 阶段一建：统一消息封装
  platform-detector.js            # 阶段一建：按 URL 判定平台
platforms/
  douyin/platform.js              # 阶段一建：platformId/domains/supportedPages
  douyin/features/sku-fill.js     # 阶段一建：feature 描述 + component 引用
  douyin/features/similar-publish.js
```

`platforms/` 下只放**元数据与视图引用**，真正的自动化执行仍留在 `content.js` / `similar.js`，通过现有消息协议调用。这样阶段一不触碰执行逻辑。

## 五、阶段一：UI 重构（可立即开工）

### 改动清单

| 文件 | 动作 |
|---|---|
| `manifest.json` | `side_panel` 指向新页面；`web_accessible_resources` 无需新增（同源页面直接引用） |
| `app/popup/*` | 新建：品牌头、当前平台、常用功能、进行中任务数、最近任务、打开侧边栏、设置 |
| `app/sidepanel/*` | 新建：左侧导航（首页/功能中心/任务中心/收藏/设置）+ 右侧内容区 |
| `app/sidepanel/views/*` | 首页、功能中心、功能详情、任务中心（阶段一只读展示）、设置 |
| `app/shared/*` | 主题变量、DOM 小工具、消息封装、Excel 解析（从 popup.js 搬） |
| `core/*` | 平台注册中心、功能注册中心、平台识别、消息总线 |
| `platforms/douyin/*` | 抖店平台定义 + 两个功能的元数据 |
| 旧 `popup.html/js/css` | **保留**，作为回退路径，阶段一验证通过后再删 |

### 迁移两个功能的落点

- **批量填充 SKU** → 功能详情页四步（导入 Excel / 字段匹配 / 数据预览 / 执行）。原有能力全保留：工作表选择、表头识别、手动映射、自动拆分开关、预览、条数校验、诊断按钮。
- **批量发布相似品** → 功能详情页三步（输入 ID / 确认任务 / 执行与结果）。原有能力全保留：手动输入、Excel 列读取、开始/停止、诊断、运行日志、结果汇总、复制全部/只复制失败。

### 验收

1. 点图标 → 小窗（≤520px），可打开侧边栏并定位到指定功能；
2. 侧边栏内两个功能都能完整跑通一次（与 0.9.0 行为一致）；
3. 平台识别：在抖店页面显示「抖店」，非抖店显示「未识别」；
4. 无网页悬浮按钮；
5. `node tests/*.js` 全部通过（tests 目录仅本地，不入库）。

## 六、阶段二：统一任务管理

- 后台 `task-manager.js`：任务模型 + 状态机 + 持久化（`tasks` 键）；
- 发布相似品队列从 `similar.js` 搬到后台，**保留"先登记后点击"时序**；
- `content.js` 增加 `BATCH_PROGRESS` 只读上报（不改填充流程）；
- `chrome.runtime.onStartup` 把未完成任务标记 `interrupted`；
- 任务中心接真实状态，禁用模拟进度。

## 七、阶段三：注册中心与执行器

- 执行器接口 `start/pause/resume/cancel/getStatus`，能力声明按功能声明（不假设都支持暂停）；
- 用「模拟平台 + 模拟功能」验证：新增功能不改公共导航与任务中心核心代码；
- 内容脚本按 `content/douyin/` 整理，同步更新注入路径。

## 八、阶段四：体验增强

收藏、最近使用、搜索、深色主题、快捷键。

## 九、开工前需要你确认的 3 件事

1. **阶段一先做骨架还是做完整**：可以先出「导航 + 首页 + 功能中心 + 空壳详情页」让你看样式，也可以一次做到两个功能都能跑。
2. **旧 popup 是否保留**：建议保留一版做回退，验收通过后再删。
3. **是否接受阶段二改 `content.js` 加进度上报**（只加不改，但确实动了已验证代码）。

## 十、已确认的决策（2026-11-26）

| 事项 | 决定 |
|---|---|
| 阶段一交付粒度 | **先出骨架看样式**：导航 + 首页 + 功能中心 + 功能详情外壳 + 任务中心空状态 + 设置 |
| 旧 popup | **保留**，作为回退入口（详情页与设置页都有「打开旧版面板」） |
| 阶段二进度上报 | **允许改 `content.js`**，只加只读上报，不动填充流程 |

## 十一、阶段一骨架完成情况

已完成：

- `manifest`：`default_popup` → `app/popup/index.html`，`side_panel` → `app/sidepanel/index.html`，版本 2.0.0；
- 五个页面：首页、功能中心（搜索 + 平台筛选 + 分类筛选 + 只看收藏）、功能详情（步骤/适用页面/回退入口）、任务中心（六个状态页签 + 空状态）、设置（主题/默认启动页/数据清理/版本）；
- 双入口：弹窗 360px 快速启动，点击功能经 `panelState` 落到侧边栏对应功能；
- 平台识别：按 URL 后缀匹配域名 + 页面规则，顶栏常驻显示「平台 · 页面 · 标签标题」；
- 注册中心：`core/platform-registry` + `core/feature-registry`，抖店与两个功能由 `platforms/` 声明，UI 无任何硬编码清单。

过渡期处理：

- 旧 `popup.js` 的 `activeTab()` 改为**跳过扩展页**，否则旧面板以独立小窗打开时会把自身当成商品页；
- `core/version.js` 允许「manifest 版本」与「过渡常量 0.9.0」两种命中，阶段二把内容脚本改成上报 manifest 版本后可删掉常量。

已验证（离线）：

- `tests/check-registry.js`：注册、筛选、重复注册报错、平台/页面识别、**模拟新平台接入无需改公共代码**；
- `tests/check-views.js`：五个视图 + 两个功能详情页在最小 DOM 替身里全部渲染成功，含「功能不存在」「未识别平台」兜底。

待真机验证：弹窗→侧边栏的手势跳转、侧边栏宽度自适应、深色主题观感。

## 十二、阶段一（功能迁移）完成情况

版本 2.0.1。两个功能的操作界面已从旧面板迁到侧边栏，执行链路未改。

| 功能 | 步骤 | 数据/协议 |
|---|---|---|
| 批量填充 SKU | 导入 Excel → 字段匹配 → 数据预览 → 执行 | 复用 `PING` / `DIAGNOSE` / `BATCH_FILL`；表格与映射仍写 `doudianBatchWorkbook` / `doudianBatchState`，与旧面板共用 |
| 批量发布相似品 | 输入商品 ID → 确认任务 → 执行与结果 | 复用 `SIMILAR_PING` / `SIMILAR_DIAG` / `SIMILAR_RUN` / `SIMILAR_STOP`；进度与结果读 `similarRun` / `similarProgress`，关面板不影响队列 |

新增模块（均为纯读取/展示，不改页面执行）：

- `app/shared/excel.js`：XLSX 读取（从 popup.js 搬出，参数改为 File 对象）；
- `app/shared/sku.js`：表头认列 + 记录构造（规则仍在 `columns.js` / `parser.js`，不复制第二份）；
- `app/shared/ids.js`、`app/shared/clipboard.js`、`app/shared/run-format.js`：ID 解析、写剪贴板、结果复制文本；
- `core/page-bridge.js`：定位目标标签页（排除扩展页）+ 内容脚本版本握手/注入；
- `app/sidepanel/views/{wizard,feature-views,feature-sku-fill,feature-similar-publish}.js`。

设计取舍（按方案第 11 条）：

- 功能详情页的正文按 `feature.component` 从 `feature-views.js` 取，功能清单仍只来自注册中心；
- 不伪造进度：SKU 填充执行期间只显示「正在执行 + 页面上的实际提示」，结束才按页面返回的真实结果汇总；
- 能力声明按真实情况给：SKU 填充只有 `start`（页面里是一条消息跑完整个队列，没有停止协议），发布相似品有 `start / cancel / status`；
- 旧面板保留为回退入口（详情页右上角「旧版面板」）；
- SKU 填充的表格与映射沿用旧键名，两个入口来回切换不丢数据。

新增离线检查：

- `tests/check-wizards.js`：表格→记录（拆分/必填/零价格/跳过行）、ID 解析与去重、失败原因复制文本（全部/只失败）、两个功能页在真实 storage 数据下渲染到正确步骤、`MSG` 常量与页面脚本监听字符串对齐；
- `tests/check-views.js` 增补：两个详情页必须渲染出「真实操作界面」而不是占位；连续渲染同一功能页不能变空白；
- `tests/check-search.js` 增补：列表本来只有 1 件商品时，「搜索前后内容不变」也要判定成功（静态证据）。

## 十三、阶段一补充：轻量任务记录

用户实测反馈「任务中心三次测试都没有任何记录」。阶段二的后台任务管理器还没做，但让任务中心长期空着不可接受，
所以先补了一层**按运行快照补记**的轻量实现（`app/shared/tasks.js`）：

- 记录来源是页面脚本已经写好的运行快照（`similarRun` / `skuFillRun`），不新增执行链路；
- `similarRun` 增加 `runId`（开始时间），同一个 runId 只更新同一条任务记录，开始 / 进度回传 / 面板重开后恢复都调同一个 `recordRun`；
- 面板中途关掉、跑完再打开，恢复时会补记一条完整记录；
- 状态由快照推导：`running` / `completed` / `completed_with_errors` / `cancelled`（没跑完就停）/ `failed`（一条没成）；
- 写入串行化（读-改-写排队），最多保留 40 条，`tasks` 键纳入数据清理。

这不是阶段二的替代：真正的中断恢复、暂停/续跑、跨面板任务的唯一真相仍要等后台任务管理器。

## 十四、下一步（阶段二）

1. 统一任务模型 + 持久化（重启后标记 `interrupted`），把轻量记录换成后台任务管理器；
2. 执行器注册（`start / pause / resume / cancel / getStatus`），发布相似品优先接；
3. 若要做到「SKU 填充可暂停/可续跑」，需要给 `content.js` 增加进度上报与停止检查点（只加不改填充流程）。

## 十五、阶段一追加：第三个功能（裂变链接，原「批量复制变体」）

用户提出「同一个链接复制相似品、逐条换标题和主图」，评估见 `feature-title-image-assessment.md`。
它没有另起一条执行链路，而是复用现有的「发布相似品」跨标签页协议，只在两处扩展：

- **列表页**：新增 `runVariants`，把原来的 `searchAndOpenSimilar` 拆成 `searchSource`（搜索并定位一行）
  与 `openSimilarOnRow`（点按钮 → 确认 → 等接管）。变体队列只调用一次 `searchSource`，之后每轮复用那一行。
- **发布页**：`SIMILAR_PUBLISH` 增加 `variant` 标记（由后台从 pending 带过来），收到后先填标题、
  用「图库替换」换主图第一张，再执行原有的 `publishNow`。

新增共享模块 `app/shared/images.js`（图片名过滤/自然排序/标题配对），
新增视图 `views/feature-copy-variants.js`（四步向导），新增测试 `tests/check-variants.js`。
功能清单一律来自注册中心，公共导航/筛选/任务中心零改动。

### 2.1.1 补充

- 展示名：发布相似品 → **旧链上新**，批量复制变体 → **裂变链接**（`featureId` 不变）。
- 裂变链接新增「导购短标题」填写：整条标题 + 前 24 字（含英文/数字取 23），
  规则在 `app/shared/titles.js` 与 `similar.js` 各一份，`tests/check-variants.js` 比对两边结果。
- 裂变链接暂时只填不发：视图里 `PUBLISH_ENABLED = false` → `VARIANT_RUN.publish = false` →
  `variantPending.publish = false` → 发布页填完即回报 `filled + keepTab`，不点发布、不关页面。
  改回 `true` 即恢复原有发布流程。

### 2.1.2 修复

- `openSimilarOnRow` 拆分时漏了 `id` 参数，函数体里 `String(id)` 每条抛 ReferenceError，
  被 catch 吞成「没能登记本条的发布任务」，旧链上新与裂变链接都无法启动。已补参数与两个调用点。
- 测试加三条断言：函数签名带 id、每个调用点参数个数为 3、登记时对 id 做空值兜底。

### 2.1.3 修复

- 确认弹窗默认停在「设置渠道品」上，旧代码只点一下、不校验，导致创建成渠道品。
- 新增 `findOptionCard / cardChecked / chooseSimilarOption`：默认已选中则不点；
  否则点卡片壳（等动画稳定）并校验「发布相似品已选 + 设置渠道品未选」，
  再用两张卡片样式签名互换做第二重判据；都不成立则取消弹窗并报错，绝不带渠道品继续。
- 自检输出两张卡片各自的选中状态与样式，便于下次换版适配。版本 2.1.3 / 0.9.5。
