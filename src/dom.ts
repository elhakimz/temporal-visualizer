/** Tiny element builder: h('div', { class: 'x' }, 'text', childNode). Text is always inserted as text, never as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (string | Node)[]) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

const ICON_COPY = '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 3.5v-.4A1.6 1.6 0 0 0 8.9 1.5H3.6A1.6 1.6 0 0 0 2 3.1v5.3a1.6 1.6 0 0 0 1.6 1.6h.4"/>';
const ICON_CHECK = '<path d="M3 8.5l3.2 3L13 4.5"/>';
const ICON_OPEN = '<path d="M9 2.5h4.5V7M13.5 2.5L7 9M11 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3"/>';
export const icon = (inner: string) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = inner; return s; };
export const iconOpen = () => icon(ICON_OPEN);

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* not allowed here: fall back */ }
  const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0;pointer-events:none' });
  ta.value = text; document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function announce(msg: string) { const live = document.getElementById('announce'); if (live) live.textContent = msg; }

/**
 * A button that copies `text()` to the clipboard and confirms with a check mark.
 * `what` names the thing for screen readers ("workflow ID"); `label` is the visible text (omit for an icon-only button).
 */
export function copyButton(what: string, text: () => string, label?: string, cls = 'copy-btn'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, title: `Copy ${what}`, 'aria-label': `Copy ${what}` });
  const paint = (done: boolean) => { b.replaceChildren(icon(done ? ICON_CHECK : ICON_COPY), ...(label ? [done ? 'Copied' : label] : [])); b.dataset.state = done ? 'copied' : ''; };
  paint(false);
  let timer: number | undefined;
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyText(text());
    announce(ok ? `Copied ${what}` : `Could not copy ${what}`);
    if (!ok) return;
    paint(true); window.clearTimeout(timer); timer = window.setTimeout(() => paint(false), 1400);
  });
  return b;
}
