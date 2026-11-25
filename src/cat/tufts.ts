// Live fur (design doc 1.5 B and C): a groom field per part in rest-pose local coordinates, and
// ~1,600 tufts redrawn every frame that read it (combed direction, flattening, sleek or ruffled tone).

import type { Field } from './field'
import { lightAt, coat } from './bake'
import { mulberry32, smoothstep } from './noise'
import { RAMPS, type RGB, css, family } from './palette'
import type { Mat, PartDef } from './rig'

const lumOf = (c: [number, number, number]) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11

/** How strongly a finger pass combs the fur. Spec says 8; 40 makes one ordinary pass readable. */
export const COMB_GAIN = 40
const BRUSH = 0.16
const SPEED_FULL = 4.8
/** spec 3; 8 so one pass reaches full sleekness */
const SLEEK_GAIN = 8 // HW/s (= 600 px/s at HW 125)

export class Groom {
  readonly cols: number
  readonly rows: number
  cx: Float32Array
  cy: Float32Array
  press: Float32Array
  sleek: Float32Array
  fx: Float32Array
  fy: Float32Array
  active = false
  constructor(
    def: PartDef,
    readonly x0: number,
    readonly y0: number,
    x1: number,
    y1: number,
    readonly cell = 0.05,
  ) {
    this.cols = Math.ceil((x1 - x0) / cell)
    this.rows = Math.ceil((y1 - y0) / cell)
    const n = this.cols * this.rows
    this.cx = new Float32Array(n)
    this.cy = new Float32Array(n)
    this.press = new Float32Array(n)
    this.sleek = new Float32Array(n)
    this.fx = new Float32Array(n)
    this.fy = new Float32Array(n)
    for (let j = 0; j < this.rows; j++)
      for (let i = 0; i < this.cols; i++) {
        const a = def.flow(x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell)
        this.fx[j * this.cols + i] = Math.cos(a)
        this.fy[j * this.cols + i] = Math.sin(a)
      }
  }

