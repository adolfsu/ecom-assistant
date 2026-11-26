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
