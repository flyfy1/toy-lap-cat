// Live face (design doc 1.3): eyes with lids, pupils and catchlights, nose, mouth, whiskers.
// Drawn every frame in head-local HW units on top of the baked head.

import { EYE, NOSE } from './rig'
import { COAT } from './palette'

export interface FaceState {
  /** eye openness, left and right (1 open, 0 closed) */
  open: [number, number]
  /** lower-lid raise (squint), left and right */
  squint: [number, number]
  /** 0..1: closed eyes curve into happy upward arcs */
  happy: number
  /** pupil offset (HW, head-local) */
  pupil: [number, number]
  /** pupil diameter as a fraction of iris height */
  pupilSize: number
  /** 0..1 chin lift: face features ride up */
  look: number
  /** whisker pad pushed forward (cheek lean) */
  padPush: number
  /** extra whisker angle (radians), for twitches */
  whisk: number
  /** 0..1 pupils to vertical slits (irk) */
  slit: number
  /** 0..1 eyes cross (boop) */
  cross: number
  /** 0..1 mouth open: yawn (teeth only here) */
  yawn: number
  /** 0..1 small open mouth (bite hold) */
  bite: number
  /** 0..1 tongue out (grooming lick) */
  lick: number
  /** whisker tip lag per side (head-local HW), from a spring that trails head motion */
  wtip: [number, number][]
}

export const restFace = (): FaceState => ({ open: [1, 1], squint: [0, 0], happy: 0, pupil: [0, 0], pupilSize: 0.7, look: 0, padPush: 0, whisk: 0, slit: 0, cross: 0, yawn: 0, bite: 0, lick: 0, wtip: [[0, 0], [0, 0]] })

const LID = '#2A211C'

interface EyeGeo {
  ix: number
  iy: number
  ox: number
  oy: number
  // top and bottom cubic controls
  t1: [number, number]
  t2: [number, number]
  b1: [number, number]
  b2: [number, number]
}

function eyeGeo(side: -1 | 1, look: number): EyeGeo {
  const cx = side * EYE.x
  const cy = EYE.y - look * 0.035
  const w = EYE.w
  const h = EYE.h * (1 - look * 0.08)
  const ix = cx - side * w * 0.5
  const ox = cx + side * w * 0.5
  const iy = cy + 0.012
  const oy = cy - 0.016
  return {
    ix,
    iy,
    ox,
    oy,
    t1: [ix + side * w * 0.08, cy - h * 0.7],
    t2: [ox - side * w * 0.2, cy - h * 0.7],
    b1: [ox - side * w * 0.12, cy + h * 0.66],
    b2: [ix + side * w * 0.16, cy + h * 0.68],
  }
}

function eyePath(c: CanvasRenderingContext2D, g: EyeGeo) {
  c.moveTo(g.ix, g.iy)
  c.bezierCurveTo(g.t1[0], g.t1[1], g.t2[0], g.t2[1], g.ox, g.oy)
  c.bezierCurveTo(g.b1[0], g.b1[1], g.b2[0], g.b2[1], g.ix, g.iy)
  c.closePath()
}

const lerp2 = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/** The visible eye opening as a lens between the corners: the upper lid curve slides from the full
 *  eye top (o = 1) down toward the lower lid (o = 0), keeping its corners, so a half-closed eye is a
 *  soft almond (content), never a cut-off trapezoid (cross). The lower lid rises with the squint. */
function openGeo(g: EyeGeo, o: number, sq: number) {
  const k = 0.12 + 0.88 * o
  const b1 = lerp2(g.b1, g.t2, sq * 0.3)
  const b2 = lerp2(g.b2, g.t1, sq * 0.3)
  const t1 = lerp2(b2, g.t1, k)
  const t2 = lerp2(b1, g.t2, k)
  // keep a soft dome on a half-closed lid (a flat lid reads as bored)
  const dome = 0.12 * o * (1 - o)
  t1[1] -= dome
  t2[1] -= dome
  return { t1, t2, b1, b2 }
}
function topEdge(c: CanvasRenderingContext2D, g: EyeGeo, q: ReturnType<typeof openGeo>) {
  c.moveTo(g.ix, g.iy)
  c.bezierCurveTo(q.t1[0], q.t1[1], q.t2[0], q.t2[1], g.ox, g.oy)
}
function lensPath(c: CanvasRenderingContext2D, g: EyeGeo, q: ReturnType<typeof openGeo>) {
  topEdge(c, g, q)
  c.bezierCurveTo(q.b1[0], q.b1[1], q.b2[0], q.b2[1], g.ix, g.iy)
  c.closePath()
}

