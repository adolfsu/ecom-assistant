/*
 * XLSX 读取（纯前端、零依赖）。
 *
 * 从旧面板 popup.js 原样搬过来，只把参数从「DOM 里的 file input」改成「File 对象」。
 * 不引第三方库：扩展包里塞一个 SheetJS 不划算，而抖店表格结构简单，
 * 读 sharedStrings + 逐个 worksheet 足够。
 */

function columnIndex(cellReference) {
  const letters = String(cellReference || '').match(/[A-Z]+/)?.[0] || '';
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

/** 按 ZIP 中央目录解包；只处理 store(0) 与 deflate(8) 两种压缩方式 */
export async function unzipXlsx(file) {
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

export function parseXml(source) {
  const documentNode = new DOMParser().parseFromString(source || '', 'application/xml');
  if (documentNode.querySelector('parsererror')) throw new Error('Excel 内部 XML 文件损坏');
  return documentNode;
}

export function readWorksheet(files, path, sharedStrings) {
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

/**
 * @param {File} file
 * @returns {Promise<Array<{name:string, rows:string[][]}>>}
 */
export async function parseWorkbook(file) {
  const files = await unzipXlsx(file);
  if (!files['xl/workbook.xml']) throw new Error('这不是有效的 .xlsx 文件（缺少 workbook.xml）');
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

/** 表头行下拉框的文案：截取前 5 个非空单元格 */
export function describeRow(row, limit = 75) {
  return (row || []).filter(Boolean).slice(0, 5).join(' / ').slice(0, limit);
}
