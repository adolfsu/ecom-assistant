/*
 * 抖店商品编辑页 · 图片空间结构探测脚本（Console 备用版）
 *
 * 已被「侧边栏 → 设置 → 页面结构探测」按钮取代（app/shared/probe.js）：
 * 按钮版能读到跨域 iframe、结果直接可复制，不需要开 DevTools。
 * 本文件仅在扩展无法注入时（例如权限还没覆盖素材库域名）作为备用手段保留。
 *
 * 用法：
 *   1. 打开「发布相似品」后的商品编辑页
 *   2. 点主图区域的「上传/选择图片」，等图片空间的图片列表显示出来（不要关掉弹窗）
 *   3. F12 → Console → 粘贴本文件全部内容 → 回车
 *   4. 屏幕中央会出现一个文本框，已自动全选，Ctrl+C 复制后发给开发
 *
 * 只读：不点击、不修改任何页面元素，唯一的副作用是在页面上浮出一个文本框。
 */
(() => {
  const lines = [];
  const push = (...args) => lines.push(...args);
  const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const cut = (value, limit = 120) => {
    const text = norm(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  const visible = (element) => {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  /* ---------- 1. 收集所有可访问的 document（含同源 iframe） ---------- */

  const docs = [];
  const frameNotes = [];
  const walk = (doc, depth, trail) => {
    if (!doc || docs.length >= 10) return;
    docs.push({ doc, depth, trail });
    doc.querySelectorAll('iframe, frame').forEach((frame, index) => {
      let inner = null;
      try {
        inner = frame.contentDocument;
      } catch {
        inner = null;
      }
      if (inner) walk(inner, depth + 1, `${trail} > iframe[${index}]`);
      else frameNotes.push(`${trail} > iframe[${index}] 不可访问（跨域或未加载）：${cut(frame.src, 100)}`);
    });
  };
  walk(document, 0, 'main');

  push('===== 抖店图片空间结构探测 =====');
  push(`时间：${new Date().toLocaleString()}`);
  push(`页面地址：${location.href}`);
  push(`可访问文档：${docs.length} 个（主文档 + 同源 iframe）`);
  if (frameNotes.length) {
    push('');
    push('-- 无法访问的 iframe --');
    frameNotes.forEach(note => push(`  ${note}`));
  }

  /* ---------- 2. 逐文档扫描 ---------- */

  const KEY_TEXT = /设为主图|设封面|设为封面|主图|上移|下移|置顶|置前|删除|移除|确定|确认|取消|上传|从图片空间|图片空间|排序|保存/;

  docs.forEach(({ doc, depth, trail }, index) => {
    const win = doc.defaultView || window;
    const images = Array.from(doc.querySelectorAll('img'));
    const tag = depth === 0 ? '主文档' : `iframe 内（第 ${depth} 层）`;
    push('');
    push(`---------- [文档 ${index}] ${tag}　路径 ${trail} ----------`);
    push(`  URL：${cut(doc.location && doc.location.href, 120) || '（同主文档）'}`);
    push(`  元素总数：${doc.querySelectorAll('*').length}　可见 img：${images.filter(visible).length} / 全部 ${images.length}`);

    /* 2.1 搜索框：图片空间若支持按素材名搜索，是最省事的入口 */
    const inputs = Array.from(doc.querySelectorAll('input')).filter(visible);
    const searchInputs = inputs.filter(element =>
      /搜索|素材|图片名|名称|search/i.test(
        `${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''} ${element.className || ''}`,
      ),
    );
    push(`  可见 input：${inputs.length} 个；疑似搜索框：${searchInputs.length} 个`);
    searchInputs.slice(0, 4).forEach(element => {
      push(`    · placeholder=「${element.getAttribute('placeholder') || ''}」 class=${cut(element.className, 60)}`);
    });

    /* 2.2 图片密集区：找出「最内层」且图片数量多的容器 */
    const candidates = [];
    doc.querySelectorAll('*').forEach(element => {
      if (element.tagName === 'IMG') return;
      const count = element.querySelectorAll('img').length;
      if (count < 4) return;
      // 只要最内层：父元素的图片数不能比自己少（否则说明自己不是最细的那层容器）
      const parent = element.parentElement;
      const parentCount = parent ? parent.querySelectorAll('img').length : 0;
      if (parentCount === count) return;
      candidates.push({ element, count });
    });
    candidates.sort((a, b) => b.count - a.count);

    if (!candidates.length) {
      push('  未发现图片密集容器（可能是懒加载未触发、图片用 canvas/背景图渲染，或弹窗还没打开）');
    }

    const selector = (element) => {
      const parts = [];
      let node = element;
      for (let level = 0; level < 4 && node && node.nodeType === 1; level += 1) {
        const cls = String(node.className || '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map(name => `.${name.replace(/[^\w-]/g, '')}`)
          .join('');
        parts.unshift(`${node.tagName.toLowerCase()}${cls}`);
        node = node.parentElement;
      }
      return parts.join(' > ');
    };

    candidates.slice(0, 3).forEach((item, order) => {
      const { element, count } = item;
      push('');
      push(`  【图片密集区 ${String.fromCharCode(65 + order)}】${count} 张图`);
      push(`    选择器：${selector(element)}`);
      push(`    标签：<${element.tagName.toLowerCase()}> class=${cut(element.className, 90)}`);
      push(`    尺寸：[${Math.round(element.getBoundingClientRect().width)}x${Math.round(element.getBoundingClientRect().height)}]`);

      // 卡片样本：取图片的 2 层父元素作为「一张卡」
      const firstImage = element.querySelector('img');
      if (!firstImage) return;
      const card = firstImage.parentElement && firstImage.parentElement.parentElement
        ? firstImage.parentElement.parentElement
        : firstImage.parentElement;
      push(`    卡片标签：<${card.tagName.toLowerCase()}> class=${cut(card.className, 90)}`);
      push(`    卡片文本：「${cut(card.textContent, 80)}」`);

      /* 关键：图片的可读标识在哪 */
      push('    -- 前 3 张图的标识线索 --');
      Array.from(element.querySelectorAll('img')).slice(0, 3).forEach((image, position) => {
        const attrs = {};
        for (const attr of image.attributes) {
          if (/^(src|alt|title|data-|aria-)/.test(attr.name)) {
            attrs[attr.name] = cut(attr.value, 90);
          }
        }
        const holder = image.closest('[data-id], [title], [aria-label]') || image.parentElement;
        push(`      #${position + 1} <img> ${JSON.stringify(attrs)}`);
        push(`         父级线索：${holder === image ? '无' : `<${holder.tagName.toLowerCase()}> title=「${cut(holder.getAttribute('title'), 50)}」 data*=「${
          Object.keys(holder.dataset || {}).join(',') || '无'
        }」文本=「${cut(holder.textContent, 40)}」`}`);
        // 卡内是否藏着名字元素（hover 才显示的常见做法）
        const named = Array.from(card.querySelectorAll('*')).filter(child => {
          const cls = String(child.className || '');
          return /name|title|fileName|file-name/i.test(cls) && norm(child.textContent);
        });
        if (named.length) {
          push(`         卡内疑似名称元素：${named.slice(0, 2).map(n => `「${cut(n.textContent, 40)}」(class=${cut(n.className, 40)})`).join(' / ')}`);
        }
      });

      /* 卡片是否带 checkbox / 单选框（选中式交互） */
      const boxes = card.querySelectorAll('input[type="checkbox"], input[type="radio"], .checkbox, [class*="checkbox"]');
      push(`    卡片内勾选控件：${boxes.length} 个`);
    });

    /* 2.3 关键动作按钮 */
    const actionNodes = Array.from(doc.querySelectorAll('button, [role="button"], a, span, div'))
      .filter(element => visible(element) && element.children.length <= 3)
      .map(element => norm(element.textContent))
      .filter(text => text && text.length <= 12 && KEY_TEXT.test(text));
    const uniqueActions = [...new Set(actionNodes)];
    push('');
    push(`  可见动作文案（去重）：${uniqueActions.length ? uniqueActions.map(text => `「${text}」`).join(' ') : '无'}`);

    /* 2.4 虚拟滚动线索 */
    const scrollers = Array.from(doc.querySelectorAll('*')).filter(element => {
      if (!visible(element)) return false;
      const style = win.getComputedStyle(element);
      return /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 40;
    });
    push(`  可滚动容器：${scrollers.length} 个${
      scrollers.length ? `（最高内容 ${Math.max(...scrollers.map(s => s.scrollHeight))}px）` : ''
    }`);
    const pagers = Array.from(doc.querySelectorAll('*'))
      .filter(element => visible(element) && /^(下一页|上一页|next|prev)$/i.test(norm(element.textContent)))
      .length;
    push(`  分页控件：${pagers ? `${pagers} 个` : '未发现'}`);
  });

  /* ---------- 3. 主图区域（发布页那一侧） ---------- */

  push('');
  push('---------- 主图区域（主文档中带「主图」字样的区块） ----------');
  const hosts = Array.from(document.querySelectorAll('*')).filter(element => {
    if (!visible(element)) return false;
    const text = norm(element.textContent);
    return text.length < 60 && /主图|商品图/.test(text);
  });
  if (!hosts.length) push('  未找到「主图」区块文本');
  hosts.slice(0, 4).forEach(element => {
    const box = element.closest('div') || element.parentElement;
    push(`  · 「${cut(element.textContent, 30)}」 <${box.tagName.toLowerCase()}> class=${cut(box.className, 80)}`);
    const near = box.parentElement ? box.parentElement.querySelectorAll('img').length : 0;
    push(`    邻近 img 数：${near}　同行按钮：${
      Array.from(box.querySelectorAll('button, [role="button"], span'))
        .filter(visible)
        .map(node => norm(node.textContent))
        .filter(Boolean)
        .slice(0, 6)
        .map(text => `「${text}」`)
        .join('') || '无'
    }`);
  });

  /* ---------- 4. 输出到浮层 ---------- */

  const report = lines.join('\n');
  console.log(report);

  const old = document.getElementById('__probe_material__');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = '__probe_material__';
  panel.style.cssText = 'position:fixed;inset:4% 4%;z-index:2147483647;background:#0f172a;color:#e2e8f0;'
    + 'padding:12px;border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.5);font:12px/1.55 Consolas,monospace;'
    + 'display:flex;flex-direction:column;gap:8px;';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;color:#94a3b8;';
  bar.innerHTML = '<span>探测完成 —— 文本框已全选，按 Ctrl+C 复制后发给开发</span>';
  const close = document.createElement('button');
  close.textContent = '关闭';
  close.style.cssText = 'padding:3px 10px;border:1px solid #334155;border-radius:6px;background:#1e293b;color:#e2e8f0;cursor:pointer;font:inherit;';
  close.onclick = () => panel.remove();
  bar.append(close);
  const box = document.createElement('textarea');
  box.value = report;
  box.style.cssText = 'flex:1;width:100%;resize:none;border:1px solid #334155;border-radius:8px;background:#020617;'
    + 'color:#e2e8f0;padding:10px;font:12px/1.55 Consolas,monospace;white-space:pre;';
  panel.append(bar, box);
  document.documentElement.append(panel);
  box.focus();
  box.select();
})();
