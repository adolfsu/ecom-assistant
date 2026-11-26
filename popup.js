// popup 脚本一旦出错，直接把原因写到状态栏，避免面板“点了没反应”却看不出问题
window.addEventListener('error', event => {
  const text = `扩展脚本异常：${event.message}。请在 edge://extensions 重新加载扩展。`;
  const status = document.getElementById('status');
  if (status) status.textContent = text;
  const similar = document.getElementById('similarProgress');
  if (similar) {
    similar.textContent = text;
    similar.className = 'status warn';
  }
});

const byId = id => document.getElementById(id);

// 模块缺失时也不要让整个面板崩掉，否则表现为“按钮点了没反应”
const ColumnMap = window.ColumnMap || {};
const fields = ColumnMap.fields || ['skuName', 'code', 'price', 'specValue', 'specUnit', 'quantity', 'quantityUnit'];
const fieldLabels = ColumnMap.fieldLabels || {};
const guessColumn = ColumnMap.guessColumn || (() => undefined);
const headerScore = ColumnMap.headerScore || (() => 0);

let workbook = [];
let rows = [];
let records = [];

function columnIndex(cellReference) {
  const letters = cellReference.match(/[A-Z]+/)?.[0] || '';
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

async function unzipXlsx(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  let endOffset = -1;
  const searchStart = Math.max(0, buffer.byteLength - 65558);
  for (let offset = buffer.byteLength - 22; offset >= searchStart; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('无法识别 XLSX 文件');

  const entryCount = view.getUint16(endOffset + 10, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const files = {};
  let offset = directoryOffset;

  for (let index = 0; index < entryCount; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 46, nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = new Uint8Array(buffer, dataOffset, compressedSize);

    if (method === 0) {
      files[name] = new TextDecoder().decode(compressed);
    } else if (method === 8) {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      files[name] = new TextDecoder().decode(await new Response(stream).arrayBuffer());
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function parseXml(source) {
  const documentNode = new DOMParser().parseFromString(source || '', 'application/xml');
  if (documentNode.querySelector('parsererror')) throw new Error('Excel 内部 XML 文件损坏');
  return documentNode;
}

function readWorksheet(files, path, sharedStrings) {
  const worksheet = parseXml(files[path]);
  const result = [];
  for (const rowNode of worksheet.getElementsByTagNameNS('*', 'row')) {
    const values = [];
    for (const cell of rowNode.getElementsByTagNameNS('*', 'c')) {
      const index = columnIndex(cell.getAttribute('r'));
      const type = cell.getAttribute('t');
      const valueNode = cell.getElementsByTagNameNS('*', 'v')[0];
      let value = valueNode?.textContent || '';
      if (type === 's') value = sharedStrings[Number(value)] || '';
      if (type === 'inlineStr') {
        value = [...cell.getElementsByTagNameNS('*', 't')].map(text => text.textContent).join('');
      }
      values[index] = value;
    }
    result.push(values.map(value => value ?? ''));
  }
  return result;
}

async function parseWorkbook(file) {
  const files = await unzipXlsx(file);
  const workbookXml = parseXml(files['xl/workbook.xml']);
  const relationshipXml = parseXml(files['xl/_rels/workbook.xml.rels']);
  const relationships = {};
  for (const relation of relationshipXml.getElementsByTagNameNS('*', 'Relationship')) {
    relationships[relation.getAttribute('Id')] = relation.getAttribute('Target');
  }
  const sharedStrings = files['xl/sharedStrings.xml']
    ? [...parseXml(files['xl/sharedStrings.xml']).getElementsByTagNameNS('*', 'si')]
      .map(item => [...item.getElementsByTagNameNS('*', 't')].map(text => text.textContent).join(''))
    : [];

  return [...workbookXml.getElementsByTagNameNS('*', 'sheet')].map(sheet => {
    const relationId = sheet.getAttribute('r:id')
      || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let path = relationships[relationId];
    if (!path) throw new Error(`找不到工作表：${sheet.getAttribute('name')}`);
    path = path.startsWith('/') ? path.slice(1) : `xl/${path}`;
    path = path.replace('xl/xl/', 'xl/');
    return { name: sheet.getAttribute('name'), rows: readWorksheet(files, path, sharedStrings) };
  });
}

function loadSheet(sheetIndex) {
  rows = workbook[Number(sheetIndex)]?.rows || [];
  const headerSelect = byId('header');
  headerSelect.replaceChildren();
  rows.forEach((row, index) => {
    const description = row.filter(Boolean).slice(0, 5).join(' / ').slice(0, 75);
    headerSelect.add(new Option(`第 ${index + 1} 行：${description}`, String(index)));
  });
  const bestIndex = rows.reduce((best, row, index) => headerScore(row) > headerScore(rows[best] || []) ? index : best, 0);
  headerSelect.value = String(bestIndex);
  loadHeader(bestIndex);
}

/**
 * 开关打开时，把「名称已含规格」的行拆出规格与数量；已有值优先，不会被覆盖。
 * 具体规则在 parser.js 里，可独立测试。
 */
function splitRecord(record) {
  if (!byId('autoSplit').checked) return { record };
  const parser = window.SkuNameParser;
  if (!parser) return { record, error: '拆分模块没有加载，请重新加载扩展' };
  return parser.applyToRecord(record);
}

function updateRecords() {
  const selectedColumns = Object.fromEntries(fields.map(field => [field, byId(field).value]));
  const splitErrors = [];
  let splitCount = 0;
  const tableRows = rows.slice(Number(byId('header').value) + 1).map((row, index) => {
    const values = Object.fromEntries(fields.map(field => {
      const column = selectedColumns[field];
      return [field, column === '' ? '' : String(row[Number(column)] ?? '').trim()];
    }));
    return { sourceRow: Number(byId('header').value) + index + 2, ...values };
  }).filter(record => {
    // 只把「有名称 + 有编码或价格」的行当 SKU 候选，表尾的工单/评价等说明行直接忽略
    const hasName = String(record.skuName ?? '').trim();
    const hasCodeOrPrice = String(record.code ?? '').trim() || String(record.price ?? '').trim();
    return Boolean(hasName && hasCodeOrPrice);
  })
    .map(record => {
      const result = splitRecord(record);
      if (result.error) splitErrors.push({ row: record.sourceRow, reason: result.error });
      else if (result.split) splitCount++;
      return result.record;
    });

  const requiredFields = ['skuName', 'specValue', 'specUnit', 'quantity', 'quantityUnit', 'code', 'price'];
  const completeRows = tableRows.filter(record => requiredFields.every(field => String(record[field] ?? '').trim()));
  const incompleteCount = tableRows.length - completeRows.length;
  const invalidPriceCount = completeRows.filter(record => !Number.isFinite(Number(record.price)) || Number(record.price) <= 0).length;
  records = completeRows;
  const warnings = [];
  if (incompleteCount) warnings.push(`已跳过 ${incompleteCount} 行字段不全`);
  if (invalidPriceCount) warnings.push(`${invalidPriceCount} 行售价为 0 或无效`);
  byId('recordCount').textContent = `识别到 ${records.length} 条可导入 SKU${warnings.length ? `，${warnings.join('，')}` : ''}`;
  if (invalidPriceCount) byId('recordCount').title = '为避免把零价格写入商品，价格必须为大于 0 的数字。';
  else byId('recordCount').removeAttribute('title');

  const splitInfo = byId('splitInfo');
  if (splitErrors.length) {
    const rowText = splitErrors.slice(0, 6).map(item => item.row).join('、');
    splitInfo.textContent = `${splitErrors.length} 条名称没识别出规格：第 ${rowText} 行${splitErrors.length > 6 ? ' 等' : ''}（${splitErrors[0].reason}）`;
    splitInfo.className = 'status warn';
    splitInfo.title = splitErrors.map(item => `第 ${item.row} 行：${item.reason}`).join('\n');
  } else if (splitCount) {
    splitInfo.textContent = `已按名称自动拆分 ${splitCount} 条，规格与数量均识别成功`;
    splitInfo.className = 'status ok';
    splitInfo.removeAttribute('title');
  } else {
    splitInfo.textContent = '';
    splitInfo.className = 'status';
    splitInfo.removeAttribute('title');
  }

  byId('batchFill').disabled = records.length === 0;
  byId('batchFill').textContent = records.length
    ? '批量创建并填写所有 SKU'
    : (records.length === 0 ? '暂无可导入的 SKU（看上方提示）' : '批量创建并填写所有 SKU');
  const first = records[0];
  byId('preview').textContent = first
    ? `首条预览：${first.skuName}｜${first.specValue || '—'} ${first.specUnit || ''} × ${first.quantity || '—'} ${first.quantityUnit || ''}｜编码 ${first.code}｜价格 ${first.price}`
    : '请检查表头和列映射：名称、编码、价格必须有值，规格与数量可由名称自动拆分。';
}

function loadHeader(headerIndex) {
  const header = rows[Number(headerIndex)] || [];
  for (const field of fields) {
    const select = byId(field);
    const previousValue = select.value;
    select.replaceChildren(new Option('不导入此列', ''));
    header.forEach((name, index) => select.add(new Option(String(name || `列${index + 1}`), String(index))));
    const matching = header.findIndex(name => guessColumn(name, field));
    if (matching >= 0) select.value = String(matching);
    else if (previousValue && Number(previousValue) < header.length) select.value = previousValue;
  }
  updateRecords();
  refreshIdColumns();
}

function saveState() {
  if (!workbook.length) return;
  chrome.storage.local.set({
    doudianBatchWorkbook: workbook,
    doudianBatchWorkbookName: byId('file').files[0]?.name || '已选商品表格',
    doudianBatchState: {
      sheet: byId('sheet').value,
      header: byId('header').value,
      columns: Object.fromEntries(fields.map(field => [field, byId(field).value])),
      autoSplit: byId('autoSplit').checked
    }
  });
}

function restoreState(state) {
  if (!state) return;
  const sheetIndex = workbook[Number(state.sheet)] ? state.sheet : '0';
  byId('sheet').value = sheetIndex;
  loadSheet(sheetIndex);
  if (rows[Number(state.header)]) {
    byId('header').value = state.header;
    loadHeader(state.header);
  }
  const headerNames = rows[Number(byId('header').value)] || [];
  for (const field of fields) {
    const column = state.columns?.[field];
    if (column === undefined) continue;
    if (column === '') { byId(field).value = ''; continue; }
    // 旧列号指向的列必须仍然像这个字段，才沿用；否则按新表头重新识别
    if (guessColumn(headerNames[Number(column)], field)) byId(field).value = column;
  }
  if (state.autoSplit !== undefined) byId('autoSplit').checked = state.autoSplit !== false;
  updateRecords();
}

/**
 * 取「真正要操作的那个页面」。
 * 2.0 起旧面板可能在独立小窗里打开，此时 currentWindow 的活动标签就是扩展页自己，
 * 直接拿会报「没有可用的商品编辑页」，所以先排除扩展页，再退回抖店标签。
 */
function isExtensionTab(tab) {
  return /^(chrome|edge|moz)-extension:/i.test(String(tab && tab.url || ''));
}

async function activeTab() {
  const pick = async query => {
    const tabs = await chrome.tabs.query(query);
    return tabs.find(tab => tab && tab.id && !isExtensionTab(tab)) || null;
  };
  let tab = await pick({ active: true, currentWindow: true });
  if (!tab) tab = await pick({ active: true, lastFocusedWindow: true });
  if (!tab) {
    const tabs = await chrome.tabs.query({ url: ['https://*.jinritemai.com/*'] });
    tab = tabs.find(item => item && item.id) || null;
  }
  if (!tab?.id) throw new Error('没有可用的商品编辑页');
  return tab;
}

const CONTENT_VERSION = '0.9.10';

async function connectContentScript(tab) {
  let version = null;
  try {
    const pong = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    version = pong?.version || null;
  } catch {
    version = null;
  }
  if (version === CONTENT_VERSION) return;
  // 页面里还留着上一版脚本时不要重复注入，否则两套脚本会同时处理同一次批量任务
  if (version) throw new Error(`商品页里运行的还是旧版脚本（${version}），请先按 F5 刷新抖店页面，再重新点一次`);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
}

byId('file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    workbook = await parseWorkbook(file);
    byId('sheet').replaceChildren();
    workbook.forEach((sheet, index) => byId('sheet').add(new Option(sheet.name, String(index))));
    byId('data').hidden = false;
    // 换了文件就按新表头重新认列，避免沿用上一份表格的列号（列数相近时会指到别的字段）
    for (const field of fields) byId(field).value = '';
    loadSheet(0);
    byId('status').textContent = `已读取 ${file.name}`;
    saveState();
  } catch (error) {
    byId('status').textContent = `读取失败：${error.message}`;
  }
});

byId('sheet').addEventListener('change', event => {
  loadSheet(event.target.value);
  saveState();
});
byId('autoSplit').addEventListener('change', () => updateRecords());
byId('header').addEventListener('change', event => {
  loadHeader(event.target.value);
  saveState();
});
for (const field of fields) {
  byId(field).addEventListener('change', () => {
    updateRecords();
    saveState();
  });
}

byId('batchFill').addEventListener('click', async () => {
  if (!records.length) return;
  byId('batchFill').disabled = true;
  byId('status').textContent = `正在向商品编辑页创建 ${records.length} 条 SKU…`;
  try {
    const tab = await activeTab();
    await connectContentScript(tab);
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'BATCH_FILL', records });
    if (result?.error) throw new Error(result.error);
    if (!result?.results) throw new Error('商品页没有返回批量填入结果');
    const created = result.results.filter(item => ['已创建', '已存在'].includes(item.results?.sku)).length;
    const prices = result.results.filter(item => item.results?.price === '已填入').length;
    const codes = result.results.filter(item => item.results?.code === '已填入').length;
    const failure = result.results.find(item => !item.ok);
    byId('status').textContent = `SKU ${created}/${records.length}，价格 ${prices}/${records.length}，编码 ${codes}/${records.length}${failure ? `。首个问题在表格第 ${failure.row} 行` : ''}`;
  } catch (error) {
    byId('status').textContent = `批量填入失败：${error.message}`;
  } finally {
    byId('batchFill').disabled = false;
  }
});

byId('diagnose').addEventListener('click', async () => {
  const box = byId('diag');
  byId('diagnose').disabled = true;
  try {
    const tab = await activeTab();
    await connectContentScript(tab);
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'DIAGNOSE' });
    box.textContent = result?.text || '页面没有返回结构信息';
  } catch (error) {
    box.textContent = `自检失败：${error.message}`;
  } finally {
    box.hidden = false;
    byId('diagnose').disabled = false;
  }
});

