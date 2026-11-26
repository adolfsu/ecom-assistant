/*
 * 页面结构探测：注入到抖店页面各 frame 执行，返回一段可直接阅读的文本。
 *
 * 重要约束：这个函数会被 chrome.scripting.executeScript 以 func 形式序列化后注入，
 * 所以它**必须是自包含的**——不能引用本模块或任何外部作用域的变量/函数。
 *
 * 第一版按「全页图片最多的容器」找图片区，结果被店铺头像/广告图/图标淹没，看不到素材弹窗。
 * 现在改为：先识别可视弹层（position: fixed/absolute + z-index + 面积），
 * 只在弹层内部按「网格布局」定位素材卡片，并输出格子的 outerHTML 供判断。
 */

export function probeFrame() {
  const lines = [];
  const push = (...args) => lines.push(...args);
  const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const cut = (value, limit) => {
    const text = norm(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  const styleOf = (element) => {
    try {
      return element.ownerDocument.defaultView.getComputedStyle(element);
    } catch {
      return null;
    }
  };
  const visible = (element) => {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = styleOf(element);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
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
  /** 一个元素是否「带图」：img 子元素，或自身/子元素的 background-image */
  const hasImage = (element) => {
    if (!element || element.nodeType !== 1) return false;
    if (element.tagName === 'IMG') return true;
    if (element.querySelector('img')) return true;
    const own = element.style && element.style.backgroundImage;
    if (own && own.includes('url(')) return true;
    return Array.from(element.querySelectorAll('*')).slice(0, 12)
      .some(node => node.style && node.style.backgroundImage && node.style.backgroundImage.includes('url('));
  };
  const descImage = (element) => {
    // 找出这个格子里真正承载图片的元素，并吐出它的标识线索
    const image = element.tagName === 'IMG' ? element : element.querySelector('img');
    if (image) {
      const attrs = [];
      for (const attr of image.attributes) {
        if (/^(src|alt|title|data-|aria-)/.test(attr.name)) attrs.push(`${attr.name}=${cut(attr.value, 80)}`);
      }
      return `<img> ${attrs.join(' | ') || '（无可用属性）'}`;
    }
    const painted = Array.from(element.querySelectorAll('*'))
      .find(node => node.style && node.style.backgroundImage && node.style.backgroundImage.includes('url('));
    if (painted) {
      return `背景图 style=${cut(painted.style.backgroundImage, 110)}`;
    }
    return '未找到图片元素';
  };

  let isTop = false;
  try {
    isTop = window.top === window;
  } catch {
    isTop = false;
  }

  push(`===== frame：${isTop ? '主文档' : '内嵌 iframe'} =====`);
  push(`URL：${cut(location.href, 150)}`);
  push(`元素总数：${document.querySelectorAll('*').length}　可见 img：${Array.from(document.querySelectorAll('img')).filter(visible).length}`);

  /* ---------- iframe 清单 ---------- */
  const frames = Array.from(document.querySelectorAll('iframe, frame'));
  if (frames.length) {
    push(`本层含 ${frames.length} 个 iframe：`);
    frames.slice(0, 8).forEach((frame, index) => {
      let accessible = false;
      try {
        accessible = Boolean(frame.contentDocument);
      } catch {
        accessible = false;
      }
      push(`  [${index}] src=${cut(frame.src, 110) || '（无 src）'} 可访问=${accessible ? '是' : '否'}`);
    });
  } else {
    push('本层无 iframe（素材弹窗是同层 DOM，可直接操作）');
  }

  /* ---------- 弹层识别：素材库一定是浮层 ---------- */
  const layers = [];
  document.querySelectorAll('div, section, aside, dialog, [role="dialog"]').forEach(element => {
    if (element === document.body || element === document.documentElement) return;
    if (!visible(element)) return;
    const style = styleOf(element);
    if (!style) return;
    const fixed = /fixed|absolute/.test(style.position);
    const zIndex = parseInt(style.zIndex, 10) || 0;
    const rect = element.getBoundingClientRect();
    // 浮层的两个必要条件：脱离文档流 + 有层级；尺寸足够大（排除小气泡）
    if (!fixed && zIndex < 100) return;
    if (rect.width < 300 || rect.height < 200) return;
    layers.push({ element, zIndex, fixed, rect, position: style.position });
  });
  layers.sort((a, b) => b.zIndex - a.zIndex
    || (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

  push('');
  push('---------- 弹层 ----------');
  if (!layers.length) {
    push('未发现可见浮层：图片空间可能没打开、已关闭，或用 Portal 挂在了别处');
  }

  layers.slice(0, 3).forEach((layer, order) => {
    const { element, zIndex, rect, position } = layer;
    const label = String.fromCharCode(65 + order);
    push('');
    push(`【弹层 ${label}】<${element.tagName.toLowerCase()}> class=${cut(element.className, 100)}`);
    push(`  position=${position} z-index=${zIndex} 尺寸=[${Math.round(rect.width)}x${Math.round(rect.height)}]`);
    push(`  文本（前 160 字）：「${cut(element.textContent, 160)}」`);

    /* 弹层内的搜索框 */
    const inputs = Array.from(element.querySelectorAll('input')).filter(visible);
    const searches = inputs.filter(node => /搜索|素材|图片名|名称|search/i.test(
      `${node.getAttribute('placeholder') || ''} ${node.getAttribute('aria-label') || ''} ${node.className || ''}`,
    ));
    push(`  input ${inputs.length} 个${searches.length ? `，其中搜索框 ${searches.length} 个` : '，未见搜索框'}`);
    inputs.slice(0, 10).forEach(node => {
      push(`    input: placeholder=「${cut(node.getAttribute('placeholder'), 40)}」 type=${node.type} class=${cut(node.className, 40)}`);
    });

    /* 网格识别：子元素数量 >= 4 且大部分都带图，这是素材卡片的排布特征 */
    const grids = [];
    element.querySelectorAll('*').forEach(node => {
      const kids = Array.from(node.children);
      if (kids.length < 4) return;
      const withImage = kids.filter(hasImage);
      if (withImage.length / kids.length < 0.7) return;
      // 只要最内层的网格：避免把外层布局容器也当网格
      const inner = kids.some(kid => kid.children.length >= 4 && Array.from(kid.children).filter(hasImage).length >= 4);
      if (inner) return;
      grids.push({ node, count: withImage.length, kids });
    });
    grids.sort((a, b) => b.count - a.count);

    push(`  疑似网格容器：${grids.length} 个${grids.length ? `（最大 ${grids[0].count} 格）` : ''}`);

    grids.slice(0, 2).forEach((grid, gridOrder) => {
      const { node, kids, count } = grid;
      push('');
      push(`  【网格 ${label}${gridOrder + 1}】${count} 格　${selector(node)}`);
      push(`    class=${cut(node.className, 100)}`);
      push(`    首格 outerHTML（截断）：「${cut(kids[0].outerHTML, 420)}」`);
      push(`    首格文本：「${cut(kids[0].textContent, 80)}」`);
      push(`    首格图片：${descImage(kids[0])}`);
      kids.slice(1, 3).forEach((kid, position) => {
        push(`    第 ${position + 2} 格：class=${cut(kid.className, 60)} 文本=「${cut(kid.textContent, 40)}」 ${cut(descImage(kid), 150)}`);
      });
      // 名字可能藏在 hover 才出现的元素里
      const named = Array.from(node.querySelectorAll('*')).filter(child => {
        const cls = String(child.className || '');
        return /name|title|fileName|file-name|desc/i.test(cls) && norm(child.textContent) && norm(child.textContent).length < 60;
      });
      if (named.length) {
        push(`    卡内疑似名称元素：${named.slice(0, 3).map(child => `「${cut(child.textContent, 40)}」(${cut(child.className, 40)})`).join(' / ')}`);
      }
      push(`    网格内勾选控件：${node.querySelectorAll('input[type="checkbox"], input[type="radio"], [class*="checkbox"], [class*="Checkbox"]').length} 个`);
    });

    /* 弹层内的按钮 */
    const buttons = [...new Set(
      Array.from(element.querySelectorAll('button, [role="button"], a, span'))
        .filter(node => visible(node) && node.children.length <= 3)
        .map(node => norm(node.textContent))
        .filter(text => text && text.length <= 14),
    )];
    push(`  弹层内文案（前 20 个）：${buttons.slice(0, 20).map(text => `「${text}」`).join(' ') || '无'}`);
  });

  /* ---------- 主图区块（仅在主文档看） ---------- */
  if (isTop) {
    push('');
    push('---------- 主图区块 ----------');
    const hosts = Array.from(document.querySelectorAll('*')).filter(element => {
      if (!visible(element)) return false;
      const text = norm(element.textContent);
      return text.length < 30 && /^\*?主图$|主图视频|主图3:4/.test(text);
    });
    if (!hosts.length) push('  未找到「主图」区块文本');
    hosts.slice(0, 4).forEach(element => {
      // 往上找 3 层，看看主图区里有什么可点的东西
      let box = element;
      for (let level = 0; level < 3 && box.parentElement; level += 1) box = box.parentElement;
      const images = box.querySelectorAll('img').length;
      const acts = [...new Set(
        Array.from(box.querySelectorAll('button, [role="button"], span, div'))
          .filter(node => visible(node) && node.children.length <= 2)
          .map(node => norm(node.textContent))
          .filter(text => text && text.length <= 12),
      )];
      push(`  · 「${cut(element.textContent, 20)}」容器 class=${cut(box.className, 80)} 内含 img ${images} 个`);
      push(`    可点文案：${acts.slice(0, 12).map(text => `「${text}」`).join(' ') || '无'}`);
    });
  }

  return lines.join('\n');
}
