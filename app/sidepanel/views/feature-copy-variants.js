/*
 * 裂变链接（抖店）—— 2.0 侧边栏版四步向导。
 *
 * 场景：同一个源商品，连续复制 N 个相似品，每条换一个标题和一张主图。
 * 与「旧链上新」的差别是：
 *   - 源商品只搜索一次（搜索串位的风险只出现一次，单条也更快）；
 *   - 每条的数据不是商品 ID，而是「标题 + 素材库图片名」。
 *
 * 2.1.1 起先只做到「填商品标题 + 导购短标题 + 换主图」，PUBLISH_ENABLED = false 时不点发布，
 * 页面留着给人核对；2.1.8 实测通过后打开开关，复用已经跑通的发布、关页流程。
 *
 * 执行体仍在 similar.js（VARIANT_RUN），进度和结果写 storage，所以关掉面板不影响队列。
 */

import { h, clear } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { KEYS, read, writeMany, readMany, onChange } from '../../shared/storage.js';
import { parseIds } from '../../shared/ids.js';
import { columnValues } from '../../shared/sku.js';
import { parseTitles, pickImageNames, buildVariants } from '../../shared/images.js';
import { shortTitleOf, textWidth } from '../../shared/titles.js';
import { copyWithFeedback } from '../../shared/clipboard.js';
import { variantFailure, variantRunText } from '../../shared/run-format.js';
import { recordRun, runStatus } from '../../shared/tasks.js';
import { MSG, toTab } from '../../../core/message-bus.js';
import { resolveTargetTab, ensureScript, isDouyinUrl } from '../../../core/page-bridge.js';
import { detectPlatform } from '../../../core/platform-detector.js';
import { stepper, wizardFoot, setStatus, statusLine, kvRow, inlineEmpty, sectionTitle } from './wizard.js';

const STEP_TITLES = ['源商品', '变体列表', '任务确认', '执行与结果'];
const PREVIEW_LIMIT = 12;

/**
 * 是否点「发布商品」。
 * 2.1.1~2.1.7 只做填写（填完标题与主图就回报、页面保留给人核对），实测 3 条 / 7 条均通过；
 * 2.1.8 起接上发布：走 similar.js 里已经跑通的 publishNow()，成功后自动关页。
 * 发布页的成败都会回传，失败页在变体模式下也会关掉（一次开十几二十页，留着反而看不到重点）。
 */
const PUBLISH_ENABLED = true;

let cache = null;
let repaint = null;
let offChange = null;

function blankState() {
  return {
    step: 0,
    sourceId: '',
    titlesText: '',
    column: '',
    images: [],
    folderName: '',
    status: null,
    starting: false,
    run: null,
    progress: null,
    debug: [],
    diagOpen: false,
    logOpen: false,
    workbook: null,
    skuState: {},
  };
}

async function restore() {
  const state = blankState();
  const data = await readMany([
    KEYS.variantSource, KEYS.variantTitles, KEYS.variantImages, KEYS.variantState,
    KEYS.variantRun, KEYS.variantProgress, KEYS.variantDebug,
    KEYS.skuWorkbook, KEYS.skuState,
  ]);

  const saved = data[KEYS.variantState] || {};
  state.sourceId = String(data[KEYS.variantSource] || saved.sourceId || '');
  state.titlesText = String(data[KEYS.variantTitles] || saved.titlesText || '');
  state.images = Array.isArray(data[KEYS.variantImages]) ? data[KEYS.variantImages] : [];
  state.folderName = saved.folderName || '';
  state.column = saved.column || '';
  state.run = data[KEYS.variantRun] || null;
  state.progress = data[KEYS.variantProgress] || null;
  state.debug = Array.isArray(data[KEYS.variantDebug]) ? data[KEYS.variantDebug] : [];
  state.workbook = Array.isArray(data[KEYS.skuWorkbook]) ? data[KEYS.skuWorkbook] : null;
  state.skuState = data[KEYS.skuState] || {};

  if (state.run && (state.run.running || (state.run.results || []).length)) state.step = 3;
  else if (state.titlesText || state.images.length) state.step = 1;
  else if (state.sourceId) state.step = 0;
  return state;
}

