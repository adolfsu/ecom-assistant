/*
 * 批量填充 SKU（抖店）—— 2.0 侧边栏版四步向导。
 *
 * 边界（顺着 2.0 方案第 11 条）：
 *   - 执行链路一行不改：仍是给商品编辑页发 content.js 的 BATCH_FILL，页面里逐条创建；
 *   - 数据仍然存在旧面板用过的键里（doudianBatchWorkbook / doudianBatchState），
 *     两个入口互相切换不会丢表格；
 *   - 不伪造进度条：批量填入期间只显示「正在执行 + 页面上的实际提示」，
 *     结束才按页面返回的真实结果汇总。
 */

import { h, clear } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { KEYS, write, writeMany, readMany } from '../../shared/storage.js';
import { parseWorkbook, describeRow } from '../../shared/excel.js';
import {
  fields, fieldLabel, bestHeaderIndex, mapColumns, mergeColumns,
  buildRecords, previewText,
} from '../../shared/sku.js';
import { copyWithFeedback } from '../../shared/clipboard.js';
import { fillDetail, fillFailure, fillRunText } from '../../shared/run-format.js';
import { recordRun, runStatus } from '../../shared/tasks.js';
import { MSG, toTab } from '../../../core/message-bus.js';
import { resolveTargetTab, ensureScript, isDouyinUrl } from '../../../core/page-bridge.js';
import { detectPlatform } from '../../../core/platform-detector.js';
import { stepper, wizardFoot, setStatus, statusLine, kvRow, inlineEmpty, sectionTitle } from './wizard.js';

const STEP_KEYS = ['import', 'mapping', 'preview', 'run'];

/* 路由来回切换时保留向导状态（面板重开则从 storage 恢复） */
let cache = null;
// 页面可能因为标签页切换被重新渲染，异步流程必须绘制「最新那一份」而不是旧节点
let repaint = null;
let latestLive = {};

function blankState() {
  return {
    step: 0,
    workbook: null,
    fileName: '',
    sheetIndex: 0,
    headerIndex: 0,
    columns: {},
    autoSplit: true,
    restored: false,
    status: null,
    running: false,
    run: null,
    diag: '',
    diagOpen: false,
  };
}

async function restore() {
  const state = blankState();
  const data = await readMany([KEYS.skuWorkbook, KEYS.skuWorkbookName, KEYS.skuState, KEYS.skuRun]);
  const workbook = data[KEYS.skuWorkbook];
  state.run = data[KEYS.skuRun] || null;

  if (Array.isArray(workbook) && workbook.length) {
    state.workbook = workbook;
    state.fileName = data[KEYS.skuWorkbookName] || '上次选择的表格';
    state.restored = true;

    const saved = data[KEYS.skuState] || {};
    state.sheetIndex = workbook[Number(saved.sheet)] ? Number(saved.sheet) : 0;
    const rows = workbook[state.sheetIndex]?.rows || [];
    state.headerIndex = rows[Number(saved.header)] ? Number(saved.header) : bestHeaderIndex(rows);
    state.columns = mergeColumns(rows[state.headerIndex] || [], saved.columns || {});
    if (saved.autoSplit !== undefined) state.autoSplit = saved.autoSplit !== false;

    const savedStep = Number(saved.step);
    if (Number.isInteger(savedStep) && savedStep >= 0 && savedStep < STEP_KEYS.length) state.step = savedStep;
    else state.step = state.run ? 3 : 1;
  }
  return state;
}

