// Limbs (polish v2, spec 2.1-2.5): each limb is baked straight in strip space (root at x = 0, axis +x)
// and drawn every frame as slices along a bone curve. Bones have constant lengths; IK never stretches.

import type { Sprite } from './bake'
import { type Mat, type V2, mul, rot, scl, tr } from './rig'

export const D = Math.PI / 180

/** A centreline node: strip coordinate x and its cat-space point. */
export interface Node {
  x: number
  p: V2
}

const angDiff = (a: number, b: number) => {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}
export { angDiff }

/** Two-bone IK from root R toward target T. sigma picks the bend side and never flips.
 *  Out-of-reach targets are clamped to 97 % of full extension along the same direction. */
export function ik2(R: V2, T: V2, L1: number, L2: number, sigma: 1 | -1) {
  const dx = T[0] - R[0]
  const dy = T[1] - R[1]
  let d = Math.hypot(dx, dy) || 1e-6
  const ux = dx / d
  const uy = dy / d
  const dmax = 0.97 * (L1 + L2)
  const dmin = Math.abs(L1 - L2) + 0.03
  const clamped = d > dmax
  d = Math.min(dmax, Math.max(dmin, d))
  const ca = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)
  const al = Math.acos(Math.max(-1, Math.min(1, ca)))
  const ea = Math.atan2(uy, ux) + sigma * al
  const E: V2 = [R[0] + L1 * Math.cos(ea), R[1] + L1 * Math.sin(ea)]
  const W: V2 = [R[0] + ux * d, R[1] + uy * d]
  return { E, W, clamped, reach: d / (L1 + L2) }
}

/** Centreline of a two-bone limb: straight bones with the joint filleted by a quadratic Bezier
 *  spanning +-f of arc length. Strip x runs 0..L1+L2. */
export function boneNodes(S: V2, E: V2, W: V2, L1: number, L2: number, f: number): Node[] {
  const a1 = Math.atan2(E[1] - S[1], E[0] - S[0])
  const a2 = Math.atan2(W[1] - E[1], W[0] - E[0])
  const turn = Math.abs(angDiff(a2, a1))
  if (turn < 2 * D) return [
    { x: 0, p: S },
    { x: L1, p: E },
    { x: L1 + L2, p: W },
  ]
  const ff = Math.min(f, L1 * 0.45, L2 * 0.45)
  const A: V2 = [E[0] - Math.cos(a1) * ff, E[1] - Math.sin(a1) * ff]
  const B: V2 = [E[0] + Math.cos(a2) * ff, E[1] + Math.sin(a2) * ff]
  const out: Node[] = [
    { x: 0, p: S },
    { x: L1 - ff, p: A },
  ]
  const m = Math.max(2, Math.ceil(turn / (6 * D)))
  for (let i = 1; i < m; i++) {
    const t = i / m
    const u = 1 - t
    out.push({ x: L1 - ff + 2 * ff * t, p: [u * u * A[0] + 2 * u * t * E[0] + t * t * B[0], u * u * A[1] + 2 * u * t * E[1] + t * t * B[1]] })
  }
  out.push({ x: L1 + ff, p: B })
  out.push({ x: L1 + L2, p: W })
  return out
}

export interface StripStats {
  slices: number
}

/** Draw a straight-baked strip sprite along the nodes. Slices turn at most 8 deg each; neighbours
 *  overlap by halfW*|dTheta|/2 + 0.5 device px so the outer edge of a bend stays closed.
 *  Only slices whose middle lies in [from, to) are drawn (to split a limb across layers). */
export function drawStrip(ctx: CanvasRenderingContext2D, dev: Mat, sp: Sprite, nodes: Node[], halfW: number, from = -1e9, to = 1e9, st?: StripStats) {
  const n = nodes.length
  if (n < 2) return
  const seg: number[] = []
  for (let k = 0; k < n - 1; k++) seg.push(Math.atan2(nodes[k + 1].p[1] - nodes[k].p[1], nodes[k + 1].p[0] - nodes[k].p[0]))
  // group segments into slices
  const sl: [number, number][] = []
  let i = 0
  while (i < n - 1) {
    let j = i + 1
    while (j < n - 1 && Math.abs(angDiff(seg[j], seg[i])) <= 8 * D) j++
    sl.push([i, j])
    i = j
  }
  const th = sl.map(([a, b]) => Math.atan2(nodes[b].p[1] - nodes[a].p[1], nodes[b].p[0] - nodes[a].p[0]))
  const unit = Math.hypot(dev[0], dev[1])
  const halfPx = 0.5 / unit
  const sx0 = sp.x0
  const sx1 = sp.x0 + sp.bw
  const ppu = sp.ppu
  const H = sp.cv.height
  for (let s = 0; s < sl.length; s++) {
    const [a, b] = sl[s]
    const Xi = nodes[a].x
    const Xj = nodes[b].x
    const mid = (Xi + Xj) / 2
    if (mid < from || mid >= to) continue
    const ovL = s > 0 ? halfW * Math.abs(angDiff(th[s], th[s - 1])) * 0.5 + halfPx : 0
    const ovR = s < sl.length - 1 ? halfW * Math.abs(angDiff(th[s + 1], th[s])) * 0.5 + halfPx : 0
    const Xa = s === 0 ? sx0 : Xi - ovL
    const Xb = s === sl.length - 1 ? sx1 : Xj + ovR
    const P = nodes[a].p
    const Q = nodes[b].p
    const chord = Math.hypot(Q[0] - P[0], Q[1] - P[1])
    const sx = Xj - Xi > 1e-6 ? chord / (Xj - Xi) : 1
    const m = mul(dev, mul(tr(P[0], P[1]), mul(rot(th[s]), scl(sx, 1))))
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    const c0 = Math.max(0, (Xa - sx0) * ppu)
    const c1 = Math.min(sp.cv.width, (Xb - sx0) * ppu)
    if (c1 - c0 < 0.5) continue
    ctx.drawImage(sp.cv, c0, 0, c1 - c0, H, sx0 + c0 / ppu - Xi, sp.y0, (c1 - c0) / ppu, sp.bh)
    if (st) st.slices++
  }
}

