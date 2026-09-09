// One small, deliberately limited palette. Everything on screen is mixed from
// these so the room reads as a single illustration instead of a pile of assets.
export const PAL = {
  floorA:   '#9c7a55', floorB:   '#916f4c', floorEdge:'#7a5c3e',
  wallL:    '#4f4a68', wallR:    '#5c5779', wallTop:  '#6d6889', wallTrim:'#3c3853',
  shadow:   'rgba(20,14,34,0.30)',

  wood:     '#8a5f3c', woodD:    '#6d4a2e', woodL:    '#a8794f',
  white:    '#e8e4f0', whiteD:   '#c4bed6', whiteS:   '#a49dbb',
  steel:    '#9aa3b8', steelD:   '#77808f', steelL:   '#bfc7d8',
  fabric:   '#3f7d84', fabricD:  '#2f6068', fabricL:  '#57a0a4',
  warm:     '#e0a05a', warmD:    '#c07f42',
  green:    '#5aa363', greenD:   '#3f7a4a',
  screen:   '#171a2c', screenOn: '#8fd8e8',
  glass:    '#7fb6c9', night:    '#2b3057',
  red:      '#d9625c', pink:     '#e79bb0',
  black:    '#241d33', ink:      '#2c2340',

  body:     '#f0c98a', bodyD:    '#d5a86a', bodyL:    '#fbe3b4',
  belly:    '#fdf1d8', blush:    '#f0918e',
};

/** Slightly darken/lighten a hex colour — used for dynamic lighting. */
export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
