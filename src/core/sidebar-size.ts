/** Sidebar width rules: never narrower than the filter chips need, never wider than a share of the window. */
export const MIN_WIDTH = 260;
export const MAX_RATIO = 0.45;
export const DEFAULT_WIDTH = 340;
export const RAIL_WIDTH = 48;

export const maxWidth = (viewport: number) => Math.max(MIN_WIDTH, Math.floor(viewport * MAX_RATIO));
export const clampWidth = (width: number, viewport: number) =>
  Math.min(maxWidth(viewport), Math.max(MIN_WIDTH, Math.round(width)));