function drawEye(c: CanvasRenderingContext2D, side: -1 | 1, s: FaceState, px: number) {
  const idx = side < 0 ? 0 : 1
  const g = eyeGeo(side, s.look)
  const cx = side * EYE.x
  const cy = EYE.y - s.look * 0.035
  const h = EYE.h
  const open = Math.max(0, Math.min(1, s.open[idx] * (1 - s.happy)))
  const sq = s.squint[idx]
  const q = openGeo(g, open, sq)
  // y of the upper lid edge at the eye centre (cubic midpoint)
  const lidY = 0.125 * g.iy + 0.375 * q.t1[1] + 0.375 * q.t2[1] + 0.125 * g.oy

  if (open > 0.06) {
    // soft dark socket rim so the eye sits in the fur
    c.save()
    c.beginPath()
    eyePath(c, g)
    c.strokeStyle = 'rgba(42,30,24,0.16)'
    c.lineWidth = 2.4 * px
    c.stroke()
    c.restore()

    c.save()
    c.beginPath()
    lensPath(c, g, q)
    c.clip()
    // iris: soft green with a warm hazel ring round the pupil and a warm olive-brown rim
    const pxo = cx + s.pupil[0] - side * 0.04 * s.cross
    const pyo = cy + s.pupil[1]
    const ig = c.createRadialGradient(pxo, pyo, 0.01, cx, cy, EYE.w * 0.56)
    const I = COAT.iris
    ig.addColorStop(0, I[0])
    ig.addColorStop(0.3, I[1])
    ig.addColorStop(0.58, I[2])
    ig.addColorStop(0.8, I[3])
    ig.addColorStop(0.93, I[4])
    ig.addColorStop(1, I[5])
    c.fillStyle = ig
    c.fillRect(cx - 0.2, cy - 0.2, 0.4, 0.4)
    // radial iris fibres, alternating lengths, and a darker limbal ring
    c.strokeStyle = 'rgba(60,82,34,0.16)'
    c.lineWidth = 0.8 * px
    c.beginPath()
    for (let k = 0; k < 28; k++) {
      const a = (k / 28) * Math.PI * 2 + 0.05
      const r1 = k % 2 ? 0.1 : 0.118
      c.moveTo(pxo + Math.cos(a) * 0.048, pyo + Math.sin(a) * 0.048)
      c.lineTo(pxo + Math.cos(a) * r1, pyo + Math.sin(a) * r1)
    }
    c.stroke()
    {
      const R = EYE.w * 0.56
      const lr = c.createRadialGradient(cx, cy, R * 0.86, cx, cy, R)
      lr.addColorStop(0, 'rgba(52,58,24,0)')
      lr.addColorStop(0.5, 'rgba(52,58,24,0.3)')
      lr.addColorStop(1, 'rgba(52,58,24,0.3)')
      c.fillStyle = lr
      c.fillRect(cx - R, cy - R, R * 2, R * 2)
    }
    // pupil
    const pr = (s.pupilSize * h) / 2
    const pg = c.createRadialGradient(pxo, pyo, pr * 0.7, pxo, pyo, pr * 1.08)
    pg.addColorStop(0, '#0F0D0C')
    pg.addColorStop(1, 'rgba(15,13,12,0)')
    c.fillStyle = pg
    c.beginPath()
    if (s.slit > 0.01) {
      c.setTransform(c.getTransform().scale(1 - 0.78 * s.slit, 1 + 0.12 * s.slit, 1, pxo, pyo))
      c.arc(pxo, pyo, pr * 1.08, 0, Math.PI * 2)
      c.fill()
      c.setTransform(c.getTransform().scale(1 / (1 - 0.78 * s.slit), 1 / (1 + 0.12 * s.slit), 1, pxo, pyo))
    } else {
      c.arc(pxo, pyo, pr * 1.08, 0, Math.PI * 2)
      c.fill()
    }
    // upper lid casts a soft shadow onto the eye
    const sg = c.createLinearGradient(0, lidY - 0.02, 0, lidY + h * 0.34)
    sg.addColorStop(0, 'rgba(30,22,14,0.5)')
    sg.addColorStop(1, 'rgba(30,22,14,0)')
    c.fillStyle = sg
    c.fillRect(cx - 0.2, cy - 0.2, 0.4, 0.4)
    // catchlights: same side in both eyes (upper-left big, lower-right small); the big one rides
    // just under the lid so a sleepy eye still shines
    c.fillStyle = '#FFFFFF'
    const hy = Math.max(cy - 0.036, lidY + 0.03)
    const hk = 0.72 + 0.28 * open
    c.beginPath()
    c.ellipse(cx - 0.034, hy, 0.034 * hk, 0.028 * hk, -0.4, 0, Math.PI * 2)
    c.fill()
    c.globalAlpha = 0.85
    c.beginPath()
    c.arc(cx + 0.045, Math.max(cy + 0.038, hy + 0.04), 0.013, 0, Math.PI * 2)
    c.fill()
    c.restore()

    // lid lines: the lower lid thin and fading toward the outer corner (no ring round the eye),
    // a moist highlight along its inner third; the upper lid edge heavier
    c.save()
    c.lineCap = 'round'
    c.lineJoin = 'round'
    {
      const lg = c.createLinearGradient(g.ix, g.iy, g.ox, g.oy)
      lg.addColorStop(0, 'rgba(38,26,20,0.45)')
      lg.addColorStop(0.6, 'rgba(38,26,20,0.3)')
      lg.addColorStop(1, 'rgba(38,26,20,0)')
      c.strokeStyle = lg
      c.lineWidth = 0.8 * px
      c.beginPath()
      c.moveTo(g.ox, g.oy)
      c.bezierCurveTo(q.b1[0], q.b1[1], q.b2[0], q.b2[1], g.ix, g.iy)
      c.stroke()
      const hl = c.createLinearGradient(g.ix, g.iy, g.ox, g.oy)
      hl.addColorStop(0, 'rgba(255,250,240,0.55)')
      hl.addColorStop(0.33, 'rgba(255,250,240,0)')
      c.strokeStyle = hl
      c.lineWidth = 1 * px
      c.beginPath()
      c.moveTo(g.ox, g.oy + 1.2 * px)
      c.bezierCurveTo(q.b1[0], q.b1[1] + 1.2 * px, q.b2[0], q.b2[1] + 1.2 * px, g.ix, g.iy + 1.2 * px)
      c.stroke()
    }
    c.strokeStyle = LID
    c.lineWidth = (1.5 + 0.3 * (1 - open)) * px
    c.beginPath()
    topEdge(c, g, q)
    c.stroke()
    c.restore()
  } else {
    // closed: a curved line. happy -> upward arc
    c.save()
    c.lineCap = 'round'
    c.strokeStyle = LID
    const midY = cy + 0.02
    const arcUp = s.happy
    const cy1 = midY + 0.045 * (1 - arcUp) - 0.06 * arcUp
    c.lineWidth = 1.9 * px
    c.beginPath()
    const ix = g.ix + side * 0.012
    const ox = g.ox - side * 0.012
    c.moveTo(ix, g.iy + 0.01)
    c.quadraticCurveTo(cx, cy1, ox, g.oy + 0.012)
    c.stroke()
    if (COAT.id === 'tux' || COAT.id === 'void') {
      // on dark fur the closed eye is a pale lash line, or it vanishes
      c.strokeStyle = 'rgba(236,222,204,0.85)'
      c.lineWidth = 1.2 * px
      c.stroke()
    }
    c.restore()
  }
}


