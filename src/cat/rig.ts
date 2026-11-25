// Rest-pose rig of the cat (design doc 1.2-1.4): part silhouettes, fur flow, coat pattern.
// All geometry is in HW (head width) units. Cat space: origin O, x right, y down.

import type { PathFn } from './field'
import { clamp01, makeNoise, smoothstep } from './noise'
import { COAT } from './palette'

export const D2R = Math.PI / 180
export type V2 = [number, number]

export type PartId = 'tailA' | 'tail' | 'belly' | 'torso' | 'thigh' | 'hindNear' | 'hindFar' | 'legFar' | 'chest' | 'legNear' | 'earL' | 'earR' | 'head' | 'palmTop' | 'palmSole' | 'toeTop' | 'toeSole'

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
  /** baked straight in strip space and drawn as slices (limbs, tail), or a paw piece: not a rest-pose part */
  strip?: boolean
  paw?: boolean
  /** light direction in local space (default: the scene light) */
  light?: number[]
  /** underlay inset from the silhouette (HW; default 0.022) */
  inset?: number
  /** 0..1 where the tip hairs catch a sheen (along the back) */
  sheen?: (x: number, y: number) => number
  /** colour of what lies behind the part at a cat-space point, when it is not the rug */
  under?: (x: number, y: number) => [number, number, number] | null
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

/** Afternoon sun through a window at the upper left (cat space): 1 in the light patch, 0 in shade.
 *  The patch runs along the light direction; two mullion bars cross it. */
export const SUN_DIR: V2 = [0.35, 0.94]
export function sunAt(x: number, y: number): number {
  const across = x * 0.94 - y * 0.35
  const along = x * 0.35 + y * 0.94
  let k = smoothstep(0.57, 0.33, across) * smoothstep(-2.3, -2.0, across) * smoothstep(1.65, 1.2, along)
  // window mullions: one bar along the beam, one across it
  const bar = (d: number) => 1 - 0.85 * smoothstep(0.1, 0.035, Math.abs(d))
  k *= bar(across + 1.45) * bar(along + 1.95)
  return k
}
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
export const tailR = (u: number) => (0.098 - 0.026 * u) * (u > 0.955 ? Math.sqrt(Math.max(0, 1 - (u - 0.955) / 0.05)) * 0.88 + 0.12 : 1)

/** Torso coordinates of a cat-space point: u along the spine (0 neck .. 1 rump), v across (0 spine .. 1 belly). */
export function torsoUV(x: number, y: number) {
  const { u, s } = spine.nearest(x, y)
  return { u, v: s / thick(u) }
}

/** hind leg: the haunch ellipse (rotates about HIND.H) */
export const THIGH = { x: 0.78, y: 0.17, rx: 0.44, ry: 0.39, r: -18 * D2R }