chrome.storage.local.get(['doudianBatchWorkbook', 'doudianBatchWorkbookName', 'doudianBatchState'], data => {
  if (!Array.isArray(data.doudianBatchWorkbook)) return;
  workbook = data.doudianBatchWorkbook;
  byId('sheet').replaceChildren();
  workbook.forEach((sheet, index) => byId('sheet').add(new Option(sheet.name, String(index))));
  byId('data').hidden = false;
  loadSheet(0);
  restoreState(data.doudianBatchState);
  byId('status').textContent = `已载入 ${data.doudianBatchWorkbookName || '上次选择的表格'}`;
});

/* ---------------- 发布相似品 ---------------- */

const SIMILAR_VERSION = '0.9.10';

// 去掉粘贴时常带的首尾引号（不写引号字面量，避免和静态检查的字符串剥离打架）
function stripQuotes(value) {
  const quotes = String.fromCharCode(34, 39, 96);
  let text = String(value || '').trim();
  while (text && quotes.includes(text[0])) text = text.slice(1);
  while (text && quotes.includes(text[text.length - 1])) text = text.slice(0, -1);
  return text.trim();
}

function parseIds(text) {
  const seen = new Set();
  const ids = [];
  for (const raw of String(text || '').split(/[\s,，;；、]+/)) {
    const id = stripQuotes(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** 把当前表头下的列名填进「从表格某列读取」，并优先猜 ID / 编码列 */
function refreshIdColumns() {
  const select = byId('similarColumn');
  if (!select) return;
  const header = rows[Number(byId('header').value)] || [];
  const previous = select.value;
  select.replaceChildren(new Option('— 不读取 —', ''));
  header.forEach((name, index) => {
    const label = String(name ?? '').trim();
    if (label) select.add(new Option(`${index + 1}. ${label}`, String(index)));
  });
  if (previous && Array.from(select.options).some(option => option.value === previous)) {
    select.value = previous;
    return;
  }
  const guess = header.findIndex(name => /商品\s*id|^id$|商品编码|sku编码/i.test(String(name ?? '').trim()));
  if (guess >= 0) select.value = String(guess);
}

async function connectSimilarScript(tab) {
  let version = null;
  try {
    const pong = await chrome.tabs.sendMessage(tab.id, { type: 'SIMILAR_PING' });
    version = pong?.version || null;
  } catch {
    version = null;
  }
  if (version === SIMILAR_VERSION) return;
  if (version) throw new Error(`页面里运行的还是旧版脚本（${version}），请先按 F5 刷新抖店页面`);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['similar.js'] });
}

function renderSimilarProgress(value) {
  const box = byId('similarProgress');
  if (!box) return;
  if (!value) {
    box.textContent = '';
    box.className = 'status';
    return;
  }
  box.textContent = value.text || '';
  box.className = value.stopped ? 'status warn' : (value.done ? 'status ok' : 'status');
}

/** 一条结果的失败原因：优先用采集到的具体校验提示，多条合并 */
function resultReason(item) {
  const issues = Array.isArray(item.issues) ? item.issues.filter(Boolean) : [];
  const text = issues.length ? issues.join('；') : String(item.reason || '').trim();
  return text || '原因未记录';
}

/** 复制用的纯文本：制表符分隔，直接粘进 Excel / 表格就是一列一条 */
function formatRun(run, onlyFailed) {
  if (!run || !Array.isArray(run.results) || !run.results.length) return '';
  const rows = run.results.filter(item => !onlyFailed || !item.ok);
  if (!rows.length) return '';
  const lines = [onlyFailed ? '商品ID\t失败原因' : '商品ID\t状态\t失败原因'];
  for (const item of rows) {
    lines.push(onlyFailed
      ? `${item.id}\t${resultReason(item)}`
      : `${item.id}\t${item.ok ? '成功' : '失败'}\t${item.ok ? '' : resultReason(item)}`);
  }
  return lines.join('\n');
}

let similarRunCache = null;

function renderSimilarResult(run) {
  similarRunCache = run || null;
  const wrap = byId('similarResultWrap');
  const box = byId('similarResult');
  if (!wrap || !box) return;
  if (!run || !Array.isArray(run.results) || !run.results.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const success = run.results.filter(item => item.ok).length;
  const failed = run.results.length - success;
  const summary = byId('similarSummary');
  if (summary) {
    const pass = document.createElement('span');
    pass.className = 'pass';
    pass.textContent = `成功 ${success}`;
    const fail = document.createElement('span');
    fail.className = 'fail';
    fail.textContent = `失败 ${failed}`;
    summary.replaceChildren(
      pass,
      document.createTextNode(' · '),
      fail,
      document.createTextNode(` · 共 ${run.results.length} 条`)
    );
  }

  box.textContent = run.results
    .map(item => (item.ok
      ? `成功  ${item.id}`
      : `失败  ${item.id}  ← ${resultReason(item)}`))
    .join('\n');
}

/** 写剪贴板：优先 async API，失败退回 textarea + execCommand */
async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 面板可能没有焦点，退回旧接口 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyRun(onlyFailed, button) {
  const text = formatRun(similarRunCache, onlyFailed);
  const status = byId('similarProgress');
  if (!text) {
    if (status) {
      status.textContent = onlyFailed ? '这次没有失败项' : '还没有结果可复制';
      status.className = 'status';
    }
    return;
  }
  const ok = await copyText(text);
  if (!button) return;
  const label = button.dataset.label || button.textContent;
  button.dataset.label = label;
  button.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => {
    button.textContent = label;
  }, 1500);
}

byId('similarCopyAll')?.addEventListener('click', event => copyRun(false, event.currentTarget));
byId('similarCopyFail')?.addEventListener('click', event => copyRun(true, event.currentTarget));

byId('similarColumn').addEventListener('change', () => {
  const column = byId('similarColumn').value;
  const box = byId('similarProgress');
  if (column === '') return;
  const start = Number(byId('header').value) + 1;
  const values = rows.slice(start).map(row => String(row[Number(column)] ?? '').trim());
  const ids = parseIds(values.join('\n'));
  if (!ids.length) {
    box.textContent = '这一列没有可用内容';
    return;
  }
  byId('similarIds').value = ids.join('\n');
  box.textContent = `已从该列读取 ${ids.length} 个 ID`;
});

byId('similarStart').addEventListener('click', async () => {
  const box = byId('similarProgress');
  const ids = parseIds(byId('similarIds').value);
  if (!ids.length) {
    box.textContent = '请先填写商品 ID';
    return;
  }
  byId('similarStart').disabled = true;
  try {
    const tab = await activeTab();
    const url = tab.url || '';
    if (!/jinritemai\.com/i.test(url)) throw new Error('请先切到抖店后台的「商品列表」页，再打开扩展');
    if (/\/create/i.test(url)) throw new Error('当前是商品发布页，请先切回「商品列表」页');
    await connectSimilarScript(tab);
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'SIMILAR_RUN', ids });
    if (result?.error) throw new Error(result.error);
    await chrome.storage.local.set({ similarIds: ids });
    box.textContent = `已开始，共 ${ids.length} 条。可以关掉这个面板，流程会在列表页自己继续。`;
    box.className = 'status';
  } catch (error) {
    box.textContent = `无法开始：${error.message}`;
    box.className = 'status warn';
  } finally {
    byId('similarStart').disabled = false;
  }
});