export async function render(ctx, feature) {
  if (!cache) cache = await restore();
  const state = cache;
  const steps = feature && feature.steps && feature.steps.length
    ? feature.steps
    : STEP_TITLES.map(title => ({ title }));

  const stepsBox = h('div', { class: 'wizard-steps' });
  const body = h('div', { class: 'wizard-body' });
  const root = h('div', { class: 'wizard' }, [stepsBox, body]);

  /* ---------- 数据 ---------- */

  function sourceId() {
    return parseIds(state.sourceId)[0] || '';
  }

  function titles() {
    return parseTitles(state.titlesText);
  }

  function pair() {
    return buildVariants(titles(), state.images);
  }

  function headerRow() {
    const sheet = state.workbook?.[Number(state.skuState.sheet ?? 0)];
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    const index = Number(state.skuState.header ?? 0);
    return { rows, header: rows[index] || [], index };
  }

  async function persist() {
    try {
      await writeMany({
        [KEYS.variantSource]: sourceId(),
        [KEYS.variantTitles]: state.titlesText,
        [KEYS.variantImages]: state.images,
        [KEYS.variantState]: {
          folderName: state.folderName,
          column: state.column,
          sourceId: sourceId(),
          titlesText: state.titlesText,
        },
      });
    } catch {
      /* 存储失败不阻塞操作，页面里还有一份内存状态 */
    }
  }

  /* ---------- 任务记录 ---------- */

  function syncTask(run) {
    if (!run || !run.runId || !Array.isArray(run.items) || !run.items.length) return;
    const results = Array.isArray(run.results) ? run.results : [];
    const success = results.filter(item => item.ok).length;
    const total = run.items.length;
    recordRun({
      featureId: 'douyin.copy-variants',
      platformId: 'douyin',
      name: '裂变链接',
      signature: `variant:${run.runId}`,
      status: run.error && !results.length
        ? 'failed'
        : runStatus({ running: Boolean(run.running), total, done: results.length, failed: results.length - success }),
      total,
      done: results.length,
      success,
      failed: results.length - success,
      startedAt: Number(run.runId) || Date.now(),
      at: run.at,
    }).catch(() => {});
  }

  /* ---------- 第 1 步：源商品 ---------- */

  function stepSource() {
    const input = h('input', {
      class: 'input mono',
      type: 'text',
      spellcheck: 'false',
      placeholder: '例如 3855988816393404893',
      oninput: event => {
        state.sourceId = event.target.value;
        refresh();
      },
    });
    input.value = state.sourceId;

    const line = h('div', { class: 'status-line' });

    function refresh() {
      const list = parseIds(state.sourceId);
      const ok = list.length === 1;
      setStatus(
        line,
        list.length === 0
          ? '填一个商品 ID。整批只搜索这一次，后面的变体都从它复制。'
          : list.length === 1
            ? '已识别 1 个商品 ID'
            : `识别到 ${list.length} 个 ID，这里只需要一个（会用第一个：${list[0]}）`,
        list.length === 0 ? '' : (ok ? 'ok' : 'warn')
      );
      nextBtn.disabled = list.length === 0;
      nextBtn.textContent = list.length ? '下一步：填写变体' : '请先填写商品 ID';
    }

    const nextBtn = h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        state.sourceId = sourceId();
        await persist();
        state.step = 1;
        draw();
      },
    });

    refresh();

    return h('div', {}, [
      h('div', { class: 'card' }, [
        sectionTitle('源商品 ID', '这是要被复制的那个商品。整批只会搜索它一次。'),
        input,
        h('div', { style: 'margin-top:8px' }, [line]),
      ]),

      h('div', { class: 'notice', style: 'margin-top:12px' }, [
        h('span', { html: icon('info') }),
        h('div', {}, [
          h('div', { text: '每一条都会在商品列表里点一次「发布相似品」。' }),
          h('div', { style: 'margin-top:2px;opacity:.85' },
            '请先把素材库里的图片按顺序准备好，并确认左侧选中了目标文件夹。'),
        ]),
      ]),

      wizardFoot([nextBtn]),
    ]);
  }

  /* ---------- 第 2 步：标题与图片 ---------- */

  function stepVariants() {
    /* --- 标题 --- */
    const area = h('textarea', {
      class: 'input',
      rows: '6',
      spellcheck: 'false',
      placeholder: '一行一条标题\n去水垢清洁剂 柠檬酸配方 500ml\n厨房重油污 泡沫型清洁剂 500ml',
      oninput: event => {
        state.titlesText = event.target.value;
        scheduleRefresh();
      },
    });
    area.value = state.titlesText;

    const titleLine = h('div', { class: 'status-line' });

    /* --- 表格取列 --- */
    const { rows, header, index } = headerRow();
    const columnSelect = h('select', {
      class: 'input',
      onchange: event => {
        state.column = event.target.value;
        if (state.column === '') return;
        const values = columnValues(rows, index, state.column);
        const list = parseTitles(values.join('\n'));
        if (!list.length) {
          setStatus(titleLine, '这一列没有可用内容', 'warn');
          return;
        }
        state.titlesText = list.join('\n');
        area.value = state.titlesText;
        scheduleRefresh();
        setStatus(titleLine, `已从该列读取 ${list.length} 条标题`, 'ok');
        persist().catch(() => {});
      },
    });
    columnSelect.append(h('option', { value: '', text: '— 不读取 —' }));
    header.forEach((name, cellIndex) => {
      const label = String(name ?? '').trim();
      if (!label) return;
      columnSelect.append(h('option', { value: String(cellIndex), text: `${cellIndex + 1}. ${label}` }));
    });
    if (state.column) columnSelect.value = state.column;

    /* --- 图片文件夹 --- */
    const folderInput = h('input', {
      type: 'file',
      multiple: true,
      webkitdirectory: true,
      style: 'display:none',
      onchange: async event => {
        const files = event.target.files;
        const names = pickImageNames(Array.from(files || []).map(file => ({
          name: file.name,
          webkitRelativePath: file.webkitRelativePath,
        })));
        const first = files && files[0] ? String(files[0].webkitRelativePath || '') : '';
        state.folderName = first ? first.split('/')[0] : '';
        state.images = names;
        await persist();
        draw();
      },
    });

    // 同一个文件夹再选一次时 change 不触发，先清空 value
    // 属性形式各浏览器都认，property 再设一次更稳
    try { folderInput.webkitdirectory = true; } catch { /* 忽略 */ }

    const pickFolder = () => {
      try { folderInput.value = ''; } catch { /* 忽略 */ }
      folderInput.click();
    };

    const folderBox = h('div', {}, [
      state.images.length
        ? h('div', { class: 'row row-between' }, [
          h('div', { class: 'row' }, [
            h('span', { class: 'feature-icon', html: icon('upload') }),
            h('div', {}, [
              h('div', { class: 'list-item-title', text: state.folderName || '已选择文件夹' }),
              h('div', { class: 'list-item-sub', text: `${state.images.length} 张图片` }),
            ]),
          ]),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: pickFolder }, ['重新选择', h('span', { html: icon('refresh') })]),
        ])
        : h('div', { class: 'dropzone', role: 'button', tabindex: '0', onclick: pickFolder }, [
          h('div', { class: 'dropzone-icon', html: icon('upload') }),
          h('div', { class: 'dropzone-title', text: '选择图片文件夹' }),
          h('div', { class: 'dropzone-hint', text: '只读取文件名，不会上传图片。按文件名自然排序后与标题一一对应。' }),
        ]),
      state.images.length
        ? h('div', { class: 'id-preview mono' }, state.images.slice(0, 8).map(name => h('div', { text: name })))
        : null,
      state.images.length > 8
        ? h('div', { class: 'setting-desc', text: `… 其余 ${state.images.length - 8} 张` })
        : null,
    ]);

    /* --- 配对结果（局部刷新，避免重绘打断输入） --- */
    const pairBox = h('div', {});

    function pairContent() {
      const built = pair();
      if (!built.titleCount && !built.imageCount) {
        return [inlineEmpty('还没有数据。先粘贴标题、选择图片文件夹。')];
      }
      const nodes = [
        h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, [
          h('span', { class: 'badge', text: `标题 ${built.titleCount} 条` }),
          h('span', { class: 'badge', text: `图片 ${built.imageCount} 张` }),
          h('span', { class: 'badge badge-primary', text: `保留 ${built.used} 条` }),
        ]),
      ];

      if (!built.used) {
        nodes.push(h('div', { style: 'margin-top:8px' }, [
          statusLine(built.titleCount ? '还没有选择图片文件夹' : '还没有标题', 'warn'),
        ]));
        return nodes;
      }

      const dropped = [];
      if (built.unusedTitles.length) dropped.push(`${built.unusedTitles.length} 条标题没有对应图片`);
      if (built.unusedImages.length) dropped.push(`${built.unusedImages.length} 张图片没有对应标题`);
      if (dropped.length) {
        nodes.push(h('div', { class: 'setting-desc', style: 'margin-top:8px' }, [
          statusLine(`按数量少的为准，${dropped.join('、')}，不会执行。`, 'warn'),
        ]));
      }

      const table = h('table', { class: 'preview-table preview-variants' }, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', { text: '#' }),
            h('th', { text: '商品标题' }),
            h('th', { text: '导购短标题' }),
            h('th', { text: '素材库图片名' }),
          ]),
        ]),
        h('tbody', {}, built.items.slice(0, PREVIEW_LIMIT).map(item => h('tr', {}, [
          h('td', { class: 'mono', text: String(item.no) }),
          h('td', { title: item.title, text: item.title }),
          h('td', {
            title: `${shortTitleOf(item.title)}（${textWidth(shortTitleOf(item.title))} 字符位，上限 24）`,
            text: shortTitleOf(item.title),
          }),
          h('td', { class: 'mono', title: item.image, text: item.image }),
        ]))),
      ]);

      nodes.push(h('div', { class: 'table-wrap', style: 'margin-top:10px' }, [table]));
      if (built.items.length > PREVIEW_LIMIT) {
        nodes.push(h('div', { class: 'setting-desc', style: 'margin-top:6px' },
          `… 其余 ${built.items.length - PREVIEW_LIMIT} 条不在此列出`));
      }
      return nodes;
    }

    function refreshPair() {
      clear(pairBox);
      pairBox.append(...pairContent());
      const built = pair();
      setStatus(
        titleLine,
        built.titleCount ? `已识别 ${built.titleCount} 条标题` : '还没有标题。一行一条，粘贴即可。',
        built.titleCount ? 'ok' : ''
      );
      nextBtn.disabled = built.used === 0;
      nextBtn.textContent = built.used ? `下一步：确认 ${built.used} 条` : '标题与图片都要有';
    }

    let timer = 0;
    function scheduleRefresh() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshPair();
        persist().catch(() => {});
      }, 250);
    }

    const nextBtn = h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        if (!pair().used) return;
        await persist();
        state.step = 2;
        draw();
      },
    });

    refreshPair();

    return h('div', {}, [
      h('div', { class: 'card' }, [
        sectionTitle('标题', '一行一条。粘贴表格整列，或从已导入的表格里选一列。'),
        area,
        h('div', { style: 'margin-top:8px' }, [titleLine]),
        h('div', { class: 'setting-desc', style: 'margin-top:8px' },
          '每条会同时填两个标题：商品标题写整条；导购短标题取前 24 个字符，标题里含英文或数字时取前 23 个。'),
        h('div', { class: 'form-row', style: 'margin-top:10px' }, [
          h('label', { class: 'form-label', text: '从表格读取' }),
          columnSelect,
        ]),
      ]),

      h('div', { class: 'card', style: 'margin-top:12px' }, [
        sectionTitle('图片', '选本地文件夹，只读文件名。请与店铺素材库里的文件名保持一致。'),
        folderBox,
        folderInput,
      ]),

      h('div', { class: 'card', style: 'margin-top:12px' }, [
        sectionTitle('配对结果', '按文件名顺序与标题一一对应，数量少的为准。'),
        pairBox,
      ]),

      wizardFoot([
        h('button', { class: 'btn', onclick: () => { state.step = 0; draw(); }, text: '上一步' }),
        nextBtn,
      ]),
    ]);
  }

  /* ---------- 第 3 步：任务确认 ---------- */

  function stepConfirm() {
    const built = pair();
    const id = sourceId();
    const target = ctx.target || {};
    const detected = target.url ? detectPlatform(target.url) : {};
    const onList = Boolean(target.url) && isDouyinUrl(target.url)
      && (!detected.page || detected.page.key === 'product-list');

    const status = statusLine('', '');

    const startBtn = h('button', {
      class: 'btn btn-primary',
      disabled: state.starting || !built.used || !id,
      onclick: () => startRun(),
    }, [PUBLISH_ENABLED ? '开始并发布' : '开始填写', h('span', { html: icon('play') })]);

    return h('div', {}, [
      h('div', { class: 'card' }, [
        kvRow('源商品 ID', id || '（未填写）'),
        kvRow('变体条数', `${built.used} 条`),
        kvRow('标题 / 图片', `${built.titleCount} / ${built.imageCount}`),
        kvRow('本次动作', PUBLISH_ENABLED ? '填商品标题 + 短标题 + 换主图 + 发布' : '填商品标题 + 短标题 + 换主图，不点发布'),
        built.unusedTitles.length || built.unusedImages.length
          ? kvRow('不执行', [
            built.unusedTitles.length ? `${built.unusedTitles.length} 条标题` : '',
            built.unusedImages.length ? `${built.unusedImages.length} 张图片` : '',
          ].filter(Boolean).join('、'))
          : null,
      ]),

      h('div', { class: 'card', style: 'margin-top:12px' }, [
        h('div', { class: 'row row-between' }, [
          h('div', { class: 'row' }, [
            h('span', { class: 'feature-icon', html: icon(target.platform ? target.platform.icon : 'info') }),
            h('div', {}, [
              h('div', { class: 'list-item-title', text: target.platform ? target.platform.name : '未识别平台' }),
              h('div', { class: 'list-item-sub', text: target.page ? target.page.name : '请切到商品列表页' }),
            ]),
          ]),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => ctx.refresh() }, ['刷新', h('span', { html: icon('refresh') })]),
        ]),
        kvRow('当前页面', onList ? '商品列表，可以开始' : '不是商品列表页', h('span', {
          class: `badge ${onList ? 'badge-success' : 'badge-warn'}`.trim(),
          text: onList ? '已就绪' : '请先切换',
        })),
      ]),

      h('div', { style: 'margin-top:12px' }, [status]),

      h('div', { class: 'notice', style: 'margin-top:12px' }, [
        h('span', { html: icon('info') }),
        h('div', {}, [
          PUBLISH_ENABLED
            ? h('div', { text: `开始后会连续打开 ${built.used} 个发布页，每条填两个标题、换主图后自动发布。` })
            : h('div', { text: `开始后会连续打开 ${built.used} 个发布页，每条填好商品标题、导购短标题和主图，然后停在那里不发布。` }),
          h('div', { style: 'margin-top:2px;opacity:.85' },
            PUBLISH_ENABLED
              ? '可以关掉这个面板，队列在列表页继续跑。期间不要操作列表页，也不要手动关闭新开的标签页。'
              : '填完的页面会保留，方便你逐条核对标题和主图；核对完手动关闭即可。第一次验证建议先只留 3 条标题试跑。'),
        ]),
      ]),

      wizardFoot([
        h('button', { class: 'btn', disabled: state.starting, onclick: () => { state.step = 1; draw(); }, text: '上一步' }),
        startBtn,
      ]),
    ]);
  }

  /* ---------- 第 4 步：执行与结果 ---------- */

  async function startRun() {
    const built = pair();
    const id = sourceId();
    if (!id || !built.used) {
      state.status = { text: '源商品 ID 或变体数据不完整', tone: 'warn' };
      state.step = built.used ? 0 : 1;
      draw();
      return;
    }

    state.starting = true;
    state.status = { text: '正在连接商品列表页…', tone: '' };
    draw();

    try {
      const tab = await resolveTargetTab();
      if (!tab) throw new Error('没有可用的标签页，请先打开抖店「商品列表」页。');
      if (!isDouyinUrl(tab.url)) {
        throw new Error(`当前标签页不是抖店后台（${tab.title || tab.url || '未知页面'}），请先切到「商品列表」页。`);
      }
      const detected = detectPlatform(tab.url);
      if (detected.page && detected.page.key !== 'product-list') {
        throw new Error(`当前页面是「${detected.page.name}」，请先切回「商品列表」页再开始。`);
      }

      await ensureScript(tab.id, { ping: MSG.SIMILAR_PING, file: 'similar.js' });
      const result = await toTab(tab.id, {
        type: MSG.VARIANT_RUN,
        sourceId: id,
        publish: PUBLISH_ENABLED,
        items: built.items.map(item => ({ no: item.no, title: item.title, image: item.image })),
      }, 20000);
      if (result && result.error) throw new Error(result.error);

      await persist();
      // 页面已确认启动，先用乐观快照占位；真实进度由 storage 覆盖
      state.run = {
        running: true,
        runId: Date.now(),
        sourceId: id,
        publish: PUBLISH_ENABLED,
        items: built.items,
        index: 0,
        results: [],
        at: Date.now(),
      };
      state.status = {
        text: PUBLISH_ENABLED
          ? `已开始，共 ${built.used} 条。可以关掉面板，流程会在列表页继续。`
          : `已开始，共 ${built.used} 条。每条填完标题和主图就停下，不会发布。`,
        tone: 'ok',
      };
      state.step = 3;
    } catch (error) {
      state.status = { text: `无法开始：${error.message}`, tone: 'error' };
    } finally {
      state.starting = false;
      draw();
    }
  }

  async function stopRun() {
    try {
      const tabId = await read(KEYS.similarListTabId);
      if (!tabId) throw new Error('没有记录到列表页，可能已经关闭');
      await toTab(tabId, { type: MSG.VARIANT_STOP }, 8000);
      state.status = { text: '已发送停止指令，当前这一条走完后就会停。', tone: 'warn' };
    } catch (error) {
      state.status = { text: `停止失败：${error.message}`, tone: 'error' };
    }
    draw();
  }

  function stepRun() {
    const run = state.run || {};
    const items = Array.isArray(run.items) ? run.items : [];
    const results = Array.isArray(run.results) ? run.results : [];
    const success = results.filter(item => item.ok).length;
    const total = items.length;
    const percent = total ? Math.round(results.length / total * 100) : 0;
    // 只填模式：成功 = 已填好，没有提交
    const filledOnly = run.publish === false;
    const doneLabel = filledOnly ? '已填好' : '已发布';
    const info = {
      running: Boolean(run.running),
      total,
      done: results.length,
      success,
      failed: results.length - success,
      percent,
      text: state.progress?.text || '',
    };
    state.runningCount = info.running ? 1 : 0;

    const status = statusLine(
      state.status ? state.status.text : (info.running ? (filledOnly ? '填写中…' : '执行中…') : ''),
      state.status ? state.status.tone : ''
    );
    const bar = h('div', { class: 'progress-bar' });
    const fill = h('div', { class: 'progress-fill' });
    fill.style.width = `${info.percent}%`;
    bar.append(fill);

    const logBox = h('pre', { class: 'diag-box' });
    logBox.hidden = !state.logOpen;
    logBox.textContent = state.debug.length
      ? state.debug.slice(-40).join('\n')
      : `还没有运行日志。跑一次后这里会记录：搜索源商品 / 打开发布页 / 填商品标题 / 填导购短标题 / 换主图${filledOnly ? '' : ' / 发布结果'}。`;

    const hasResults = results.length > 0;

    return h('div', {}, [
      h('div', { class: 'card' }, [
        h('div', { class: 'row row-between' }, [
          h('div', { class: 'row' }, [
            h('span', { class: `dot ${info.running ? 'dot-warn' : (total && info.done >= total ? 'dot-success' : '')}`.trim() }),
            h('div', {}, [
              h('div', { class: 'list-item-title', text: info.running ? (filledOnly ? '填写中' : '执行中') : (total ? (filledOnly ? '已填完' : '已结束') : '尚未开始') }),
              h('div', { class: 'list-item-sub', text: total ? `${info.done} / ${total} 条已返回结果` : '等待开始' }),
            ]),
          ]),
          info.running
            ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => stopRun() }, ['停止', h('span', { html: icon('square') })])
            : null,
        ]),

        h('div', { style: 'margin-top:10px' }, [bar]),
        info.text
          ? h('div', { class: 'progress-text', text: info.text })
          : h('div', { class: 'progress-text muted', text: '进度提示会显示在这里。' }),
      ]),

      filledOnly
        ? h('div', { class: 'notice', style: 'margin-top:12px' }, [
          h('span', { html: icon('info') }),
          h('div', {}, [
            h('div', { text: '这一版只填不发布：每条填好两个标题和主图后停在那一步，页面保留。' }),
            h('div', { style: 'margin-top:2px;opacity:.85', text: '逐条核对无误后手动点发布（或关掉页面）。等这一段验证稳了再打开自动发布。' }),
          ]),
        ])
        : null,

      run.error
        ? h('div', { style: 'margin-top:12px' }, [
          h('div', { class: 'card' }, [
            h('div', { class: 'row' }, [
              h('span', { html: icon('alert') }),
              h('div', { class: 'list-item-title', text: '整批中止' }),
            ]),
            h('div', { class: 'setting-desc', style: 'margin-top:6px', text: run.error }),
          ]),
        ])
        : null,

      h('div', { style: 'margin-top:12px' }, [status]),

      hasResults
        ? h('div', { class: 'card', style: 'margin-top:12px' }, [
          h('div', { class: 'row row-between' }, [
            h('div', { class: 'setting-title', text: '执行结果' }),
            h('span', { class: 'setting-desc', text: run.at ? new Date(run.at).toLocaleString('zh-CN') : '' }),
          ]),
          h('div', { class: 'result-summary', style: 'margin-top:8px' }, [
            h('span', { class: 'pass', text: `${filledOnly ? '已填好' : '成功'} ${info.success}` }),
            h('span', { class: 'muted', text: ' · ' }),
            h('span', { class: 'fail', text: `失败 ${info.failed}` }),
            h('span', { class: 'muted', text: ` · 共 ${total || results.length} 条` }),
          ]),
          h('div', { class: 'result-actions' }, [
            h('button', {
              class: 'btn btn-sm',
              onclick: event => copyWithFeedback(event.currentTarget, variantRunText(run, false), { empty: '还没有结果可复制' }),
            }, ['复制全部结果', h('span', { html: icon('copy') })]),
            h('button', {
              class: 'btn btn-sm btn-ghost',
              onclick: event => copyWithFeedback(event.currentTarget, variantRunText(run, true), { empty: '这次没有失败项' }),
            }, '只复制失败项'),
          ]),
          h('div', { class: 'result-list' }, results.map(item => h('div', {
            class: `result-item ${item.ok ? 'is-ok' : 'is-fail'}`.trim(),
          }, [
            h('span', { class: `dot ${item.ok ? 'dot-success' : 'dot-error'}`.trim() }),
            h('div', { class: 'result-main' }, [
              h('div', { class: 'result-title' }, [
                h('span', { text: `#${item.no || '?'}` }),
                h('span', { class: 'truncate', text: item.title || '（无标题）' }),
              ]),
              h('div', { class: 'result-sub mono', text: item.image || '未配图' }),
              item.ok && item.filled ? h('div', { class: 'result-sub', text: '已填好，未发布' }) : null,
              item.ok ? null : h('div', { class: 'result-sub', text: variantFailure(item) }),
            ]),
          ]))),
        ])
        : h('div', { style: 'margin-top:12px' }, [
          inlineEmpty(info.total
            ? (run.error ? '整批没能开始或中途停住了，原因见上方。' : '已经开始，等待第一条结果返回…')
            : '还没有开始。回到上一步确认变体列表后开始。'),
        ]),

      h('div', { class: 'tool-row' }, [
        h('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: () => {
            state.logOpen = !state.logOpen;
            logBox.hidden = !state.logOpen;
          },
        }, ['运行日志（卡住时看这个）', h('span', { html: icon('list') })]),
      ]),
      logBox,

      wizardFoot([
        h('button', {
          class: 'btn',
          disabled: info.running,
          onclick: () => { state.step = 1; draw(); },
          text: '修改列表',
        }),
        info.running
          ? h('button', { class: 'btn', onclick: () => stopRun() }, ['停止任务', h('span', { html: icon('square') })])
          : h('button', {
            class: 'btn btn-primary',
            onclick: () => { state.step = 2; draw(); },
            text: '再跑一批',
          }),
      ]),
    ]);
  }

  /* ---------- 绘制 ---------- */

  function draw() {
    repaint = draw;
    clear(stepsBox);
    stepsBox.append(stepper({
      steps,
      current: state.step,
      locked: state.starting,
      onJump: index => {
        if (state.starting || state.run?.running) return;
        state.step = index;
        draw();
      },
    }));

    clear(body);
    if (state.step === 0) body.append(stepSource());
    else if (state.step === 1) body.append(stepVariants());
    else if (state.step === 2) body.append(stepConfirm());
    else body.append(stepRun());
  }

  // 先认领绘制权再画第一帧：否则重新进入详情页时，这一次 draw 会被转发给
  // 上一份已脱离文档的节点，页面就是空白（相似品页踩过同一个坑）。
  repaint = draw;
  syncTask(state.run);
  draw();

  if (typeof offChange === 'function') offChange();
  const off = onChange(changes => {
    let dirty = false;
    if (changes[KEYS.variantRun]) {
      state.run = changes[KEYS.variantRun].newValue || null;
      syncTask(state.run);
      dirty = true;
    }
    if (changes[KEYS.variantProgress]) {
      state.progress = changes[KEYS.variantProgress].newValue || null;
      dirty = true;
    }
    if (changes[KEYS.variantDebug]) {
      state.debug = changes[KEYS.variantDebug].newValue || [];
      dirty = state.logOpen;
    }
    if (!dirty) return;
    if (typeof root.isConnected === 'boolean' && !root.isConnected) {
      off();
      return;
    }
    if (state.step === 3) draw();
  });
  offChange = off;

  return root;
}