  index(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.cell)
    const j = Math.floor((y - this.y0) / this.cell)
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1
    return j * this.cols + i
  }

  /** Finger at local (x, y) moving at local velocity (vx, vy) HW/s. */
  write(x: number, y: number, vx: number, vy: number, dt: number) {
    const r = BRUSH
    const sp = Math.hypot(vx, vy)
    const nx = sp > 1e-4 ? vx / sp : 0
    const ny = sp > 1e-4 ? vy / sp : 0
    const k = Math.min(sp / SPEED_FULL, 1) * dt * COMB_GAIN
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / this.cell))
    const i1 = Math.min(this.cols - 1, Math.floor((x + r - this.x0) / this.cell))
    const j0 = Math.max(0, Math.floor((y - r - this.y0) / this.cell))
    const j1 = Math.min(this.rows - 1, Math.floor((y + r - this.y0) / this.cell))
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cxp = this.x0 + (i + 0.5) * this.cell
        const cyp = this.y0 + (j + 0.5) * this.cell
        const dist = Math.hypot(cxp - x, cyp - y)
        if (dist >= r) continue
        const wgt = 1 - smoothstep(0, r, dist)
        const q = j * this.cols + i
        let ax = this.cx[q] + nx * k * wgt
        let ay = this.cy[q] + ny * k * wgt
        const l = Math.hypot(ax, ay)
        if (l > 1) {
          ax /= l
          ay /= l
        }
        this.cx[q] = ax
        this.cy[q] = ay
        this.press[q] = Math.max(this.press[q], wgt)
        this.sleek[q] = Math.min(1, this.sleek[q] + wgt * dt * SLEEK_GAIN)
      }
    this.active = true
  }

  /** press: tau 0.12 s. With-grain comb and sleek fade out linearly over 2.5 s; against-grain ruffle
   *  decays with a 6 s time constant, so it is still faintly there after 4 s. */
  decay(dt: number) {
    if (!this.active) return
    const pk = Math.exp(-dt / 0.12)
    const ak = Math.exp(-dt / 6)
    let any = false
    for (let q = 0; q < this.cx.length; q++) {
      const p = this.press[q] * pk
      this.press[q] = p < 0.002 ? 0 : p
      const s = this.sleek[q] - dt / 2.5
      this.sleek[q] = s > 0 ? s : 0
      const ax = this.cx[q]
      const ay = this.cy[q]
      const l = Math.hypot(ax, ay)
      if (l > 0) {
        const dot = ax * this.fx[q] + ay * this.fy[q]
        // same threshold as the ruffle look: anything combed against the grain is slow to recover
        let nl = dot < -0.08 ? l * ak : l - dt / 2.5
        if (nl < 0.004) nl = 0
        this.cx[q] = (ax / l) * nl
        this.cy[q] = (ay / l) * nl
      }
      if (this.press[q] || this.sleek[q] || this.cx[q] || this.cy[q]) any = true
    }
    this.active = any
  }

  /** mean baked colour per cell (rgb), filled once the bake is done */
  mean: Float32Array | null = null
  setMean(sp: { cv: HTMLCanvasElement; x0: number; y0: number; ppu: number }, data: Uint8ClampedArray) {
    const W = sp.cv.width
    const H = sp.cv.height
    const m = new Float32Array(this.cols * this.rows * 3)
    for (let j = 0; j < this.rows; j++)
      for (let i = 0; i < this.cols; i++) {
        const X0 = Math.floor((this.x0 + i * this.cell - sp.x0) * sp.ppu)
        const Y0 = Math.floor((this.y0 + j * this.cell - sp.y0) * sp.ppu)
        const n = Math.max(1, Math.round(this.cell * sp.ppu))
        let r = 0
        let g = 0
        let b = 0
        let c = 0
        for (let y = Y0; y < Y0 + n; y += 2)
          for (let x = X0; x < X0 + n; x += 2) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue
            const k = (y * W + x) * 4
            if (data[k + 3] < 128) continue
            r += data[k]
            g += data[k + 1]
            b += data[k + 2]
            c++
          }
        const q = (j * this.cols + i) * 3
        m[q] = c ? r / c : 120
        m[q + 1] = c ? g / c : 100
        m[q + 2] = c ? b / c : 80
      }
    this.mean = m
  }

  private cv: HTMLCanvasElement | null = null
  private img: ImageData | null = null
  private inside: Float32Array | null = null
  /** Soft tone map of the field: a light sheen along with-grain trails, darker undercoat where ruffled.
   *  Drawn under the tufts with the part transform over the grid rectangle. */
  paint(field: Field): HTMLCanvasElement | null {
    if (!this.active) return null
    if (!this.cv) {
      this.cv = document.createElement('canvas')
      this.cv.width = this.cols
      this.cv.height = this.rows
      this.img = new ImageData(this.cols, this.rows)
      this.inside = new Float32Array(this.cols * this.rows)
      for (let j = 0; j < this.rows; j++)
        for (let i = 0; i < this.cols; i++) this.inside[j * this.cols + i] = smoothstep(0.0, 0.07, field.sample(this.x0 + (i + 0.5) * this.cell, this.y0 + (j + 0.5) * this.cell))
    }
    const px = this.img!.data
    const ins = this.inside!
    const mean = this.mean
    for (let q = 0; q < this.cx.length; q++) {
      const k = q * 4
      const along = this.cx[q] * this.fx[q] + this.cy[q] * this.fy[q]
      const ruf = Math.max(0, Math.min(1, (-along - 0.08) / 0.4))
      const sl = along > 0 ? this.sleek[q] * Math.min(1, along * 2 + 0.3) : 0
      const pr = this.press[q]
      // base: the local mean fur colour (hides the baked stroke texture so the live tufts dominate)
      let r = mean ? mean[q * 3] : 120
      let g = mean ? mean[q * 3 + 1] : 100
      let b = mean ? mean[q * 3 + 2] : 80
      let a = 0
      if (ruf > 0.01) {
        const k2 = 1 - 0.55 * ruf
        r *= k2
        g *= k2
        b *= k2
        a = 0.9 * ruf
      } else if (sl > 0.01) {
        // sleek: lighter and a touch warmer, like light on flattened fur
        r = r + (255 - r) * 0.42 * sl
        g = g + (244 - g) * 0.38 * sl
        b = b + (222 - b) * 0.32 * sl
        a = 0.9 * sl
      }
      if (pr > 0.01) {
        const k3 = 1 - 0.12 * pr
        r *= k3
        g *= k3
        b *= k3
        a = Math.max(a, 0.5 * pr)
      }
      px[k] = r
      px[k + 1] = g
      px[k + 2] = b
      px[k + 3] = 255 * ins[q] * Math.min(0.9, a)
    }
    this.cv.getContext('2d')!.putImageData(this.img!, 0, 0)
    return this.cv
  }

  /** Smooth the field toward the rest state in a region (grooming). */
  reset() {
    this.cx.fill(0)
    this.cy.fill(0)
    this.press.fill(0)
    this.sleek.fill(0)
    this.active = false
  }
}