export async function render(ctx, feature) {
  if (!cache) cache = await restore();
  const state = cache;
  const steps = feature && feature.steps && feature.steps.length
    ? feature.steps
    : STEP_KEYS.map(key => ({ title: key }));

  const stepsBox = h('div', { class: 'wizard-steps' });
  const body = h('div', { class: 'wizard-body' });
  const root = h('div', { class: 'wizard' }, [stepsBox, body]);

  let live = {};

  /* ---------- 数据 ---------- */

  function rowsOf() {
    if (!state.workbook) return [];
    const sheet = state.workbook[state.sheetIndex];
    return Array.isArray(sheet?.rows) ? sheet.rows : [];
  }

  function headerRow() {
    return rowsOf()[state.headerIndex] || [];
  }

  function currentData() {
    return buildRecords({
      rows: rowsOf(),
      headerIndex: state.headerIndex,
      columns: state.columns,
      autoSplit: state.autoSplit,
    });
  }

  async function persist() {
    if (!state.workbook) return;
    await writeMany({
      [KEYS.skuWorkbook]: state.workbook,
      [KEYS.skuWorkbookName]: state.fileName,
      [KEYS.skuState]: {
        sheet: String(state.sheetIndex),
        header: String(state.headerIndex),
        columns: { ...state.columns },
        autoSplit: state.autoSplit,
        step: state.step,
      },
    });
  }

  function goStep(index) {
    if (state.running) return;
    state.step = Math.max(0, Math.min(steps.length - 1, index));
    persist().catch(() => {});
    draw();
  }

  /* ---------- 任务记录 ---------- */

  /**
   * 按 skuFillRun 快照补记任务（同一个 runId 只对应一条，重复调用只更新）。
   * 页面上跑完会写 skuFillRun，所以面板中途关掉、事后打开也能在任务中心看到这一条。
   */
  function syncTask(run) {
    if (!run || !run.runId || !Array.isArray(run.results) || !run.results.length) return;
    const total = Number(run.total) || run.results.length;
    const success = run.results.filter(item => item.ok).length;
    recordRun({
      featureId: 'douyin.sku-fill',
      platformId: 'douyin',
      name: '批量填充 SKU',
      signature: `sku:${run.runId}`,
      status: runStatus({ running: false, total, done: run.results.length, failed: run.results.length - success }),
      total,
      done: run.results.length,
      success,
      failed: run.results.length - success,
      at: run.at,
    }).catch(() => {});
  }

  /* ---------- 渲染 ---------- */

  /**
   * 异步流程里拿到的 draw 可能属于已经被替换掉的旧节点，
   * 这里统一转发到最新一份，避免「跑完了界面不更新」。
   */
  function draw() {
    if (typeof repaint === 'function' && repaint !== draw) {
      repaint();
      return;
    }
    repaint = draw;
    clear(stepsBox);
    stepsBox.append(stepper({
      steps,
      current: state.step,
      locked: state.running,
      onJump: goStep,
    }));

    clear(body);
    live = {};
    latestLive = live;
    if (state.step === 0) body.append(stepImport());
    else if (state.step === 1) body.append(stepMapping());
    else if (state.step === 2) body.append(stepPreview());
    else body.append(stepRun());
  }

  /* ---------- 第 1 步：导入 ---------- */

  async function loadFile(file) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      state.status = { text: '只支持 .xlsx 文件。如果是 .xls，请先在 Excel 里另存为 .xlsx。', tone: 'error' };
      draw();
      return;
    }
    state.status = { text: `正在读取 ${file.name}…`, tone: '' };
    draw();
    try {
      const workbook = await parseWorkbook(file);
      if (!workbook.length) throw new Error('这个文件没有工作表');
      state.workbook = workbook;
      state.fileName = file.name;
      state.sheetIndex = 0;
      state.restored = false;
      applySheet(0);
      state.status = { text: `已读取 ${file.name}，共 ${workbook.length} 个工作表`, tone: 'ok' };
      state.step = 1;
      await persist();
    } catch (error) {
      state.status = { text: `读取失败：${error.message}`, tone: 'error' };
    }
    draw();
  }

  function applySheet(index) {
    state.sheetIndex = Math.max(0, Math.min((state.workbook?.length || 1) - 1, index));
    const rows = rowsOf();
    state.headerIndex = bestHeaderIndex(rows);
    state.columns = mapColumns(rows[state.headerIndex] || []);
  }

  function stepImport() {
    const fileInput = h('input', {
      type: 'file',
      accept: '.xlsx',
      style: 'display:none',
      onchange: event => loadFile(event.target.files && event.target.files[0]),
    });

    // 同一个文件重选时 change 不会触发，先清空 value
    const pick = () => {
      try { fileInput.value = ''; } catch { /* 忽略 */ }
      fileInput.click();
    };

    const zone = h('div', {
      class: 'dropzone',
      role: 'button',
      tabindex: '0',
      onclick: () => pick(),
      onkeydown: event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          pick();
        }
      },
      ondragover: event => {
        event.preventDefault();
        zone.style.borderColor = 'var(--c-primary)';
        zone.style.background = 'var(--c-primary-soft)';
      },
      ondragleave: () => {
        zone.style.borderColor = '';
        zone.style.background = '';
      },
      ondrop: event => {
        event.preventDefault();
        zone.style.borderColor = '';
        zone.style.background = '';
        loadFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
      },
    }, [
      h('span', { class: 'dropzone-icon', html: icon('upload', 'i-lg') }),
      h('div', { class: 'dropzone-title', text: '选择或拖入商品表格（.xlsx）' }),
      h('div', { class: 'dropzone-hint', text: '表头不必在第一行，下一步可以手工指定；文件只在本机读取，不会上传。' }),
      fileInput,
    ]);

    const loaded = state.workbook
      ? h('div', { class: 'card', style: 'margin-top:12px' }, [
        h('div', { class: 'row row-between' }, [
          h('div', { class: 'grow' }, [
            h('div', { class: 'setting-title truncate', text: state.fileName || '已载入表格' }),
            h('div', { class: 'setting-desc' },
              `${state.workbook.length} 个工作表 · 当前「${state.workbook[state.sheetIndex]?.name || '—'}」`
              + ` · 共 ${(state.workbook[state.sheetIndex]?.rows || []).length} 行`),
          ]),
          h('span', { class: 'badge badge-success', text: state.restored ? '已恢复上次' : '已读取' }),
        ]),
        h('div', { class: 'row', style: 'margin-top:10px' }, [
          h('button', {
            class: 'btn btn-sm',
            onclick: () => { state.status = null; pick(); },
          }, ['换一个文件', h('span', { html: icon('refresh') })]),
          state.restored
            ? h('button', {
              class: 'btn btn-sm btn-ghost',
              onclick: async () => {
                await writeMany({ [KEYS.skuWorkbook]: [], [KEYS.skuWorkbookName]: '', [KEYS.skuState]: {} });
                state.workbook = null;
                state.fileName = '';
                state.restored = false;
                state.columns = {};
                state.headerIndex = 0;
                state.sheetIndex = 0;
                draw();
              },
            }, '清除')
            : null,
        ]),
      ])
      : inlineEmpty('还没有表格。选一个 .xlsx，下一步会显示字段匹配。');

    const status = statusLine(state.status?.text || '', state.status?.tone || '');

    return h('div', {}, [
      zone,
      loaded,
      h('div', { style: 'margin-top:12px' }, [status]),
      wizardFoot([
        h('button', {
          class: 'btn btn-primary',
          disabled: !state.workbook,
          onclick: () => goStep(1),
        }, state.workbook ? '下一步：字段匹配' : '请先选择表格'),
      ]),
    ]);
  }

  /* ---------- 第 2 步：字段匹配 ---------- */

  function stepMapping() {
    const rows = rowsOf();
    const header = headerRow();

    const sheetSelect = h('select', {
      class: 'input',
      onchange: event => {
        applySheet(Number(event.target.value));
        persist().catch(() => {});
        draw();
      },
    });
    (state.workbook || []).forEach((sheet, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = sheet.name;
      sheetSelect.append(option);
    });
    sheetSelect.value = String(state.sheetIndex);

    const headerSelect = h('select', {
      class: 'input',
      onchange: event => {
        state.headerIndex = Number(event.target.value);
        state.columns = mapColumns(rows[state.headerIndex] || [], state.columns);
        persist().catch(() => {});
        draw();
      },
    });
    rows.forEach((row, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `第 ${index + 1} 行：${describeRow(row)}`;
      headerSelect.append(option);
    });
    headerSelect.value = String(state.headerIndex);

    const summary = h('div', { class: 'status-line' });
    const nextBtn = h('button', { class: 'btn btn-primary', onclick: () => goStep(2) });

    function refreshSummary() {
      const data = currentData();
      summary.textContent = data.records.length
        ? `识别到 ${data.records.length} 条可导入 SKU${data.warnings.length ? `，${data.warnings.join('，')}` : ''}`
        : '还没有可导入的 SKU：名称、编码（或价格）必须有值，规格与数量可由名称自动拆分。';
      summary.className = `status-line ${data.records.length ? (data.warnings.length ? 'is-warn' : 'is-ok') : 'is-warn'}`.trim();
      nextBtn.disabled = data.records.length === 0;
      nextBtn.textContent = data.records.length ? `下一步：预览 ${data.records.length} 条` : '暂无可导入数据';
    }

    const fieldSelects = fields().map(field => {
      const select = h('select', {
        class: 'input',
        onchange: event => {
          state.columns[field] = event.target.value;
          persist().catch(() => {});
          refreshSummary();
        },
      });
      select.append(new Option('不导入此列', ''));
      header.forEach((name, index) => {
        select.append(new Option(String(name || `列${index + 1}`), String(index)));
      });
      select.value = state.columns[field] === undefined ? '' : String(state.columns[field]);
      return h('div', { class: 'form-row' }, [
        h('label', { class: 'form-label', text: fieldLabel(field) }),
        select,
      ]);
    });

    const autoSplit = h('input', {
      type: 'checkbox',
      onchange: event => {
        state.autoSplit = Boolean(event.target.checked);
        persist().catch(() => {});
        refreshSummary();
      },
    });
    autoSplit.checked = state.autoSplit;

    refreshSummary();

    return h('div', {}, [
      state.status
        ? h('div', { style: 'margin-bottom:10px' }, [statusLine(state.status.text, state.status.tone)])
        : null,

      h('div', { class: 'card' }, [
        sectionTitle('表格范围', '先确认读哪张工作表、哪一行是表头。'),
        h('div', { class: 'form-row' }, [
          h('label', { class: 'form-label', text: '工作表' }),
          sheetSelect,
        ]),
        h('div', { class: 'form-row' }, [
          h('label', { class: 'form-label', text: '表头行' }),
          headerSelect,
        ]),
      ]),

      h('div', { class: 'card', style: 'margin-top:12px' }, [
        sectionTitle('字段匹配', '只填名称、编码、价格也能跑；规格与数量勾选下面自动拆分即可。'),
        ...fieldSelects,
        h('label', { class: 'check-row' }, [
          autoSplit,
          h('span', { text: '名称已含规格时自动拆分（只拆最右一组，已有值不会被覆盖）' }),
        ]),
      ]),

      h('div', { style: 'margin-top:12px' }, [summary]),

      wizardFoot([
        h('button', { class: 'btn', onclick: () => goStep(0), text: '上一步' }),
        nextBtn,
      ]),
    ]);
  }

  /* ---------- 第 3 步：预览 ---------- */

  function stepPreview() {
    const data = currentData();
    const first = data.records[0];
    const preview = data.records.slice(0, 10);

    const stats = h('div', { class: 'stat-row' }, [
      h('div', { class: 'stat' }, [
        h('div', { class: 'stat-value', text: String(data.records.length) }),
        h('div', { class: 'stat-label', text: '可导入' }),
      ]),
      h('div', { class: 'stat' }, [
        h('div', { class: 'stat-value', text: String(data.skipped) }),
        h('div', { class: 'stat-label', text: '跳过（字段不全）' }),
      ]),
      h('div', { class: 'stat' }, [
        h('div', { class: 'stat-value', text: String(data.splitCount) }),
        h('div', { class: 'stat-label', text: '自动拆分' }),
      ]),
    ]);

    const table = preview.length
      ? h('div', { class: 'table-wrap' }, [
        h('table', { class: 'preview-table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: '行' }),
            h('th', { text: 'SKU 名称' }),
            h('th', { text: '规格' }),
            h('th', { text: '数量' }),
            h('th', { text: '编码' }),
            h('th', { text: '价格' }),
          ])]),
          h('tbody', {}, preview.map(record => h('tr', {}, [
            h('td', { class: 'mono', text: String(record.sourceRow) }),
            h('td', { text: record.skuName }),
            h('td', { text: `${record.specValue}${record.specUnit}` }),
            h('td', { text: `${record.quantity}${record.quantityUnit}` }),
            h('td', { class: 'mono', text: record.code }),
            h('td', { class: 'mono', text: record.price }),
          ]))),
        ]),
        data.records.length > preview.length
          ? h('div', { class: 'setting-desc', style: 'padding:6px 2px 0' },
            `仅显示前 ${preview.length} 条，共 ${data.records.length} 条`)
          : null,
      ])
      : inlineEmpty('没有可导入的数据，请回到上一步检查字段匹配。');

    const errors = data.splitErrors.length
      ? h('div', { class: 'notice', style: 'margin-top:12px' }, [
        h('span', { html: icon('alert') }),
        h('div', {}, [
          h('div', { text: `${data.splitErrors.length} 条名称没识别出规格，这些行会被跳过` }),
          h('div', { style: 'margin-top:2px;opacity:.85' },
            `第 ${data.splitErrors.slice(0, 6).map(item => item.row).join('、')} 行`
            + `${data.splitErrors.length > 6 ? ' 等' : ''}（${data.splitErrors[0].reason}）`),
        ]),
      ])
      : null;

    return h('div', {}, [
      stats,
      data.warnings.length
        ? h('div', { class: 'status-line is-warn', style: 'margin-top:10px' }, data.warnings.join('，'))
        : null,
      h('div', { class: 'card', style: 'margin-top:12px;padding:10px 12px' }, [
        h('div', { class: 'preview-line mono', text: previewText(first) }),
      ]),
      h('div', { style: 'margin-top:12px' }, [table]),
      errors,
      wizardFoot([
        h('button', { class: 'btn', onclick: () => goStep(1), text: '上一步' }),
        h('button', {
          class: 'btn btn-primary',
          disabled: data.records.length === 0,
          onclick: () => goStep(3),
        }, data.records.length ? `下一步：执行 ${data.records.length} 条` : '暂无数据'),
      ]),
    ]);
  }

  /* ---------- 第 4 步：执行与结果 ---------- */

  async function startRun() {
    const data = currentData();
    if (!data.records.length) {
      state.status = { text: '没有可导入的数据，请回到上一步检查。', tone: 'warn' };
      draw();
      return;
    }

    // 一次执行一个 runId：任务中心靠它把「开始 / 结束」认成同一条记录
    const runId = Date.now();
    const total = data.records.length;

    state.running = true;
    state.status = { text: '正在连接商品编辑页…', tone: '' };
    draw();
    recordRun({
      featureId: 'douyin.sku-fill',
      platformId: 'douyin',
      name: '批量填充 SKU',
      signature: `sku:${runId}`,
      status: 'running',
      total,
      done: 0,
      startedAt: runId,
    }).catch(() => {});

    try {
      const tab = await resolveTargetTab();
      if (!tab) throw new Error('没有可用的标签页。请先打开抖店商品编辑页，并点开一个空白 SKU 的编辑框。');
      if (!isDouyinUrl(tab.url)) {
        throw new Error(`当前标签页不是抖店后台（${tab.title || tab.url || '未知页面'}），请先切到商品编辑页。`);
      }

      const detected = detectPlatform(tab.url);
      if (detected.page && detected.page.key !== 'product-create') {
        setStatus(latestLive.status, '当前页面不像商品编辑页，正在尝试连接；如果页面里没有打开规格编辑框，会直接报错。', 'warn');
      }

      await ensureScript(tab.id, { ping: MSG.PING, file: 'content.js' });
      setStatus(latestLive.status, `已连接页面，正在逐条创建 ${data.records.length} 条 SKU。请不要关闭或刷新这个商品页。`, '');

      const result = await toTab(tab.id, { type: MSG.BATCH_FILL, records: data.records, runId }, 15 * 60 * 1000);
      if (result && result.error) throw new Error(result.error);
      if (!result || !Array.isArray(result.results)) throw new Error('商品页没有返回批量填入结果');

      state.run = {
        runId,
        at: Date.now(),
        total: data.records.length,
        results: result.results,
        tabTitle: tab.title || '',
      };
      await write(KEYS.skuRun, state.run);
      syncTask(state.run);

      const success = result.results.filter(item => item.ok).length;
      state.status = {
        text: `执行结束：成功 ${success} / 共 ${data.records.length} 条，请在页面上核对后自行保存商品。`,
        tone: success === data.records.length ? 'ok' : 'warn',
      };
    } catch (error) {
      state.status = { text: `批量填入失败：${error.message}`, tone: 'error' };
      recordRun({
        featureId: 'douyin.sku-fill',
        platformId: 'douyin',
        name: '批量填充 SKU',
        signature: `sku:${runId}`,
        status: 'failed',
        total,
        done: 0,
        startedAt: runId,
        at: Date.now(),
      }).catch(() => {});
    } finally {
      state.running = false;
      draw();
    }
  }

  async function runDiagnose() {
    const box = latestLive.diag;
    if (!box) return;
    box.textContent = '正在检查页面结构…';
    try {
      const tab = await resolveTargetTab();
      if (!tab || !isDouyinUrl(tab.url)) throw new Error('请先切到抖店商品编辑页');
      await ensureScript(tab.id, { ping: MSG.PING, file: 'content.js' });
      const result = await toTab(tab.id, { type: MSG.DIAGNOSE }, 20000);
      box.textContent = result?.text || '页面没有返回结构信息';
    } catch (error) {
      box.textContent = `自检失败：${error.message}`;
    }
  }

  function stepRun() {
    const data = currentData();
    const target = ctx.target || {};
    const onEditor = Boolean(target.page && target.page.key === 'product-create');
    const status = statusLine(state.status?.text || '', state.status?.tone || '');
    live.status = status;

    const runBtn = h('button', {
      class: 'btn btn-primary',
      disabled: state.running || data.records.length === 0,
      onclick: () => startRun(),
    });
    runBtn.append(
      h('span', { html: icon(state.running ? 'clock' : 'play') }),
      h('span', { text: state.running ? '正在执行…' : `开始填入 ${data.records.length} 条` })
    );

    const diagBox = h('pre', { class: 'diag-box', hidden: !state.diagOpen });
    diagBox.textContent = state.diag || '还没有检查。点「检查页面结构」会把识别到的规格框信息打在这里，卡住时发给开发者看。';
    live.diag = diagBox;

    const diagBtn = h('button', {
      class: 'btn btn-sm btn-ghost',
      onclick: async () => {
        state.diagOpen = true;
        diagBox.hidden = false;
        await runDiagnose();
      },
    }, ['检查页面结构', h('span', { html: icon('search') })]);

    const run = state.run;
    const resultBox = run && Array.isArray(run.results) && run.results.length
      ? h('div', { class: 'card', style: 'margin-top:12px' }, [
        h('div', { class: 'row row-between' }, [
          h('div', { class: 'setting-title', text: '上次执行结果' }),
          h('span', { class: 'setting-desc', text: new Date(run.at).toLocaleString('zh-CN') }),
        ]),
        h('div', { class: 'result-summary', style: 'margin-top:8px' }, [
          h('span', { class: 'pass', text: `成功 ${run.results.filter(item => item.ok).length}` }),
          h('span', { class: 'muted', text: ' · ' }),
          h('span', { class: 'fail', text: `失败 ${run.results.filter(item => !item.ok).length}` }),
          h('span', { class: 'muted', text: ` · 共 ${run.total || run.results.length} 条` }),
        ]),
        h('div', { class: 'result-actions' }, [
          h('button', {
            class: 'btn btn-sm',
            onclick: event => copyWithFeedback(event.currentTarget, fillRunText(run, false), { empty: '还没有结果可复制' }),
          }, ['复制全部结果', h('span', { html: icon('copy') })]),
          h('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: event => copyWithFeedback(event.currentTarget, fillRunText(run, true), { empty: '这次没有失败项' }),
          }, '只复制失败项'),
        ]),
        h('div', { class: 'result-list' }, run.results.map(item => h('div', {
          class: `result-item ${item.ok ? 'is-ok' : 'is-fail'}`.trim(),
        }, [
          h('span', { class: `dot ${item.ok ? 'dot-success' : 'dot-error'}`.trim() }),
          h('div', { class: 'result-main' }, [
            h('div', { class: 'result-title' }, [
              h('span', { class: 'mono', text: `第 ${item.row} 行` }),
              h('span', { class: 'truncate', text: item.skuName || '' }),
            ]),
            h('div', { class: 'result-sub', text: item.ok ? fillDetail(item) : fillFailure(item) }),
          ]),
        ]))),
      ])
      : null;

    return h('div', {}, [
      h('div', { class: 'card' }, [
        h('div', { class: 'row row-between' }, [
          h('div', { class: 'row' }, [
            h('span', { class: 'feature-icon', html: icon(target.platform ? target.platform.icon : 'info') }),
            h('div', {}, [
              h('div', { class: 'list-item-title', text: target.platform ? target.platform.name : '未识别平台' }),
              h('div', { class: 'list-item-sub', text: target.page ? target.page.name : '请切到商品编辑页' }),
            ]),
          ]),
          h('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: () => ctx.refresh(),
          }, ['刷新', h('span', { html: icon('refresh') })]),
        ]),
        kvRow('本次条数', `${data.records.length} 条`, h('span', {
          class: `badge ${onEditor ? 'badge-success' : 'badge-warn'}`.trim(),
          text: onEditor ? '页面匹配' : '页面待确认',
        })),
        h('div', { class: 'setting-desc', style: 'margin-top:8px' },
          '执行前请先在商品页点开一个空白 SKU 的「填写并新增规格值」编辑框；执行过程中不要刷新页面。'),
      ]),

      h('div', { style: 'margin-top:12px' }, [status]),

      h('div', { style: 'margin-top:12px;display:flex;gap:8px;align-items:center' }, [
        diagBtn,
      ]),
      diagBox,

      resultBox,

      wizardFoot([
        h('button', {
          class: 'btn',
          disabled: state.running,
          onclick: () => goStep(2),
          text: '上一步',
        }),
        runBtn,
      ]),
    ]);
  }

  // 先认领绘制权再画第一帧：否则重新进入详情页时，这一次 draw 会被转发给
  // 上一份已脱离文档的节点，页面就是空白（发布相似品那边踩过同一个坑）。
  repaint = draw;
  syncTask(state.run);
  draw();
  return root;
}

/** 供离线测试清理模块缓存 */
export function resetCache() {
  cache = null;
}