/** Live contact shadow of a limb: one path, three nested strokes (no blur filters per frame). */
export function limbShadow(ctx: CanvasRenderingContext2D, dev: Mat, pts: V2[], r: number, lift: number, k = 1) {
  const ox = 0.022 * (1 + 3 * lift)
  const oy = 0.038 * (1 + 3 * lift)
  ctx.setTransform(dev[0], dev[1], dev[2], dev[3], dev[4], dev[5])
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + ox, pts[i][1] + oy)
  for (const [w, a] of [
    [2 * r + 0.05, 0.08],
    [2 * r + 0.025, 0.1],
    [2 * r, 0.12],
  ]) {
    ctx.strokeStyle = `rgba(90,67,50,${a * k})`
    ctx.lineWidth = w
    ctx.stroke()
  }
}

/** Soft elliptical shadow (paws), three nested ellipses. */
export function blobShadow(ctx: CanvasRenderingContext2D, dev: Mat, c: V2, rx: number, ry: number, ang: number, lift: number, k = 1) {
  const ox = 0.022 * (1 + 3 * lift)
  const oy = 0.038 * (1 + 3 * lift)
  ctx.setTransform(dev[0], dev[1], dev[2], dev[3], dev[4], dev[5])
  for (const [g, a] of [
    [0.025, 0.08],
    [0.0125, 0.1],
    [0, 0.12],
  ]) {
    ctx.fillStyle = `rgba(90,67,50,${a * k})`
    ctx.beginPath()
    ctx.ellipse(c[0] + ox, c[1] + oy, rx + g, ry + g, ang, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Soft crease shadow on the inner side of a bent joint. */
export function creaseAO(ctx: CanvasRenderingContext2D, dev: Mat, S: V2, E: V2, W: V2, r: number) {
  const a1 = Math.atan2(E[1] - S[1], E[0] - S[0])
  const a2 = Math.atan2(W[1] - E[1], W[0] - E[0])
  const t = angDiff(a2, a1)
  const bend = Math.min(1, Math.abs(t) / (Math.PI / 2))
  if (bend < 0.08) return
  // inner side: the side the limb turns toward
  const bis = a1 + t / 2 + (t > 0 ? Math.PI / 2 : -Math.PI / 2)
  const cx = E[0] + Math.cos(bis) * r * 0.55
  const cy = E[1] + Math.sin(bis) * r * 0.55
  ctx.setTransform(dev[0], dev[1], dev[2], dev[3], dev[4], dev[5])
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.9)
  g.addColorStop(0, `rgba(60,44,32,${0.25 * bend})`)
  g.addColorStop(1, 'rgba(60,44,32,0)')
  ctx.fillStyle = g
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
}

// ---------- paws ----------

/** Paw space: the wrist at the origin, toes along +x. Toe bases sit at about x = 0.165. */
export const TOE_BASE = 0.165
export const PAD_C = 0.21

export interface PawPose {
  /** wrist (cat space) */
  W: V2
  /** direction the toes point */
  a: number
  splay: number
  /** 0 sole to the viewer, 1 top (furred back) */
  top: boolean
  /** width scale for the turn-over (1 normal, 0.5 at the swap) */
  flip: number
  s: number
  lift: number
  /** toe foreshortening (1 flat .. 0.6 curled) */
  curl: number
  /** squash along the paw axis on impact */
  squash: number
}

export interface PawSprites {
  palmTop: Sprite
  palmSole: Sprite
  toeTop: Sprite
  toeSole: Sprite
}

const FAN0 = [-8, -3, 3, 8]
const FAN1 = [-24, -8, 8, 24]

export function pawMatrix(p: PawPose): Mat {
  const ls = 1 + 0.04 * p.lift / 0.03
  return mul(tr(p.W[0], p.W[1]), mul(rot(p.a), scl(p.s * ls * p.squash, p.s * ls * p.flip)))
}

/** Toe matrices in paw space. */
export function toeMats(p: PawPose): Mat[] {
  const out: Mat[] = []
  for (let k = 0; k < 4; k++) {
    const o = k - 1.5
    const fan = (FAN0[k] + (FAN1[k] - FAN0[k]) * p.splay) * D
    const ext = 0.012 * p.splay
    // on the sole the beans sit close round the main pad; on top the toes form the front of the paw
    const base = p.top ? TOE_BASE : TOE_BASE - 0.04
    const bx = base - 0.011 * o * o + ext
    const by = o * ((p.top ? 0.045 : 0.04) + 0.012 * p.splay)
    const ts = Math.abs(o) > 1 ? 0.9 : 1
    out.push(mul(tr(bx, by), mul(rot(fan), scl(ts * p.curl, ts))))
  }
  return out
}

export function drawPaw(ctx: CanvasRenderingContext2D, dev: Mat, ps: PawSprites, p: PawPose, alpha = 1) {
  const pm = mul(dev, pawMatrix(p))
  const toes = toeMats(p)
  const palm = p.top ? ps.palmTop : ps.palmSole
  const toe = p.top ? ps.toeTop : ps.toeSole
  const put = (sp: Sprite, m: Mat) => {
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    ctx.drawImage(sp.cv, sp.x0, sp.y0, sp.bw, sp.bh)
  }
  if (alpha < 1) ctx.globalAlpha = alpha
  if (p.top) {
    // outer toes first, so the middle ones overlap them (the paw is domed)
    for (const k of [0, 3, 1, 2]) put(toe, mul(pm, toes[k]))
    put(palm, pm)
    if (p.splay > 0.7) drawClaws(ctx, pm, toes, (p.splay - 0.7) / 0.3, alpha)
  } else {
    put(palm, pm)
    if (p.splay > 0.7) drawClaws(ctx, pm, toes, (p.splay - 0.7) / 0.3, alpha)
    for (const k of [0, 3, 1, 2]) put(toe, mul(pm, toes[k]))
  }
  if (alpha < 1) ctx.globalAlpha = 1
}

function drawClaws(ctx: CanvasRenderingContext2D, pm: Mat, toes: Mat[], k: number, alpha: number) {
  for (const tm of toes) {
    const m = mul(pm, tm)
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    ctx.beginPath()
    ctx.moveTo(0.068, -0.009)
    ctx.quadraticCurveTo(0.098 * (0.85 + 0.15 * k) + 0.004, -0.006, 0.084 + 0.022 * k, 0.004)
    ctx.quadraticCurveTo(0.08, 0.002, 0.068, 0.008)
    ctx.closePath()
    ctx.fillStyle = `rgba(237,230,216,${0.95 * k * alpha})`
    ctx.fill()
    ctx.lineWidth = 0.004
    ctx.strokeStyle = `rgba(150,135,120,${0.6 * k * alpha})`
    ctx.stroke()
  }
}

/** Distance from p to the segment ab. */
export function segDist(p: V2, a: V2, b: V2) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy || 1e-9
  let f = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2
  f = f < 0 ? 0 : f > 1 ? 1 : f
  return Math.hypot(p[0] - a[0] - dx * f, p[1] - a[1] - dy * f)
}

// ---------- keyframe tracks ----------

export type Ease = (t: number) => number
export const E = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number) => t * t * t,
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number) => {
    const c1 = 1.6
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
  hold: () => 0,
}

/** track(t, [[ms, value, ease], ...]): value at time t (ms), easing into each key. */
export function track(t: number, keys: [number, number, Ease?][]): number {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e] = keys[i]
    if (t <= t1) {
      const [t0, v0] = keys[i - 1]
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1
      return v0 + (v1 - v0) * (e ?? E.inOutSine)(f)
    }
  }
  return keys[keys.length - 1][1]
}

/** 2D critically-ish damped spring. */
export class Spring2 {
  v: V2 = [0, 0]
  constructor(
    public p: V2,
    public k = 200,
    public d = 26,
  ) {}
  step(t: V2, dt: number, k = this.k, d = this.d) {
    const n = Math.max(1, Math.ceil((dt * Math.max(Math.sqrt(k), d)) / 0.4))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      this.v[0] += (k * (t[0] - this.p[0]) - d * this.v[0]) * h
      this.v[1] += (k * (t[1] - this.p[1]) - d * this.v[1]) * h
      this.p[0] += this.v[0] * h
      this.p[1] += this.v[1] * h
    }
    return this.p
  }
  set(p: V2, v?: V2) {
    this.p = [p[0], p[1]]
    if (v) this.v = [v[0], v[1]]
  }
}
