(() => {
  const scriptVersion = '0.9.9';
  if (window.__doudianSheetFillVersion === scriptVersion) return;
  window.__doudianSheetFillVersion = scriptVersion;

  const fieldNames = {
    skuName: 'SKU 名称',
    code: '商品编码',
    price: '价格',
    specValue: '规格数值',
    specUnit: '规格单位',
    quantity: '数量',
    quantityUnit: '数量量词'
  };
  let toastTimer = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function showNotice(message, isError = false, duration = 7000) {
    let host = document.getElementById('__doudian_fill_notice');
    if (!host) {
      host = document.createElement('div');
      host.id = '__doudian_fill_notice';
      host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<style>.box{max-width:430px;padding:12px 16px;border-radius:8px;background:#163b6d;color:#fff;font:14px/1.5 "Microsoft YaHei",sans-serif;box-shadow:0 4px 18px #0004;white-space:pre-line}.error{background:#9d2e26}</style><div class="box"></div>';
      document.documentElement.append(host);
    }
    const box = host.shadowRoot.querySelector('.box');
    box.textContent = message;
    box.classList.toggle('error', isError);
    host.style.display = 'block';
    clearTimeout(toastTimer);
    if (duration > 0) toastTimer = setTimeout(() => { host.style.display = 'none'; }, duration);
  }

  function allVisible(selector, root = document) {
    const result = [];
    const visit = node => {
      for (const element of node.querySelectorAll(selector)) {
        if (visible(element)) result.push(element);
      }
      for (const element of node.querySelectorAll('*')) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(root);
    return result;
  }

  function editableControls(root = document) {
    return allVisible('input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"]', root)
      .filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true');
  }

  function normalize(value) {
    return String(value ?? '').replace(/\s+/g, '').replace(/[【】\[\]()（）*×xX·,，:：-]/g, '').toLocaleLowerCase();
  }

  function domOrder(left, right) {
    if (left === right) return 0;
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function setNativeValue(element, value) {
    const text = String(value ?? '');
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
    } else if (element.isContentEditable || element.matches('[role="textbox"]')) {
      element.textContent = text;
    } else {
      throw new Error('找到的控件不是文本输入项');
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function valueOf(element) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value
      : element.textContent.trim();
  }

  async function setText(element, value) {
    const wanted = String(value ?? '').trim();
    if (!wanted) return '表格值为空';
    // 组件库会把下拉框内部的搜索 input 标成只读，真遇到只读字段时先解除只读再写值，
    // 而不是直接放弃这一行。
    if (element.readOnly) element.removeAttribute('readonly');
    if (element.getAttribute('aria-readonly') === 'true') element.removeAttribute('aria-readonly');
    setNativeValue(element, wanted);
    await settle();
    let actual = valueOf(element);
    const isNumber = element instanceof HTMLInputElement && element.type === 'number';
    if (actual !== wanted && !(isNumber && Number(actual) === Number(wanted))) {
      if (element instanceof HTMLInputElement && ['text', 'search', 'tel', 'url'].includes(element.type)) element.select();
      setNativeValue(element, wanted);
      await sleep(140);
      actual = valueOf(element);
    }
    return actual === wanted || (isNumber && Number(actual) === Number(wanted))
      ? '已填入'
      : '页面没有接受该值';
  }

  /* ---------------- 规格编辑框结构识别 ---------------- */

  const SELECT_LIKE = 'select, [role="combobox"], [aria-haspopup="listbox"], [class*="select" i]';

  // 下拉框内部那个只读搜索输入框：绝不能当成文本字段
  function isSelectSearchBox(element) {
    if (!element.readOnly) return false;
    return element.getAttribute('role') === 'combobox'
      || element.getAttribute('aria-haspopup') === 'listbox'
      || element.getAttribute('aria-autocomplete') !== null
      || /selection-input|selection-search|selection-search-input|combobox/i.test(String(element.className || ''));
  }

  // 返回页面上的下拉框“外壳”，一个下拉只算一个；按文档顺序排列
  function dropdownHosts(root) {
    const raw = allVisible(SELECT_LIKE, root).filter(element => {
      // 用外层容器文本判断，连“选择规则/单品”这个下拉内部的输入框一起排除
      const shell = element.parentElement ? element.parentElement.closest('[class*="select" i]') : null;
      if (/单品|选择规则/.test(`${element.textContent || ''}${shell ? shell.textContent : ''}`)) return false;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 8 && rect.height > 8 && rect.width < 380 && rect.height < 90)) return false;
      // 真正的下拉框一定自带输入框/原生 select，或者本身就是 combobox；借此过滤掉问号提示、图标按钮
      return element.tagName === 'SELECT'
        || element.getAttribute('role') === 'combobox'
        || Boolean(element.querySelector('input, select, [role="combobox"]'));
    });
    const pool = new Set(raw);
    const hosts = [];
    for (const element of raw) {
      let host = element;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (!pool.has(parent)) break;
        host = parent;
      }
      if (!hosts.includes(host)) hosts.push(host);
    }
    return hosts
      .filter(host => !hosts.some(other => other !== host && other.contains(host)))
      .sort(domOrder);
  }

  // 编辑框里的真实文本输入项（排除下拉框外壳及其内部的搜索框）
  function editorTextInputs(editor, hosts) {
    return allVisible('input:not([type="hidden"]), textarea', editor)
      .filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true')
      .filter(element => !hosts.some(host => host === element || host.contains(element)))
      .filter(element => !isSelectSearchBox(element))
      .filter(element => !/填写并新增规格值/.test(`${element.getAttribute('placeholder') || ''}${element.getAttribute('aria-label') || ''}`))
      .sort(domOrder);
  }

  /**
   * 规格行结构固定为：[名称] [规格值] [规格单位▾] * [数量] [数量量词▾]
   * 按文档顺序识别，不再依赖像素坐标（像素法会把下拉框自带的只读搜索框当成规格值）。
   */
  function editorFields(editor) {
    const allHosts = dropdownHosts(editor);
    if (allHosts.length < 2) {
      throw new Error(`规格编辑框里只找到 ${allHosts.length} 个单位下拉框，预期需要两个（规格单位、数量量词）`);
    }
    // 结构末尾一定是“规格单位、数量量词”两个下拉；多出来的（例如名称也用了下拉/自动完成）从后往前取
    const hosts = allHosts.length > 2 ? allHosts.slice(-2) : allHosts;
    const specUnit = hosts[0];
    const quantityUnit = hosts[1];
    const texts = editorTextInputs(editor, allHosts);
    const before = texts.filter(element => domOrder(element, specUnit) < 0);
    const between = texts.filter(element => domOrder(specUnit, element) < 0 && domOrder(element, quantityUnit) < 0);

    let skuName = null;
    let specValue = null;
    if (before.length >= 2) {
      specValue = before[before.length - 1];
      skuName = before[before.length - 2];
    } else if (before.length === 1) {
      specValue = before[0];
    }
    const named = texts.find(element => /名称|描述|sku/i.test(`${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''}`));
    if (named && named !== specValue) skuName = named;
    const quantity = between[0] || null;

    const problems = [];
    if (!skuName) problems.push('名称输入框');
    if (!specValue) problems.push('规格数值输入框');
    if (!quantity) problems.push('数量输入框');
    if (problems.length) {
      throw new Error(`规格编辑框结构识别失败，没找到${problems.join('、')}（找到 ${texts.length} 个文本控件、${hosts.length} 个下拉框）。请点“检查页面规格框结构”把结果发给我`);
    }
    return { skuName, specValue, specUnit, quantity, quantityUnit, hosts, texts };
  }

  function findAddTrigger() {
    // 已创建的规格值行也会占着同一个 placeholder，所以要优先取“当前为空”的那个，且新的空白项总在最后
    const inputs = allVisible('input, textarea, [contenteditable="true"], [role="textbox"]').filter(element => {
      const hint = `${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''}`;
      return hint.includes('填写并新增规格值') && !element.disabled;
    });
    const empty = inputs.find(element => !valueOf(element).trim());
    if (empty) return empty;
    if (inputs.length) return inputs[inputs.length - 1];
    return allVisible('button, [role="button"], [class*="input" i], [tabindex]')
      .find(element => element.textContent.includes('填写并新增规格值')) || null;
  }

  function findEditor() {
    const trigger = findAddTrigger();
    const tryFrom = start => {
      let node = start;
      for (let depth = 0; node && node !== document.body && depth < 14; depth++, node = node.parentElement) {
        const edits = editableControls(node).filter(element => element !== trigger);
        const dropdowns = dropdownHosts(node);
        // 下拉数量加上限，避免往上爬到“价格库存”整表容器（那里有十几个下拉）
        if (edits.length >= 3 && dropdowns.length >= 2 && dropdowns.length <= 4) return node;
      }
      return null;
    };

    // 占位提示元素在文本框填满后会被隐藏，所以锚点不止一个
    for (const anchor of ['输入商品描述', '请输入规格值']) {
      const markers = allVisible('body *')
        .filter(element => {
          const text = element.textContent || '';
          return text.includes(anchor) && text.length < 260;
        })
        .sort((left, right) => left.textContent.length - right.textContent.length);
      for (const marker of markers.slice(0, 3)) {
        const editor = tryFrom(marker);
        if (editor) return editor;
      }
    }

    // 兜底：从“填写并新增规格值”这个入口往上找，它不随填值消失
    if (trigger) {
      const editor = tryFrom(trigger);
      if (editor) return editor;
    }

    const overlays = allVisible('[role="dialog"], [role="tooltip"], [class*="popover" i], [class*="popup" i], [class*="dropdown" i]');
    return overlays.find(element => {
      const dropdowns = dropdownHosts(element).length;
      return editableControls(element).length >= 3 && dropdowns >= 2 && dropdowns <= 4;
    }) || null;
  }

  /* ---------------- 下拉框选择 ---------------- */

  function optionPool(wanted, alreadyThere, loose = false) {
    const wantedText = normalize(wanted);
    const matches = text => {
      const current = normalize(text);
      if (current === wantedText) return true;
      return loose && current && (current.includes(wantedText) || wantedText.includes(current));
    };
    const candidates = allVisible('[role="option"], [class*="option" i], li')
      .filter(element => !alreadyThere.has(element))
      .filter(element => matches(element.textContent))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.width < 400 && rect.height < 90;
      });
    const leaves = candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)));
    return (leaves.length ? leaves : candidates).sort((left, right) => {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return a.width * a.height - b.width * b.height;
    });
  }

  function hostShows(host, wanted) {
    const wantedText = normalize(wanted);
    const text = normalize(host.textContent);
    if (text.includes(wantedText)) return true;
    const input = host.querySelector('input');
    return Boolean(input && normalize(input.value) === wantedText);
  }

  function mouseClick(target, core = false) {
    const rect = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: rect.left + Math.min(10, Math.max(2, rect.width / 2)),
      clientY: rect.top + rect.height / 2
    };
    if (!core) {
      target.click();
      return;
    }
    // 按真实鼠标顺序派发：有些下拉是 mousedown 展开、有些是 click 展开
    for (const [type, Ctor] of [['pointerdown', PointerEvent], ['mousedown', MouseEvent], ['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', MouseEvent]]) {
      target.dispatchEvent(new Ctor(type, init));
    }
  }

  /**
   * 真正能点开面板的元素：下拉外壳往往外面还套了一层 xxx-select-wrap，
   * 点外壳只会向上冒泡，打不开内层绑了事件的“下拉核心”，所以要点内层。
   */
  function clickAnchor(host) {
    const inner = [...host.querySelectorAll('[role="combobox"], [class*="select" i], [class*="selection" i], input:not([type="hidden"])')]
      .filter(element => visible(element) && element.getBoundingClientRect().height > 6);
    const core = inner.find(element => {
      const rect = element.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      return rect.width <= hostRect.width + 2 && rect.height <= hostRect.height + 2;
    });
    return core || host;
  }

  function centerPoint(host) {
    const rect = host.getBoundingClientRect();
    const node = document.elementFromPoint(rect.left + Math.min(12, Math.max(3, rect.width / 2)), rect.top + rect.height / 2);
    return node && (host === node || host.contains(node)) ? node : null;
  }

  function resolveEditorField(key) {
    const editor = findEditor();
    if (!editor) return null;
    try {
      const fields = editorFields(editor);
      return fields[key] || null;
    } catch {
      return null;
    }
  }

  function searchInputOf(host) {
    return [...host.querySelectorAll('input:not([type="hidden"])')].find(input => visible(input)) || null;
  }

  function pressKey(target, key, keyCode) {
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true
      }));
    }
  }

  async function setDropdown(element, value, key) {
    const wanted = String(value ?? '').trim();
    if (!wanted) return '表格值为空';

    let host = element;
    // 抖店会在输入后重绘规格编辑框，之前抓到的节点可能已经脱离文档，这时按字段名重新取一次
    const refresh = () => {
      if (!host || !host.isConnected) {
        const next = key ? resolveEditorField(key) : null;
        if (next) host = next;
      }
      return Boolean(host && host.isConnected);
    };

    if (host instanceof HTMLSelectElement) {
      const option = [...host.options].find(item => normalize(item.textContent) === normalize(wanted) || item.value === wanted)
        || [...host.options].find(item => normalize(item.textContent).includes(normalize(wanted)));
      if (!option) return `原生下拉框没有「${wanted}」选项`;
      host.value = option.value;
      host.dispatchEvent(new Event('input', { bubbles: true }));
      host.dispatchEvent(new Event('change', { bubbles: true }));
      return '已填入';
    }

    if (!refresh()) return '下拉框已从页面消失，无法选择';
    const alreadyThere = new Set(allVisible('*'));
    const newOptionNodes = () => allVisible('[role="option"], [class*="option" i]').filter(node => !alreadyThere.has(node));
    host.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(80);

    const pick = () => optionPool(wanted, alreadyThere).concat([]);

    const attempts = [
      () => mouseClick(clickAnchor(host)),
      () => mouseClick(clickAnchor(host), true),
      () => { const node = centerPoint(host); if (node) mouseClick(node, true); },
      () => {
        const anchor = clickAnchor(host);
        (searchInputOf(host) || anchor).focus?.();
        pressKey(anchor, 'ArrowDown', 40);
      },
      () => {
        // 可搜索下拉兜底：把关键字敲进去
        const input = searchInputOf(host);
        if (!input || input.readOnly || input.disabled) return;
        input.focus();
        setNativeValue(input, wanted);
      }
    ];

    let options = [];
    for (const attempt of attempts) {
      if (newOptionNodes().length) break; // 面板已展开就别再点，否则会点回去
      if (!refresh()) break;
      attempt();
      await sleep(430);
      options = pick();
      if (!options.length) options = optionPool(wanted, alreadyThere, true);
      if (options.length) break;
      const input = searchInputOf(host);
      if (input && !input.readOnly && normalize(input.value)) {
        pressKey(input, 'Enter', 13);
        await sleep(280);
        if (hostShows(host, wanted)) return '已填入';
      }
    }

    // 原生 select 兜底：部分组件会保留一个隐藏 select 承载真实取值
    if (!options.length) {
      const native = host.querySelector('select') || host.closest('select');
      if (native) {
        const option = [...native.options].find(item => normalize(item.textContent) === normalize(wanted))
          || [...native.options].find(item => normalize(item.textContent).includes(normalize(wanted)));
        if (option) {
          native.value = option.value;
          native.dispatchEvent(new Event('input', { bubbles: true }));
          native.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(160);
          if (hostShows(host, wanted)) return '已填入';
        }
      }
    }

    if (!options.length) {
      const labels = [];
      for (const node of newOptionNodes()) {
        const text = node.textContent.trim();
        if (text && text.length < 20 && !labels.includes(text)) labels.push(text);
      }
      const shape = host.isConnected ? `点击目标 ${describe(clickAnchor(host))}` : '下拉框节点已被页面重建';
      return labels.length
        ? `下拉框已打开，找不到「${wanted}」。可选：${labels.slice(0, 12).join('、')}`
        : `下拉框没能展开，找不到「${wanted}」（${shape}）`;
    }

    const target = options[0];
    const clickNode = target.closest('[role="option"], [class*="option" i]') || target;
    clickNode.click();
    await sleep(220);
    if (hostShows(host, wanted)) return '已填入';

    // 少数组件要按真实鼠标顺序点一次才生效
    mouseClick(target, true);
    await sleep(240);
    if (hostShows(host, wanted)) return '已填入';

    pressKey(clickNode, 'Enter', 13);
    await sleep(200);
    if (hostShows(host, wanted)) return '已填入';

    document.activeElement?.blur?.();
    await sleep(120);
    return `点击了「${wanted}」但下拉框没有更新`;
  }

  /* ---------------- 规格行创建 ---------------- */

  function editorName(editor) {
    try {
      return valueOf(editorFields(editor).skuName).trim();
    } catch {
      return '';
    }
  }

  // 抖店靠“点空白处”收起规格填写框并提交当前规格值，必须在文档层面补一次鼠标序列
  function blankClick() {
    document.activeElement?.blur?.();
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: 4, clientY: 4
    };
    for (const [type, Ctor] of [['pointerdown', PointerEvent], ['mousedown', MouseEvent], ['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', MouseEvent]]) {
      document.body.dispatchEvent(new Ctor(type, init));
    }
  }

  // 点空白 → 当前填写框收起 → 值才会落成上面的规格值条
  async function commitEditor() {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!findEditor()) return true;
      blankClick();
      await sleep(340);
    }
    return !findEditor();
  }

  // 填写框收起后，再点“填写并新增规格值”才会出现下一条空白编辑框
  async function openEditor() {
    let editor = findEditor();
    if (editor) {
      if (!editorName(editor)) return editor;
      await commitEditor();
    }
    const trigger = findAddTrigger();
    if (!trigger) throw new Error('页面上找不到“填写并新增规格值”空白项');
    trigger.click();
    await sleep(420);
    editor = findEditor();
    if (!editor) {
      // 有时第一下只是把残留弹层关掉，需要再点一次
      trigger.click();
      await sleep(520);
      editor = findEditor();
    }
    if (!editor) throw new Error('点击“填写并新增规格值”后没有出现规格编辑框');
    return editor;
  }

  function rowLikeElements() {
    return allVisible('tr, [role="row"], [class*="row" i], [class*="sku" i], [class*="item" i]');
  }

  function recordSearchText(record) {
    return normalize(`${record.skuName}${record.specValue}${record.specUnit}${record.quantity}${record.quantityUnit}`);
  }

  function rowInputs(node) {
    const hosts = dropdownHosts(node);
    return editableControls(node)
      .filter(element => !hosts.some(host => host === element || host.contains(element)))
      .filter(element => !isSelectSearchBox(element));
  }

  /**
   * 价格与库存表里一条 SKU 的“套餐类型”文字，正好是 名称+规格+单位+数量+量词 拼起来的整串。
   * 所以必须先找到这段文字，再往上找到**只包这一条**的容器：
   * 容器文案不能比 key 长太多，且输入框数量在 1~5 个之间（跨多行的容器会有 8 个以上）。
   * 旧版用“包含名称/规格/数量”匹配，会被“名称互为前缀”的 SKU 骗到，把价格写进别人的行。
   */
  function rowFromLeaf(leaf, key) {
    let node = leaf;
    for (let depth = 0; node && node.parentElement && node !== document.body && depth < 9; depth++, node = node.parentElement) {
      const text = normalize(node.textContent);
      if (!text.includes(key)) break;
      if (text.length > key.length + 40) break;
      const count = rowInputs(node).length;
      if (count >= 1 && count <= 6) return node;
    }
    return null;
  }

  function findSkuRow(record) {
    const key = recordSearchText(record);
    if (!key) return null;
    const editor = findEditor();
    const leaves = allVisible('div, span, p, td, [class*="cell" i], [class*="name" i]')
      .filter(element => normalize(element.textContent) === key)
      .filter(element => {
        if (!editor) return true;
        return !(editor === element || editor.contains(element) || element.contains(editor));
      });
    if (!leaves.length) return null;
    const deepest = leaves.filter(element => !leaves.some(other => other !== element && element.contains(other)));
    for (const leaf of deepest) {
      const row = rowFromLeaf(leaf, key);
      if (row) return row;
    }
    return null;
  }

  function cellElements(row) {
    const explicit = [...row.children].filter(element =>
      element.matches('td, th, [role="cell"], [role="columnheader"], [class*="cell" i], [class*="column" i]')
    );
    return explicit.length ? explicit : [...row.children];
  }

  function tableField(row, label) {
    const headers = rowLikeElements().filter(element => {
      const text = normalize(element.textContent);
      return text.includes(normalize(label)) && editableControls(element).length === 0;
    });
    for (const header of headers) {
      const headerCells = cellElements(header);
      const index = headerCells.findIndex(cell => normalize(cell.textContent).includes(normalize(label)));
      if (index < 0) continue;
      const rowCells = cellElements(row);
      const field = rowCells[index] && editableControls(rowCells[index])[0];
      if (field) return field;
    }
    return null;
  }

  function fieldByHint(root, words) {
    return editableControls(root).find(element => {
      const label = `${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('name') || ''}`;
      return words.some(word => label.includes(word));
    }) || null;
  }

  function fieldByLabel(root, words) {
    const labels = allVisible('label, span, div, th, [role="cell"]', root)
      .filter(element => {
        const text = normalize(element.textContent);
        return text.length <= 32 && words.some(word => text === normalize(word));
      })
      .sort((left, right) => left.textContent.length - right.textContent.length);
    for (const label of labels) {
      let parent = label;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        const input = editableControls(parent).find(element => element !== label);
        if (input) return input;
      }
    }
    return null;
  }

  async function tryRowEdit(record, row) {
    row.click();
    await sleep(200);
    const codeInput = fieldByHint(document, ['商家编码', '商品编码', 'SKU编码'])
      || fieldByLabel(document, ['商家编码', '商品编码']);
    if (!codeInput || row.contains(codeInput)) return null;
    const container = codeInput.closest('[role="dialog"], [class*="dialog" i], [class*="modal" i], [class*="popover" i]');
    if (!container) return null;
    const result = await setText(codeInput, record.code);
    if (result !== '已填入') return null;
    const confirm = allVisible('button, [role="button"]', container)
      .find(element => /^(确定|保存|完成|确认)$/.test(element.textContent.trim()));
    confirm?.click();
    await sleep(160);
    return '已填入';
  }

  async function applyBulkCode(row, code) {
    const codeInput = fieldByHint(document, ['商家编码', '商品编码', 'SKU编码'])
      || fieldByLabel(document, ['商家编码', '商品编码']);
    if (!codeInput || row.contains(codeInput)) return null;
    const checkbox = row.querySelector('input[type="checkbox"], [role="checkbox"]');
    if (checkbox && (visible(checkbox) || visible(checkbox.parentElement))) {
      const checked = checkbox instanceof HTMLInputElement ? checkbox.checked : checkbox.getAttribute('aria-checked') === 'true';
      if (!checked) (checkbox.closest('label') || checkbox).click();
    } else {
      row.click();
      await sleep(120);
      const selected = row.getAttribute('aria-selected') === 'true'
        || row.getAttribute('aria-checked') === 'true'
        || /selected|checked|active/i.test(row.className);
      if (!selected) return null;
    }
    const inputResult = await setText(codeInput, code);
    const applyButton = allVisible('button, [role="button"]')
      .find(element => normalize(element.textContent) === normalize('批量设置'));
    if (inputResult !== '已填入' || !applyButton) return null;
    applyButton.click();
    await sleep(180);
    return '已填入';
  }

  function fieldHint(element) {
    return `${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('name') || ''}`;
  }

  /**
   * 价格与库存表的列顺序是：全部套餐类型 | 价格 | 现货库存 | 商家编码 | 条形码。
   * 除下拉框内部搜索框外，一行里剩下的输入框按顺序就是 价格、库存、编码、条码，
   * 所以“按提示词匹配 → 按列位置”比按表头找单元格更不容易错位。
   */
  async function fillPriceAndCode(record) {
    const row = findSkuRow(record);
    if (!row) return { price: '没有找到该 SKU 对应的价格库存行', code: '没有找到该 SKU 对应的价格库存行' };

    const inputs = rowInputs(row);
    const pickPrice = list => list.find(element => /价格|售价|金额|price/i.test(fieldHint(element)))
      || (list.length >= 3 ? list[0] : null)
      || list[0] || null;
    const pickCode = list => list.find(element => /商家编码|商品编码|sku编码|货号|编码/i.test(fieldHint(element)))
      || (list.length >= 3 ? list[2] : null)
      || null;

    const codeField = pickCode(inputs) || tableField(row, '商家编码');
    let codeResult = codeField ? await setText(codeField, record.code) : null;
    if (codeResult !== '已填入') codeResult = await tryRowEdit(record, row);
    if (codeResult !== '已填入') codeResult = await applyBulkCode(row, record.code);

    const currentRow = findSkuRow(record) || row;
    const currentInputs = currentRow === row ? inputs : rowInputs(currentRow);
    const priceField = pickPrice(currentInputs) || tableField(currentRow, '价格');

    return {
      price: priceField ? await setText(priceField, record.price) : '该 SKU 行中没有找到价格输入框',
      code: codeResult === '已填入' ? codeResult : (codeResult || '该 SKU 行中没有找到独立编码输入框')
    };
  }

  async function waitForRow(record) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const row = findSkuRow(record);
      if (row) return row;
      // 第 8 次还没出现，可能是填写框没真正收起，再补一次“点空白”
      if (attempt === 8) await commitEditor();
      await sleep(320);
    }
    return null;
  }

  async function createOne(record, index, total) {
    const before = findSkuRow(record);
    if (!before) {
      await openEditor();
      // 先写三段文本，再选两个下拉，避免下拉展开时的浮层打断输入
      const actions = ['skuName', 'specValue', 'quantity', 'specUnit', 'quantityUnit'];
      const results = {};
      let editor = findEditor();
      if (!editor) {
        return { row: record.sourceRow, skuName: record.skuName, ok: false, results: { skuName: '打开编辑框后没能定位到它（结构识别失败）' } };
      }
      let fields;
      try {
        fields = editorFields(editor);
      } catch (error) {
        return { row: record.sourceRow, skuName: record.skuName, ok: false, results: { skuName: error.message } };
      }
      for (const key of actions) {
        // 抖店在文本填满后会把占位提示隐藏，findEditor 的锚点随之消失；
        // 只要手里这个节点还在文档里就继续用，不必每步都重新找编辑框
        if (!fields[key] || !fields[key].isConnected) {
          const next = findEditor() || (editor && editor.isConnected ? editor : null);
          if (!next) {
            results[key] = '页面重绘后没有找到规格编辑框（原节点已失效）';
            return { row: record.sourceRow, skuName: record.skuName, ok: false, results };
          }
          editor = next;
          try {
            fields = editorFields(editor);
          } catch (error) {
            results[key] = error.message;
            return { row: record.sourceRow, skuName: record.skuName, ok: false, results };
          }
        }
        results[key] = key === 'specUnit' || key === 'quantityUnit'
          ? await setDropdown(fields[key], record[key], key)
          : await setText(fields[key], record[key]);
        if (results[key] !== '已填入') return { row: record.sourceRow, skuName: record.skuName, ok: false, results };
      }
      if (!(await commitEditor())) {
        return { row: record.sourceRow, skuName: record.skuName, ok: false, continue: false, results: { sku: '规格填写框没有收起（点空白处无效），已停止后续导入' } };
      }
      await sleep(260);
    }

    const row = await waitForRow(record);
    if (!row) {
      return {
        row: record.sourceRow,
        skuName: record.skuName,
        ok: false,
        continue: false,
        results: { sku: '规格值没有出现在价格与库存列表中，已停止后续导入' }
      };
    }

    const pricing = await fillPriceAndCode(record);
    const ok = pricing.price === '已填入' && pricing.code === '已填入';
    showNotice(`${index + 1}/${total} ${record.skuName}\n价格：${pricing.price}\n编码：${pricing.code}`, !ok, 5000);
    return { row: record.sourceRow, skuName: record.skuName, ok, continue: true, results: { sku: before ? '已存在' : '已创建', ...pricing } };
  }

  async function batchFill(records, runId) {
    if (!Array.isArray(records) || !records.length) throw new Error('没有可导入的表格行');
    const required = ['skuName', 'specValue', 'specUnit', 'quantity', 'quantityUnit', 'code', 'price'];
    const missing = records.find(record => required.some(key => !String(record[key] ?? '').trim()));
    if (missing) throw new Error(`表格第 ${missing.sourceRow} 行缺少名称、规格、单位、数量、量词、编码或价格`);
    const invalidPrice = records.find(record => !Number.isFinite(Number(record.price)) || Number(record.price) <= 0);
    if (invalidPrice) throw new Error(`表格第 ${invalidPrice.sourceRow} 行售价为 ${invalidPrice.price}。请在表格填入大于 0 的实际售价后再导入，页面尚未做任何修改。`);

    const results = [];
    for (let index = 0; index < records.length; index++) {
      showNotice(`正在处理 ${index + 1}/${records.length}\n${records[index].skuName}`, false, 0);
      try {
        const result = await createOne(records[index], index, records.length);
        results.push(result);
        if (!result.continue) break;
      } catch (error) {
        results.push({ row: records[index].sourceRow, skuName: records[index].skuName, ok: false, results: { error: error.message } });
        break;
      }
    }
    try {
      const leftoverEditor = findEditor();
      if (leftoverEditor && !editorName(leftoverEditor)) await commitEditor();
    } catch {
      /* 清理失败不影响结果汇总 */
    }
    const succeeded = results.filter(item => item.ok).length;
    const lines = results.map(item => {
      const details = Object.entries(item.results).map(([field, value]) => `${fieldNames[field] || field} ${value}`).join('；');
      return `第${item.row}行 ${item.skuName}：${details}`;
    });
    showNotice(`批量填入完成 ${succeeded}/${records.length} 条\n${lines.join('\n')}`, succeeded !== records.length, 15000);
    // 只读上报：侧边栏关掉时这次的回复会丢，落一份结果到 storage，下次打开还能看到。
    // 不参与填充流程，写失败也不影响本次执行。
    try {
      chrome.storage.local.set({ skuFillRun: { runId: Number(runId) || 0, at: Date.now(), total: records.length, results } });
    } catch {
      /* 忽略 */
    }
    return { results };
  }

  /* ---------------- 结构自检 ---------------- */

  function describe(element) {
    const rect = element.getBoundingClientRect();
    const raw = typeof element.className === 'string' ? element.className : (element.getAttribute('class') || '');
    const cls = String(raw).trim().replace(/\s+/g, '.').slice(0, 48);
    return `${element.tagName.toLowerCase()}${cls ? `.${cls}` : ''} [${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}]`;
  }

  function diagnose() {
    const editor = findEditor();
    if (!editor) return '没有找到规格编辑框。请先在抖店页面点开“填写并新增规格值”的编辑框，再点“检查页面规格框结构”。';
    const hosts = dropdownHosts(editor);
    const texts = editorTextInputs(editor, hosts);
    const lines = [`编辑框：${describe(editor)}`];
    lines.push(`下拉框 ${hosts.length} 个：`);
    hosts.forEach((host, index) => lines.push(`  ${index + 1}. ${describe(host)} 文本「${host.textContent.trim().slice(0, 10)}」 → 点击核心 ${describe(clickAnchor(host))}`));
    lines.push(`文本输入框 ${texts.length} 个：`);
    texts.forEach((text, index) => {
      const hint = text.getAttribute('placeholder') || text.getAttribute('aria-label') || '—';
      lines.push(`  ${index + 1}. ${describe(text)} placeholder=${hint} 只读=${text.readOnly}`);
    });
    try {
      const fields = editorFields(editor);
      lines.push('识别结果：');
      lines.push(`  名称 → ${describe(fields.skuName)}`);
      lines.push(`  规格数值 → ${describe(fields.specValue)}`);
      lines.push(`  规格单位 → ${describe(fields.specUnit)}`);
      lines.push(`  数量 → ${describe(fields.quantity)}`);
      lines.push(`  数量量词 → ${describe(fields.quantityUnit)}`);
    } catch (error) {
      lines.push(`识别失败：${error.message}`);
    }
    return lines.join('\n');
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === 'PING') {
      reply({ ok: true, version: scriptVersion });
      return;
    }
    if (message.type === 'DIAGNOSE') {
      try {
        reply({ text: diagnose() });
      } catch (error) {
        reply({ text: `自检失败：${error.message}` });
      }
      return;
    }
    if (message.type === 'BATCH_FILL') {
      batchFill(message.records, message.runId).then(reply).catch(error => {
        showNotice(`批量填入失败：${error.message}`, true, 12000);
        reply({ error: error.message, results: [] });
      });
      return true;
    }
  });
})();
