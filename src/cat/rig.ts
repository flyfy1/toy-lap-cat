// Rest-pose rig of the cat (design doc 1.2-1.4): part silhouettes, fur flow, coat pattern.
// All geometry is in HW (head width) units. Cat space: origin O, x right, y down.

import type { PathFn } from './field'
import { clamp01, makeNoise, smoothstep } from './noise'
import { COAT } from './palette'

export const D2R = Math.PI / 180
export type V2 = [number, number]

export type PartId = 'tailA' | 'tailB' | 'tailC' | 'belly' | 'torso' | 'thigh' | 'footNear' | 'legFar' | 'chest' | 'legNear' | 'earL' | 'earR' | 'head'

/** Pattern sample: white amount, stripe amount, tone multiplier (1 = plain coat). */
export interface Pat {
  w: number
  s: number
  tone: number
}

export interface PartDef {
  id: PartId
  /** local bbox, padded for fringe */
  bbox: [number, number, number, number]
  path: PathFn
  /** fur direction (radians) at a local point */
  flow(x: number, y: number): number
  pat(x: number, y: number): Pat
  /** stroke length at a local point (HW) */
  len(x: number, y: number): number
  /** direction jitter (radians) at a local point */
  jitter(x: number, y: number): number
  /** shading radius: distance from the edge at which the surface faces the viewer */
  R: number
  /** rest transform local -> cat space */
  toCat: Mat
  /** stroke density multiplier */
  density?: number
  /** ambient occlusion blobs in local coords: x, y, r, alpha */
  ao?: [number, number, number, number][]
  /** where no fur strokes go (local), e.g. the inner ear */
  noFur?: (x: number, y: number) => boolean
  /** fringe length multiplier (default 1.05) */
  fringe?: number
  /** extra painting on the baked sprite after shading (local coords) */
  decorate?: (c: CanvasRenderingContext2D) => void
  tufts?: boolean
  /** extra pseudo-height bumps for shading (local) */
  bump?: (x: number, y: number) => number
}

export type Mat = [number, number, number, number, number, number]
export const ident: Mat = [1, 0, 0, 1, 0, 0]
export function mul(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
}
export const tr = (x: number, y: number): Mat => [1, 0, 0, 1, x, y]
export const rot = (a: number): Mat => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]
export const scl = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0]
export const apply = (m: Mat, x: number, y: number): V2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
export function inv(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2]
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

// ---------- curves ----------

function catmull(pts: V2[], n: number): V2[] {
  const out: V2[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let k = 0; k < n; k++) {
      const t = k / n
      const t2 = t * t
      const t3 = t2 * t
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** A polyline with arc-length parameter and nearest-point queries. */
export class Curve {
  pts: V2[]
  cum: number[]
  len: number
  constructor(ctrl: V2[], n = 16) {
    this.pts = catmull(ctrl, n)
    this.cum = [0]
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(this.pts[i][0] - this.pts[i - 1][0], this.pts[i][1] - this.pts[i - 1][1]))
    this.len = this.cum[this.cum.length - 1]
  }
  /** point and unit tangent at arc fraction u */
  at(u: number): { p: V2; t: V2 } {
    const s = Math.max(0, Math.min(1, u)) * this.len
    let i = 1
    while (i < this.cum.length - 1 && this.cum[i] < s) i++
    const a = this.pts[i - 1]
    const b = this.pts[i]
    const seg = this.cum[i] - this.cum[i - 1] || 1
    const f = (s - this.cum[i - 1]) / seg
    const tx = (b[0] - a[0]) / seg
    const ty = (b[1] - a[1]) / seg
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], t: [tx, ty] }
  }
  /** nearest point: arc fraction u, signed distance (positive on the right-hand side = belly side), tangent */
  nearest(x: number, y: number): { u: number; s: number; t: V2 } {
    let best = 1e9
    let bu = 0
    let bs = 0
    let bt: V2 = [1, 0]
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1]
      const b = this.pts[i]
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const l2 = dx * dx + dy * dy || 1e-9
      let f = ((x - a[0]) * dx + (y - a[1]) * dy) / l2
      f = f < 0 ? 0 : f > 1 ? 1 : f
      const px = a[0] + dx * f
      const py = a[1] + dy * f
      const d2 = (x - px) * (x - px) + (y - py) * (y - py)
      if (d2 < best) {
        best = d2
        const l = Math.sqrt(l2)
        bt = [dx / l, dy / l]
        bu = (this.cum[i - 1] + l * f) / this.len
        // right-hand normal of travel in y-down coords is (-ty, tx)
        bs = (x - px) * -bt[1] + (y - py) * bt[0] >= 0 ? Math.sqrt(d2) : -Math.sqrt(d2)
      }
    }
    return { u: bu, s: bs, t: bt }
  }
}