export function drawFace(c: CanvasRenderingContext2D, s: FaceState, px: number) {
  drawEye(c, -1, s, px)
  drawEye(c, 1, s, px)

  const ny = NOSE.y - s.look * 0.05
  const nw = NOSE.w
  const nh = NOSE.h
  // nose: rounded inverted triangle
  c.save()
  const ng = c.createLinearGradient(0, ny - nh / 2, 0, ny + nh / 2)
  ng.addColorStop(0, COAT.nose[0])
  ng.addColorStop(0.55, COAT.nose[1])
  ng.addColorStop(1, COAT.nose[2])
  c.fillStyle = ng
  c.beginPath()
  c.moveTo(-nw / 2, ny - nh / 2 + 0.006)
  c.quadraticCurveTo(0, ny - nh / 2 - 0.008, nw / 2, ny - nh / 2 + 0.006)
  c.quadraticCurveTo(nw / 2 + 0.004, ny - nh / 2 + 0.016, nw * 0.12, ny + nh / 2 - 0.006)
  c.quadraticCurveTo(0, ny + nh / 2 + 0.004, -nw * 0.12, ny + nh / 2 - 0.006)
  c.quadraticCurveTo(-nw / 2 - 0.004, ny - nh / 2 + 0.016, -nw / 2, ny - nh / 2 + 0.006)
  c.closePath()
  c.fill()
  // highlight
  c.fillStyle = 'rgba(255,235,228,0.55)'
  c.beginPath()
  c.ellipse(-0.012, ny - nh * 0.2, 0.016, 0.008, -0.2, 0, Math.PI * 2)
  c.fill()
  // nostrils: two small commas
  c.fillStyle = 'rgba(122,62,60,0.75)'
  for (const sd of [-1, 1]) {
    c.beginPath()
    c.ellipse(sd * nw * 0.24, ny + nh * 0.08, 0.009, 0.0045, sd * 0.5, 0, Math.PI * 2)
    c.fill()
    c.beginPath()
    c.moveTo(sd * nw * 0.17, ny + nh * 0.1)
    c.quadraticCurveTo(sd * nw * 0.3, ny + nh * 0.22, sd * nw * 0.36, ny + nh * 0.04)
    c.lineWidth = 0.7 * px
    c.strokeStyle = 'rgba(122,62,60,0.5)'
    c.stroke()
  }
  // moist highlight at the upper left
  c.fillStyle = 'rgba(255,245,240,0.7)'
  c.beginPath()
  c.ellipse(-nw * 0.18, ny - nh * 0.28, 0.008, 0.004, -0.3, 0, Math.PI * 2)
  c.fill()
  // underline
  c.strokeStyle = '#7A4A46'
  c.lineWidth = 1 * px
  c.lineCap = 'round'
  c.beginPath()
  c.moveTo(-nw * 0.3, ny + nh * 0.12)
  c.quadraticCurveTo(0, ny + nh * 0.62, nw * 0.3, ny + nh * 0.12)
  c.stroke()

  // philtrum + "w" mouth (or an open mouth when yawning / holding a bite)
  const mTop = ny + nh / 2
  const my = mTop + 0.03
  const open = Math.max(s.yawn * 0.22, s.bite * 0.07)
  if (open > 0.008) {
    const mw = 0.07 + 0.06 * Math.min(1, open / 0.12)
    const top = my - 0.004
    c.save()
    c.beginPath()
    c.moveTo(-mw, top)
    c.quadraticCurveTo(0, top - 0.012, mw, top)
    c.bezierCurveTo(mw * 0.9, top + open * 0.9, mw * 0.4, top + open * 1.15, 0, top + open * 1.15)
    c.bezierCurveTo(-mw * 0.4, top + open * 1.15, -mw * 0.9, top + open * 0.9, -mw, top)
    c.closePath()
    const mg = c.createLinearGradient(0, top, 0, top + open)
    mg.addColorStop(0, '#5A2F2E')
    mg.addColorStop(1, '#7E3E3C')
    c.fillStyle = mg
    c.fill()
    c.clip()
    // tongue, curled up at the tip
    c.fillStyle = '#E58C8A'
    c.beginPath()
    c.ellipse(0, top + open * 1.05, mw * 0.62, open * 0.42, 0, 0, Math.PI * 2)
    c.fill()
    c.strokeStyle = 'rgba(160,70,70,0.5)'
    c.lineWidth = 0.8 * px
    c.beginPath()
    c.moveTo(0, top + open * 0.75)
    c.lineTo(0, top + open * 1.1)
    c.stroke()
    if (s.yawn > 0.35) {
      // the only time teeth show: two small fangs
      c.fillStyle = '#FBF6EE'
      for (const sd of [-1, 1]) {
        c.beginPath()
        c.moveTo(sd * mw * 0.62, top + 0.002)
        c.lineTo(sd * mw * 0.48, top + 0.002)
        c.lineTo(sd * mw * 0.55, top + 0.028)
        c.closePath()
        c.fill()
      }
    }
    c.restore()
    c.strokeStyle = '#5A3F3A'
    c.lineWidth = 1.1 * px
    c.beginPath()
    c.moveTo(0, mTop)
    c.lineTo(0, top - 0.008)
    c.stroke()
  }
  if (s.lick > 0.02) {
    c.fillStyle = '#E58C8A'
    c.beginPath()
    c.ellipse(0, my + 0.006 + 0.008 * s.lick, 0.022, 0.006 + 0.01 * s.lick, 0, 0, Math.PI * 2)
    c.fill()
  }
  if (open <= 0.008) {
  c.strokeStyle = '#5A3F3A'
  c.lineWidth = 1.2 * px
  c.beginPath()
  c.moveTo(0, mTop)
  c.lineTo(0, my)
  c.moveTo(0, my)
  c.quadraticCurveTo(-0.035, my + 0.035, -0.08, my + 0.004)
  c.moveTo(0, my)
  c.quadraticCurveTo(0.035, my + 0.035, 0.08, my + 0.004)
  c.stroke()
  }

  // whisker dots on the pads
  c.fillStyle = 'rgba(80,58,46,0.5)'
  for (const sd of [-1, 1])
    for (let r = 0; r < 3; r++)
      for (let k = 0; k < 3 - (r === 2 ? 1 : 0); k++) {
        c.beginPath()
        c.arc(sd * (0.055 + k * 0.024 + r * 0.008), my - 0.012 + r * 0.019 - s.look * 0.01, 0.0055, 0, Math.PI * 2)
        c.fill()
      }
  c.restore()
}

