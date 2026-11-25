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

// ---------- coats (?c=): palette + mask swaps ----------

export type CoatId = 'tabby' | 'orange' | 'tux' | 'void'

/** Per-coat extras read by the baker, the rig and the face. */
export const COAT = {
  id: 'tabby' as CoatId,
  /** stripe strength multiplier (tux and void have none) */
  stripe: 1,
  /** torso width multiplier (orange: 大橘为重) */
  wide: 1,
  iris: ['#C8B860', '#C2C56C', '#A9BE66', '#93AE5E', '#86894A', '#6E6238'],
  nose: ['#F0ADA6', '#E8958F', '#C97A74'],
  innerEar: ['#C98F86', '#E9B4A8', '#D99C92'],
}

const BASE = { P: { ...P }, RAMPS: RAMPS.map((r) => r.slice()), COAT: { ...COAT } }

export function applyCoat(id: CoatId) {
  Object.assign(P, BASE.P)
  BASE.RAMPS.forEach((r, i) => (RAMPS[i] = r.slice()))
  Object.assign(COAT, BASE.COAT, { id })
  const set = (k: keyof typeof P, h: string) => ((P as Record<string, unknown>)[k] = hex(h))
  if (id === 'orange') {
    set('under', '#9A5A2E')
    set('base', '#D08A4E')
    set('mid', '#E0A266')
    set('tip', '#F3CC93')
    set('stripe', '#A55F2C')
    set('stripeCore', '#8A4A20')
    RAMPS[0] = ['#8E542C', '#B06A38', '#D08A4E', '#E0A266', '#F0C68E'].map(hex)
    RAMPS[1] = ['#6E3818', '#8A4A20', '#A55F2C', '#BC7440', '#CC8A52'].map(hex)
    COAT.stripe = 0.85
    COAT.wide = 1.12
    COAT.iris = ['#D9B84E', '#CFC25E', '#B9B85A', '#A8A452', '#9A8A40', '#7A6430']
  } else if (id === 'tux' || id === 'void') {
    set('under', '#141110')
    set('base', '#262120')
    set('mid', '#332D2A')
    set('tip', '#4E4642')
    set('stripe', '#1A1614')
    set('stripeCore', '#110E0D')
    RAMPS[0] = ['#141110', '#1F1B19', '#2A2523', '#3A3330', '#544B46'].map(hex)
    RAMPS[1] = RAMPS[0].slice()
    COAT.stripe = 0
    COAT.iris = ['#D8D86A', '#CFD46A', '#B4C460', '#9EB458', '#8A8F48', '#6E6838']
    if (id === 'void') {
      set('white', '#2E2926')
      set('whiteShade', '#1E1A18')
      set('belly', '#2A2523')
      RAMPS[2] = RAMPS[0].slice()
      COAT.iris = ['#F3CC52', '#EBBE46', '#DDAA3E', '#CC9636', '#A8762A', '#7A5420']
      COAT.nose = ['#6A5450', '#4E3C3A', '#3A2C2A']
      COAT.innerEar = ['#5A4440', '#7A5C56', '#6A4E48']
    }
  }
}
