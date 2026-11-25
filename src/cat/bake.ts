// Baked fur (design doc 1.5 A): per part an offscreen sprite made of a soft pattern underlay plus
// three passes of tapered hair strokes, then form shading and ambient occlusion on top.
// Baking is progressive: the underlay is drawn at once, strokes fill in over later frames.

import { Field } from './field'
import { clamp01, mulberry32, smoothstep } from './noise'
import { COAT, P, type RGB, mix, scale } from './palette'
export { LIGHT }
import { type PartDef, type PartId, apply, earInnerPath as earInner, sunAt } from './rig'

export interface Sprite {
  def: PartDef
  field: Field
  cv: HTMLCanvasElement
  c: CanvasRenderingContext2D
  ppu: number
  x0: number
  y0: number
  bw: number
  bh: number
  strokes: number
  /** underlay colours at field resolution (to find white fur when shading) */
  under?: ImageData | null
  /** all passes and the shading are done */
  finished: boolean
}

const LIGHT = (() => {
  const v = [-0.45, -0.6, 0.66]
  const l = Math.hypot(v[0], v[1], v[2])
  return v.map((x) => x / l)
})()

/** Form-shading factor (about 0.35..1.15) at a local point of a part. */
export function lightAt(def: PartDef, f: Field, x: number, y: number): number {
  const d = f.sample(x, y)
  const g = f.grad(x, y)
  const s = clamp01(d / def.R)
  const h = Math.sqrt(Math.max(0.0001, 1 - (1 - s) * (1 - s)))
  const k = Math.min(4, (1 - s) / Math.max(h, 0.12))
  let nx = -g[0] * k
  let ny = -g[1] * k
  if (def.bump) {
    const e = 0.02
    nx -= ((def.bump(x + e, y) - def.bump(x - e, y)) / (2 * e)) * 0.25
    ny -= ((def.bump(x, y + e) - def.bump(x, y - e)) / (2 * e)) * 0.25
  }
  const nl = Math.hypot(nx, ny, 1)
  const Lv = def.light ?? LIGHT
  const diff = (nx * Lv[0] + ny * Lv[1] + Lv[2]) / nl
  const [cx, cy] = apply(def.toCat, x, y)
  const gg = 1 - 0.22 * smoothstep(-1.4, 1.6, cx * 0.55 + cy * 0.85)
  return Math.max(0.45, Math.min(1.18, (0.52 + 0.6 * Math.max(diff, -0.2)) * gg))
}

/** White fur keeps more light in the shadows (it scatters), so it never turns grey. */
export const shadeFor = (L: number, w: number) => L + (1 - L) * 0.55 * w * (L < 1 ? 1 : 0)

/** Coat colour for a pattern sample and pass (0 undercoat, 1 mid, 2 tips). */
export function coat(w: number, s: number, tone: number, pass: number, r: number): RGB {
  s *= COAT.stripe
  let tab: RGB
  let str: RGB
  let wh: RGB
  if (pass === 0) {
    tab = P.under
    str = P.stripeCore
    wh = P.whiteShade
  } else if (pass === 1) {
    tab = mix(P.base, P.mid, r)
    str = mix(P.stripe, P.stripeCore, r * 0.5)
    wh = mix(P.white, P.belly, r * 0.45)
  } else {
    // agouti ticking: most tips pale, a few dark
    tab = r < 0.86 ? mix(P.base, P.tip, (r / 0.86) * 0.85) : P.stripe
    str = r < 0.8 ? mix(P.stripe, P.stripeCore, r) : P.base
    wh = COAT.id === 'void' ? mix(P.white, P.tip, r * 0.5) : mix(P.white, [255, 253, 248], r)
  }
  const t = scale(mix(tab, str, s), tone)
  return mix(t, scale(wh, 0.5 + 0.5 * Math.min(1.08, tone)), w)
}

// finer hairs than the first version, about 12 % denser (the bake budget caps it at that)
const PASSES = [
  { alpha: 0.52, len: 1.1, w: 0.013, dens: 1450 },
  { alpha: 0.76, len: 0.9, w: 0.0095, dens: 2750 },
  { alpha: 0.62, len: 0.6, w: 0.0065, dens: 2150 },
]

