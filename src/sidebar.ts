import { DEFAULT_WIDTH, MIN_WIDTH, RAIL_WIDTH, clampWidth, maxWidth } from './core/sidebar-size';

const STORE_KEY = 'temporal-visualizer.sidebar';
const STEP = 16;
const BIG_STEP = 48;

interface Saved { width: number; collapsed: boolean }

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<Saved> | null;
    return { width: Number(raw?.width) || DEFAULT_WIDTH, collapsed: raw?.collapsed === true };
  } catch { return { width: DEFAULT_WIDTH, collapsed: false }; }
}

/**
 * Resizable, collapsible workflow sidebar.
 * Drag the handle, use the arrow keys on it (Shift for bigger steps, Home/End for the limits),
 * or double-click it to reset.  Collapsing leaves a narrow rail that still shows the failure count
 * and a dot when a new workflow arrives.
 */
export function initSidebar(o: {
  app: HTMLElement; side: HTMLElement; handle: HTMLElement;
  collapse: HTMLButtonElement; expand: HTMLButtonElement;
  railBadge: HTMLElement; railDot: HTMLElement;
}) {
  const state = load();
  state.width = clampWidth(state.width, window.innerWidth);

  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode */ } };

  function apply() {
    o.app.style.setProperty('--side-w', `${state.collapsed ? RAIL_WIDTH : state.width}px`);
    o.app.classList.toggle('side-collapsed', state.collapsed);
    o.collapse.setAttribute('aria-expanded', String(!state.collapsed));
    o.expand.setAttribute('aria-expanded', String(!state.collapsed));
    o.handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    o.handle.setAttribute('aria-valuemax', String(maxWidth(window.innerWidth)));
    o.handle.setAttribute('aria-valuenow', String(state.width));
  }

  function setWidth(width: number, persist: boolean) {
    state.width = clampWidth(width, window.innerWidth);
    apply();
    if (persist) save();
  }

  function setCollapsed(collapsed: boolean) {
    if (state.collapsed === collapsed) return;
    state.collapsed = collapsed;
    // Animate only the toggle; dragging must follow the pointer without easing.
    o.app.classList.add('animate');
    window.setTimeout(() => o.app.classList.remove('animate'), 260);
    if (!collapsed) o.railDot.hidden = true;
    apply();
    save();
    (collapsed ? o.expand : o.collapse).focus({ preventScroll: true });
  }

  // ----- drag -----
  o.handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    o.handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const left = o.side.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => setWidth(ev.clientX - left, false);
    const stop = () => {
      o.handle.removeEventListener('pointermove', move);
      o.handle.removeEventListener('pointerup', stop);
      o.handle.removeEventListener('pointercancel', stop);
      document.body.classList.remove('resizing');
      save();
    };
    o.handle.addEventListener('pointermove', move);
    o.handle.addEventListener('pointerup', stop);
    o.handle.addEventListener('pointercancel', stop);
    e.preventDefault();
  });

  // ----- keyboard -----
  o.handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const next = e.key === 'ArrowLeft' ? state.width - step
      : e.key === 'ArrowRight' ? state.width + step
      : e.key === 'Home' ? MIN_WIDTH
      : e.key === 'End' ? maxWidth(window.innerWidth)
      : null;
    if (next === null) return;
    e.preventDefault();
    setWidth(next, true);
  });
  o.handle.addEventListener('dblclick', () => setWidth(DEFAULT_WIDTH, true));

  o.collapse.addEventListener('click', () => setCollapsed(true));
  o.expand.addEventListener('click', () => setCollapsed(false));
  window.addEventListener('resize', () => setWidth(state.width, false));   // keep within the share limit

  apply();

  return {
    /** Failure count shown on the rail while the list is collapsed. */
    setFailures(n: number) {
      o.railBadge.hidden = n === 0;
      o.railBadge.textContent = String(n);
      o.railBadge.setAttribute('aria-label', `${n} failed workflows`);
    },
    /** Marks that something new arrived while the list could not be seen. */
    flagNew() { if (state.collapsed) o.railDot.hidden = false; },
    get collapsed() { return state.collapsed; },
    get width() { return state.width; },
  };
}