// ---------- shape helpers ----------

type Ctx = CanvasRenderingContext2D | Path2D
function ell(c: Ctx, cx: number, cy: number, rx: number, ry: number, r = 0) {
  c.moveTo(cx + Math.cos(r) * rx, cy + Math.sin(r) * rx)
  c.ellipse(cx, cy, rx, ry, r, 0, Math.PI * 2)
}
function circ(c: Ctx, x: number, y: number, r: number) {
  c.moveTo(x + r, y)
  c.arc(x, y, r, 0, Math.PI * 2)
}
/** union of circles along a curve with radius r(u) offset sideways by off(u) */
function sweep(c: Ctx, cv: Curve, r: (u: number) => number, off: (u: number) => number = () => 0, n = 48, u0 = 0, u1 = 1) {
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n
    const { p, t } = cv.at(u)
    const o = off(u)
    circ(c, p[0] - t[1] * o, p[1] + t[0] * o, r(u))
  }
}
const gauss = (x: number, s: number) => Math.exp(-(x * x) / (2 * s * s))
const angDiff = (a: number, b: number) => {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}
const lerpPiece = (u: number, keys: [number, number][]) => {
  if (u <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++)
    if (u <= keys[i][0]) {
      const [u0, v0] = keys[i - 1]
      const [u1, v1] = keys[i]
      const f = (u - u0) / (u1 - u0)
      const s = f * f * (3 - 2 * f)
      return v0 + (v1 - v0) * s
    }
  return keys[keys.length - 1][1]
}

// ---------- the rig ----------

// Curled side-lying kitten ("loaf"): round bean torso on the ground line (y ~ 0.6), head resting low on
// the chest, near front paw curled up under the chin showing its toe beans, far front paw tucked flat,
// hind leg folded with a big haunch and the foot tucked forward under it, tail wrapped round the front.
export const HEAD_C: V2 = [-0.86, -0.36]
export const HEAD_ROT = -10 * D2R
export const EYE = { x: 0.23, y: 0.04, w: 0.24, h: 0.22 }
export const NOSE = { y: 0.2, w: 0.09, h: 0.06 }
export const EAR = { x: 0.33, y: -0.255, base: 0.34, h: 0.36, tilt: 22 * D2R, extraLeft: 4 * D2R }
export const GROUND = 0.6
/** Cat-space extent of the rest pose including whisker reach (for layout). */
export const EXTENT = { x0: -1.66, x1: 1.32, y0: -1.12, y1: 0.86 }

export const spine = new Curve([
  [-0.55, -0.4],
  [-0.08, -0.6],
  [0.5, -0.58],
  [0.95, -0.3],
  [1.08, 0.16],
])
const thick = (u: number) =>
  COAT.wide *
  lerpPiece(u, [
    [0, 0.84],
    [0.22, 1.1],
    [0.5, 1.2],
    [0.78, 1.05],
    [0.92, 0.84],
    [1, 0.66],
  ])

/** Tail: root inside the rump, round the back of the haunch, then along the ground in front of the
 *  hind foot to the front paws. tailA (behind the body) and tailB (on the ground, in front) meet at the joint. */
export const tailCurve = new Curve([
  [0.9, 0.02],
  [1.16, 0.3],
  [1.13, 0.58],
  [0.8, 0.73],
  [0.3, 0.76],
  [-0.12, 0.7],
  [-0.36, 0.6],
])
const tailR = (u: number) => (0.098 - 0.026 * u) * (u > 0.955 ? Math.sqrt(Math.max(0, 1 - (u - 0.955) / 0.05)) * 0.88 + 0.12 : 1)
export const TAIL_JOINT = 0.27
/** the tail tip (tailC) swings about this point: twitch, thump, whip, curl */
export const TAIL_TIP_JOINT = 0.76

/** Torso coordinates of a cat-space point: u along the spine (0 neck .. 1 rump), v across (0 spine .. 1 belly). */
export function torsoUV(x: number, y: number) {
  const { u, s } = spine.nearest(x, y)
  return { u, v: s / thick(u) }
}