interface Tuft {
  x: number
  y: number
  ang: number
  len: number
  fam: number
  step: number
  jit: number
  q: number
}

const MAX_ROT = (70 * Math.PI) / 180

export class TuftLayer {
  tufts: Tuft[] = []
  /** per-family ramps; replaced by colours measured from the baked sprite once it is done */
  ramps: RGB[][] = RAMPS.map((r) => r.slice())
  matched = false
  constructor(
    readonly def: PartDef,
    field: Field,
    readonly groom: Groom,
    seed: number,
    exclude: (x: number, y: number) => boolean,
    spacing = 0.045,
  ) {
    const rnd = mulberry32(seed)
    const [x0, y0, x1, y1] = def.bbox
    for (let y = y0; y < y1; y += spacing)
      for (let x = x0; x < x1; x += spacing) {
        const px = x + (rnd() - 0.5) * spacing
        const py = y + (rnd() - 0.5) * spacing
        const d = field.sample(px, py)
        if (d < 0.02) continue
        if (def.noFur?.(px, py) || exclude(px, py)) continue
        const pt = def.pat(px, py)
        const fam = family(pt.w, pt.s)
        const L = lightAt(def, field, px, py)
        const col = coat(pt.w, pt.s, pt.tone, 1, 0.5)
        const target = lumOf(col) * Math.pow(L, 0.75)
        const ramp = RAMPS[fam]
        let best = 0
        let bd = 1e9
        for (let k = 0; k < 5; k++) {
          const dd = Math.abs(lumOf(ramp[k]) - target)
          if (dd < bd) {
            bd = dd
            best = k
          }
        }
        this.tufts.push({
          x: px,
          y: py,
          ang: def.flow(px, py) + (rnd() * 2 - 1) * def.jitter(px, py),
          len: def.len(px, py) * (0.8 + rnd() * 0.4),
          fam,
          step: best + (rnd() - 0.5) * 0.6,
          jit: rnd() * 2 - 1,
          q: groom.index(px, py),
        })
      }
  }

