// Seeded randomness and smooth value noise, so every bake of the same seed is identical.

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 2D value noise in [-1, 1] with smoothstep interpolation. */
export function makeNoise(seed: number): (x: number, y: number) => number {
  const N = 256
  const r = mulberry32(seed)
  const vals = new Float32Array(N)
  for (let i = 0; i < N; i++) vals[i] = r() * 2 - 1
  const perm = new Uint8Array(N * 2)
  const p = Array.from({ length: N }, (_, i) => i)
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[p[i], p[j]] = [p[j], p[i]]
  }
  for (let i = 0; i < N * 2; i++) perm[i] = p[i & 255]
  const v = (ix: number, iy: number) => vals[perm[(perm[ix & 255] + iy) & 511]]
  return (x: number, y: number) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = v(ix, iy)
    const b = v(ix + 1, iy)
    const c = v(ix, iy + 1)
    const d = v(ix + 1, iy + 1)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
}

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