// near front leg: from the shoulder down and forward, wrist bent, paw curled up toward the chin, sole to the viewer
const legNearC = new Curve([
  [-0.3, 0.02],
  [-0.48, 0.24],
  [-0.62, 0.36],
])
// far front leg: tucked flat along the ground, paw from above (white mitten)
const legFarC = new Curve([
  [-0.2, 0.36],
  [-0.32, 0.5],
  [-0.42, 0.55],
])
/** paw centre and the direction its toes point */
export const PAW_NEAR = { x: -0.74, y: 0.33, a: Math.atan2(-0.55, -1) }
export const PAW_FAR = { x: -0.53, y: 0.57, a: Math.PI + 0.1 }
export const THIGH = { x: 0.78, y: 0.17, rx: 0.44, ry: 0.39, r: -18 * D2R }
/** hind foot, folded forward under the haunch: heel (under the thigh) to toes */
export const FOOT = { hx: 0.8, hy: 0.5, tx: 0.48, ty: 0.56 }

function pawPath(c: Ctx, x: number, y: number, a: number, s = 1) {
  ell(c, x, y, 0.135 * s, 0.112 * s, a)
  // 4 toe bumps along the front edge
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  for (let k = 0; k < 4; k++) {
    const off = (k - 1.5) * 0.056 * s
    const fwd = (0.098 - 0.012 * Math.abs(k - 1.5)) * s
    circ(c, x + ca * fwd - sa * off, y + sa * fwd + ca * off, 0.046 * s)
  }
}

/** Pink pads on a paw whose sole faces the viewer: a lobed main pad and four toe beans. */
function toeBeans(c: CanvasRenderingContext2D, x: number, y: number, a: number, s: number) {
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const at = (f: number, o: number): V2 => [x + ca * f * s - sa * o * s, y + sa * f * s + ca * o * s]
  const pad = (px: number, py: number, rx: number, ry: number, rot: number) => {
    const g = c.createRadialGradient(px - 0.25 * rx, py - 0.3 * ry, 0, px, py, Math.max(rx, ry) * 1.05)
    g.addColorStop(0, '#F4BDB7')
    g.addColorStop(0.6, '#E7A3A0')
    g.addColorStop(0.9, '#CF8B88')
    g.addColorStop(1, 'rgba(207,139,136,0)')
    c.fillStyle = g
    c.beginPath()
    c.ellipse(px, py, rx, ry, rot, 0, Math.PI * 2)
    c.fill()
  }
  c.save()
  // soft shadow so the pads sit in the fur
  c.fillStyle = 'rgba(150,110,100,0.18)'
  c.beginPath()
  const [mx, my] = at(-0.02, 0)
  c.ellipse(mx, my + 0.004, 0.068 * s, 0.056 * s, a, 0, Math.PI * 2)
  c.fill()
  // main (metacarpal) pad: three lobes toward the toes
  for (const o of [-0.026, 0, 0.026]) {
    const [px, py] = at(-0.018 + (o === 0 ? 0.006 : 0), o)
    pad(px, py, 0.034 * s, 0.03 * s, a)
  }
  const [cx, cy] = at(-0.036, 0)
  pad(cx, cy, 0.05 * s, 0.032 * s, a + Math.PI / 2)
  // toe beans in an arc
  for (let k = 0; k < 4; k++) {
    const o = (k - 1.5) * 0.034
    const f = 0.062 - 0.012 * Math.abs(k - 1.5)
    const [px, py] = at(f, o)
    pad(px, py, 0.02 * s, 0.017 * s, a)
  }
  // highlights
  c.fillStyle = 'rgba(255,240,236,0.55)'
  for (let k = 0; k < 4; k++) {
    const o = (k - 1.5) * 0.034
    const f = 0.062 - 0.012 * Math.abs(k - 1.5)
    const [px, py] = at(f + 0.004, o - 0.004)
    c.beginPath()
    c.ellipse(px, py, 0.006 * s, 0.004 * s, a, 0, Math.PI * 2)
    c.fill()
  }
  c.restore()
}

function headPath(c: Ctx) {
  const N = 140
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2
    const bump = 0.1 * gauss(angDiff(th, 30 * D2R), 20 * D2R) + 0.1 * gauss(angDiff(th, 150 * D2R), 20 * D2R) - 0.03 * gauss(angDiff(th, 90 * D2R), 22 * D2R) + 0.015 * gauss(angDiff(th, -90 * D2R), 40 * D2R)
    const x = 0.5 * Math.cos(th) * (1 + bump)
    const y = 0.43 * Math.sin(th) * (1 + bump * 0.5)
    if (i === 0) c.moveTo(x, y)
    else c.lineTo(x, y)
  }
  c.closePath()
}

