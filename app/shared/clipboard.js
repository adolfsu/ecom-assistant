/*
 * 写剪贴板。侧边栏通常有焦点，但独立小窗/失焦时 async API 会拒绝，
 * 所以保留 textarea + execCommand 的旧路径（旧面板里验证过可用）。
 */

export async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 没有焦点，退回旧接口 */
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

/** 复制按钮的通用反馈：改文案 1.5 秒后复原 */
export async function copyWithFeedback(button, text, { empty = '没有可复制的内容' } = {}) {
  const label = button.dataset.label || button.textContent;
  button.dataset.label = label;
  if (!text) {
    button.textContent = empty;
    setTimeout(() => { button.textContent = label; }, 1500);
    return false;
  }
  const ok = await copyText(text);
  button.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => { button.textContent = label; }, 1500);
  return ok;
}
