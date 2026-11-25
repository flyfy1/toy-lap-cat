// Baked fur (design doc 1.5 A): per part an offscreen sprite made of a soft pattern underlay plus
// three passes of tapered hair strokes, then form shading and ambient occlusion on top.
// Baking is progressive: the underlay is drawn at once, strokes fill in over later frames.

import { Field } from './field'
import { clamp01, mulberry32, smoothstep } from './noise'
import { P, type RGB, mix, scale } from './palette'
import { type PartDef, type PartId, apply, earInnerPath as earInner } from './rig'

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
  const diff = (nx * LIGHT[0] + ny * LIGHT[1] + LIGHT[2]) / nl
  const [cx, cy] = apply(def.toCat, x, y)
  const gg = 1 - 0.22 * smoothstep(-1.4, 1.6, cx * 0.55 + cy * 0.85)
  return Math.max(0.45, Math.min(1.18, (0.52 + 0.6 * Math.max(diff, -0.2)) * gg))
}

/** White fur keeps more light in the shadows (it scatters), so it never turns grey. */
export const shadeFor = (L: number, w: number) => L + (1 - L) * 0.55 * w * (L < 1 ? 1 : 0)

/** Coat colour for a pattern sample and pass (0 undercoat, 1 mid, 2 tips). */
export function coat(w: number, s: number, tone: number, pass: number, r: number): RGB {
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
    wh = mix(P.white, [255, 253, 248], r)
  }
  const t = scale(mix(tab, str, s), tone)
  return mix(t, scale(wh, 0.5 + 0.5 * Math.min(1.08, tone)), w)
}

const PASSES = [
  { alpha: 0.5, len: 1.1, w: 0.016, dens: 1300 },
  { alpha: 0.74, len: 0.9, w: 0.0125, dens: 2500 },
  { alpha: 0.58, len: 0.6, w: 0.0085, dens: 1900 },
]

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
    const inset = this.o.fur ? 0.022 : 0
    const soft = this.o.fur ? 0.012 : 0.004
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
    g.addColorStop(0, '#C98F86')
    g.addColorStop(0.45, P.innerEar)
    g.addColorStop(1, '#D99C92')
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
            const L = shadeFor(lightAt(def, f, x, y), pt.w)
            let a = def.flow(x, y) + (rnd() * 2 - 1) * def.jitter(x, y)
            let len = def.len(x, y) * pass.len * (0.7 + rnd() * 0.55)
            let dx = Math.cos(a)
            let dy = Math.sin(a)
            if (d < 0.045) {
              // fringe: tips cross the silhouette
              const g = f.grad(x, y)
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
            let col = coat(pt.w, pt.s, pt.tone, pi, r)
            col = scale(col, Math.pow(L, 0.75) * (0.93 + rnd() * 0.14))
            const key = (Math.min(255, col[0]) >> 3) | ((Math.min(255, col[1]) >> 3) << 5) | ((Math.min(255, col[2]) >> 3) << 10)
            let p = buckets.get(key)
            if (!p) buckets.set(key, (p = new Path2D()))
            const w = pass.w * (0.8 + rnd() * 0.4) * (pi === 2 && pt.w > 0.5 ? 0.9 : 1)
            const bend = (rnd() * 2 - 1) * 0.25 * len
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
          const keys = [...buckets.keys()].sort((ka, kb) => lum(ka) - lum(kb))
          for (const k of keys) {
            c.fillStyle = `rgb(${(k & 31) << 3},${((k >> 5) & 31) << 3},${((k >> 10) & 31) << 3})`
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
    c.save()
    c.globalCompositeOperation = 'source-atop'
    c.drawImage(tmp, f.x0, f.y0, f.w / f.res, f.h / f.res)
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

const lum = (k: number) => (k & 31) * 0.3 + ((k >> 5) & 31) * 0.59 + ((k >> 10) & 31) * 0.11