/** Ear in its own frame: base centre at origin, tip up (-y). */
function earPath(c: Ctx) {
  const b = EAR.base / 2
  const h = EAR.h
  const tipR = 0.03
  c.moveTo(-b, 0.1)
  c.lineTo(-b, 0)
  c.quadraticCurveTo(-b * 0.75, -h * 0.55, -tipR, -h + tipR * 0.6)
  c.quadraticCurveTo(0, -h - tipR * 0.4, tipR, -h + tipR * 0.6)
  c.quadraticCurveTo(b * 0.85, -h * 0.5, b, 0)
  c.lineTo(b, 0.1)
  c.closePath()
}
export function earInnerPath(c: Ctx) {
  const b = EAR.base / 2
  const h = EAR.h
  c.moveTo(-b * 0.62, 0.02)
  c.quadraticCurveTo(-b * 0.45, -h * 0.5, -0.006, -h * 0.82)
  c.quadraticCurveTo(b * 0.55, -h * 0.45, b * 0.72, 0.02)
  c.closePath()
}
const inEarInner = (x: number, y: number) => {
  const b = EAR.base / 2
  const h = EAR.h
  if (y > 0.0 || y < -h * 0.8) return false
  const t = -y / (h * 0.82)
  const half = b * 0.6 * (1 - t)
  return Math.abs(x - 0.0) < half
}

export interface RigOpts {
  seed: number
}

