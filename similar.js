/*
 * 抖店「发布相似品」批处理（侧边栏里叫「旧链上新」）
 * 列表页：按 ID 搜索 → 点「发布相似品」→ 确认弹窗选第一项 → 确定（抖店自己打开新标签页）
 * 发布页：等页面就绪 → 点「发布商品」→ 等「商品提交成功」→ 通知后台关闭标签页
 * 队列由列表页脚本自己驱动，每条之间等后台转发的「发布页已完成」信号。
 *
 * 同一份脚本还承载「裂变链接」（同一个源商品连点 N 次，每条换标题和主图）：
 * 列表页走 runVariants()，发布页由 SIMILAR_PUBLISH.variant 触发 applyVariant()。
 */
(() => {
  const VERSION = '0.9.3';
  if (window.__doudianSimilar) return;
  window.__doudianSimilar = VERSION;

  const WAIT_SIGNAL_MS = 240000;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function norm(value) {
    return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** 去掉所有空白再比：按钮文案有时会渲染成「查 询」「发 布」 */
  function compact(value) {
    return norm(value).replace(/\s+/g, '');
  }

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return Number(style.opacity || 1) > 0.05;
  }

  function allVisible(selector, root = document) {
    return Array.from(root.querySelectorAll(selector)).filter(visible);
  }

  function isClickable(element) {
    if (!element) return false;
    const tag = element.tagName;
    if (tag === 'BUTTON' || tag === 'A') return true;
    if (element.getAttribute('role') === 'button') return true;
    if (/btn|button|link|action|operate/i.test(String(element.className || ''))) return true;
    try {
      return getComputedStyle(element).cursor === 'pointer';
    } catch {
      return false;
    }
  }

  /**
   * 派发一整套鼠标事件。
   * 默认先把坐标交给 elementFromPoint 做命中测试（能正确处理被遮挡的情况）；
   * strict=true 时**直接派发到元素本身** —— 弹窗按钮必须这样：弹窗入场动画期间
   * elementFromPoint 很可能返回背后的遮罩，点到遮罩等于点「取消」，弹窗就闪一下没了。
   */
  function mouseClick(element, options = {}) {
    if (!element || !element.isConnected) return false;
    try {
      element.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
      /* 元素可能不可滚动 */
    }
    const rect = element.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 2);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 2);
    const target = options.strict ? element : (document.elementFromPoint(x, y) || element);
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      button: 0, clientX: x, clientY: y
    };
    const sequence = [
      ['pointerdown', PointerEvent], ['mousedown', MouseEvent],
      ['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', MouseEvent]
    ];
    for (const [type, Ctor] of sequence) {
      try {
        target.dispatchEvent(new Ctor(type, init));
      } catch {
        target.dispatchEvent(new MouseEvent(type, init));
      }
    }
    return true;
  }

  /** 这个元素的中心点，真的能落到它自己（或它的子节点）上吗 */
  function pointReaches(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === element || element.contains(hit)));
  }

  /** 等元素「就位」：位置连续 250ms 不变，且中心点确实点在它身上（动画结束、没被遮罩盖住） */
  async function waitClickable(element, timeout = 4000) {
    const startedAt = Date.now();
    let lastBox = '';
    let stableAt = 0;
    while (Date.now() - startedAt < timeout) {
      const rect = element.getBoundingClientRect();
      const box = [rect.left, rect.top, rect.width, rect.height].map(value => Math.round(value)).join(',');
      if (pointReaches(element)) {
        if (box === lastBox && Date.now() - stableAt >= 250) return true;
        if (box !== lastBox) {
          lastBox = box;
          stableAt = Date.now();
        }
      } else {
        lastBox = '';
      }
      await sleep(100);
    }
    return false;
  }

  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressKey(element, key, keyCode) {
    const init = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
    for (const type of ['keydown', 'keypress', 'keyup']) {
      element.dispatchEvent(new KeyboardEvent(type, init));
    }
  }

  async function waitFor(fn, timeout = 20000, interval = 400) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      let value = null;
      try {
        value = fn();
      } catch {
        value = null;
      }
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  function report(text, extra = {}) {
    try {
      // 两个功能各有自己的面板，进度不要互相覆盖
      const key = runtime.mode === 'variant' ? 'variantProgress' : 'similarProgress';
      chrome.storage.local.set({ [key]: { text, at: Date.now(), ...extra } });
    } catch {
      /* 扩展被重载时会失败，忽略 */
    }
  }

  /** 往面板的「运行日志」里写一行，出问题时能看出到底卡在哪一步（3 秒内重复内容只记一次） */
  let lastLogText = '';
  let lastLogAt = 0;
  function logStep(text) {
    const now = Date.now();
    if (text === lastLogText && now - lastLogAt < 3000) return;
    lastLogText = text;
    lastLogAt = now;
    try {
      const page = /\/(create|edit)(\?|$|\/)/.test(location.pathname) ? '发布页' : '列表页';
      const pending = chrome.runtime.sendMessage({
        type: 'SIMILAR_LOG',
        text: `[${page}] ${text}`,
        channel: runtime.mode === 'variant' ? 'variant' : ''
      });
      if (pending && pending.catch) pending.catch(() => {});
    } catch {
      /* 扩展被重载时忽略 */
    }
  }

  /* ---------------- 列表页：搜索并打开发布相似品 ---------------- */

  // 记住上一次真正用过的搜索框：列表刷新后组件可能被替换，但若原元素还在就继续用它，
  // 避免第二轮把页面里别的文本框（筛选/行内编辑）误认成搜索框
  let lastSearchInput = null;

  function usableInput(element) {
    if (!element || !element.isConnected) return false;
    if (element.disabled || element.readOnly) return false;
    const type = String(element.type || 'text').toLowerCase();
    if (type !== 'text' && type !== 'search') return false;
    // 弹窗/抽屉里的输入框不是列表搜索框
    if (typeof element.closest === 'function'
      && element.closest('[role="dialog"], [class*="modal" i], [class*="drawer" i]')) return false;
    return true;
  }

  function describeInput(element) {
    if (!element) return '（无）';
    const rect = element.getBoundingClientRect();
    return `placeholder=「${element.getAttribute('placeholder') || ''}」type=${element.type || 'text'} `
      + `[${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}] `
      + `value=「${norm(element.value).slice(0, 30)}」`;
  }

  function findSearchInput() {
    if (usableInput(lastSearchInput) && visible(lastSearchInput)) return lastSearchInput;

    const inputs = allVisible('input').filter(usableInput);
    const scored = inputs.map(element => {
      const hint = `${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''}`;
      let score = 0;
      if (/商品\s*id/i.test(hint)) score += 12;
      if (/商品id或商品名称|商品名称|商品标题|关键词/.test(hint)) score += 8;
      if (/搜索|查询|请输入/.test(hint)) score += 4;
      const rect = element.getBoundingClientRect();
      if (rect.width > 200) score += 3;
      if (rect.top < 400) score += 2;
      // 没有任何提示文字的输入框基本不是搜索框（行内编辑、备注等），别让它靠"够宽"胜出
      if (!hint.trim()) score -= 8;
      return { element, score };
    }).filter(item => item.score >= 4);
    scored.sort((left, right) => right.score - left.score);
    if (!scored.length) return null;
    lastSearchInput = scored[0].element;
    return lastSearchInput;
  }

  /** 列表里可见的数据行 */
  function listRows() {
    const table = document.querySelector('table');
    const scope = table || document;
    const rows = Array.from(scope.querySelectorAll('tbody tr, [role="row"]')).filter(visible);
    if (rows.length) return rows;
    // 有些版本是 div 网格，没有 table / role=row
    return Array.from(document.querySelectorAll('[class*="table"] [class*="row"], [class*="list"] [class*="row"]'))
      .filter(visible)
      .filter(element => element.childElementCount >= 2);
  }

  /**
   * 列表数据的「指纹」：用来判断这次搜索到底有没有让列表刷新。
   * 只认表格行，不掺整页文字（时间、toast 会让它一直变）；拿不到行时退回表格区域文字，
   * 保证「列表换了内容」这件事仍然可观测。空指纹在判定里不算刷新，避免把骨架屏当结果。
   */
  function listPrint() {
    const rows = listRows();
    const text = rows.slice(0, 5).map(row => norm(row.textContent)).join('|');
    if (text) return text.slice(0, 1200);
    const region = document.querySelector('[class*="table-body"], [class*="table-content"], [class*="table"], [class*="list-body"]');
    const fallback = region ? norm(region.textContent).slice(0, 1200) : '';
    return fallback.length > 40 ? fallback : '';
  }

  /** 指纹为空时把列表结构记进日志，便于判断是不是选择器没命中 */
  function logListStructure() {
    const count = selector => document.querySelectorAll(selector).length;
    logStep(`列表结构：table=${count('table')}，tbody tr=${count('tbody tr')}，role=row=${count('[role="row"]')}`);
  }

  /** 表格是否还在加载（有遮罩/骨架时先别动，容易点到旧数据） */
  function listBusy() {
    return Boolean(document.querySelector(
      '.semi-spin-spinning, .ant-spin-spinning, [class*="table-loading"], [class*="loading-mask"], [class*="loading-wrapper"], [class*="spin-container"]'
    ));
  }

  /**
   * 列表底部的「共 N 件商品」。这是判断**筛选真的生效**的硬指标：
   * 按商品 ID 搜索后应该只剩 1 件；如果还是 3 件，说明查询根本没作用在列表上。
   */
  function resultCount() {
    const hit = allVisible('div, span, p, li')
      .filter(element => element.childElementCount <= 1)
      .map(element => norm(element.textContent))
      .find(text => text.length < 30 && /^共\s*\d+\s*[件条个]/.test(text));
    if (!hit) return null;
    const matched = hit.match(/共\s*(\d+)/);
    return matched ? Number(matched[1]) : null;
  }

  function findSearchButton(input) {
    // 「查询/搜索」是真搜索；「筛选」只作最后手段（点开的多半是筛选抽屉，不会刷新列表）
    const rank = text => (text === '查询' ? 2 : text === '搜索' ? 2 : text === '筛选' ? 0 : -1);
    const buttons = allVisible('button, [role="button"], a')
      .filter(element => {
        const text = compact(element.textContent);
        return rank(text) >= 0;
      })
      .filter(element => !element.disabled)
      .filter(element => isClickable(element) || isClickable(element.parentElement));
    if (!buttons.length) return null;
    if (!input) return buttons[0];
    const anchor = input.getBoundingClientRect();
    const row = anchor.top + anchor.height / 2;
    return buttons
      .map(element => {
        const rect = element.getBoundingClientRect();
        return { element, score: rank(compact(element.textContent)) * 100 - Math.abs(rect.top + rect.height / 2 - row) / 50 };
      })
      .sort((left, right) => right.score - left.score)[0].element;
  }

  /** 找不到查询按钮时，把页面上「查/搜」相关的按钮都记进日志，便于判断结构 */
  function logSearchButtonCandidates() {
    const near = allVisible('button, [role="button"], a')
      .filter(element => /查|搜/.test(norm(element.textContent)))
      .slice(0, 6)
      .map(element => `「${norm(element.textContent)}」${element.disabled ? '(禁用)' : ''}${describeBox(element)}`);
    logStep(`没有可点的查询按钮，页面候选：${near.join(' ') || '无'}`);
  }

  /** 只有一条结果时（列表显示「共 1 件商品」）直接认那一行，不依赖 ID 是否显示在页面上 */
  function singleResultRow() {
    const summary = allVisible('div, span, p').find(element => {
      const text = norm(element.textContent);
      return text.length < 24 && /共\s*1\s*[件条个]/.test(text);
    });
    if (!summary) return null;
    const rows = Array.from(document.querySelectorAll('tbody tr, [role="row"]'))
      .filter(visible)
      .filter(row => /发布相似品|编辑|下架/.test(row.textContent || ''));
    return rows.length === 1 ? rows[0] : null;
  }

  /**
   * 页面上有没有「这次确实搜了 XX」的物证：搜索框里还是这个 ID，或出现「商品ID：XX」的筛选标签。
   * 用来给「共 1 件商品」的兜底加一道正向确认，避免把上一条的结果当成这一条。
   */
  function searchEvidence(id, input) {
    const key = norm(id);
    if (input && norm(input.value) === key) return 'input';
    const chip = allVisible('span, div, li, p')
      .filter(element => element.childElementCount <= 1)
      .map(element => norm(element.textContent))
      .find(text => text.length > key.length && text.length < 60
        && text.includes(key) && /(商品\s*id|id\s*[:：]|筛选|搜索)/i.test(text));
    return chip ? 'chip' : '';
  }

  /**
   * 静态搜索证据：列表本来就只剩这一件商品（或本来就只有一件）时，
   * 搜索前后表格内容一模一样，「刷新」判据必然判不出来 —— 这是误报失败的头号原因。
   * 这时改用「列表只剩 1 行 + 该行精确命中这个 ID」作为证据：
   * 精确命中不走兜底，命中的一定是这个商品本身，继续发布不会发错。
   * @returns {string|false} 生效理由，未满足时返回 false
   */
  function staticSearchEvidence(id) {
    const hit = findUniqueResult(id, { allowFallback: false, exactOnly: true });
    if (!hit || !hit.el) return false;
    const count = resultCount();
    if (count === 1) return '页面只剩 1 件商品且这一行就是该 ID';
    const rows = listRows();
    if (count === null && rows.length <= 1) return `列表只有 ${rows.length} 行且就是该 ID`;
    return false;
  }

  /** 是不是筛选栏/标签里的文字（「商品ID：xxx」这种），不能当成商品行用 */
  function looksLikeFilterChip(element) {
    let node = element;
    for (let depth = 0; node && node !== document.body && depth < 5; depth++, node = node.parentElement) {
      const cls = String(node.className || '');
      const role = typeof node.getAttribute === 'function' ? String(node.getAttribute('role') || '') : '';
      if (/filter|tag|chip|selected|condition|query|search-?bar|search-?form/i.test(`${cls} ${role}`)) return true;
    }
    return false;
  }

  /**
   * 在列表里找这条 ID 的唯一结果。
   * allowFallback=false 时**禁止**「共 1 件商品」这类模糊兜底 —— 上一轮的结果页正好也是
   * 「共 1 件」，若不禁用，会在新一次搜索还没生效时就命中上一条商品，导致整条流程串位。
   */
  function findUniqueResult(id, options = {}) {
    const allowFallback = options.allowFallback !== false;
    const key = norm(id);
    const leaves = Array.from(document.querySelectorAll('td, div, span, p, a'))
      .filter(element => element.childElementCount === 0)
      .filter(visible);
    // 列表里 ID 常带前缀（商品ID：xxx / ID:xxx），剥掉再比；但「带前缀 + 不在表格行里」
    // 多半是筛选栏上的「商品ID：xxx」标签，不能当成商品行用
    const hits = [];
    for (const element of leaves) {
      const raw = norm(element.textContent);
      const text = raw.replace(/^(商品\s*id|id)\s*[:：]?\s*/i, '');
      if (text === key) hits.push({ element, prefixed: text !== raw });
    }
    const usableHits = hits.filter(item => !looksLikeFilterChip(item.element));
    if (usableHits.length) {
      const inRow = usableHits.filter(item => typeof item.element.closest === 'function'
        && item.element.closest('tbody tr, [role="row"]'));
      if (inRow.length) return { el: inRow[0].element };
      const plain = usableHits.filter(item => !item.prefixed);
      if (plain.length) return { el: plain[0].element };
    }

    // ID 可能只藏在 title / aria-label 里，或页面上显示的是编码而非数字 ID
    // （exactOnly：这类"包含即可"的匹配不能作为"当前列表就是这件商品"的证据）
    if (options.exactOnly) return null;
    const byAttr = Array.from(document.querySelectorAll('[title], [aria-label]'))
      .filter(visible)
      .filter(element => {
        const haystack = `${element.getAttribute('title') || ''} ${element.getAttribute('aria-label') || ''}`;
        return haystack.includes(key);
      });
    if (byAttr.length) return { el: byAttr[0] };

    if (!allowFallback) return null;

    const empty = allVisible('div, span, p').find(element => {
      const text = norm(element.textContent);
      return text.length < 24 && /暂无数据|没有找到|无匹配|未找到|暂无结果/.test(text);
    });
    if (empty) return { empty: true };

    const only = singleResultRow();
    if (!only) return null;

    const text = norm(only.textContent);
    // 1) 这一行是前面处理过的商品 → 列表还停在旧结果上
    if (previousIds.some(old => old && text.includes(String(old)))) {
      logStep(`兜底命中上一轮的商品（行内出现旧 ID），已否决`);
      return null;
    }
    // 2) 这一行的内容跟搜索前一模一样 → 就是旧结果，不是新搜出来的
    const head = text.slice(0, 80);
    if (options.beforePrint && head && options.beforePrint.includes(head)) {
      logStep('兜底命中的行与搜索前完全一致，判定为旧结果并否决');
      return null;
    }
    // 3) 必须有「这次真搜了这个 ID」的物证，否则宁可报错也不乱点发布
    if (options.requireEvidence) {
      const evidence = searchEvidence(id, options.input);
      if (!evidence) {
        logStep(`兜底命中一行，但页面没有任何「已搜索 ${key}」的痕迹，判定不可信`);
        return { untrusted: true };
      }
      logStep(`兜底命中一行，物证：${evidence === 'input' ? '搜索框仍是该 ID' : '页面出现该 ID 的筛选标签'}`);
    }
    return { el: only, fallback: true };
  }

  function similarButtons() {
    return allVisible('button, a, span, div, [role="button"]')
      .filter(element => compact(element.textContent) === '发布相似品')
      .filter(element => {
        const nodes = allVisible('button, a, span, div', element);
        return nodes.length <= 2 && (isClickable(element) || isClickable(element.parentElement));
      });
  }

  function rowContainer(anchor) {
    let node = anchor;
    for (let depth = 0; node && node !== document.body && depth < 9; depth++, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.height > 40 && rect.height < 240 && rect.width > 380) return node;
    }
    return anchor.parentElement || anchor;
  }

  function nearestTo(elements, anchor) {
    const rect = anchor.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    return elements.slice().sort((left, right) => {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return Math.abs(a.top + a.height / 2 - center) - Math.abs(b.top + b.height / 2 - center);
    })[0];
  }

  /**
   * 抖店的确认弹窗有两种形态，都要能点：
   *   A. 带单选项的（列表第一项「发布相似品」，底部「确定 / 取消」）
   *   B. 纯文字确认（标题「确认发布相似品吗?」，底部「确认 / 取消」，确认为蓝色主按钮）
   * 按钮统一按“确认类文案 + 排除取消类文案”找，并优先蓝色主按钮，绝不误点取消。
   */
  const OK_TEXTS = ['确定', '确认', '确认发布', '确定发布', '好的', '继续发布'];
  const CANCEL_TEXTS = ['取消', '关闭', '返回', '再想想'];

  /** 在给定容器里找“确认”类按钮，返回最靠下、最像主按钮的那个（没有就返回 null） */
  function okTarget(root) {
    const candidates = Array.from(root.querySelectorAll('button, [role="button"], a, span, div'))
      .filter(visible)
      .filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true');

    const matches = candidates.filter(element => {
      const text = compact(element.textContent);
      return OK_TEXTS.includes(text) && !CANCEL_TEXTS.includes(text);
    });
    if (!matches.length) return null;

    // 只保留最深层节点，避免点到包了两个按钮的外层容器
    const deepest = matches.filter(element => !matches.some(other => other !== element && element.contains(other)));

    const isPrimary = element => {
      const self = String(element.className || '');
      const parent = String(element.parentElement?.className || '');
      const grand = String(element.parentElement?.parentElement?.className || '');
      return /primary|btn-ok|aux-btn-primary|confirm|danger/i.test(`${self} ${parent} ${grand}`);
    };

    // 弹窗底部的那个：先按主按钮样式挑，再按“最靠下”兜底
    const bottomMost = deepest.slice().sort((left, right) => {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return b.top - a.top;
    });

    return bottomMost.find(isPrimary) || bottomMost[0];
  }

  function findConfirmDialog() {
    const nodes = allVisible('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="confirm" i], [class*="popup" i]')
      .filter(element => /请确认要进行的操作|发布相似品|设置渠道品|确认要发布/.test(element.textContent || ''))
      // 弹窗里必须真有“确认/确定”按钮，避免把提示条、整页容器认成弹窗
      .filter(element => Boolean(okTarget(element)));
    return nodes.sort((left, right) => norm(left.textContent).length - norm(right.textContent).length)[0] || null;
  }

  // 只有“带单选项”的弹窗才需要先点选第一项（旧版的「发布相似品 / 设置渠道品」二选一）
  function dialogHasOptions(dialog) {
    return Boolean(dialog.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
  }

  function pickCard(dialog, title) {
    const nodes = Array.from(dialog.querySelectorAll('div, label, li'))
      .filter(element => visible(element) && norm(element.textContent).startsWith(title))
      .filter(element => norm(element.textContent).length < 200);
    const deepest = nodes.filter(element => !nodes.some(other => other !== element && element.contains(other)));
    return deepest[0] || null;
  }

  /* ---------------- 列表页：搜索并打开发布相似品 ---------------- */

  const PENDING_KEY = 'similarPending';

  /** 读后台登记的待接管任务（点确认前登记，点确认后由后台打上 sent） */
  async function readPending() {
    try {
      const data = await chrome.storage.local.get([PENDING_KEY]);
      return data[PENDING_KEY] || null;
    } catch {
      return null;
    }
  }

  // 已经处理过的 ID：用来识破「共 1 件商品」兜底命中上一条结果的情况
  let previousIds = [];

  /** 点掉弹窗的取消按钮（登记失败时用，避免弹窗残留挡住下一轮） */
  function clickDialogCancel(dialog) {
    const candidates = Array.from(dialog.querySelectorAll('button, [role="button"], a, span'))
      .filter(visible)
      .filter(element => CANCEL_TEXTS.includes(norm(element.textContent)));
    const deepest = candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)));
    return deepest.length ? mouseClick(deepest[0], { strict: true }) : false;
  }

  /**
   * 点弹窗里的「确认」。
   * 必须等按钮就位（动画结束、中心点确实命中按钮本身）再**直接派发事件到按钮**，
   * 不能走 elementFromPoint —— 弹窗还在缩放/淡入时它会返回背后的遮罩，
   * 点到遮罩等于点「取消」，弹窗就闪一下消失、也不会开新标签页。
   */
  async function clickDialogOk(dialog) {
    const target = okTarget(dialog);
    if (!target) return false;
    const settled = await waitClickable(target, 4000);
    logStep(`确认按钮：${settled ? '已就位' : '4 秒内未就位（可能被遮罩盖住或在动画中）'} ${describeBox(target)}`);
    return mouseClick(target, { strict: true });
  }

  /**
   * 把 ID 写进搜索框。
   * 先用「全选 + insertText」一次性替换（只产生一次 input 事件，不会让平台的「输入即搜」
   * 先拿空值搜一遍）；值没留住再退回逐字符键入 —— 有些组件库只认真实的按键序列。
   */
  async function typeSearchId(input, id) {
    const want = String(id);
    try {
      input.scrollIntoView({ block: 'center' });
    } catch {
      /* 忽略 */
    }
    // 先像真人一样点一下输入框：部分组件库只有收到真实的 mousedown/click 才进入可编辑态，
    // 直接 focus + 改 value 会被它当成外部赋值、随后又用自身 state 覆盖回去
    mouseClick(input);
    await sleep(150);
    input.focus();
    let typed = false;
    try {
      if (input.select) input.select();
      typed = document.execCommand('insertText', false, want);
    } catch {
      typed = false;
    }
    if (!typed || norm(input.value) !== norm(want)) setNativeValue(input, want);
    await sleep(250);

    if (norm(input.value) !== norm(want)) {
      // 逐字符键入：keydown → insertText → keyup
      try {
        if (input.select) input.select();
        document.execCommand('delete');
      } catch {
        /* 忽略 */
      }
      for (const char of want) {
        pressKey(input, char, char.charCodeAt(0));
        try {
          document.execCommand('insertText', false, char);
        } catch {
          /* 忽略 */
        }
        await sleep(40);
      }
      await sleep(150);
    }
    logStep(`写入搜索框后：${describeInput(input)}`);
    return norm(input.value) === norm(want);
  }

  /**
   * 等列表**稳定地**换成另一批数据。只有 'changed' / null 两种结果。
   *
   * 这里绝对不能再用「页面上已经出现这个 ID」当搜索成功的证据：未筛选的列表里
   * 本来就可能有这个商品（比如刚发过的那个正排在第一位），一进循环就命中，
   * 会让所有搜索动作全被跳过 —— 这就是「填了 ID 但根本没搜」的根因。
   * 唯一可信的证据是：表格内容在本次动作后发生了**稳定**变化（连续 600ms 不变），
   * 且新指纹不为空（空指纹是加载中的骨架屏）。
   */
  async function waitStableRefresh(beforePrint, timeout) {
    const startedAt = Date.now();
    let candidate = '';
    let candidateAt = 0;
    while (Date.now() - startedAt < timeout) {
      const print = listPrint();
      if (print && print !== beforePrint) {
        if (print === candidate && Date.now() - candidateAt >= 600) {
          logStep(`列表已刷新：${listRows().length} 行`);
          return 'changed';
        }
        if (print !== candidate) {
          candidate = print;
          candidateAt = Date.now();
        }
      } else {
        candidate = '';
      }
      await sleep(250);
    }
    return null;
  }

  /** 搜索框右侧的放大镜图标按钮（有些版本没有「查询」文字按钮，只有一个图标） */
  function findSearchIcon(input) {
    let node = input;
    for (let depth = 0; node && node !== document.body && depth < 4; depth++, node = node.parentElement) {
      const icon = Array.from(node.querySelectorAll('button, [role="button"], span, i, svg'))
        .filter(visible)
        .filter(element => element !== input)
        .filter(element => {
          const cls = `${String(element.className || '')} ${String(element.parentElement?.className || '')}`;
          return /search|magnif|suffix|append|addon|icon-btn/i.test(cls);
        })
        .find(element => !norm(element.textContent));
      if (icon) return icon;
    }
    return null;
  }

  /**
   * 按顺序尝试触发搜索，直到列表稳定刷新为止。
   * 每一步都写日志：下次出问题能直接看出"哪个动作真的让列表变了"。
   */
  async function triggerSearch(input, id, beforePrint) {
    const attempts = [
      { name: '回车', timeout: 6000, run: () => pressKey(input, 'Enter', 13) },
      {
        name: '点「查询」按钮',
        timeout: 15000,
        run: () => {
          const button = findSearchButton(input);
          if (!button) {
            logSearchButtonCandidates();
            return false;
          }
          mouseClick(button);
          return true;
        }
      },
      {
        name: '再回车 + 点「查询」',
        timeout: 9000,
        run: () => {
          pressKey(input, 'Enter', 13);
          const button = findSearchButton(input);
          if (button) mouseClick(button);
          return true;
        }
      },
      {
        name: '点搜索图标',
        timeout: 10000,
        run: () => {
          const icon = findSearchIcon(input);
          if (!icon) return false;
          mouseClick(icon);
          return true;
        }
      },
      {
        name: '失焦提交',
        timeout: 8000,
        run: () => {
          input.blur();
          if (document.body && document.body.click) document.body.click();
          return true;
        }
      }
    ];

    for (const attempt of attempts) {
      const acted = attempt.run();
      if (acted === false) {
        logStep(`尝试「${attempt.name}」：页面上找不到对应元素，跳过`);
        continue;
      }
      const state = await waitStableRefresh(beforePrint, attempt.timeout);
      logStep(`尝试「${attempt.name}」→ ${state || '列表未刷新'}`);
      if (state) return state;
    }
    return null;
  }

  /**
   * 等后台真正接管新开的发布页（pending.sent），避免"以为开了其实没开"。
   * 同时盯住确认弹窗：弹窗已经关掉、后台也没见到任何新建标签页，说明平台把这次发布
   * 拒了（重复发布最常见），这时立刻返回失败原因，不必干等 35 秒。
   */
  async function waitOpenOutcome(timeout = 35000) {
    const startedAt = Date.now();
    let dialogGoneAt = 0;
    while (Date.now() - startedAt < timeout) {
      const pending = await readPending();
      if (!pending) return { ok: false, gone: true };
      if (pending.sent) return { ok: true };

      const dialogOpen = Boolean(findConfirmDialog());
      if (!dialogOpen) {
        if (!dialogGoneAt) dialogGoneAt = Date.now();
        const created = Array.isArray(pending.created) ? pending.created.length : 0;
        // 弹窗关了 12 秒、后台也没记录到任何新标签 → 平台没有打开发布页
        if (created === 0 && Date.now() - dialogGoneAt > 12000) return { ok: false, closed: true };
      } else {
        dialogGoneAt = 0;
      }
      await sleep(500);
    }
    return { ok: false, gone: false };
  }

  /**
   * 搜索并定位某个商品，返回 `{ el, fallback }`。
   * 裂变链接只调用一次；旧链上新每条调用一次。
   */
  async function searchSource(id, label) {
    const input = await waitFor(findSearchInput, 15000, 300);
    if (!input) {
      throw new Error('没找到商品列表的搜索框，请确认当前页是「商品管理 → 商品列表」');
    }

    // 上一轮的刷新可能还没结束，先等表格停下来，否则输入会被骨架屏/遮罩吃掉
    await waitFor(() => !listBusy(), 12000, 300);

    report(`${label}搜索商品 ${id}…`);
    // 指纹必须基于「已经有数据」的列表：空列表渲染成有数据不能算"搜索刷新了"
    const baselineReady = await waitFor(() => Boolean(listPrint()), 10000, 300);
    if (!baselineReady) logListStructure();
    const beforePrint = listPrint();
    const beforeCount = resultCount();
    logStep(`搜索前：${listRows().length} 行，计数 ${beforeCount === null ? '未知' : beforeCount}，指纹（前 60 字）：${beforePrint.slice(0, 60) || '（空）'}`);
    const typed = await typeSearchId(input, id);
    if (!typed) throw new Error(`没能把「${id}」写进搜索框，请手动点一下搜索框后再重新开始`);

    // 快速通道：列表本来就只有这一件商品时，搜它不会让表格内容发生任何变化，
    // 「列表已刷新」判据等满 6 秒也等不到（这就是实测里列表只有 1 条时那次失败）。
    // 先按一次回车，再用几秒确认「只剩 1 行 + 精确命中这个 ID」。
    // 注意这不是 0.8.5 那个被删掉的捷径：那条只认"页面上存在这个 ID"，
    // 列表还有 3 件时也会命中；这里要求列表确实只剩这一行，多件列表绝不会走这条。
    pressKey(input, 'Enter', 13);
    let state = await waitFor(() => staticSearchEvidence(id), 4000, 300);
    if (state) logStep(`列表本来就只有这一件商品（${state}），按搜索生效处理`);

    // 否则依次尝试 回车 → 查询按钮 → 再回车+查询 → 搜索图标 → 失焦提交，
    // 直到列表稳定刷新才算搜索成功；绝不假设"已经搜过"
    if (!state) state = await triggerSearch(input, id, beforePrint);
    if (!state) {
      // 动作链跑完表格还是没变，最后再确认一次静态证据（可能是刷新期间短暂空表导致快速通道没赶上）
      const staticReason = staticSearchEvidence(id);
      if (staticReason) {
        state = 'static';
        logStep(`列表内容与搜索前一致，但${staticReason}，按搜索生效处理`);
      }
    }
    logStep(`搜索判定：${state || '未生效'}；当前指纹（前 60 字）：${listPrint().slice(0, 60) || '（空）'}`);
    if (!state) {
      throw new Error(`输入「${id}」后商品列表没有刷新，搜索没有生效（可手动点一次「查询」确认页面正常）`);
    }

    // 硬校验：按商品 ID 搜索后应该只剩 1 件。若列表还是多件，说明查询没有作用在列表上，
    // 此时页面上的那条 ID 只是"本来就在列表里"，继续点发布只会发错或触发平台重复拦截。
    let afterCount = resultCount();
    if (afterCount !== null && afterCount > 1) {
      // 分页计数有时比表格晚一拍更新，给它 4 秒同步
      await waitFor(() => {
        const count = resultCount();
        return count !== null && count <= 1;
      }, 4000, 250);
      afterCount = resultCount();
    }
    logStep(`搜索后：${listRows().length} 行，计数 ${afterCount === null ? '未知' : afterCount}`);
    if (afterCount !== null && afterCount > 1) {
      throw new Error(`输入「${id}」并点了查询，但列表仍有 ${afterCount} 件商品，筛选没有真正生效，已停止（避免对错误的商品点发布）`);
    }

    // 走到这里才能用「共 1 件商品」兜底，因为列表确实换了一批数据；
    // 兜底还要求页面留下「搜过这个 ID」的物证，否则宁可跳过
    let found = await waitFor(() => findUniqueResult(id, { beforePrint, requireEvidence: true, input }), 7000, 400);
    if (!found) {
      // 少数情况下列表短暂闪了一下却没真搜，补一次「查询」再等，避免误判该商品不存在
      const retry = findSearchButton(input);
      if (retry) {
        mouseClick(retry);
        found = await waitFor(() => findUniqueResult(id, { beforePrint, requireEvidence: true, input }), 14000, 400);
      }
    }
    if (found && found.empty) throw new Error(`搜索「${id}」没有结果`);
    if (found && found.untrusted) {
      throw new Error(`搜索后只看到一条结果，但页面上找不到「${id}」的痕迹，无法确认是不是这条商品，已跳过（建议在列表显示「商品ID」列）`);
    }
    if (!found || !found.el) throw new Error(`搜索「${id}」后没在列表里找到该商品，可能还在加载或 ID 有误`);
    return found;
  }

  /**
   * 在已定位的商品行上点「发布相似品」→ 确认 → 等新标签页被接管。
   * 拆出来是给变体模式复用：那里只搜一次源商品，之后每一轮都拿同一行去点。
   */
  async function openSimilarOnRow(found, label) {
    if (found.fallback) report(`${label}页面上没有直接显示该 ID，按「共 1 件商品」的唯一结果继续…`);
    logStep(`结果定位方式：${found.fallback ? '共 1 件商品兜底' : 'ID 精确命中'}`);

    report(`${label}找到商品，点「发布相似品」…`);
    // 优先取该商品行内的按钮，避免命中列表顶部的批量操作栏
    const row = rowContainer(found.el);
    logStep(`命中行文本（前 70 字）：${norm(row.textContent).slice(0, 70)}`);
    const inRow = Array.from(row.querySelectorAll('button, a, span, div, [role="button"]'))
      .filter(element => visible(element) && compact(element.textContent) === '发布相似品');
    let button = inRow.length
      ? inRow[0]
      : (similarButtons().length ? nearestTo(similarButtons(), found.el) : null);
    if (!button) {
      // 有些列表把入口收在「更多」里
      const more = Array.from(row.querySelectorAll('button, [role="button"], span, div, a'))
        .filter(element => visible(element) && /^(更多|更多操作|\.\.\.)$/.test(norm(element.textContent)))
        .filter(element => isClickable(element) || isClickable(element.parentElement))[0];
      if (more) {
        mouseClick(more);
        await sleep(700);
        const options = similarButtons();
        if (options.length) button = nearestTo(options, found.el);
      }
    }
    if (!button) throw new Error('找到了商品，但没找到「发布相似品」按钮（该行可能只有「编辑/更多」）');

    mouseClick(button);
    logStep('已点击「发布相似品」');
    const dialog = await waitFor(findConfirmDialog, 9000, 300);
    if (!dialog) throw new Error('点击「发布相似品」后没有出现确认弹窗');
    logStep(`确认弹窗：${norm(dialog.textContent).slice(0, 60)}；按钮：${
      Array.from(dialog.querySelectorAll('button, [role="button"]')).filter(visible)
        .map(node => `「${norm(node.textContent)}」`).join('') || '无'
    }`);

    // 只有带单选项的弹窗才需要先选第一项；纯文字确认弹窗直接点确认
    if (dialogHasOptions(dialog)) {
      const card = pickCard(dialog, '发布相似品');
      if (card) {
        mouseClick(card);
        await sleep(450);
      }
    }
    // 关键顺序：先登记“即将打开发布页”，让后台在**点确认之前**拍下标签页快照。
    // 若放在点击之后，新标签页已在快照里，会被当成“本来就存在的创建页”而拒绝接管。
    // 登记不上就干脆别点：否则会开出一个没人接管的发布页，整条流程只能干等。
    let registered = false;
    try {
      const ack = await chrome.runtime.sendMessage({
        type: 'SIMILAR_OPENED',
        id: String(id),
        // 发布页要据此决定「填标题 + 换主图」：不能靠 storage 里有没有 variantPending，
        // 否则上一批变体留下的残值会污染下一批普通的发布相似品
        variant: runtime.mode === 'variant'
      });
      registered = Boolean(ack && ack.ok);
    } catch {
      registered = false;
    }
    if (!registered) {
      clickDialogCancel(dialog);
      logStep('登记任务失败，已点掉弹窗、不点确认');
      throw new Error('没能登记本条的发布任务（扩展后台可能刚被重载），请重新点一次「开始」');
    }
    await sleep(120);

    if (!(await clickDialogOk(dialog))) {
      const seen = Array.from(dialog.querySelectorAll('button, [role="button"]'))
        .filter(visible)
        .map(node => norm(node.textContent))
        .filter(Boolean);
      try {
        await chrome.runtime.sendMessage({ type: 'SIMILAR_CANCEL' });
      } catch {
        /* 忽略 */
      }
      throw new Error(`确认弹窗里没找到「确认/确定」按钮（实际按钮：${seen.join('、') || '无'}）`);
    }
    logStep('已点「确认」（直接派发到按钮），等待新标签页被接管…');
    await sleep(400);

    // 点完再看一眼：弹窗还开着、后台也没见到新标签 → 点没被平台接住，补一次（只补一次）
    const stillOpen = findConfirmDialog();
    if (stillOpen) {
      const pendingNow = await readPending();
      const createdNow = pendingNow && Array.isArray(pendingNow.created) ? pendingNow.created.length : 0;
      if (!createdNow) {
        logStep('弹窗仍在且没有新标签，补点一次「确认」');
        await clickDialogOk(stillOpen);
        await sleep(500);
      }
    }
    if (!findConfirmDialog()) logStep('弹窗已关闭');

    // 弹窗关了却没新标签：问后台平台有没有尝试 window.open。
    // 合成的点击没有「用户激活」，平台的 window.open 很可能被浏览器弹窗拦截（返回 null），
    // 于是弹窗照常关闭、新页却一个都没有。被拦时由扩展自己 chrome.tabs.create 补开。
    await sleep(1200);
    const afterClick = await readPending();
    if (!(afterClick && afterClick.sent) && !findConfirmDialog()) {
      try {
        const grab = await chrome.runtime.sendMessage({ type: 'SIMILAR_GRAB_URL' });
        if (grab && grab.opened) {
          logStep(`平台的新页被浏览器拦下，已由扩展打开：${grab.url}`);
        } else if (grab && grab.succeeded) {
          logStep('平台已自行打开新页，等待接管…');
        } else if (grab) {
          logStep(`平台没有尝试打开新页（捕获 window.open ${grab.captured} 次），确认点击可能没被平台接住`);
        }
      } catch {
        /* 扩展被重载时忽略 */
      }
    }

    // 点了确认 ≠ 发布页开了：等后台真正接管新标签页，再往上报“已打开发布页”
    const outcome = await waitOpenOutcome(25000);
    const toast = findFailureToast();
    logStep(`接管结果：${outcome.ok ? '已接管' : outcome.gone ? '登记被撤销/没开新标签' : outcome.closed ? '弹窗已关闭且没有新标签页' : '35 秒内无新标签页'}${toast ? `；平台提示：${toast}` : ''}`);
    if (!outcome.ok) {
      if (!outcome.gone) {
        try {
          await chrome.runtime.sendMessage({ type: 'SIMILAR_CANCEL' });
        } catch {
          /* 忽略 */
        }
      }
      const hint = /重复|已发布|已存在|已生成|不可/.test(toast)
        ? `平台提示「${toast}」`
        : '平台没有打开发布页（确认点击可能没被接住，或该商品当前状态不允许发布）';
      throw new Error(`点了确认但没开新标签页：${hint}，本条跳过`);
    }
    report(`${label}已打开发布页，自动发布中…`);
    return { opened: true };
  }

  /** 旧链上新的单条流程：搜一次 → 点开 → 等接管 */
  async function searchAndOpenSimilar(id, index, total) {
    const label = `第 ${index + 1}/${total} 条：`;
    const found = await searchSource(id, label);
    return openSimilarOnRow(found, label);
  }

  /* ---------------- 发布页：填标题 / 换主图（变体模式） ---------------- */

  /**
   * 读列表页写下的「这一条用哪个标题、哪张图」。
   * 队列在列表页，发布页是另一个标签页，只能靠 storage 交接。
   */
  function readVariantPending() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(['variantPending'], data => {
          resolve(data && data.variantPending ? data.variantPending : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  const SHORT_TITLE_LIMIT = 24;
  const SHORT_TITLE_LIMIT_MIXED = 23;
  const MIXED_TITLE_RE = /[0-9０-９A-Za-zＡ-Ｚａ-ｚ]/;

  /** 按用户看到的字符数算（emoji 算一个，不按 UTF-16 拆半） */
  function charLength(value) {
    return Array.from(String(value ?? '')).length;
  }

  /**
   * 商品标题 → 导购短标题：前 24 个字符；标题里含英文或数字时只取前 23 个。
   * app/shared/titles.js 有一份同样的实现，tests/check-variants.js 会比对两边结果。
   */
  function shortTitleOf(title) {
    const chars = Array.from(String(title ?? '').trim());
    if (!chars.length) return '';
    const limit = MIXED_TITLE_RE.test(chars.join('')) ? SHORT_TITLE_LIMIT_MIXED : SHORT_TITLE_LIMIT;
    const cut = chars.slice(0, limit).join('');
    const trimmed = cut.replace(/[\s,，、;；:：!！?？.。/／|｜·]+$/, '').trim();
    return trimmed || cut.trim();
  }

  /**
   * 发布页上的两个标题框：商品标题（完整）与导购短标题（24 字）。
   * 认法：placeholder/aria-label 的文案 → 输入框所在行上的标签文字 → maxlength 大小兜底。
   *
   * 行标签只认「最近一层含『标题』字样、且长度不超过 120」的容器：
   * 再往上就是整个基础信息表单，里面同时有「商品标题」和「导购短标题」两个词，
   * 拿它判断会把两个框认成同一个。
   */
  function titleFields() {
    const fields = allVisible('input, textarea')
      .filter(element => !element.disabled && !element.readOnly)
      .filter(element => {
        const type = String(element.type || '').toLowerCase();
        return element.tagName === 'TEXTAREA' || type === '' || type === 'text';
      });

    const hints = element => `${element.placeholder || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('name') || ''}`;
    /**
     * 找输入框所在行的标签文字。
     * exclude 用来挡「外层容器同时包住两个标题框」的情况：那一层两个词都有，
     * 拿它判断会把商品标题框认成短标题框（反之亦然）。挡掉后交给 maxlength 兜底。
     */
    const nearLabel = (element, pattern, exclude) => {
      let node = element.parentElement;
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        const text = norm(node.textContent || '');
        if (!text || text.length > 120) continue;
        if (!/标题/.test(text)) continue;
        if (exclude && exclude.test(text)) return false;
        return pattern.test(text);
      }
      return false;
    };
    const topMost = list => list
      .slice()
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0] || null;

    // 先认短标题：它的名字更独特，认错方向再反过来排除不容易串
    const short = fields.find(element => /导购短标题|短标题/.test(hints(element)))
      || fields.find(element => nearLabel(element, /导购短标题/, /商品标题/))
      || fields.find(element => nearLabel(element, /短标题/, /商品标题/))
      || null;

    const rest = fields.filter(element => element !== short);
    let product = rest.find(element => /商品标题/.test(hints(element)))
      || rest.find(element => nearLabel(element, /商品标题/, /短标题/))
      || null;

    if (!product) {
      // 兜底：整页最靠上的长文本框（商品标题上限 60，短标题只有 24）
      const long = rest.filter(element => Number(element.maxLength) > SHORT_TITLE_LIMIT);
      const typical = long.filter(element => {
        const max = Number(element.maxLength);
        return max >= 40 && max <= 80;
      });
      product = topMost(typical.length ? typical : (long.length ? long : rest));
    }

    let shortField = short;
    if (!shortField && product) {
      // 短标题框没认出来时，先找 maxlength 正好 24 的，再放宽到 40 以内；
      // 认不出就跳过（不阻断整条）
      const pool = fields.filter(element => element !== product);
      const exact = pool.filter(element => Number(element.maxLength) === SHORT_TITLE_LIMIT);
      shortField = topMost(exact.length ? exact : pool.filter(element => {
        const max = Number(element.maxLength);
        return max > 0 && max <= 40;
      }));
    }

    // 最后交叉校验一次：商品标题的上限一定比短标题大
    if (product && shortField) {
      const a = Number(product.maxLength);
      const b = Number(shortField.maxLength);
      if (a > 0 && b > 0 && a < b) {
        const swap = product;
        product = shortField;
        shortField = swap;
      }
    }

    return { product, short: shortField };
  }

  /** 往一个标题框写值：受控组件吞掉赋值时改走插入文本，写完必须核对 */
  async function writeTitleField(field, value, label, options = {}) {
    let target = String(value ?? '');
    const max = Number(field.maxLength);
    if (max > 0 && charLength(target) > max) {
      if (!options.clip) {
        throw new Error(`${label} ${charLength(target)} 字，超过输入框上限 ${max} 字，已停止这一条`);
      }
      target = Array.from(target).slice(0, max).join('');
    }

    field.focus();
    if (typeof field.select === 'function') field.select();
    setNativeValue(field, target);
    await sleep(200);

    let actual = String(field.value || '').trim();
    if (actual !== target) {
      // 受控组件偶尔吞掉一次性赋值，改走「插入文本」路径
      try {
        if (typeof field.select === 'function') field.select();
        document.execCommand('insertText', false, target);
      } catch {
        /* 忽略 */
      }
      await sleep(250);
      actual = String(field.value || '').trim();
    }

    if (actual !== target) {
      // 平台按自己的宽度规则截断时，实际值会是目标值的前缀（短标题常见），
      // 这种情况不算失败，按平台收下的值继续
      if (options.lenient && actual && target.startsWith(actual)) {
        logStep(`${label}被平台截到 ${charLength(actual)} 字，按实际值继续`);
        return actual;
      }
      throw new Error(`${label}没写进去：期望 ${charLength(target)} 字，实际 ${charLength(actual)} 字`);
    }
    return actual;
  }

  async function fillPublishTitle(title) {
    const value = String(title || '').trim();
    if (!value) throw new Error('这一条没有标题');

    const fields = await waitFor(() => {
      const found = titleFields();
      return found && found.product ? found : null;
    }, 30000, 500);
    if (!fields || !fields.product) throw new Error('发布页没找到「商品标题」输入框');

    const actual = await writeTitleField(fields.product, value, '商品标题');
    logStep(`商品标题已填入（${charLength(actual)} 字）`);

    const shortValue = shortTitleOf(value);
    // 短标题框偶尔比商品标题晚半拍渲染，给它一点时间再判定「这一页没有」
    const shortField = fields.short || await waitFor(() => titleFields().short, 1500, 250);
    // 万一两个名字都指向同一个框，宁可少填也不能把短标题盖到商品标题上
    if (!shortField || shortField === fields.product) {
      logStep('这一页没找到独立的「导购短标题」输入框，跳过');
      return actual;
    }
    if (!shortValue) return actual;
    // 短标题是派生值，平台若只允许 23 字就直接截，不算失败
    const shortActual = await writeTitleField(shortField, shortValue, '导购短标题', { clip: true, lenient: true });
    logStep(`导购短标题已填入（${charLength(shortActual)} 字）：${shortActual}`);
    return actual;
  }

  /** 主图区块：从「*主图」标题往上找，直到包含「导入抖店图库 / 上传图片」的容器 */
  function mainImageArea() {
    const heads = allVisible('div, span, label, h3, h4, p')
      .filter(element => /^[*＊]?\s*主图$/.test(norm(element.textContent)))
      .filter(element => element.getBoundingClientRect().height <= 44);
    for (const head of heads) {
      let node = head.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (/导入抖店图库|上传图片|从主图填入/.test(node.textContent || '')) return node;
      }
    }
    return null;
  }

  /** 主图区里的图片，按「先上后左」排序，第一张就是主图第一张 */
  function mainImageList() {
    const area = mainImageArea();
    if (!area) return [];
    return Array.from(area.querySelectorAll('img'))
      .filter(visible)
      .filter(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 56 || rect.height < 56) return false;
        const src = String(element.currentSrc || element.src || '');
        return /ecombdimg|ecom-shop-material|\.(jpe?g|png|webp)/i.test(src);
      })
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        if (Math.abs(a.top - b.top) > 14) return a.top - b.top;
        return a.left - b.left;
      });
  }

  /** 对图片及其三层祖先都派发 hover：浮层可能绑在父级容器上，位置不固定 */
  function hoverAround(image) {
    let node = image;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      hoverElement(node);
    }
  }

  /** hover 的目标：含「编辑 / 删除」的图容器；找不到就退回 img 的父级 */
  function firstMainImageBox(image) {
    let node = image;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 60 && rect.height >= 60 && /编辑|删除/.test(node.textContent || '')) return node;
    }
    return (image && image.parentElement) || image;
  }

  /**
   * 合成 hover：四个入口（智能创作/好图复刻/本地替换/图库替换）是 hover 才渲染的。
   * mouseenter 不冒泡，必须直接派发到目标元素；React 的 onMouseEnter 实际监听 mouseover。
   */
  function hoverElement(element) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
      try {
        element.dispatchEvent(new MouseEvent(type, init));
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 悬停菜单里的「图库替换」，取最内层那个（外层容器文本可能也含这四个字） */
  function findLibraryReplace() {
    return allVisible('button, [role="button"], div, span, a')
      .filter(element => compact(element.textContent) === '图库替换')
      .sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length)[0] || null;
  }

  function findLibrarySearch(root = document) {
    return Array.from(root.querySelectorAll('input'))
      .filter(visible)
      .find(element => /查询图片名称|图片名称|图片名/.test(
        `${element.placeholder || ''} ${element.getAttribute('aria-label') || ''}`
      )) || null;
  }

  /** 素材库弹层：从「查询图片名称」的输入框往上找 modal/dialog 容器 */
  function findLibraryDialog() {
    const input = findLibrarySearch();
    if (!input) return null;
    let node = input;
    for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      const cls = String(node.className || '');
      const rect = node.getBoundingClientRect();
      if (/modal|dialog|drawer|popup/i.test(cls) && rect.width > 300 && rect.height > 200) return node;
    }
    return document.body;
  }

  /** 素材网格里的卡片 */
  function libraryCards(dialog) {
    if (!dialog) return [];
    let best = null;
    for (const grid of Array.from(dialog.querySelectorAll('[class*="grid" i]'))) {
      const count = Array.from(grid.children)
        .filter(child => child.querySelector && child.querySelector('img')).length;
      if (count && (!best || count > best.count)) best = { grid, count };
    }
    if (best) {
      return Array.from(best.grid.children).filter(child => child.querySelector && child.querySelector('img'));
    }
    // 没有 grid 容器时，退回「文件名元素的祖父级」
    const names = Array.from(dialog.querySelectorAll('[class*="fileName" i]'));
    if (!names.length) return [];
    const parent = names[0].parentElement && names[0].parentElement.parentElement;
    return parent ? Array.from(parent.children).filter(child => child.querySelector && child.querySelector('img')) : [];
  }

  function cardName(card) {
    if (!card) return '';
    const node = card.querySelector('[class*="fileName" i]') || card.querySelector('[class*="name" i]');
    return norm(node ? node.textContent : '');
  }

  function stripExtName(name) {
    return String(name || '').replace(/\.(jpe?g|png|webp|gif|bmp)$/i, '');
  }

  /** 卡片名与目标名是否算同一张：抠出文件名后**全等**比较（不用包含，避免 1.jpg 命中 11.jpg） */
  function nameMatches(cardText, imageName) {
    const text = norm(cardText).toLowerCase();
    const full = norm(imageName).toLowerCase();
    const body = norm(stripExtName(imageName)).toLowerCase();
    if (!text || !full) return false;

    // 卡片文本里常夹着尺寸（「1.jpg」旁边还有 800*800），先抠出文件名再逐字比较。
    // 不用「包含」：搜 1.jpg 时 11.jpg 也包含它，会选错图。
    const candidates = [text];
    const found = text.match(/[^\s/\\]+\.(?:jpe?g|png|webp|gif|bmp)/i);
    if (found) candidates.push(found[0]);

    return candidates.some(value =>
      value === full || value === body || stripExtName(value) === body);
  }

  /** 选中一张素材：先点卡片（用户也是这么点的），没勾上再补点 checkbox */
  function selectLibraryCard(card) {
    const box = card.querySelector('input[type="checkbox"]');
    if (box && box.checked) return true;
    try {
      mouseClick(card);
    } catch {
      /* 忽略 */
    }
    if (box && !box.checked) {
      try {
        mouseClick(box);
      } catch {
        try {
          box.click();
        } catch {
          /* 忽略 */
        }
      }
    }
    return box ? Boolean(box.checked) : null;
  }

  function findLibraryConfirm(dialog) {
    return Array.from(dialog.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .filter(element => /^(确定|确认|使用|选好了|完成|添加)$/.test(norm(element.textContent)))
      .sort((left, right) => right.getBoundingClientRect().top - left.getBoundingClientRect().top)[0] || null;
  }

  /**
   * 用「图库替换」把主图第一张换成素材库里指定文件名的图。
   * 只换第一张：悬停菜单挂在第一张图上，选完素材库点确定，平台自己替换那一格。
   */
  async function replaceMainImageViaLibrary(imageName) {
    // 发布页刚打开时主图区可能还没渲染完，等第一张出现再动手（只填模式没有后续的发布等待兜底）
    const before = await waitFor(() => mainImageList()[0], 20000, 500);
    if (!before) {
      throw new Error('发布页没找到主图第一张（没认出主图区块，或图片还没加载完）');
    }
    const beforeSrc = String(before.currentSrc || before.src || '');

    hoverAround(before);
    let button = await waitFor(findLibraryReplace, 4000, 250);
    if (!button) {
      // 淡入动画期间按钮可能还没挂上，等一拍再 hover 一次
      await sleep(400);
      hoverAround(before);
      button = await waitFor(findLibraryReplace, 5000, 250);
    }
    if (!button) {
      const seen = allVisible('button, [role="button"], div, span')
        .filter(element => /替换|图库|复刻/.test(norm(element.textContent)))
        .map(element => norm(element.textContent).slice(0, 10))
        .slice(0, 8);
      throw new Error(`主图悬停菜单里没找到「图库替换」（看到：${seen.join('、') || '无'}）`);
    }
    mouseClick(button);
    logStep('已点击「图库替换」');

    const dialog = await waitFor(findLibraryDialog, 15000, 400);
    if (!dialog) throw new Error('点击「图库替换」后没有出现素材库弹窗');
    const input = findLibrarySearch(dialog);
    if (!input) throw new Error('素材库弹窗里没有「查询图片名称」搜索框');

    logStep(`素材库已打开，搜索「${imageName}」`);
    input.focus();
    setNativeValue(input, imageName);
    pressKey(input, 'Enter', 13);

    const findFirstMatch = () => {
      const list = libraryCards(dialog);
      if (!list.length) return null;
      const first = list[0];
      return nameMatches(cardName(first), imageName) ? first : null;
    };

    let target = await waitFor(findFirstMatch, 12000, 400);
    if (!target) {
      // 有的素材库不认回车，只认旁边的「查询」按钮
      const query = Array.from(dialog.querySelectorAll('button, [role="button"], span, div'))
        .filter(visible)
        .filter(element => /^(查询|搜索)$/.test(norm(element.textContent)))[0];
      if (query) {
        logStep('素材库没有响应回车，补点一次「查询」');
        mouseClick(query);
        target = await waitFor(findFirstMatch, 8000, 400);
      }
    }

    if (!target) {
      const seen = libraryCards(dialog).slice(0, 3).map(card => cardName(card)).filter(Boolean);
      try {
        const cancel = Array.from(dialog.querySelectorAll('button, [role="button"]'))
          .filter(visible)
          .filter(element => /^(取消|关闭)$/.test(norm(element.textContent)))[0];
        if (cancel) mouseClick(cancel);
      } catch {
        /* 忽略 */
      }
      throw new Error(seen.length
        ? `素材库里没搜到「${imageName}」（当前前三个：${seen.join('、')}），请确认左侧已选中目标文件夹`
        : `素材库里没搜到「${imageName}」，请确认左侧已选中目标文件夹`);
    }

    const checked = selectLibraryCard(target);
    await sleep(350);
    logStep(`已选中「${cardName(target) || imageName}」，勾选：${checked === null ? '无法判定' : (checked ? '已勾选' : '未勾选')}`);

    const confirm = findLibraryConfirm(dialog);
    if (!confirm) throw new Error('素材库弹窗里没找到「确定」按钮');
    mouseClick(confirm);
    logStep('已点「确定」，等待主图更新…');

    await waitFor(() => !findLibrarySearch(), 10000, 300);

    const after = await waitFor(() => {
      const image = mainImageList()[0];
      if (!image) return null;
      const src = String(image.currentSrc || image.src || '');
      return src && src !== beforeSrc ? image : null;
    }, 15000, 400);

    if (!after) throw new Error('点了「确定」但主图第一张没有更新（可能没选中素材，或平台要求先裁剪）');
    logStep('主图第一张已更新');
  }

  /** 裂变链接在发布页的前置动作；不在变体任务里时直接返回 null */
  async function applyVariant() {
    const pending = await readVariantPending();
    if (!pending || !pending.title) {
      throw new Error('这一条的标题没读到（列表页没写进 storage），已停止，避免发出没改标题的商品');
    }
    const no = Number(pending.index) + 1;
    report(`第 ${no} 条：填写标题…`);
    await fillPublishTitle(pending.title);
    report(`第 ${no} 条：替换主图「${pending.image}」…`);
    await replaceMainImageViaLibrary(pending.image);
    return pending;
  }

  /* ---------------- 发布页：点击发布并等待成功 ---------------- */

  function findPublishButton() {
    const buttons = allVisible('button, [role="button"]').filter(element => {
      const text = norm(element.textContent);
      if (!text) return false;
      if (text === '发布商品') return true;
      return text.length <= 8 && text.startsWith('发布商品') && !text.includes('视频');
    });
    return buttons.sort((left, right) => right.getBoundingClientRect().top - left.getBoundingClientRect().top)[0] || null;
  }

  function findPublishConfirmDialog() {
    const nodes = allVisible('[role="dialog"], [class*="modal" i], [class*="confirm" i]')
      .filter(element => /发布|提交/.test(element.textContent || '') && /确定|确认/.test(element.textContent || ''));
    return nodes.sort((left, right) => norm(left.textContent).length - norm(right.textContent).length)[0] || null;
  }

  function findFailureToast() {
    const nodes = allVisible('[class*="toast" i], [class*="message" i], [class*="notification" i], [class*="alert" i]')
      .filter(element => {
        const text = norm(element.textContent);
        if (!text || text.length > 90) return false;
        return /(失败|错误|异常|不能为空|请填写|请选择|请完善|必填|未通过)/.test(text);
      });
    return nodes.length ? norm(nodes[0].textContent) : '';
  }

  /** 看起来像「错误/校验」文案的句子 */
  const ISSUE_PATTERN = /(失败|错误|异常|不能为空|请填写|请选择|请完善|必填|未通过|不支持|超出|超限|违规|重复|已存在|无效|非法|请上传|必选)/;

  /**
   * 收集页面上的错误/校验提示（浮层 + 表单内联），去重后最多 6 条。
   * 失败时把这几条带回面板，批量跑完能直接看出是哪类问题，不用一个个点开标签页找。
   */
  function collectIssues() {
    const found = [];
    const push = text => {
      const value = norm(text);
      if (!value || value.length < 2 || value.length > 120) return;
      if (!ISSUE_PATTERN.test(value)) return;
      if (!found.includes(value)) found.push(value);
    };

    allVisible('[class*="toast" i], [class*="message" i], [class*="notification" i], [class*="alert" i], [role="alert"]')
      .forEach(element => push(element.textContent));

    allVisible('[class*="error" i], [class*="invalid" i], [class*="warning" i], [class*="danger" i]')
      .filter(element => element.childElementCount <= 3)
      .forEach(element => push(element.textContent));

    return found.slice(0, 6).map(text => text.slice(0, 80));
  }

  /** 只保留「这次新出现」的提示：点击前就存在的校验文案不能算本次失败 */
  function diffIssues(before, after) {
    const remain = new Map();
    for (const item of before) remain.set(item, (remain.get(item) || 0) + 1);
    const fresh = [];
    for (const item of after) {
      const left = remain.get(item) || 0;
      if (left > 0) remain.set(item, left - 1);
      else fresh.push(item);
    }
    return fresh;
  }

  async function publishNow() {
    report('发布页：等待页面加载完成…');
    const button = await waitFor(findPublishButton, 90000, 500);
    if (!button) throw new Error('发布页没有出现「发布商品」按钮，请确认新标签页已正常加载');

    // 等按钮从禁用/加载态恢复
    await waitFor(() => {
      if (!button.isConnected) return 'gone';
      return button.disabled ? null : 'ready';
    }, 25000, 400);
    if (!button.isConnected) throw new Error('「发布商品」按钮在加载过程中消失了');

    // 「发布商品」按钮出现不代表商品信息已加载完，等关键区块渲染后再点，避免提交空数据
    await waitFor(() => /商品信息质量|商品标题|基础信息|价格库存/.test(document.body.innerText || ''), 30000, 500);
    await sleep(1500);

    report('发布页：点击「发布商品」…');
    // 点击前先记下页面上已有的提示，之后只认「新出现」的那些，避免把原有的提醒当成失败原因
    const baseline = collectIssues();
    mouseClick(button);
    await sleep(1400);

    const confirm = findPublishConfirmDialog();
    if (confirm) {
      await clickDialogOk(confirm);
      await sleep(1200);
    }

    const clickedAt = Date.now();
    const outcome = await waitFor(() => {
      const text = document.body.innerText || '';
      if (/商品提交成功|提交成功|继续发布商品视频/.test(text)) return { ok: true };
      // 新冒出来的校验提示：立刻判失败，不必等满 45 秒
      const fresh = diffIssues(baseline, collectIssues());
      if (fresh.length) return { ok: false, reason: fresh[0], issues: fresh };
      // 兜底：有些提示文案和点击前重叠，45 秒内出现浮层提示也判失败
      if (Date.now() - clickedAt < 45000) {
        const failure = findFailureToast();
        if (failure) return { ok: false, reason: failure, issues: [failure] };
      }
      return null;
    }, 180000, 800);

    if (!outcome) {
      const error = new Error('点击发布后 3 分钟内没有出现「商品提交成功」');
      error.issues = collectIssues().slice(0, 3);
      throw error;
    }
    if (!outcome.ok) {
      const issues = Array.isArray(outcome.issues) && outcome.issues.length ? outcome.issues : [outcome.reason || '发布失败'];
      const error = new Error(`发布失败：${issues[0]}`);
      error.issues = issues;
      throw error;
    }

    report('发布页：提交成功，关闭标签页');
    try {
      chrome.runtime.sendMessage({ type: 'SIMILAR_PUBLISH_DONE', ok: true });
    } catch {
      /* 忽略 */
    }
    setTimeout(() => {
      try {
        window.close();
      } catch {
        /* 浏览器可能不允许脚本关闭，后台会兜底关闭 */
      }
    }, 600);
    return { ok: true };
  }

  /* ---------------- 结构自检 ---------------- */

  function describeBox(element) {
    const rect = element.getBoundingClientRect();
    return `[${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}]`;
  }

  function diagnose() {
    const lines = [];
    lines.push(`页面：${location.href}`);

    const inputs = allVisible('input')
      .filter(element => !element.disabled && ['text', 'search'].includes(String(element.type || 'text').toLowerCase()))
      .slice(0, 8);
    lines.push(`可见文本框 ${inputs.length} 个：`);
    inputs.forEach((element, index) => {
      lines.push(`  ${index + 1}. placeholder=「${element.getAttribute('placeholder') || ''}」 ${describeBox(element)}`);
    });

    const picked = findSearchInput();
    lines.push(picked ? `认领的搜索框：${describeInput(picked)}` : '认领的搜索框：没找到');

    const searchButton = findSearchButton(picked);
    lines.push(`认领的查询按钮：${searchButton ? `「${norm(searchButton.textContent)}」${describeBox(searchButton)}` : '没找到'}`);

    const buttons = similarButtons();
    lines.push(`「发布相似品」候选 ${buttons.length} 个：`);
    buttons.slice(0, 6).forEach((element, index) => {
      lines.push(`  ${index + 1}. <${element.tagName.toLowerCase()}> class=${String(element.className || '').slice(0, 50)} ${describeBox(element)}`);
    });

    const rows = listRows();
    lines.push(`表格行 ${rows.length} 行${rows[0] ? `，首行：${norm(rows[0].textContent).slice(0, 80)}` : ''}`);
    lines.push(`列表指纹：${listPrint().slice(0, 100) || '（空）'}`);
    lines.push(`加载中：${listBusy() ? '是' : '否'}`);

    const dialog = findConfirmDialog();
    if (dialog) {
      const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]'))
        .filter(visible)
        .map(node => `「${norm(node.textContent)}」${String(node.className || '').slice(0, 30)}`);
      lines.push(`确认弹窗：${norm(dialog.textContent).slice(0, 60)}`);
      lines.push(`  单选项：${dialogHasOptions(dialog) ? '有' : '无'}`);
      lines.push(`  按钮：${buttons.join(' ') || '无'}`);
    } else {
      lines.push('确认弹窗：当前没有');
    }

    const publishButton = findPublishButton();
    lines.push(`「发布商品」按钮：${publishButton ? describeBox(publishButton) : '当前页没有'}`);

    return lines.join('\n');
  }

  /* ---------------- 队列（列表页驱动） ---------------- */

  // runId 用来让侧边栏把多次「发布相似品」区分成不同任务记录，不参与执行逻辑
  const runtime = {
    running: false,
    // 'ids' = 每个 ID 各搜一次（旧链上新）；'variant' = 同一个 ID 连点多次（裂变链接）
    mode: 'ids',
    ids: [],
    variants: [],
    index: 0,
    results: [],
    // 裂变链接的开关：false = 只填标题、换主图，不点发布（测试阶段用）
    publish: true,
    pendingSignal: null,
    earlySignal: null,
    runId: 0,
    error: ''
  };

  function waitSignal() {
    if (runtime.earlySignal) {
      const payload = runtime.earlySignal;
      runtime.earlySignal = null;
      return Promise.resolve(payload);
    }
    return new Promise(resolve => {
      const finish = payload => {
        if (runtime.pendingSignal !== finish) return;
        runtime.pendingSignal = null;
        clearTimeout(timer);
        resolve(payload);
      };
      const timer = setTimeout(() => finish({ timeout: true }), WAIT_SIGNAL_MS);
      runtime.pendingSignal = finish;
    });
  }

  function persist() {
    try {
      if (runtime.mode === 'variant') {
        chrome.storage.local.set({
          variantRun: {
            running: runtime.running,
            runId: runtime.runId,
            sourceId: runtime.ids[0] || '',
            // false = 只填标题与主图，不点发布（测试阶段）
            publish: runtime.publish !== false,
            items: runtime.variants,
            index: runtime.index,
            results: runtime.results,
            error: runtime.error || '',
            at: Date.now()
          }
        });
        return;
      }
      chrome.storage.local.set({
        similarRun: {
          running: runtime.running,
          ids: runtime.ids,
          index: runtime.index,
          results: runtime.results,
          runId: runtime.runId,
          at: Date.now()
        }
      });
    } catch {
      /* 忽略 */
    }
  }

  /* ---------------- 变体队列：搜一次源商品，连点 N 次 ---------------- */

  /** 把「这一条用哪个标题、哪张图」写到 storage，发布页接管后读它 */
  function writeVariantPending(index) {
    const item = runtime.variants[index] || {};
    return new Promise(resolve => {
      try {
        chrome.storage.local.set({
          variantPending: {
            runId: runtime.runId,
            index,
            title: item.title || '',
            image: item.image || '',
            // 测试阶段只填不发：发布页据此决定填完就回报，而不是点「发布商品」
            publish: runtime.publish !== false,
            at: Date.now()
          }
        }, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  async function runVariants(sourceId, items, options = {}) {
    if (runtime.running) return { ok: false, error: '已经在运行中' };

    runtime.mode = 'variant';
    runtime.running = true;
    runtime.publish = options.publish !== false;
    runtime.ids = [String(sourceId)];
    runtime.variants = (Array.isArray(items) ? items : [])
      .map((item, index) => ({
        no: Number(item && item.no) || index + 1,
        title: String(item && item.title || '').trim(),
        image: String(item && item.image || '').trim()
      }))
      .filter(item => item.title);
    runtime.results = [];
    runtime.index = 0;
    runtime.earlySignal = null;
    runtime.error = '';
    runtime.runId = Date.now();

    const total = runtime.variants.length;
    if (!total) {
      runtime.running = false;
      return { ok: false, error: '没有可执行的变体（标题全为空）' };
    }

    previousIds = [];
    persist();
    try {
      chrome.runtime.sendMessage({ type: 'SIMILAR_REGISTER_LIST' });
    } catch {
      /* 忽略 */
    }

    let consecutiveFailures = 0;
    let row = null;

    try {
      report(`变体：搜索源商品 ${sourceId}（整批只搜这一次）…`);
      row = await searchSource(String(sourceId), '源商品：');
      logStep('源商品已定位，开始逐条复制');

      for (let index = 0; index < total; index++) {
        if (!runtime.running) break;
        runtime.index = index;
        runtime.earlySignal = null;
        // 变体是同一个 ID 反复出现，任何「排除上一条」的逻辑都会把它排掉
        previousIds = [];
        persist();

        const item = runtime.variants[index];
        const fail = (reason, issues) => {
          runtime.results.push({
            no: item.no,
            title: item.title,
            image: item.image,
            ok: false,
            reason: reason || '',
            issues: issues || [],
            at: Date.now()
          });
          persist();
        };

        // 上一条发布后列表会刷新，旧引用随时脱离文档
        if (!row || !row.el || !row.el.isConnected) {
          row = await waitFor(() => findUniqueResult(String(sourceId), { allowFallback: true }), 15000, 500);
        }
        if (!row || !row.el) {
          // 列表被刷新或翻页后旧引用会失效，这里补搜一次，而不是直接判失败。
          // 正常流程里整批只搜一次，走不到这里。
          try {
            logStep('源商品那一行已不在页面上，重新搜索一次');
            row = await searchSource(String(sourceId), `第 ${index + 1}/${total} 条：`);
          } catch (error) {
            const reason = `列表里找不到源商品那一行了（${error.message}）`;
            fail(reason);
            report(`第 ${index + 1}/${total} 条：${reason}`, { index, total });
            consecutiveFailures += 1;
            if (consecutiveFailures >= 3) {
              runtime.error = reason;
              break;
            }
            await sleep(1200);
            continue;
          }
        }

        await writeVariantPending(index);

        try {
          await openSimilarOnRow(row, `第 ${index + 1}/${total} 条：`);
        } catch (error) {
          fail(error.message);
          report(`第 ${index + 1}/${total} 条：${error.message}，跳过`, { index, total });
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            runtime.error = `连续 ${consecutiveFailures} 条失败：${error.message}`;
            break;
          }
          await sleep(1200);
          continue;
        }

        report(
          `第 ${index + 1}/${total} 条：等待发布页${runtime.publish ? '填标题、换主图并提交' : '填标题、换主图'}…`,
          { index, total }
        );
        const signal = await waitSignal();
        if (signal.stopped) break;
        if (signal.timeout) {
          fail('等待发布页超时（发布页可能卡在加载或替换主图）');
          report(`第 ${index + 1}/${total} 条：等待发布页超时，跳过`, { index, total });
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            runtime.error = '连续 3 条等待发布页超时';
            break;
          }
          continue;
        }

        if (signal.ok) {
          runtime.results.push({
            no: item.no,
            title: item.title,
            image: item.image,
            ok: true,
            // 只填模式下页面没有提交，结果里如实标注，复制出去能一眼区分
            filled: Boolean(signal.filled) || !runtime.publish,
            reason: '',
            issues: [],
            at: Date.now()
          });
          consecutiveFailures = 0;
          persist();
          report(
            `第 ${index + 1}/${total} 条：${runtime.publish ? '已发布' : '已填好（未发布）'}`,
            { index, total }
          );
          await sleep(1500);
          continue;
        }

        fail(signal.reason, signal.issues);
        consecutiveFailures += 1;
        report(`第 ${index + 1}/${total} 条失败：${signal.reason || '原因未知'}`, { index, total });
        if (consecutiveFailures >= 3) {
          runtime.error = `连续 ${consecutiveFailures} 条失败：${signal.reason || '原因未知'}`;
          break;
        }
        await sleep(1200);
      }
    } catch (error) {
      // 搜源商品就失败：整批一条都跑不了，单独记错误，不伪造逐条结果
      runtime.error = error.message;
      logStep(`整批中止：${error.message}`);
    }

    runtime.running = false;
    const success = runtime.results.filter(item => item.ok).length;
    report(
      `${runtime.publish ? '已结束' : '填写已结束'}：成功 ${success} / 共 ${total} 条`
        + (runtime.results.length > success ? `，失败 ${runtime.results.length - success}` : '')
        + (runtime.error ? `（${runtime.error}）` : '')
        + (runtime.publish ? '' : '。本版未点发布，页面已保留，核对后手动关闭。'),
      { done: true, ok: success, total }
    );
    persist();
    return { ok: true };
  }

  async function runQueue(ids) {
    if (runtime.running) return { ok: false, error: '已经在运行中' };
    runtime.mode = 'ids';
    runtime.variants = [];
    runtime.error = '';
    runtime.running = true;
    runtime.ids = ids.slice();
    runtime.results = [];
    runtime.index = 0;
    runtime.earlySignal = null;
    runtime.runId = Date.now();
    persist();
    try {
      chrome.runtime.sendMessage({ type: 'SIMILAR_REGISTER_LIST' });
    } catch {
      /* 忽略 */
    }

    let consecutiveFailures = 0;
    for (let index = 0; index < runtime.ids.length; index++) {
      if (!runtime.running) break;
      const id = runtime.ids[index];
      runtime.index = index;
      // 每条新记录开始前清掉上一轮可能残留的信号，避免"提前收到结果"导致串位
      runtime.earlySignal = null;
      // 让兜底逻辑知道前面几条是什么，防止命中上一条的结果行
      previousIds = runtime.ids.slice(0, index);
      persist();

      try {
        await searchAndOpenSimilar(id, index, runtime.ids.length);
      } catch (error) {
        runtime.results.push({ id, ok: false, reason: error.message, issues: [], at: Date.now() });
        persist();
        report(`第 ${index + 1}/${runtime.ids.length} 条：${error.message}，跳过`, { index, total: runtime.ids.length });
        await sleep(1200);
        continue;
      }

      report(`第 ${index + 1}/${runtime.ids.length} 条：等待发布页提交结果…`);
      const signal = await waitSignal();
      if (signal.stopped) break;
      if (signal.timeout) {
        runtime.results.push({ id, ok: false, reason: '等待发布页超时', issues: [], at: Date.now() });
        persist();
        report(`第 ${index + 1}/${runtime.ids.length} 条：等待发布页超时，跳过`);
        continue;
      }

      runtime.results.push({ id, ok: Boolean(signal.ok), reason: signal.reason || '', issues: signal.issues || [], at: Date.now() });
      persist();
      if (!signal.ok) {
        consecutiveFailures += 1;
        // 失败继续跑，最后汇总原因；但连续失败多半是共性问题（页面改版/账号状态），
        // 再跑下去只是白等，连续 3 条就停下并说明原因
        if (consecutiveFailures >= 3) {
          runtime.running = false;
          report(`连续 ${consecutiveFailures} 条发布失败（${signal.reason || '原因未知'}），已停止`, {
            index, total: runtime.ids.length, stopped: true
          });
          persist();
          break;
        }
        report(`第 ${index + 1}/${runtime.ids.length} 条发布失败：${signal.reason || '原因未知'}，继续下一条`, {
          index, total: runtime.ids.length
        });
        await sleep(1200);
        continue;
      }
      consecutiveFailures = 0;
      await sleep(1500);
    }

    runtime.running = false;
    const success = runtime.results.filter(item => item.ok).length;
    report(`已结束：成功 ${success} / 共 ${runtime.ids.length} 条${runtime.results.length > success ? `，失败 ${runtime.results.length - success}` : ''}`, {
      done: true, ok: success, total: runtime.ids.length
    });
    persist();
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === 'SIMILAR_PING') {
      reply({ ok: true, version: VERSION });
      return;
    }
    if (message.type === 'SIMILAR_DIAG') {
      try {
        reply({ text: diagnose() });
      } catch (error) {
        reply({ text: `自检失败：${error.message}` });
      }
      return;
    }
    if (message.type === 'SIMILAR_PUBLISH') {
      // 先切模式：applyVariant / publishNow 里的 report 与 logStep 都按它分流，
      // 不切的话发布页的进度和日志会写到「旧链上新」那边，裂变链接面板里一片空白
      if (message.variant) runtime.mode = 'variant';
      (message.variant ? applyVariant() : Promise.resolve(null))
        .then(pending => {
          // 只填不发（裂变链接测试阶段）：填完标题与主图就回报成功，
          // 不点「发布商品」、也不关标签页，留给人工核对
          if (pending && pending.publish === false) {
            const no = Number(pending.index) + 1;
            report(`第 ${no} 条：标题与主图已填好，本版不点发布，请人工核对这个页面`);
            logStep(`第 ${no} 条：已填好标题与主图，未点发布（只填模式）`);
            try {
              chrome.runtime.sendMessage({
                type: 'SIMILAR_PUBLISH_DONE',
                ok: true,
                filled: true,
                keepTab: true,
                variant: true
              });
            } catch {
              /* 忽略 */
            }
            return { ok: true, filled: true };
          }
          return publishNow();
        })
        .then(result => reply(result))
        .catch(error => {
          // 失败也要回报，否则后台一直等，整条流程会卡住；把校验提示一起带回去
          try {
            chrome.runtime.sendMessage({
              type: 'SIMILAR_PUBLISH_DONE',
              ok: false,
              reason: error.message,
              issues: Array.isArray(error.issues) ? error.issues : [],
              // 裂变链接一次会开十几二十个发布页，失败页不能全留着
              variant: runtime.mode === 'variant'
            });
          } catch {
            /* 忽略 */
          }
          reply({ ok: false, error: error.message });
        });
      return true;
    }
    if (message.type === 'VARIANT_RUN') {
      runVariants(message.sourceId, message.items, { publish: message.publish !== false });
      reply({ ok: true, started: true });
      return;
    }
    if (message.type === 'VARIANT_STOP') {
      runtime.running = false;
      runtime.earlySignal = { stopped: true };
      if (runtime.pendingSignal) runtime.pendingSignal({ stopped: true });
      report('已手动停止', { stopped: true });
      persist();
      reply({ ok: true });
      return;
    }
    if (message.type === 'SIMILAR_RUN') {
      runQueue(Array.isArray(message.ids) ? message.ids : []);
      reply({ ok: true, started: true });
      return;
    }
    if (message.type === 'SIMILAR_NEXT') {
      const payload = {
        ok: Boolean(message.ok),
        filled: Boolean(message.filled),
        reason: message.reason || '',
        issues: Array.isArray(message.issues) ? message.issues : []
      };
      if (runtime.pendingSignal) runtime.pendingSignal(payload);
      else if (runtime.running) runtime.earlySignal = payload;
      reply({ ok: true });
      return;
    }
    if (message.type === 'SIMILAR_STOP') {
      runtime.running = false;
      runtime.earlySignal = { stopped: true };
      if (runtime.pendingSignal) runtime.pendingSignal({ stopped: true });
      report('已手动停止', { stopped: true });
      persist();
      reply({ ok: true });
      return;
    }
  });
})();