byId('similarStop').addEventListener('click', async () => {
  const box = byId('similarProgress');
  try {
    const data = await chrome.storage.local.get(['similarListTabId']);
    const tabId = data.similarListTabId;
    if (!tabId) {
      box.textContent = '没有记录到列表页，可能已经关闭';
      return;
    }
    await chrome.tabs.sendMessage(tabId, { type: 'SIMILAR_STOP' });
    box.textContent = '已发送停止指令，当前这一条走完后就会停';
  } catch (error) {
    box.textContent = `停止失败：${error.message}`;
  }
});

byId('similarDiag').addEventListener('click', async () => {
  const box = byId('similarDiagBox');
  byId('similarDiag').disabled = true;
  try {
    const tab = await activeTab();
    if (!/jinritemai\.com/i.test(tab.url || '')) throw new Error('请先切到抖店「商品列表」页');
    await connectSimilarScript(tab);
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'SIMILAR_DIAG' });
    box.textContent = result?.text || '页面没有返回结构信息';
  } catch (error) {
    box.textContent = `自检失败：${error.message}`;
  } finally {
    box.hidden = false;
    byId('similarDiag').disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.similarProgress) renderSimilarProgress(changes.similarProgress.newValue);
  if (changes.similarRun) renderSimilarResult(changes.similarRun.newValue);
});

