export interface ScreenSpec {
  width: number;
  height: number;
}

export interface GridMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface GridSpec {
  columns: number;
  rows: number;
  columnGap: number;
  rowGap: number;
  margin: GridMargins;
}

export const DEFAULT_SCREEN_SPEC: ScreenSpec = {
  width: 600,
  height: 800
};

export const MAX_SCREEN_EDGE_PX = 2048;
export const MAX_GRID_TRACKS = 24;
export const MAX_GRID_SPACING_PX = 1024;
export const MIN_WIDGET_PIXEL_WIDTH = 60;
export const MIN_WIDGET_PIXEL_HEIGHT = 40;

export const DEFAULT_GRID_SPEC: GridSpec = {
  columns: 4,
  rows: 6,
  columnGap: 12,
  rowGap: 12,
  margin: {
    top: 24,
    right: 24,
    bottom: 24,
    left: 24
  }
};
