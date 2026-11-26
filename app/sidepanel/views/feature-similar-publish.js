/*
 * 批量发布相似品（抖店）—— 2.0 侧边栏版三步向导。
 *
 * 这个功能的执行体在列表页（similar.js 的队列），进度与结果都写在 storage 里，
 * 所以侧边栏只做三件事：收集 ID、校验页面、读结果显示。
 * 关掉面板不会中断队列 —— 这一点和旧面板一致，也是 2.0 的硬性要求。
 */

import { h, clear } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { KEYS, read, write, readMany, onChange } from '../../shared/storage.js';
import { parseIds, stripQuotes } from '../../shared/ids.js';
import { columnValues } from '../../shared/sku.js';
import { copyWithFeedback } from '../../shared/clipboard.js';
import { similarFailure, similarRunText } from '../../shared/run-format.js';
import { recordRun, runStatus } from '../../shared/tasks.js';
import { MSG, toTab } from '../../../core/message-bus.js';
import { resolveTargetTab, ensureScript, isDouyinUrl } from '../../../core/page-bridge.js';
import { detectPlatform } from '../../../core/platform-detector.js';
import { stepper, wizardFoot, setStatus, statusLine, kvRow, inlineEmpty, sectionTitle } from './wizard.js';

const STEP_TITLES = ['输入商品 ID', '确认任务', '执行与结果'];

let cache = null;
let repaint = null;
let offChange = null;

function blankState() {
  return {
    step: 0,
    idsText: '',
    column: '',
    status: null,
    starting: false,
    run: null,
    progress: null,
    debug: [],
    diag: '',
    diagOpen: false,
    logOpen: false,
    workbook: null,
    skuState: {},
  };
}