  /** Re-derive the tuft colours from the finished baked sprite, so resting tufts are invisible. */
  matchSprite(sp: { cv: HTMLCanvasElement; x0: number; y0: number; ppu: number }) {
    const c = sp.cv.getContext('2d', { willReadFrequently: true })!
    const W = sp.cv.width
    const H = sp.cv.height
    const data = c.getImageData(0, 0, W, H).data
    this.groom.setMean(sp, data)
    const samples: { t: Tuft; col: RGB; l: number }[][] = [[], [], []]
    for (const t of this.tufts) {
      // average over a small disc along the first half of the tuft
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let k = 0; k < 6; k++) {
        const u = k / 5
        const x = t.x + Math.cos(t.ang) * t.len * 0.5 * u
        const y = t.y + Math.sin(t.ang) * t.len * 0.5 * u
        const px = Math.round((x - sp.x0) * sp.ppu)
        const py = Math.round((y - sp.y0) * sp.ppu)
        for (const [ox, oy] of [
          [0, 0],
          [2, 0],
          [-2, 0],
          [0, 2],
          [0, -2],
        ]) {
          const X = px + ox
          const Y = py + oy
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue
          const i = (Y * W + X) * 4
          if (data[i + 3] < 200) continue
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
          n++
        }
      }
      if (!n) continue
      const col: RGB = [r / n, g / n, b / n]
      samples[t.fam].push({ t, col, l: lumOf(col) })
    }
    const Q = [0.06, 0.27, 0.5, 0.73, 0.94]
    samples.forEach((list, fam) => {
      if (list.length < 5) return
      list.sort((p, q) => p.l - q.l)
      const avg = (lo: number, hi: number): RGB => {
        const a = Math.floor(lo * list.length)
        const z = Math.max(a + 1, Math.floor(hi * list.length))
        let r = 0
        let g = 0
        let b = 0
        for (let i = a; i < z; i++) {
          r += list[i].col[0]
          g += list[i].col[1]
          b += list[i].col[2]
        }
        return [r / (z - a), g / (z - a), b / (z - a)]
      }
      this.ramps[fam] = Q.map((q) => avg(Math.max(0, q - 0.08), Math.min(1, q + 0.08)))
      list.forEach((s, i) => {
        s.t.step = Math.min(4, (i / list.length) * 5 - 0.5 + 0.0)
      })
    })
    this.matched = true
  }

  /** Draw with a local->device matrix. `half` draws every other tuft (degraded mode). */
  draw(ctx: CanvasRenderingContext2D, m: Mat, unitPx: number, half: boolean, gain: { sleek: number; ruffle: number }) {
    const g = this.groom
    const base: Path2D[] = []
    const tip: Path2D[] = []
    for (let i = 0; i < 15; i++) {
      base.push(new Path2D())
      tip.push(new Path2D())
    }
    const used = new Uint8Array(15)
    const T = this.tufts
    const [a, b, c, d, e, f] = m
    for (let i = half ? 1 : 0; i < T.length; i += half ? 2 : 1) {
      const t = T[i]
      let ang = t.ang
      let len = t.len
      let step = t.step
      const q = t.q
      if (q >= 0) {
        const cx = g.cx[q]
        const cy = g.cy[q]
        const ml = Math.hypot(cx, cy)
        const fx = Math.cos(t.ang)
        const fy = Math.sin(t.ang)
        if (ml > 0.01) {
          const dot = (cx * fx + cy * fy) / ml
          const cross = (fx * cy - fy * cx) / ml
          let delta = Math.atan2(cross, dot)
          delta = Math.max(-MAX_ROT, Math.min(MAX_ROT, delta))
          ang += delta * Math.min(1, ml * 1.6)
          const along = cx * fx + cy * fy
          if (along < -0.08) {
            const ruf = Math.min(1, (-along - 0.08) / 0.4)
            ang += t.jit * 1.4 * ruf
            step -= gain.ruffle * ruf
            len *= 1 + 0.3 * ruf
          } else if (along > 0) {
            step += gain.sleek * g.sleek[q] * Math.min(1, along * 2)
          }
        }
        len *= 1 - 0.45 * g.press[q]
      }
      const s = Math.max(0, Math.min(4, Math.round(step)))
      const k = t.fam * 5 + s
      used[k] = 1
      const dx = Math.cos(ang) * len
      const dy = Math.sin(ang) * len
      const bx = t.x
      const by = t.y
      const mx = bx + dx * 0.45 + dy * 0.12 * t.jit
      const my = by + dy * 0.45 - dx * 0.12 * t.jit
      const tx = bx + dx
      const ty = by + dy
      const X = (x: number, y: number) => a * x + c * y + e
      const Y = (x: number, y: number) => b * x + d * y + f
      const p0x = X(bx, by)
      const p0y = Y(bx, by)
      const pmx = X(mx, my)
      const pmy = Y(mx, my)
      const ptx = X(tx, ty)
      const pty = Y(tx, ty)
      const pb = base[k]
      pb.moveTo(p0x, p0y)
      pb.quadraticCurveTo(pmx, pmy, ptx, pty)
      const pt = tip[k]
      const hx = (p0x + pmx) * 0.5
      const hy = (p0y + pmy) * 0.5
      pt.moveTo(hx, hy)
      pt.quadraticCurveTo((pmx + ptx) * 0.5, (pmy + pty) * 0.5, ptx, pty)
    }
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineWidth = 0.013 * unitPx
    ctx.globalAlpha = 0.5
    for (let k = 0; k < 15; k++) {
      if (!used[k]) continue
      const fam = (k / 5) | 0
      const s = k % 5
      ctx.strokeStyle = css(this.ramps[fam][Math.max(0, s - 1)])
      ctx.stroke(base[k])
    }
    ctx.lineWidth = 0.008 * unitPx
    ctx.globalAlpha = 0.9
    for (let k = 0; k < 15; k++) {
      if (!used[k]) continue
      const fam = (k / 5) | 0
      ctx.strokeStyle = css(this.ramps[fam][k % 5])
      ctx.stroke(tip[k])
    }
    ctx.restore()
  }
}