const CLUMP = 0.045
const hash2 = (i: number, j: number, s: number) => {
  let h = (i * 374761393 + j * 668265263 + s * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
/** Fur clumps (spec 5.1): strokes rooted in one 0.045 HW cell share a direction offset, a bend, a length
 *  factor and a tone; their tips converge a little toward the cell's centre line. */
type Clump = { dOff: number; bend: number; lenF: number; tone: number; cx: number; cy: number }
const clumpCache = new WeakMap<PartDef, Map<number, Clump>>()
export function clumpAt(def: PartDef, x: number, y: number, seed: number): Clump {
  const i = Math.floor(x / CLUMP)
  const j = Math.floor(y / CLUMP)
  let cache = clumpCache.get(def)
  if (!cache) clumpCache.set(def, (cache = new Map()))
  const key = (i + 512) * 4096 + (j + 512) + seed * 1e7
  const hit = cache.get(key)
  if (hit) return hit
  const v = makeClump(def, i, j, seed)
  cache.set(key, v)
  return v
}
function makeClump(def: PartDef, i: number, j: number, seed: number): Clump {
  const r1 = hash2(i, j, seed)
  const r2 = hash2(i, j, seed + 7)
  const r3 = hash2(i, j, seed + 13)
  const r4 = hash2(i, j, seed + 29)
  const cx = (i + 0.5) * CLUMP
  const cy = (j + 0.5) * CLUMP
  // the bend follows the flow's local curl, so neighbours curve the same way
  const a0 = def.flow(cx, cy)
  const e = 0.03
  const a1 = def.flow(cx + Math.cos(a0) * e, cy + Math.sin(a0) * e)
  let curl = a1 - a0
  while (curl > Math.PI) curl -= Math.PI * 2
  while (curl < -Math.PI) curl += Math.PI * 2
  const sign = Math.abs(curl) > 0.004 ? Math.sign(curl) : r4 < 0.5 ? -1 : 1
  return { dOff: (r1 * 2 - 1) * 10 * (Math.PI / 180), bend: sign * (0.1 + 0.1 * r2), lenF: 0.85 + 0.35 * r3, tone: (r4 * 2 - 1) * 0.05, cx, cy }
}

export interface BakeOpts {
  ppu: number
  seed: number
  fur: boolean
}

export class Baker {
  sprites = new Map<PartId, Sprite>()
  private jobs: (() => void)[] = []
  /** longest single job (ms) and the frames' bake slices, for perf checks */
  maxJobMs = 0
  totalStrokes = 0
  bakeMs = 0
  startedAt = performance.now()
  doneAt = 0

  constructor(
    defs: PartDef[],
    private o: BakeOpts,
  ) {
    // everything is a job, so no single task is long: per part first a distance field and a cheap
    // flat-shaded stand-in, then the underlays, then the hair strokes
    for (const def of defs) this.jobs.push(() => this.init(def))
    this.jobs.push(() => {
      for (const sp of this.sprites.values()) this.queueUnderlay(sp)
      if (o.fur) for (const sp of this.sprites.values()) this.queueStrokes(sp)
    })
  }

  get ppu() {
    return this.o.ppu
  }

  /** Append work that runs after everything queued so far (e.g. building tufts once the fields exist). */
  add(job: () => void) {
    this.jobs.push(job)
  }

  private init(def: PartDef) {
    const o = this.o
    const [x0, y0, x1, y1] = def.bbox
    const field = new Field(def.path, x0, y0, x1, y1, 56)
    const bw = x1 - x0
    const bh = y1 - y0
    const cv = document.createElement('canvas')
    cv.width = Math.ceil(bw * o.ppu)
    cv.height = Math.ceil(bh * o.ppu)
    const c = cv.getContext('2d')!
    c.setTransform(o.ppu, 0, 0, o.ppu, -x0 * o.ppu, -y0 * o.ppu)
    const sp: Sprite = { def, field, cv, c, ppu: o.ppu, x0, y0, bw, bh, strokes: 0, finished: false }
    this.sprites.set(def.id, sp)
    this.quick(sp)
  }

  /** Frame-1 stand-in: the silhouette in its average coat colour with a soft top-left light. */
  private quick(sp: Sprite) {
    const { def, field: f, c } = sp
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let j = 1; j < 8; j++)
      for (let i = 1; i < 8; i++) {
        const x = f.x0 + ((f.w / f.res) * i) / 8
        const y = f.y0 + ((f.h / f.res) * j) / 8
        if (f.sample(x, y) <= 0) continue
        const pt = def.pat(x, y)
        const col = coat(pt.w, pt.s * 0.5, pt.tone, 1, 0.45)
        r += col[0]
        g += col[1]
        b += col[2]
        n++
      }
    if (!n) return
    const [x0, y0, x1, y1] = def.bbox
    const gr = c.createLinearGradient(x0, y0, x1, y1)
    gr.addColorStop(0, `rgb(${(r / n) * 1.05},${(g / n) * 1.05},${(b / n) * 1.05})`)
    gr.addColorStop(1, `rgb(${(r / n) * 0.7},${(g / n) * 0.7},${(b / n) * 0.7})`)
    c.fillStyle = gr
    c.beginPath()
    def.path(c)
    c.fill()
  }

  get done() {
    return this.jobs.length === 0
  }

  /** Run queued work for up to `budget` ms. */
  step(budget = 12) {
    if (!this.jobs.length) return
    const t0 = performance.now()
    while (this.jobs.length && performance.now() - t0 < budget) {
      const a = performance.now()
      this.jobs.shift()!()
      this.maxJobMs = Math.max(this.maxJobMs, performance.now() - a)
    }
    this.bakeMs += performance.now() - t0
    if (!this.jobs.length) this.doneAt = performance.now()
  }

  /** Soft pattern-coloured underlay, inset from the edge so the silhouette itself is made of fur.
   *  Computed in row bands (one job each) and drawn by the last job. */
  private queueUnderlay(sp: Sprite) {
    const { field: f, def } = sp
    const SS = this.o.fur ? 1 : 2
    const W = f.w * SS
    const H = f.h * SS
    const res = f.res * SS
    const img = new ImageData(W, H)
    const px = img.data
    // small parts (toes) take a narrower inset, or their underlay never reaches full alpha
    const inset = this.o.fur ? (def.inset ?? 0.022) : 0
    const soft = this.o.fur ? Math.min(0.012, (def.inset ?? 0.022) * 0.6) : 0.004
    const BAND = Math.max(2, Math.ceil(1000 / W))
    for (let r0 = 0; r0 < H; r0 += BAND) {
      const r1 = Math.min(H, r0 + BAND)
      this.jobs.push(() => {
        for (let j = r0; j < r1; j++)
          for (let i = 0; i < W; i++) {
            const x = f.x0 + (i + 0.5) / res
            const y = f.y0 + (j + 0.5) / res
            const d = f.sample(x, y)
            if (d < inset - soft - (this.o.fur ? 0 : 0.03)) continue
            const pt = def.pat(x, y)
            const L = shadeFor(lightAt(def, f, x, y), pt.w)
            let col = coat(pt.w, pt.s * 0.85, pt.tone, 1, 0.45)
            col = scale(col, this.o.fur ? (0.86 + 0.08 * pt.w) * L : L)
            const k = (j * W + i) * 4
            px[k] = col[0]
            px[k + 1] = col[1]
            px[k + 2] = col[2]
            px[k + 3] = this.o.fur ? 255 * smoothstep(inset - soft, inset + soft, d) : 255
          }
      })
    }
    sp.under = SS === 1 ? img : null
    this.jobs.push(() => {
      const tmp = document.createElement('canvas')
      tmp.width = W
      tmp.height = H
      tmp.getContext('2d')!.putImageData(img, 0, 0)
      const c = sp.c
      c.save()
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.clearRect(0, 0, sp.cv.width, sp.cv.height)
      c.restore()
      c.save()
      c.imageSmoothingQuality = 'high'
      c.drawImage(tmp, f.x0, f.y0, W / res, H / res)
      if (!this.o.fur) {
        // crisp vector silhouette for the ?fur=0 proportions view
        c.globalCompositeOperation = 'destination-in'
        c.beginPath()
        def.path(c)
        c.fill()
        c.globalCompositeOperation = 'source-over'
      }
      // inner ear: pink cup drawn as part of the underlay (no fur over it, tufts added later)
      if (def.noFur && (def.id === 'earL' || def.id === 'earR')) this.innerEar(sp)
      c.restore()
      if (!this.o.fur) {
        if (def.decorate) {
          c.save()
          def.decorate(c)
          c.restore()
        }
        sp.finished = true
      }
    })
  }

  private innerEar(sp: Sprite) {
    const c = sp.c
    c.save()
    const g = c.createLinearGradient(0, 0.02, 0, -0.3)
    g.addColorStop(0, COAT.innerEar[0])
    g.addColorStop(0.45, COAT.innerEar[1])
    g.addColorStop(1, COAT.innerEar[2])
    c.fillStyle = g
    c.beginPath()
    earInner(c)
    c.fill()
    // depth: darker toward the inner (lower) part of the cup
    const g2 = c.createRadialGradient(0, -0.02, 0.01, 0, -0.06, 0.2)
    g2.addColorStop(0, 'rgba(110,60,55,0.45)')
    g2.addColorStop(1, 'rgba(110,60,55,0)')
    c.fillStyle = g2
    c.beginPath()
    earInner(c)
    c.fill()
    c.restore()
  }

  private queueStrokes(sp: Sprite) {
    const { def, field: f } = sp
    let inside = 0
    for (let i = 0; i < f.d.length; i++) if (f.d[i] > 0) inside++
    const area = inside / (f.res * f.res)
    const rnd = mulberry32(this.o.seed * 131 + def.id.length * 977 + def.id.charCodeAt(0) * 13 + def.id.charCodeAt(def.id.length - 1))
    const [x0, y0, x1, y1] = def.bbox
    PASSES.forEach((pass, pi) => {
      const total = Math.round(area * pass.dens * (def.density ?? 1))
      const CH = 120
      for (let start = 0; start < total; start += CH) {
        const n = Math.min(CH, total - start)
        this.jobs.push(() => {
          const buckets = new Map<number, Path2D>()
          let made = 0
          let guard = 0
          while (made < n && guard++ < n * 8) {
            const x = x0 + rnd() * (x1 - x0)
            const y = y0 + rnd() * (y1 - y0)
            const d = f.sample(x, y)
            if (d <= 0) continue
            if (def.noFur?.(x, y)) continue
            made++
            const pt = def.pat(x, y)
            const white = pt.w > 0.5
            const L = shadeFor(lightAt(def, f, x, y), pt.w)
            const cl = clumpAt(def, x, y, def.id.length)
            const jit = Math.min(def.jitter(x, y), white ? 16 * (Math.PI / 180) : 9)
            let a = def.flow(x, y) + cl.dOff + ((rnd() * 2 - 1) * jit) / 3
            let len = def.len(x, y) * pass.len * cl.lenF * (0.9 + rnd() * 0.2) * (white ? 1.15 : 1)
            {
              // tips converge 15 % toward the clump's centre line
              const o = (x - cl.cx) * -Math.sin(a) + (y - cl.cy) * Math.cos(a)
              a -= (0.15 * o) / Math.max(len, 0.02)
            }
            let dx = Math.cos(a)
            let dy = Math.sin(a)
            const edge = d < 0.045
            const g = edge || d < 0.05 ? f.grad(x, y) : null
            if (edge && g) {
              // fringe: tips cross the silhouette
              const k = 0.3 * (1 - d / 0.045)
              dx = dx * (1 - k) - g[0] * k
              dy = dy * (1 - k) - g[1] * k
              const l = Math.hypot(dx, dy) || 1
              dx /= l
              dy /= l
              // dark undercoat stays inside; only mid and tip hairs make the fringe
              len *= pi === 0 ? 0.6 : (def.fringe ?? 1.05)
              a = Math.atan2(dy, dx)
            }
            const r = rnd()
            let col = coat(pt.w, pt.s, pt.tone * (1 + cl.tone), pi, r)
            if (white) {
              // white fur: a narrow lightness range, cool shadows instead of beige
              const k = 0.9 + 0.1 * Math.min(1, Math.pow(L, 0.75) * (0.95 + rnd() * 0.1))
              col = scale(col, k)
              const sh = Math.max(0, 1 - L) * 1.4
              col = mix(col, [213, 210, 208], Math.min(0.6, sh))
            } else col = scale(col, Math.pow(L, 0.75) * (0.93 + rnd() * 0.14))
            // sheen along the back (tip pass)
            if (pi === 2 && def.sheen) col = scale(col, 1 + 0.12 * def.sheen(x, y))
            // rim light on edges that face the window, a cool bounce on the far side
            let rim = 0
            if (g && d < 0.05) {
              const Lv = def.light ?? LIGHT
              const ll = Math.hypot(Lv[0], Lv[1]) || 1
              const face = (-g[0] * Lv[0] - g[1] * Lv[1]) / ll
              if (face > 0.25) {
                rim = Math.min(1, (face - 0.25) / 0.5) * (1 - d / 0.05)
                col = mix(scale(col, 1 + 0.18 * rim), [255, 241, 214], 0.25 * rim)
              } else if (face < -0.25) col = mix(col, [201, 183, 176], 0.08 * Math.min(1, (-face - 0.25) / 0.5))
            }
            if (edge) {
              const lu = col[0] * 0.3 + col[1] * 0.59 + col[2] * 0.11
              const below = def.under?.(...apply(def.toCat, x + dx * len, y + dy * len))
              const bl = below ? below[0] * 0.3 + below[1] * 0.59 + below[2] * 0.11 : -1
              if (below && bl - lu > 60) {
                // over a lighter part (the white belly): blend toward it and keep it short, no dark needles
                col = mix(col, below, 0.5)
                len *= 0.5
              } else if (lu < 120) {
                // soft edge against the rug: dark hairs read as spikes, so the fringe is lifted toward a warm mid tone
                const k = 0.35 * (1 - lu / 120)
                col = [col[0] + (150 - col[0]) * k, col[1] + (128 - col[1]) * k, col[2] + (104 - col[2]) * k]
                len *= 0.82
              }
            }
            const c6 = white
            const q = c6 ? 2 : 3
            const m = c6 ? 63 : 31
            const key = (((Math.min(255, col[0]) >> q) | ((Math.min(255, col[1]) >> q) << 6) | ((Math.min(255, col[2]) >> q) << 12)) + (c6 ? 1 << 18 : 0) + (edge ? 1 << 19 : 0) + (edge && rim > 0.3 ? 1 << 20 : 0)) * 1
            void m
            let p = buckets.get(key)
            if (!p) buckets.set(key, (p = new Path2D()))
            const w = pass.w * (0.8 + rnd() * 0.4) * (pi === 2 && pt.w > 0.5 ? 0.9 : 1)
            const bend = (cl.bend + (rnd() * 2 - 1) * 0.04) * len
            const px = -dy
            const py = dx
            const tx = x + dx * len
            const ty = y + dy * len
            const mx = x + dx * len * 0.5 + px * bend
            const my = y + dy * len * 0.5 + py * bend
            p.moveTo(x + px * w * 0.5, y + py * w * 0.5)
            p.quadraticCurveTo(mx + px * w * 0.22, my + py * w * 0.22, tx, ty)
            p.quadraticCurveTo(mx - px * w * 0.22, my - py * w * 0.22, x - px * w * 0.5, y - py * w * 0.5)
            p.closePath()
          }
          sp.strokes += made
          this.totalStrokes += made
          const c = sp.c
          c.save()
          c.globalAlpha = pass.alpha
          const keys = [...buckets.keys()].sort((ka, kb) => lumKey(ka) - lumKey(kb))
          for (const k of keys) {
            c.globalAlpha = k & (1 << 19) ? pass.alpha * (k & (1 << 20) ? 0.8 : 0.55) : pass.alpha
            const [rr, gg, bb] = rgbKey(k)
            c.fillStyle = `rgb(${rr},${gg},${bb})`
            c.fill(buckets.get(k)!)
          }
          c.restore()
        })
      }
    })
    this.jobs.push(() => this.finish(sp))
  }

  /** Low-frequency form shading and AO re-applied over the strokes, so the volume survives the fur noise. */
  private finish(sp: Sprite) {
    const { def, field: f, c } = sp
    const img = new ImageData(f.w, f.h)
    const px = img.data
    for (let j = 0; j < f.h; j++)
      for (let i = 0; i < f.w; i++) {
        const x = f.x0 + (i + 0.5) / f.res
        const y = f.y0 + (j + 0.5) / f.res
        const d = f.d[j * f.w + i]
        if (d < -0.08) continue
        const L = lightAt(def, f, x, y)
        const k = (j * f.w + i) * 4
        let white = 0
        if (sp.under) {
          const u = sp.under.data
          white = smoothstep(150, 200, u[k] * 0.3 + u[k + 1] * 0.59 + u[k + 2] * 0.11)
        }
        if (L < 1) {
          px[k] = 40
          px[k + 1] = 28
          px[k + 2] = 20
          px[k + 3] = 255 * Math.min(0.38, (1 - L) * 0.45) * (1 - 0.6 * white)
        } else {
          px[k] = 255
          px[k + 1] = 246
          px[k + 2] = 228
          px[k + 3] = 255 * Math.min(0.25, (L - 1) * 1.2)
        }
      }
    const tmp = document.createElement('canvas')
    tmp.width = f.w
    tmp.height = f.h
    tmp.getContext('2d')!.putImageData(img, 0, 0)
    // the sun patch at the part's rest place: a warm wash in the light, a cool veil in the shade
    const sun = new ImageData(f.w, f.h)
    const sp2 = sun.data
    const lkCache = new Map<number, number>()
    for (let j = 0; j < f.h; j++)
      for (let i = 0; i < f.w; i++) {
        const k = (j * f.w + i) * 4
        if (f.d[j * f.w + i] < -0.08) continue
        const [cx, cy] = apply(def.toCat, f.x0 + (i + 0.5) / f.res, f.y0 + (j + 0.5) / f.res)
        const s = sunAt(cx, cy)
        // a wash over dark fur lifts it toward grey and draws the patch edge as a seam: scale by the fur's lightness
        // (sampled on a 3x3 pixel grid: the pattern changes slowly and this runs inside the bake budget)
        const gi = ((i / 3) | 0) + ((j / 3) | 0) * 4096
        let lk = lkCache.get(gi)
        if (lk === undefined) {
          const pt = def.pat(f.x0 + (i + 0.5) / f.res, f.y0 + (j + 0.5) / f.res)
          const fc = coat(pt.w, pt.s, pt.tone, 1, 0.5)
          lk = Math.min(1, 0.15 + (0.85 * (fc[0] * 0.3 + fc[1] * 0.59 + fc[2] * 0.11)) / 190)
          lkCache.set(gi, lk)
        }
        if (s > 0.5) {
          sp2[k] = 255
          sp2[k + 1] = 228
          sp2[k + 2] = 188
          sp2[k + 3] = 255 * 0.2 * (s - 0.5) * 2 * lk
        } else {
          sp2[k] = 64
          sp2[k + 1] = 58
          sp2[k + 2] = 78
          sp2[k + 3] = 255 * 0.12 * (0.5 - s) * 2 * lk
        }
      }
    const tmp2 = document.createElement('canvas')
    tmp2.width = f.w
    tmp2.height = f.h
    tmp2.getContext('2d')!.putImageData(sun, 0, 0)
    c.save()
    c.globalCompositeOperation = 'source-atop'
    c.drawImage(tmp, f.x0, f.y0, f.w / f.res, f.h / f.res)
    c.drawImage(tmp2, f.x0, f.y0, f.w / f.res, f.h / f.res)
    for (const [ax, ay, ar, aa] of def.ao ?? []) {
      const g = c.createRadialGradient(ax, ay, 0, ax, ay, ar)
      g.addColorStop(0, `rgba(45,32,22,${aa})`)
      g.addColorStop(1, 'rgba(45,32,22,0)')
      c.fillStyle = g
      c.fillRect(ax - ar, ay - ar, ar * 2, ar * 2)
    }
    c.restore()
    if (def.decorate) {
      c.save()
      def.decorate(c)
      c.restore()
    }
    if (def.id === 'earL' || def.id === 'earR') this.earTufts(sp)
    sp.finished = true
  }

  /** Long pale tufts growing out of the inner ear. */
  private earTufts(sp: Sprite) {
    const c = sp.c
    const rnd = mulberry32(this.o.seed * 17 + (sp.def.id === 'earL' ? 1 : 2))
    c.save()
    c.lineCap = 'round'
    const n = 16
    for (let i = 0; i < n; i++) {
      const bx = (rnd() * 2 - 1) * 0.06
      const by = 0.01 - rnd() * 0.05
      const a = -Math.PI / 2 + bx * 4 + (rnd() * 2 - 1) * 0.3
      const L = 0.09 + rnd() * 0.12
      const tx = bx + Math.cos(a) * L
      const ty = by + Math.sin(a) * L
      const bend = (rnd() - 0.5) * 0.04
      c.strokeStyle = `rgba(244,236,224,${0.35 + rnd() * 0.35})`
      c.lineWidth = 0.003 + rnd() * 0.003
      c.beginPath()
      c.moveTo(bx, by)
      c.quadraticCurveTo(bx + Math.cos(a) * L * 0.5 + bend, by + Math.sin(a) * L * 0.5, tx, ty)
      c.stroke()
    }
    c.restore()
  }
}

/** colour of a stroke bucket key: 6 bits per channel for white fur (no banding), 5 bits otherwise */
function rgbKey(k: number): [number, number, number] {
  const q = k & (1 << 18) ? 2 : 3
  return [(k & 63) << q, ((k >> 6) & 63) << q, ((k >> 12) & 63) << q]
}
const lumKey = (k: number) => {
  const [r, g, b] = rgbKey(k)
  return r * 0.3 + g * 0.59 + b * 0.11
}