async function restore() {
  const state = blankState();
  const data = await readMany([
    KEYS.similarIds, KEYS.similarRun, KEYS.similarProgress, KEYS.similarDebug,
    KEYS.skuWorkbook, KEYS.skuState,
  ]);

  if (Array.isArray(data[KEYS.similarIds])) state.idsText = data[KEYS.similarIds].join('\n');
  state.run = data[KEYS.similarRun] || null;
  state.progress = data[KEYS.similarProgress] || null;
  state.debug = Array.isArray(data[KEYS.similarDebug]) ? data[KEYS.similarDebug] : [];
  state.workbook = Array.isArray(data[KEYS.skuWorkbook]) ? data[KEYS.skuWorkbook] : null;
  state.skuState = data[KEYS.skuState] || {};

  if (state.run && (state.run.running || (state.run.results || []).length)) state.step = 2;
  else if (state.idsText) state.step = 1;
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
  // 自检结果框按「最新一次渲染」定位，避免重绘后写进已脱离文档的节点
  let latestLive = {};

  /* ---------- 数据 ---------- */

  function headerRow() {
    const sheet = state.workbook?.[Number(state.skuState.sheet ?? 0)];
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    const index = Number(state.skuState.header ?? 0);
    return { rows, header: rows[index] || [], index };
  }

  function ids() {
    return parseIds(state.idsText);
  }

  function duplicateCount() {
    const raw = String(state.idsText || '').split(/[\s,，;；、]+/)
      .map(stripQuotes).filter(Boolean);
    return Math.max(0, raw.length - new Set(raw).size);
  }

  function progressOf() {
    const run = state.run || {};
    const total = Array.isArray(run.ids) ? run.ids.length : 0;
    const results = Array.isArray(run.results) ? run.results : [];
    const success = results.filter(item => item.ok).length;
    return {
      running: Boolean(run.running),
      total,
      done: results.length,
      success,
      failed: results.length - success,
      percent: total ? Math.round(results.length / total * 100) : 0,
      text: state.progress?.text || '',
    };
  }

  /* ---------- 任务记录 ---------- */

  /**
   * 把运行快照补记到任务中心。
   * 同一个 runId 只对应一条记录：开始、每次进度回传、面板重开后的恢复都调它，
   * 结果只会被更新到最新，不会重复，也不会在没有真实运行时凭空造记录。
   */
  function syncTask(run) {
    if (!run || !run.runId || !Array.isArray(run.ids) || !run.ids.length) return;
    const results = Array.isArray(run.results) ? run.results : [];
    const success = results.filter(item => item.ok).length;
    const total = run.ids.length;
    recordRun({
      featureId: 'douyin.similar-publish',
      platformId: 'douyin',
      name: '批量发布相似品',
      signature: `similar:${run.runId}`,
      status: runStatus({
        running: Boolean(run.running),
        total,
        done: results.length,
        failed: results.length - success,
      }),
      total,
      done: results.length,
      success,
      failed: results.length - success,
      at: run.at,
    }).catch(() => {});
  }

  /* ---------- 渲染 ---------- */

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
      locked: state.starting,
      onJump: index => {
        if (state.starting) return;
        state.step = index;
        draw();
      },
    }));

    clear(body);
    if (state.step === 0) body.append(stepIds());
    else if (state.step === 1) body.append(stepConfirm());
    else body.append(stepRun());
  }

  /* ---------- 第 1 步：输入 ID ---------- */

  function stepIds() {
    const textarea = h('textarea', {
      class: 'input',
      rows: '6',
      spellcheck: 'false',
      placeholder: '3600000000000000001\n3600000000000000002',
      oninput: event => {
        state.idsText = event.target.value;
        refreshCount();
      },
    });
    textarea.value = state.idsText;

    const countLine = h('div', { class: 'status-line' });

    function refreshCount() {
      const list = ids();
      const dup = duplicateCount();
      countLine.textContent = list.length
        ? `已识别 ${list.length} 个商品 ID${dup ? `，自动合并 ${dup} 个重复项` : ''}`
        : '还没有输入 ID。每行一个，也支持逗号、空格、顿号分隔。';
      countLine.className = `status-line ${list.length ? 'is-ok' : ''}`.trim();
      nextBtn.disabled = list.length === 0;
      nextBtn.textContent = list.length ? `下一步：确认 ${list.length} 条` : '请先填写商品 ID';
    }

    const nextBtn = h('button', {
      class: 'btn btn-primary',
      onclick: () => {
        state.step = 1;
        draw();
      },
    });

    // 从已导入的表格某列读取（复用「批量填充 SKU」导入的表格，不再要求选第二次文件）
    const { rows, header, index } = headerRow();
    const columnSelect = h('select', {
      class: 'input',
      onchange: event => {
        state.column = event.target.value;
        if (state.column === '') return;
        const values = columnValues(rows, index, state.column);
        const list = parseIds(values.join('\n'));
        if (!list.length) {
          setStatus(countLine, '这一列没有可用内容', 'warn');
          return;
        }
        state.idsText = list.join('\n');
        textarea.value = state.idsText;
        refreshCount();
        setStatus(countLine, `已从该列读取 ${list.length} 个 ID`, 'ok');
      },
    });
    columnSelect.append(h('option', { value: '', text: '— 不读取 —' }));
    header.forEach((name, cellIndex) => {
      const label = String(name ?? '').trim();
      if (!label) return;
      columnSelect.append(h('option', { value: String(cellIndex), text: `${cellIndex + 1}. ${label}` }));
    });
    if (state.column) columnSelect.value = state.column;

    refreshCount();

    return h('div', {}, [
      h('div', { class: 'card' }, [
        sectionTitle('商品 ID', '只发已存在的商品。每行一个，粘贴表格整列也可以。'),
        textarea,
        h('div', { style: 'margin-top:8px' }, [countLine]),
        h('div', { class: 'form-row', style: 'margin-top:10px' }, [
          h('label', { class: 'form-label', text: '从表格读取' }),
          columnSelect,
          h('button', {
            class: 'btn btn-sm btn-ghost',
            title: '重新读取表格（刚在「批量填充 SKU」里换了表格时用）',
            onclick: async () => {
              const data = await readMany([KEYS.skuWorkbook, KEYS.skuState]);
              state.workbook = Array.isArray(data[KEYS.skuWorkbook]) ? data[KEYS.skuWorkbook] : null;
              state.skuState = data[KEYS.skuState] || {};
              state.column = '';
              draw();
            },
          }, [h('span', { html: icon('refresh') })]),
        ]),
        state.workbook
          ? h('div', { class: 'setting-desc', text: '列表来自「批量填充 SKU」导入的表格；先在那边导入一次即可。' })
          : h('div', { class: 'setting-desc', text: '还没有导入过表格。想按列读取，先到「批量填充 SKU」导入一个 .xlsx。' }),
      ]),

      h('div', { class: 'notice', style: 'margin-top:12px' }, [
        h('span', { html: icon('info') }),
        h('div', {}, [
          h('div', { text: '执行前先把抖店切到「商品列表」页。' }),
          h('div', { style: 'margin-top:2px;opacity:.85' },
            '工具会逐条搜索 ID → 发布相似品 → 确认 → 等新标签页加载后点「发布商品」→ 成功则关闭该标签页。'),
        ]),
      ]),

      wizardFoot([nextBtn]),
    ]);
  }

  /* ---------- 第 2 步：确认 ---------- */

  function stepConfirm() {
    const list = ids();
    const dup = duplicateCount();
    const target = ctx.target || {};
    const onList = Boolean(target.page && target.page.key === 'product-list');
    const status = statusLine(state.status?.text || '', state.status?.tone || '');

    const startBtn = h('button', {
      class: 'btn btn-primary',
      disabled: state.starting || list.length === 0,
      onclick: () => startRun(),
    });
    startBtn.append(
      h('span', { html: icon(state.starting ? 'clock' : 'play') }),
      h('span', { text: state.starting ? '正在启动…' : `开始发布 ${list.length} 条` })
    );

    return h('div', {}, [
      h('div', { class: 'card' }, [
        h('div', { class: 'row row-between' }, [
          h('div', {}, [
            h('div', { class: 'setting-title', text: '任务确认' }),
            h('div', { class: 'setting-desc', text: dup ? `已自动合并 ${dup} 个重复 ID` : 'ID 已去重' }),
          ]),
          h('span', { class: 'badge badge-primary', text: `${list.length} 条` }),
        ]),
        h('div', { class: 'id-preview mono' }, list.slice(0, 5).map(id => h('div', { text: id }))),
        list.length > 5
          ? h('div', { class: 'setting-desc', text: `… 其余 ${list.length - 5} 条` })
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
          h('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: () => ctx.refresh(),
          }, ['刷新', h('span', { html: icon('refresh') })]),
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
          h('div', { text: '开始后可以关掉这个面板，队列在列表页继续跑。' }),
          h('div', { style: 'margin-top:2px;opacity:.85' },
            '期间会自动新开标签页发布商品，请不要手动关闭这些新标签页，也不要操作列表页。'),
        ]),
      ]),

      wizardFoot([
        h('button', {
          class: 'btn',
          disabled: state.starting,
          onclick: () => { state.step = 0; draw(); },
          text: '上一步',
        }),
        startBtn,
      ]),
    ]);
  }

  /* ---------- 第 3 步：执行与结果 ---------- */

  async function startRun() {
    const list = ids();
    if (!list.length) {
      state.status = { text: '请先填写商品 ID', tone: 'warn' };
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

      // 识别得到页面类型就严格要求列表页；识别不到（URL 变了）才放行，让页面脚本自己报错
      const detected = detectPlatform(tab.url);
      if (detected.page && detected.page.key !== 'product-list') {
        throw new Error(`当前页面是「${detected.page.name}」，请先切回「商品列表」页再开始。`);
      }

      await ensureScript(tab.id, { ping: MSG.SIMILAR_PING, file: 'similar.js' });
      const result = await toTab(tab.id, { type: MSG.SIMILAR_RUN, ids: list }, 20000);
      if (result && result.error) throw new Error(result.error);

      await write(KEYS.similarIds, list);
      // 页面已确认启动，先用一份「刚开始」的快照占位；真实进度由 storage 回传覆盖
      state.run = { running: true, ids: list, results: [], index: 0, at: Date.now() };
      state.status = {
        text: `已开始，共 ${list.length} 条。可以关掉这个面板，流程会在列表页继续。`,
        tone: 'ok',
      };
      state.step = 2;
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
      await toTab(tabId, { type: MSG.SIMILAR_STOP }, 8000);
      state.status = { text: '已发送停止指令，当前这一条走完后就会停。', tone: 'warn' };
    } catch (error) {
      state.status = { text: `停止失败：${error.message}`, tone: 'error' };
    }
    draw();
  }

  async function runDiagnose() {
    if (!latestLive.diag) return;
    latestLive.diag.textContent = '正在检查列表页结构…';
    try {
      const tab = await resolveTargetTab();
      if (!tab || !isDouyinUrl(tab.url)) throw new Error('请先切到抖店「商品列表」页');
      await ensureScript(tab.id, { ping: MSG.SIMILAR_PING, file: 'similar.js' });
      const result = await toTab(tab.id, { type: MSG.SIMILAR_DIAG }, 20000);
      latestLive.diag.textContent = result?.text || '页面没有返回结构信息';
    } catch (error) {
      latestLive.diag.textContent = `自检失败：${error.message}`;
    }
  }

  function stepRun() {
    const info = progressOf();
    const run = state.run;
    const hasResults = Boolean(run && Array.isArray(run.results) && run.results.length);
    const status = statusLine(state.status?.text || '', state.status?.tone || '');
    const live = { status };
    latestLive = live;

    const bar = h('div', { class: 'progress-bar' });
    const fill = h('div', { class: 'progress-fill' });
    fill.style.width = `${info.percent}%`;
    bar.append(fill);

    const diagBox = h('pre', { class: 'diag-box' });
    diagBox.hidden = !state.diagOpen;
    diagBox.textContent = state.diag || '还没有检查。点「检查列表页结构」会把识别到的搜索框、列表行信息打在这里。';
    live.diag = diagBox;

    const logBox = h('pre', { class: 'diag-box' });
    logBox.hidden = !state.logOpen;
    logBox.textContent = state.debug.length
      ? state.debug.slice(-40).join('\n')
      : '还没有运行日志。跑一次后这里会记录：登记任务 / 接管发布页 / 触发发布 / 结果回传。';

    return h('div', {}, [
      h('div', { class: 'card' }, [
        h('div', { class: 'row row-between' }, [
          h('div', { class: 'row' }, [
            h('span', { class: `dot ${info.running ? 'dot-warn' : (info.total && info.done >= info.total ? 'dot-success' : '')}`.trim() }),
            h('div', {}, [
              h('div', { class: 'list-item-title', text: info.running ? '执行中' : (info.total ? '已结束' : '尚未开始') }),
              h('div', { class: 'list-item-sub', text: info.total ? `${info.done} / ${info.total} 条已返回结果` : '等待开始' }),
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

      h('div', { style: 'margin-top:12px' }, [status]),

      hasResults
        ? h('div', { class: 'card', style: 'margin-top:12px' }, [
          h('div', { class: 'row row-between' }, [
            h('div', { class: 'setting-title', text: '执行结果' }),
            h('span', { class: 'setting-desc', text: run.at ? new Date(run.at).toLocaleString('zh-CN') : '' }),
          ]),
          h('div', { class: 'result-summary', style: 'margin-top:8px' }, [
            h('span', { class: 'pass', text: `成功 ${info.success}` }),
            h('span', { class: 'muted', text: ' · ' }),
            h('span', { class: 'fail', text: `失败 ${info.failed}` }),
            h('span', { class: 'muted', text: ` · 共 ${info.total || run.results.length} 条` }),
          ]),
          h('div', { class: 'result-actions' }, [
            h('button', {
              class: 'btn btn-sm',
              onclick: event => copyWithFeedback(event.currentTarget, similarRunText(run, false), { empty: '还没有结果可复制' }),
            }, ['复制全部结果', h('span', { html: icon('copy') })]),
            h('button', {
              class: 'btn btn-sm btn-ghost',
              onclick: event => copyWithFeedback(event.currentTarget, similarRunText(run, true), { empty: '这次没有失败项' }),
            }, '只复制失败项'),
          ]),
          h('div', { class: 'result-list' }, run.results.map(item => h('div', {
            class: `result-item ${item.ok ? 'is-ok' : 'is-fail'}`.trim(),
          }, [
            h('span', { class: `dot ${item.ok ? 'dot-success' : 'dot-error'}`.trim() }),
            h('div', { class: 'result-main' }, [
              h('div', { class: 'result-title' }, [
                h('span', { class: 'mono', text: item.id }),
              ]),
              item.ok ? null : h('div', { class: 'result-sub', text: similarFailure(item) }),
            ]),
          ]))),
        ])
        : h('div', { style: 'margin-top:12px' }, [
          inlineEmpty(info.total
            ? '已经开始，等待第一条结果返回…'
            : '还没有开始。回到上一步确认 ID 后开始。'),
        ]),

      h('div', { class: 'tool-row' }, [
        h('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: async () => {
            state.diagOpen = true;
            diagBox.hidden = false;
            await runDiagnose();
          },
        }, ['检查列表页结构', h('span', { html: icon('search') })]),
        h('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: () => {
            state.logOpen = !state.logOpen;
            logBox.hidden = !state.logOpen;
          },
        }, ['运行日志（卡住时看这个）', h('span', { html: icon('list') })]),
      ]),
      diagBox,
      logBox,

      wizardFoot([
        h('button', {
          class: 'btn',
          disabled: info.running,
          onclick: () => { state.step = 0; draw(); },
          text: '返回输入',
        }),
        info.running
          ? h('button', { class: 'btn', onclick: () => stopRun() }, ['停止任务', h('span', { html: icon('square') })])
          : h('button', {
            class: 'btn btn-primary',
            onclick: () => { state.step = 1; draw(); },
            text: '再发一批',
          }),
      ]),
    ]);
  }

  // 面板重开时把 storage 里的运行快照补进任务中心（关面板期间跑完的也能留下记录）
  syncTask(state.run);

  // 先认领绘制权再画第一帧。
  // 少了这一行，重新进入详情页（例如任务开始后新标签页触发了整体重绘）时，
  // 新实例的第一次 draw 会被当成"旧实例的回调"转发给上一份已脱离文档的节点，
  // 于是这一份永远是空白 —— 就是「开始任务后页面变空白」的根因。
  repaint = draw;
  draw();

  // 队列在页面里跑，进度/结果/日志都靠 storage 回传；只在本页可见时重绘
  if (typeof offChange === 'function') offChange();
  const off = onChange(changes => {
    let dirty = false;
    if (changes[KEYS.similarRun]) {
      state.run = changes[KEYS.similarRun].newValue || null;
      syncTask(state.run);
      dirty = true;
    }
    if (changes[KEYS.similarProgress]) {
      state.progress = changes[KEYS.similarProgress].newValue || null;
      dirty = true;
    }
    if (changes[KEYS.similarDebug]) {
      state.debug = changes[KEYS.similarDebug].newValue || [];
      dirty = state.logOpen;
    }
    if (!dirty) return;
    if (typeof root.isConnected === 'boolean' && !root.isConnected) {
      off();
      return;
    }
    if (state.step === 2) draw();
  });
  offChange = off;

  return root;
}

/** 供离线测试清理模块缓存 */
export function resetCache() {
  cache = null;
}