/** Pink pad with a soft radial gradient. */
function pinkPad(c: CanvasRenderingContext2D, px: number, py: number, rx: number, ry: number, rot: number) {
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

// ---------- limb skeleton (spec 2.2), cat space, HW units ----------

export interface FrontLeg {
  S: V2
  L1: number
  L2: number
  /** rest wrist */
  W: V2
  /** rest paw direction */
  pawA: number
  /** paw scale */
  s: number
}
export const LEG_NEAR: FrontLeg = { S: [-0.3, 0.02], L1: 0.3, L2: 0.34, W: [-0.64, 0.3], pawA: 209 * D2R, s: 1.06 }
export const LEG_FAR: FrontLeg = { S: [-0.2, 0.36], L1: 0.28, L2: 0.32, W: [-0.45, 0.55], pawA: 186 * D2R, s: 0.98 }
/** hip, knee (haunch space), shank, foot, rest toe base, offset of the far hind leg */
export const HIND = { H: [1.0, 0.0] as V2, K: [0.47, 0.36] as V2, L1: 0.36, L2: 0.33, toe: [0.46, 0.615] as V2, far: [0.07, 0.05] as V2, s: 1.0 }
/** the dynamic tail strip starts here on the rest curve */
export const TAIL_U0 = 0.27
export const TAIL_LEN = tailCurve.len * (1 - TAIL_U0)

/** Polygon outline of a straight strip from x = 0 to L, half-widths rT (-y side) and rB (+y side). */
function stripPath(L: number, rT: (x: number) => number, rB: (x: number) => number, N = 40) {
  return (c: Ctx) => {
    c.moveTo(0, -rT(0))
    for (let i = 1; i <= N; i++) {
      const x = (L * i) / N
      c.lineTo(x, -rT(x))
    }
    // rounded cap at the tip
    const ry1 = (rT(L) + rB(L)) / 2
    const cy1 = (rB(L) - rT(L)) / 2
    for (let i = 1; i < 12; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / 12
      c.lineTo(L + Math.cos(a) * ry1 * 0.85, cy1 + Math.sin(a) * ry1)
    }
    for (let i = N; i >= 0; i--) {
      const x = (L * i) / N
      c.lineTo(x, rB(x))
    }
    const ry0 = (rT(0) + rB(0)) / 2
    const cy0 = (rB(0) - rT(0)) / 2
    for (let i = 1; i < 12; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / 12
      c.lineTo(Math.cos(a) * ry0 * 0.85, cy0 + Math.sin(a) * ry0)
    }
    c.closePath()
  }
}

/** The scene light turned into a strip's local frame at its rest angle, directional term scaled by k. */
function stripLight(restA: number, k: number) {
  const lx = -0.45
  const ly = -0.6
  const ca = Math.cos(-restA)
  const sa = Math.sin(-restA)
  const x = (ca * lx - sa * ly) * k
  const y = (sa * lx + ca * ly) * k
  const z = Math.sqrt(Math.max(0.05, 1 - x * x - y * y))
  return [x, y, z]
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

  // the torso's functions all ask for the nearest spine point of the same stroke root: remember the last one
  let nx0 = NaN
  let ny0 = NaN
  let nr0: ReturnType<Curve['nearest']> = { u: 0, s: 0, t: [1, 0] }
  const near = (x: number, y: number) => {
    if (x !== nx0 || y !== ny0) {
      nx0 = x
      ny0 = y
      nr0 = spine.nearest(x, y)
    }
    return nr0
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
      const { u, s, t } = near(x, y)
      const v = clamp01(s / thick(u))
      const a = Math.atan2(t[1], t[0]) + v * 0.95 + 0.1 * fbm(x * 2.5, y * 2.5)
      return a
    },
    len(x, y) {
      const { u, s } = near(x, y)
      const v = clamp01(s / thick(u))
      return 0.065 + 0.015 * smoothstep(0.45, 0.85, v)
    },
    jitter(x, y) {
      const { u, s } = near(x, y)
      const v = clamp01(s / thick(u))
      return (12 + 13 * smoothstep(0.5, 0.85, v)) * D2R
    },
    sheen(x, y) {
      const { u, s } = near(x, y)
      const v = s / thick(u)
      return smoothstep(0.1, 0.0, Math.abs(v - 0.22) - 0.0) * smoothstep(0.05, 0.2, u) * smoothstep(0.95, 0.8, u)
    },
    pat(x, y) {
      const { u, s } = near(x, y)
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

  // ---- front legs: strips from the shoulder (x = 0) to the wrist (x = L1 + L2) ----
  // the elbow points back: the outer side of the bend is -y, where the elbow bulges
  const frontDef = (id: 'legNear' | 'legFar', g: FrontLeg, k: number): PartDef => {
    const L = g.L1 + g.L2
    const e = g.L1
    const rT = (x: number) => k * lerpPiece(x, [[0, 0.125], [e * 0.6, 0.112], [e, 0.116], [e + 0.07, 0.096], [e + 0.17, 0.08], [L - 0.06, 0.07], [L, 0.074]])
    const rB = (x: number) => k * lerpPiece(x, [[0, 0.125], [e * 0.6, 0.1], [e, 0.094], [e + 0.1, 0.083], [e + 0.2, 0.074], [L - 0.06, 0.066], [L, 0.072]])
    const restA = Math.atan2(g.W[1] - g.S[1], g.W[0] - g.S[0])
    return {
      id,
      strip: true,
      bbox: [-0.16, -0.19, L + 0.13, 0.19],
      path: stripPath(L, rT, rB),
      toCat: mul(tr(g.S[0], g.S[1]), rot(restA)),
      light: stripLight(id === 'legNear' ? 183 * D2R : 194 * D2R, 0.4),
      R: 0.1,
      fringe: 0.75,
      density: 0.8,
      flow(x, y) {
        // along the limb, fanning slightly at the wrist
        const r = (rT(x) + rB(x)) / 2
        return (y / r) * 0.28 * smoothstep(L - 0.2, L, x) + 0.12 * n1(x * 8 + (id === 'legNear' ? 0 : 5), y * 8)
      },
      len: (x) => 0.038 + 0.01 * smoothstep(e + 0.1, 0.1, x),
      jitter: () => 11 * D2R,
      pat: (x) => ({ w: 1, s: 0, tone: 1 - 0.03 * smoothstep(e, 0, x) }),
      decorate(c) {
        // the root melts into the body it is drawn over
        c.save()
        c.globalCompositeOperation = 'destination-in'
        const gr = id === 'legNear' ? c.createLinearGradient(0.02, 0, 0.24, 0) : c.createLinearGradient(0.0, 0, 0.14, 0)
        gr.addColorStop(0, 'rgba(0,0,0,0)')
        gr.addColorStop(1, 'rgba(0,0,0,1)')
        c.fillStyle = gr
        c.fillRect(-0.2, -0.3, L + 0.4, 0.6)
        c.restore()
      },
    }
  }

  // ---- paws (spec 2.3): palm and toes, top (furred back) and sole views, in paw space ----
  const palmPath = (c: Ctx) => {
    ell(c, 0.098, 0, 0.104, 0.094)
    ell(c, 0.02, 0, 0.07, 0.074)
  }
  const PADC: V2 = [0.112, 0]
  const pawPiece = (id: 'palmTop' | 'palmSole' | 'toeTop' | 'toeSole'): PartDef => {
    const toe = id === 'toeTop' || id === 'toeSole'
    const sole = id === 'palmSole' || id === 'toeSole'
    const inBean = (x: number, y: number) => Math.hypot((x - 0.05) / 0.026, y / 0.022) < 1
    const inPad = (x: number, y: number) => Math.hypot((x - PADC[0]) / 0.062, y / 0.06) < 1
    return {
      id,
      paw: true,
      bbox: toe ? [-0.05, -0.075, 0.15, 0.075] : [-0.11, -0.16, 0.27, 0.16],
      path: toe ? (c) => ell(c, 0.046, 0, 0.05, 0.034) : palmPath,
      toCat: tr(-0.8, 0.3),
      light: [0, 0, 1],
      // toes are small: a narrow soft edge keeps a solid core (a wide one made them see-through wisps)
      R: toe ? 0.012 : 0.08,
      inset: toe ? 0.008 : 0.016,
      fringe: toe ? 0.45 : 0.65,
      density: toe ? 1.2 : 1.0,
      noFur: sole ? (toe ? inBean : inPad) : undefined,
      flow(x, y) {
        const nz = 0.15 * n1(x * 12 + (toe ? 3 : 0), y * 12)
        if (!sole) return (toe ? 0 : Math.atan2(y * 0.6, 1)) + nz
        // on the sole the fur grows outward from the pads
        return toe ? Math.atan2(y, x - 0.05) + nz : Math.atan2(y, x - PADC[0]) + nz
      },
      len: () => (toe ? 0.016 : 0.028),
      jitter: () => 12 * D2R,
      pat: () => ({ w: 1, s: 0, tone: sole ? 0.98 : 1 }),
      ao: toe ? undefined : [[0.19, 0, 0.06, 0.12]],
      decorate(c) {
        if (!sole) {
          if (toe) {
            // a faint crease line down each side reads as the gap between toes
            c.save()
            c.strokeStyle = 'rgba(130,112,96,0.28)'
            c.lineWidth = 0.006
            c.lineCap = 'round'
            c.beginPath()
            c.moveTo(0.01, -0.026)
            c.quadraticCurveTo(0.04, -0.031, 0.07, -0.024)
            c.moveTo(0.01, 0.026)
            c.quadraticCurveTo(0.04, 0.031, 0.07, 0.024)
            c.stroke()
            c.restore()
          }
          return
        }
        c.save()
        c.fillStyle = 'rgba(150,110,100,0.18)'
        if (toe) {
          c.beginPath()
          c.ellipse(0.05, 0.003, 0.03, 0.025, 0, 0, Math.PI * 2)
          c.fill()
          pinkPad(c, 0.05, 0, 0.024, 0.02, 0)
          c.fillStyle = 'rgba(255,240,236,0.55)'
          c.beginPath()
          c.ellipse(0.056, -0.006, 0.007, 0.005, 0, 0, Math.PI * 2)
          c.fill()
        } else {
          c.beginPath()
          c.ellipse(PADC[0], 0.004, 0.07, 0.066, 0, 0, Math.PI * 2)
          c.fill()
          // main pad: three lobes toward the toes, a wider heel
          for (const o of [-0.028, 0, 0.028]) pinkPad(c, PADC[0] + 0.022 - Math.abs(o) * 0.25, o, 0.034, 0.03, 0)
          pinkPad(c, PADC[0] - 0.012, 0, 0.034, 0.052, 0)
          c.fillStyle = 'rgba(255,240,236,0.4)'
          c.beginPath()
          c.ellipse(PADC[0] + 0.02, -0.02, 0.012, 0.007, 0.3, 0, Math.PI * 2)
          c.fill()
        }
        c.restore()
      },
    }
  }

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
  // ---- hind legs: shank (knee -> hock) and foot (hock -> toe base) as one strip ----
  const hindDef = (id: 'hindNear' | 'hindFar', tone: number): PartDef => {
    const L1 = HIND.L1
    const L = HIND.L1 + HIND.L2
    const rT = (x: number) => lerpPiece(x, [[0, 0.1], [0.12, 0.08], [L1 - 0.06, 0.07], [L1, 0.088], [L1 + 0.08, 0.078], [L, 0.076]])
    const rB = (x: number) => lerpPiece(x, [[0, 0.1], [0.12, 0.078], [L1 - 0.06, 0.068], [L1, 0.075], [L1 + 0.1, 0.072], [L, 0.074]])
    return {
      id,
      strip: true,
      bbox: [-0.15, -0.16, L + 0.12, 0.16],
      path: stripPath(L, rT, rB),
      toCat: mul(tr(0.8, 0.5), rot(Math.PI)),
      light: stripLight(190 * D2R, 0.4),
      R: 0.08,
      fringe: 0.75,
      density: 0.7,
      flow: (x, y) => 0.12 * n1(x * 9 + 2, y * 9),
      len: () => 0.04,
      jitter: () => 12 * D2R,
      pat(x, y) {
        // a white sock toward the toes; tabby with faint bars up the shank
        const nz = n2(x * 8, y * 8)
        const w = smoothstep(L1 - 0.04, L1 + 0.06, x + 0.03 * nz)
        const ph = x * 9 + nz * 0.2
        const fr = ph - Math.floor(ph)
        const st = 0.6 * smoothstep(0.2, 0.1, Math.abs(fr - 0.5)) * smoothstep(L1 + 0.05, L1 - 0.05, x)
        return { w, s: st * (1 - w), tone: tone * 0.94 }
      },
    }
  }
  // ---- tail: tailA rigid behind the rump; the rest is one strip along a dynamic curve ----
  const tailPat = (u: number, x: number, y: number) => {
    const nz = n2(x * 6, y * 6)
    const ph = u * 9 + nz * 0.15
    const fr = ph - Math.floor(ph)
    const st = smoothstep(0.2, 0.12, Math.abs(fr - 0.5)) * smoothstep(0.05, 0.12, u)
    const tip = smoothstep(0.9, 0.96, u)
    return { w: 0, s: Math.max(st, tip * 0.9), tone: 0.97 }
  }
  const tailA: PartDef = {
    id: 'tailA',
    bbox: [0.72, -0.15, 1.38, 0.78],
    path: (c) => sweep(c, tailCurve, tailR, () => 0, 20, 0, TAIL_U0 + 0.03),
    toCat: ident,
    R: 0.09,
    flow(x, y) {
      const { t } = tailCurve.nearest(x, y)
      return Math.atan2(t[1], t[0]) + 0.1 * n1(x * 8, y * 8)
    },
    len: () => 0.068,
    jitter: () => 12 * D2R,
    noFur: (x, y) => tailCurve.nearest(x, y).u > TAIL_U0 + 0.06,
    pat(x, y) {
      return tailPat(tailCurve.nearest(x, y).u, x, y)
    },
  }
  const TL = TAIL_LEN
  const uOf = (x: number) => TAIL_U0 + (x / TL) * (1 - TAIL_U0)
  const tailStrip: PartDef = {
    id: 'tail',
    strip: true,
    bbox: [-0.14, -0.15, TL + 0.1, 0.15],
    path: stripPath(TL, (x) => tailR(uOf(Math.min(TL, x))), (x) => tailR(uOf(Math.min(TL, x))), 80),
    toCat: mul(tr(1.1, 0.64), rot(Math.PI)),
    light: [0, -0.18, 0.98],
    R: 0.09,
    density: 0.8,
    flow: (x, y) => 0.1 * n1(x * 8, y * 8),
    len: () => 0.068,
    jitter: () => 12 * D2R,
    pat: (x, y) => tailPat(uOf(x), x, y),
  }

  // ---- belly: the soft white tummy shown when the cat rolls over (drawn with alpha = roll) ----
  const BC: V2 = [0.14, 0.3]
  const belly: PartDef = {
    id: 'belly',
    bbox: [-0.62, -0.12, 0.86, 0.72],
    path: (c) => ell(c, BC[0], BC[1], 0.56, 0.26, -0.06),
    toCat: ident,
    R: 0.3,
    density: 0.9,
    fringe: 1.2,
    flow: (x, y) => Math.atan2(y - BC[1] + 0.05, x - BC[0]) + 0.25 * n1(x * 5, y * 5),
    len: () => 0.085,
    jitter: () => 28 * D2R,
    pat: (x) => ({ w: 1, s: 0, tone: 1.02 - 0.04 * smoothstep(0.3, 0.7, Math.abs(x - BC[0])) }),
  }

  // what lies behind the haunch's and the head's lower edges, when it is white fur (the belly / chest of a
  // bicolour coat); null otherwise, so solid coats keep their normal fringe
  const behind = (x: number, y: number): [number, number, number] | null => {
    const { u, s: sd } = near(x, y)
    const v = sd / thick(u)
    if (v < -0.05 || v > 1.02) return null
    return torso.pat(x, y).w > 0.5 ? [240, 236, 228] : null
  }
  thigh.under = behind
  head.under = behind
  // bake order (drawing order is set in Cat.draw)
  return [
    tailA,
    torso,
    belly,
    thigh,
    hindDef('hindNear', 1),
    hindDef('hindFar', 0.92),
    tailStrip,
    frontDef('legFar', LEG_FAR, 0.96),
    chest,
    frontDef('legNear', LEG_NEAR, 1.04),
    pawPiece('palmTop'),
    pawPiece('palmSole'),
    pawPiece('toeTop'),
    pawPiece('toeSole'),
    earDef('earL', -1),
    earDef('earR', 1),
    head,
  ]
}

/** Union silhouette of the whole rest-pose cat in cat space (for the contact shadow). */
export function catSilhouette(defs: PartDef[], c: CanvasRenderingContext2D) {
  for (const d of defs) {
    if (d.strip || d.paw) continue
    c.save()
    const m = d.toCat
    c.transform(m[0], m[1], m[2], m[3], m[4], m[5])
    c.beginPath()
    d.path(c)
    c.fill()
    c.restore()
  }
}
