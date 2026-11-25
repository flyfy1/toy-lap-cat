// Coat palette (design doc 1.4, brown tabby with white, "狸花加白").

export type RGB = [number, number, number]
export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k]
export const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`

export const P = {
  under: hex('#5E4D3C'),
  base: hex('#8A7660'),
  mid: hex('#A8937A'),
  tip: hex('#D2C1A6'),
  stripe: hex('#3E3229'),
  stripeCore: hex('#241C17'),
  white: hex('#F6F1E8'),
  whiteShade: hex('#D9D0C2'),
  belly: hex('#E8DCC8'),
  pupil: '#0F0D0C',
  nose: '#E8958F',
  pad: '#E7A3A0',
  innerEar: '#E9B4A8',
  blanket: hex('#E9D8C3'),
  stitch: hex('#D9C3A8'),
  blanketHi: hex('#F4E9DA'),
  rug: hex('#D29C86'),
  rugHi: hex('#EBC2AE'),
  rugDark: hex('#A8705E'),
  shadow: hex('#5A4332'),
  vignette: hex('#6B5440'),
  ui: '#4A3A2C',
}

/** Colour family for a pattern sample: 0 tabby, 1 stripe, 2 white. */
export const family = (w: number, s: number) => (w > 0.5 ? 2 : s > 0.5 ? 1 : 0)

/** Five lightness steps per family, used by the live tufts (dark to light). */
export const RAMPS: RGB[][] = [
  ['#54453A', '#6E5D4B', '#8A7660', '#A8937A', '#C8B69A'].map(hex),
  ['#1C1511', '#2A211B', '#3E3229', '#54463A', '#6E5E4E'].map(hex),
  ['#C2B7A8', '#D9D0C2', '#E8E1D5', '#F3EEE5', '#FCFAF5'].map(hex),
]
