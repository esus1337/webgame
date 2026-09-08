/** The game's chrome. Nation colors carry the map; everything else is neutral. */
export const THEME = {
  ocean: '#0d1620',
  oceanDeep: '#0a121a',
  provinceBorder: 'rgba(8, 14, 20, 0.35)',
  nationBorder: 'rgba(6, 10, 14, 0.85)',
  coastline: 'rgba(140, 190, 225, 0.22)',
  selection: '#f4f7fb',
  playerOutline: '#ffffff',
  battle: '#ff5a4d',
  text: '#e8edf4',
  textDim: '#8fa0b4',
  panel: '#141c26',
  panelEdge: '#26323f',
  accent: '#6fd3c7',
} as const;

/** Camera zoom below which nation labels are drawn instead of army markers. */
export const LABEL_ZOOM_LIMIT = 2.2;