chrome.storage.local.get(['similarProgress', 'similarRun', 'similarIds'], data => {
  renderSimilarProgress(data.similarProgress);
  renderSimilarResult(data.similarRun);
  if (Array.isArray(data.similarIds) && data.similarIds.length) {
    byId('similarIds').value = data.similarIds.join('\n');
  }
});

/* ---------------- 侧边栏与运行日志 ---------------- */

/**
 * 面板作为 popup 时，一切换标签页就会自动关闭，看不到进度。
 * 这里提供入口把它固定到侧边栏：侧边栏属于窗口本身，切标签页不会消失。
 */
(async function setupSidePanel() {
  const button = byId('openPanel');
  if (!button) return;
  if (!chrome.sidePanel || typeof chrome.sidePanel.open !== 'function') return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      const current = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: current.id });
      button.textContent = '已固定到侧边栏（可关闭此弹窗）';
    } catch (error) {
      button.textContent = `无法打开侧边栏：${error.message}`;
    }
  });
})();

function renderLog(lines) {
  const box = byId('similarLogBox');
  if (!box) return;
  if (!Array.isArray(lines) || !lines.length) {
    box.textContent = '还没有运行日志。点「开始」跑一次后这里会记录：登记任务 / 接管发布页 / 触发发布 / 结果回传。';
    return;
  }
  box.textContent = lines.slice(-40).join('\n');
  box.scrollTop = box.scrollHeight;
}

byId('similarLog')?.addEventListener('click', async () => {
  const box = byId('similarLogBox');
  box.hidden = !box.hidden;
  if (box.hidden) return;
  const data = await chrome.storage.local.get(['similarDebug']);
  renderLog(data.similarDebug);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const box = byId('similarLogBox');
  if (!box || box.hidden) return;
  if (changes.similarDebug) renderLog(changes.similarDebug.newValue);
});