/** Whiskers: drawn last, over everything else of the cat. Each is a tapered sliver (1.3 px at the root to
 *  0.4 px at the tip); the tips trail head motion through a spring per side (s.wtip, head-local). */
export function drawWhiskers(c: CanvasRenderingContext2D, s: FaceState, px: number) {
  const ny = NOSE.y - s.look * 0.05
  const my = ny + NOSE.h / 2 + 0.03
  c.save()
  const lens = [0.68, 0.7, 0.63, 0.56]
  const angs = [-0.2, -0.05, 0.1, 0.25]
  const sliver = (x0: number, y0: number, qx: number, qy: number, ex: number, ey: number, w0: number, w1: number, a0: number, a1: number, shadow: boolean) => {
    const N = 10
    const L: [number, number][] = []
    const R: [number, number][] = []
    const n = shadow ? N / 2 : N
    for (let i = 0; i <= n; i++) {
      const t = i / N
      const u = 1 - t
      const x = u * u * x0 + 2 * u * t * qx + t * t * ex
      const y = u * u * y0 + 2 * u * t * qy + t * t * ey
      const dx = 2 * u * (qx - x0) + 2 * t * (ex - qx)
      const dy = 2 * u * (qy - y0) + 2 * t * (ey - qy)
      const l = Math.hypot(dx, dy) || 1
      const w = ((w0 + (w1 - w0) * t) * px) / 2
      L.push([x - (dy / l) * w, y + (dx / l) * w])
      R.push([x + (dy / l) * w, y - (dx / l) * w])
    }
    const g = c.createLinearGradient(x0, y0, ex, ey)
    if (shadow) {
      g.addColorStop(0, 'rgba(60,42,30,0.24)')
      g.addColorStop(0.5, 'rgba(60,42,30,0)')
    } else {
      g.addColorStop(0, `rgba(255,253,246,${a0})`)
      g.addColorStop(1, `rgba(255,253,246,${a1})`)
    }
    c.fillStyle = g
    c.beginPath()
    c.moveTo(L[0][0], L[0][1])
    for (const p of L.slice(1)) c.lineTo(p[0], p[1])
    for (let i = R.length - 1; i >= 0; i--) c.lineTo(R[i][0], R[i][1])
    c.closePath()
    c.fill()
  }
  for (const shadow of [true, false]) {
    const ox = shadow ? 0.6 * px : 0
    const oy = shadow ? 0.9 * px : 0
    for (const sd of [-1, 1]) {
      const tip = s.wtip[sd < 0 ? 0 : 1]
      for (let k = 0; k < 4; k++) {
        const x0 = sd * (0.11 + s.padPush * 0.02)
        const y0 = my - 0.012 + k * 0.014
        const a = angs[k] + s.whisk * sd
        const Lk = lens[k]
        const lag = 0.85 + 0.1 * k
        const ex = x0 + sd * Math.cos(a) * Lk + tip[0] * lag
        const ey = y0 + Math.sin(a) * Lk + 0.06 + tip[1] * lag
        sliver(x0 + ox, y0 + oy, x0 + sd * Math.cos(a) * Lk * 0.5 + ox + tip[0] * 0.25, y0 + Math.sin(a) * Lk * 0.5 - 0.01 + oy + tip[1] * 0.25, ex + ox, ey + oy, shadow ? 1.6 : 1.3, shadow ? 1 : 0.4, 0.9, 0.45, shadow)
      }
      // brow whiskers: finer and fainter, so they stop reading as chalk marks
      if (!shadow)
        for (let k = 0; k < 3; k++) {
          const x0 = sd * (0.14 + k * 0.035)
          const y0 = EYE.y - EYE.h * 0.62 - s.look * 0.035
          const a = -1.05 + k * 0.18
          const Lk = 0.15 + k * 0.025
          sliver(x0, y0, x0 + sd * Math.cos(a) * Lk * 0.5, y0 + Math.sin(a) * Lk * 0.5, x0 + sd * Math.cos(a) * Lk + sd * 0.03 + tip[0] * 0.3, y0 + Math.sin(a) * Lk + 0.03 + tip[1] * 0.3, 0.7, 0.3, 0.6, 0.35, false)
        }
    }
  }
  c.restore()
}