export function buildRig(o: RigOpts): PartDef[] {
  const n1 = makeNoise(o.seed * 7 + 1)
  const n2 = makeNoise(o.seed * 7 + 2)
  const fbm = (x: number, y: number) => n1(x, y) * 0.6 + n2(x * 2.3, y * 2.3) * 0.4

  const headToCat = mul(tr(HEAD_C[0], HEAD_C[1]), rot(HEAD_ROT))

  // ---- head ----
  const nose: V2 = [0, NOSE.y + 0.02]
  const head: PartDef = {
    id: 'head',
    bbox: [-0.7, -0.62, 0.7, 0.62],
    path: headPath,
    toCat: headToCat,
    R: 0.4,
    density: 1.15,
    tufts: true,
    flow(x, y) {
      const dx = x - nose[0]
      const dy = y - nose[1]
      let a = Math.atan2(dy, dx)
      // above the eyes the fur sweeps back over the skull; give the radial field a slight swirl
      a += 0.12 * fbm(x * 3, y * 3)
      // under the chin the fur flows down
      if (dy > 0.02) a = Math.atan2(dy + 0.1, dx * 0.8)
      return a
    },
    len(x, y) {
      const ax = Math.abs(x)
      const cheek = smoothstep(0.32, 0.5, ax) * smoothstep(-0.15, 0.1, y)
      return 0.045 + 0.035 * cheek + 0.012 * smoothstep(0.3, 0.42, y)
    },
    jitter(x, y) {
      return (12 + 10 * smoothstep(0.25, 0.4, y) + 8 * smoothstep(0.35, 0.5, Math.abs(x))) * D2R
    },
    pat(x, y) {
      const ax = Math.abs(x)
      const nx = x + 0.035 * n1(x * 9, y * 9)
      const ny = y + 0.035 * n2(x * 9, y * 9)
      const anx = Math.abs(nx)
      // white mask: muzzle pads + chin + thin blaze up the nose
      const pad = Math.hypot(anx - 0.08, ny - 0.27) / 0.165
      const chin = Math.hypot(nx / 0.22, (ny - 0.37) / 0.13)
      const blazeW = 0.02 + Math.max(0, ny + 0.02) * 0.32
      const blaze = ny > -0.06 && ny < 0.27 ? anx / blazeW : 9
      let w = smoothstep(1.08, 0.82, Math.min(pad, chin, blaze))
      // stripes
      let s = 0
      // forehead: fan of lines radiating from the nose (reads as the tabby "M")
      const fr = Math.hypot(nx, ny - 0.18)
      const fphi = Math.atan2(nx, -(ny - 0.18))
      if (Math.abs(fphi) < 0.95) {
        const k = Math.pow(Math.max(0, Math.cos(fphi * 27)), 2.2)
        const region = smoothstep(0.3, 0.36, fr) * smoothstep(0.95, 0.6, Math.abs(fphi)) * smoothstep(0.75, 0.55, fr)
        s = Math.max(s, k * region * (1 - 0.35 * smoothstep(0.0, 0.3, Math.abs(fphi))))
      }
      // the "M" cap: a darker arc above the brows
      const capY = -0.1 - 0.06 * Math.cos(fphi * 3)
      s = Math.max(s, smoothstep(0.035, 0.0, Math.abs(ny - capY)) * smoothstep(0.26, 0.12, anx) * 0.7)
      // eye-corner line out to the cheek
      if (anx > 0.3) {
        const q = ny - 0.32 * (anx - 0.34) - 0.045
        s = Math.max(s, smoothstep(0.022, 0.006, Math.abs(q)) * smoothstep(0.33, 0.38, anx) * smoothstep(0.58, 0.48, anx))
        // two more cheek stripes below
        const q2 = ny - 0.5 * (anx - 0.34) - 0.13
        s = Math.max(s, smoothstep(0.02, 0.005, Math.abs(q2)) * smoothstep(0.36, 0.42, anx) * smoothstep(0.58, 0.5, anx) * 0.9)
        const q3 = ny - 0.6 * (anx - 0.34) - 0.21
        s = Math.max(s, smoothstep(0.018, 0.004, Math.abs(q3)) * smoothstep(0.38, 0.44, anx) * smoothstep(0.56, 0.5, anx) * 0.7)
      }
      // pale ring around the eyes, pale cheeks
      const ex = (anx - EYE.x) / (EYE.w * 0.5)
      const ey = (ny - EYE.y) / (EYE.h * 0.5)
      const er = Math.hypot(ex, ey)
      const ring = smoothstep(1.75, 1.15, er)
      s *= 1 - ring
      let tone = 1 + 0.28 * ring
      tone *= 1 + 0.2 * smoothstep(0.05, 0.3, y) * smoothstep(0.15, 0.45, ax) // lighter lower cheeks
      tone *= 1 - 0.1 * smoothstep(-0.1, -0.4, y) // darker crown
      w = clamp01(w + 0.35 * smoothstep(0.32, 0.42, y) * smoothstep(0.3, 0.1, ax))
      return { w, s: clamp01(s), tone }
    },
    bump(x, y) {
      // muzzle pads and cheeks bulge toward the viewer; brow ridge slight
      const pad = Math.max(gauss(Math.hypot(Math.abs(x) - 0.075, y - 0.26), 0.07), 0)
      const cheek = gauss(Math.hypot(Math.abs(x) - 0.33, y - 0.17), 0.12)
      const eyeSocket = -gauss(Math.hypot(Math.abs(x) - EYE.x, y - EYE.y), 0.09)
      return 0.5 * pad + 0.25 * cheek + 0.2 * eyeSocket
    },
  }

  // ---- ears ----
  const earDef = (id: 'earL' | 'earR', side: -1 | 1): PartDef => {
    const tilt = side * (EAR.tilt + (side < 0 ? EAR.extraLeft : 0))
    return {
      id,
      bbox: [-0.26, -0.48, 0.26, 0.16],
      path: earPath,
      toCat: mul(headToCat, mul(tr(side * EAR.x, EAR.y), rot(tilt))),
      R: 0.08,
      density: 1.2,
      noFur: inEarInner,
      flow(x, y) {
        return Math.atan2(-1, (x * 1.2) / Math.max(0.05, 0.4 + y)) + 0.1 * n1(x * 9, y * 9)
      },
      len: () => 0.038,
      jitter: () => 14 * D2R,
      pat(_x, y) {
        return { w: 0, s: 0.25 * smoothstep(-0.2, -0.33, y), tone: 0.9 }
      },
    }
  }

  // ---- torso ----
  const torsoPath: PathFn = (c) => {
    sweep(c, spine, (u) => thick(u) / 2, (u) => thick(u) / 2 - 0.01, 60)
    // chest / shoulder bulk under the head, belly resting on the ground
    ell(c, -0.38, -0.02, 0.42, 0.44)
    ell(c, 0.2, 0.26, 0.56, 0.34)
  }
  const torso: PartDef = {
    id: 'torso',
    bbox: [-0.95, -0.92, 1.6, 0.78],
    path: torsoPath,
    toCat: ident,
    R: 0.55,
    tufts: true,
    ao: [
      [-0.62, -0.02, 0.36, 0.45],
      [-0.28, 0.42, 0.3, 0.4],
      [0.38, 0.48, 0.3, 0.35],
      [1.08, 0.3, 0.26, 0.25],
    ],
    flow(x, y) {
      const { u, s, t } = spine.nearest(x, y)
      const v = clamp01(s / thick(u))
      const a = Math.atan2(t[1], t[0]) + v * 0.95 + 0.1 * fbm(x * 2.5, y * 2.5)
      return a
    },
    len(x, y) {
      const { u, s } = spine.nearest(x, y)
      const v = clamp01(s / thick(u))
      return 0.065 + 0.015 * smoothstep(0.45, 0.85, v)
    },
    jitter(x, y) {
      const { u, s } = spine.nearest(x, y)
      const v = clamp01(s / thick(u))
      return (12 + 13 * smoothstep(0.5, 0.85, v)) * D2R
    },
    pat(x, y) {
      const { u, s } = spine.nearest(x, y)
      const v = s / thick(u)
      const nz = fbm(x * 3.2, y * 3.2)
      // mackerel bands across the back
      const phase = u * 7.6 + v * 1.6 + nz * 0.35 - 0.15
      const fr = phase - Math.floor(phase)
      let st = smoothstep(0.17, 0.09, Math.abs(fr - 0.5))
      st *= smoothstep(0.06, 0.16, u) * smoothstep(0.62, 0.4, v)
      // dark line down the spine
      st = Math.max(st, smoothstep(0.1, 0.03, v) * smoothstep(0.08, 0.18, u) * 0.85)
      // white belly and chest
      const chest = smoothstep(0.3, 0.1, u)
      const thr = 0.7 - 0.26 * chest + 0.07 * nz
      const w = clamp01(smoothstep(thr - 0.04, thr + 0.04, v) + smoothstep(-0.3, -0.5, x) * smoothstep(-0.25, 0.1, y))
      const tone = 1 - 0.08 * smoothstep(0.3, 0.0, v) + 0.06 * smoothstep(0.35, 0.6, v)
      return { w, s: st * (1 - w), tone }
    },
  }

  // ---- chest fluff (white ruff under the chin) ----
  const chest: PartDef = {
    id: 'chest',
    bbox: [-0.95, -0.36, -0.08, 0.38],
    path: (c) => {
      ell(c, -0.52, 0.02, 0.3, 0.28, -0.3)
    },
    toCat: ident,
    R: 0.24,
    density: 0.9,
    flow(x, y) {
      return Math.atan2(y + 0.3, x + 0.45) + 0.2 * n1(x * 6, y * 6)
    },
    len: () => 0.07,
    jitter: () => 22 * D2R,
    pat: () => ({ w: 1, s: 0, tone: 1 }),
  }

  // ---- front legs: short plump forearms, soft wrist, round paws ----
  const legDef = (id: 'legNear' | 'legFar', cv: Curve, paw: { x: number; y: number; a: number }, s: number, beans: boolean): PartDef => ({
    id,
    bbox: id === 'legNear' ? [-1.0, -0.15, -0.12, 0.6] : [-0.75, 0.12, 0.08, 0.78],
    path: (c) => {
      sweep(c, cv, (u) => (0.14 - 0.055 * u) * s, () => 0, 24)
      pawPath(c, paw.x, paw.y, paw.a, s)
    },
    toCat: ident,
    R: 0.12,
    fringe: 0.7,
    ao: [[paw.x - Math.cos(paw.a) * 0.1, paw.y - Math.sin(paw.a) * 0.1, 0.09, 0.18]],
    decorate(c) {
      if (beans) {
        toeBeans(c, paw.x, paw.y, paw.a, s)
        return
      }
      // soft creases between the toes
      const ca = Math.cos(paw.a)
      const sa = Math.sin(paw.a)
      c.save()
      c.lineCap = 'round'
      c.strokeStyle = 'rgba(120,105,90,0.4)'
      c.lineWidth = 0.009
      c.beginPath()
      for (let i = 0; i < 3; i++) {
        const off = (i - 1) * 0.056 * s
        const x0 = paw.x + ca * 0.07 * s - sa * off
        const y0 = paw.y + sa * 0.07 * s + ca * off
        c.moveTo(x0, y0)
        c.lineTo(x0 + ca * 0.065 * s, y0 + sa * 0.065 * s)
      }
      c.stroke()
      c.restore()
    },
    noFur: beans ? (x, y) => Math.hypot(x - paw.x, y - paw.y) < 0.075 * s : undefined,
    flow(x, y) {
      const d = Math.hypot(x - paw.x, y - paw.y)
      if (d < 0.17 * s) {
        // fur on the paw: outward from the sole when it faces us, toward the toes otherwise
        if (beans) return Math.atan2(y - paw.y, x - paw.x) + 0.15 * n1(x * 10, y * 10)
        return paw.a + 0.15 * n1(x * 10, y * 10)
      }
      const { t } = cv.nearest(x, y)
      return Math.atan2(t[1], t[0]) + 0.12 * n1(x * 8, y * 8)
    },
    len: (x, y) => (Math.hypot(x - paw.x, y - paw.y) < 0.17 ? 0.026 : 0.045),
    jitter: () => 12 * D2R,
    pat: () => ({ w: 1, s: 0, tone: 1 }),
  })

  // ---- hind leg: a big round haunch with the foot folded forward under it ----
  const thigh: PartDef = {
    id: 'thigh',
    bbox: [0.18, -0.32, 1.38, 0.68],
    path: (c) => ell(c, THIGH.x, THIGH.y, THIGH.rx, THIGH.ry, THIGH.r),
    toCat: ident,
    R: 0.34,
    tufts: true,
    ao: [[0.45, 0.45, 0.2, 0.3]],
    flow(x, y) {
      // from the hip down and forward over the haunch toward the knee
      return Math.atan2(y + 0.2, x - 1.12) + 0.12 * fbm(x * 4, y * 4)
    },
    len: () => 0.066,
    jitter: () => 14 * D2R,
    pat(x, y) {
      // tabby bullseye rings on the haunch
      const r = Math.hypot((x - THIGH.x - 0.08) / 1.1, y - THIGH.y + 0.02)
      const nz = fbm(x * 4, y * 4)
      const ph = r * 8 + nz * 0.3
      const fr = ph - Math.floor(ph)
      const st = smoothstep(0.17, 0.08, Math.abs(fr - 0.5)) * smoothstep(0.08, 0.16, r)
      // white along the belly side (lower front) of the thigh
      const lx = (x - THIGH.x) * Math.cos(-THIGH.r) - (y - THIGH.y) * Math.sin(-THIGH.r)
      const ly = (x - THIGH.x) * Math.sin(-THIGH.r) + (y - THIGH.y) * Math.cos(-THIGH.r)
      const w = smoothstep(0.33, 0.4, ly - 0.25 * lx + 0.04 * nz)
      return { w, s: st * (1 - w), tone: 1 }
    },
  }
  // heel (under the haunch) -> ankle, then a round paw bulb with toe bumps pointing forward
  const footCv = new Curve([
    [FOOT.hx, FOOT.hy],
    [(FOOT.hx + FOOT.tx) / 2 + 0.04, (FOOT.hy + FOOT.ty) / 2 + 0.01],
    [FOOT.tx + 0.06, FOOT.ty],
  ])
  const footA = Math.atan2(FOOT.ty - FOOT.hy, FOOT.tx - FOOT.hx)
  const PX = FOOT.tx
  const PY = FOOT.ty + 0.005
  const toes: V2[] = [
    [PX - 0.1, PY - 0.05],
    [PX - 0.115, PY + 0.005],
    [PX - 0.095, PY + 0.06],
  ]
  const footNear: PartDef = {
    id: 'footNear',
    bbox: [FOOT.tx - 0.26, FOOT.hy - 0.2, FOOT.hx + 0.2, FOOT.ty + 0.2],
    path: (c) => {
      sweep(c, footCv, (u) => 0.1 - 0.02 * u, () => 0, 20)
      ell(c, PX, PY, 0.12, 0.105, -0.1)
      for (const [x, y] of toes) circ(c, x, y, 0.052)
    },
    toCat: ident,
    R: 0.1,
    fringe: 0.7,
    ao: [[PX + 0.13, PY - 0.02, 0.07, 0.22]],
    decorate(c) {
      // creases between the toes
      c.save()
      c.lineCap = 'round'
      c.strokeStyle = 'rgba(120,105,90,0.45)'
      c.lineWidth = 0.009
      c.beginPath()
      for (let k = 0; k < 2; k++) {
        const [ax, ay] = toes[k]
        const [bx, by] = toes[k + 1]
        const mx = (ax + bx) / 2
        const my = (ay + by) / 2
        c.moveTo(mx - 0.035, my)
        c.lineTo(mx + 0.035, my + 0.003)
      }
      c.stroke()
      c.restore()
    },
    flow: (x, y) => {
      if (Math.hypot(x - PX, y - PY) < 0.15) return Math.PI + 0.1 * Math.sign(y - PY) + 0.15 * n1(x * 10, y * 10)
      return footA + 0.12 * n1(x * 10, y * 10)
    },
    len: (x) => (x < PX + 0.1 ? 0.03 : 0.045),
    jitter: () => 12 * D2R,
    pat(x, y) {
      // a white sock on the paw; the shaft toward the heel is tabby
      const nz = n2(x * 8, y * 8)
      const w = smoothstep(PX + 0.2, PX + 0.12, x + 0.03 * nz)
      return { w, s: 0, tone: 0.92 }
    },
  }
  // ---- tail ----
  const tailDef = (id: 'tailA' | 'tailB' | 'tailC', u0: number, u1: number): PartDef => ({
    id,
    bbox: id === 'tailA' ? [0.72, -0.15, 1.38, 0.78] : id === 'tailB' ? [-0.1, 0.38, 1.32, 0.92] : [-0.62, 0.3, 0.3, 0.92],
    path: (c) => sweep(c, tailCurve, tailR, () => 0, id === 'tailA' ? 20 : 50, u0, u1),
    toCat: ident,
    R: 0.09,
    flow(x, y) {
      const { t } = tailCurve.nearest(x, y)
      return Math.atan2(t[1], t[0]) + 0.1 * n1(x * 8, y * 8)
    },
    len: () => 0.068,
    jitter: () => 12 * D2R,
    noFur: (x, y) => {
      const { u } = tailCurve.nearest(x, y)
      return u < u0 - 0.02 || u > u1 + 0.03
    },
    pat(x, y) {
      const { u } = tailCurve.nearest(x, y)
      const nz = n2(x * 6, y * 6)
      const ph = u * 9 + nz * 0.15
      const fr = ph - Math.floor(ph)
      const st = smoothstep(0.2, 0.12, Math.abs(fr - 0.5)) * smoothstep(0.05, 0.12, u)
      // dark tip
      const tip = smoothstep(0.9, 0.96, u)
      return { w: 0, s: Math.max(st, tip * 0.9), tone: 0.97 }
    },
  })

  // ---- belly: the soft white tummy shown when the cat rolls over (drawn with alpha = roll) ----
  const BC: V2 = [0.12, 0.3]
  const belly: PartDef = {
    id: 'belly',
    bbox: [-0.62, -0.12, 0.86, 0.72],
    path: (c) => ell(c, BC[0], BC[1], 0.62, 0.3, -0.06),
    toCat: ident,
    R: 0.3,
    density: 0.9,
    fringe: 1.2,
    flow: (x, y) => Math.atan2(y - BC[1] + 0.05, x - BC[0]) + 0.25 * n1(x * 5, y * 5),
    len: () => 0.085,
    jitter: () => 28 * D2R,
    pat: (x) => ({ w: 1, s: 0, tone: 1.02 - 0.04 * smoothstep(0.3, 0.7, Math.abs(x - BC[0])) }),
  }

  // draw order (back to front)
  return [
    tailDef('tailA', 0, TAIL_JOINT + 0.03),
    torso,
    belly,
    thigh,
    footNear,
    tailDef('tailB', TAIL_JOINT - 0.02, TAIL_TIP_JOINT + 0.02),
    tailDef('tailC', TAIL_TIP_JOINT - 0.02, 1),
    legDef('legFar', legFarC, PAW_FAR, 0.94, false),
    chest,
    legDef('legNear', legNearC, PAW_NEAR, 1.12, true),
    earDef('earL', -1),
    earDef('earR', 1),
    head,
  ]
}

/** Union silhouette of the whole rest-pose cat in cat space (for the contact shadow). */
export function catSilhouette(defs: PartDef[], c: CanvasRenderingContext2D) {
  for (const d of defs) {
    c.save()
    const m = d.toCat
    c.transform(m[0], m[1], m[2], m[3], m[4], m[5])
    c.beginPath()
    d.path(c)
    c.fill()
    c.restore()
  }
}
