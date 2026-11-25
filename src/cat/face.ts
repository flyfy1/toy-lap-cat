// Live face (design doc 1.3): eyes with lids, pupils and catchlights, nose, mouth, whiskers.
// Drawn every frame in head-local HW units on top of the baked head.

import { EYE, NOSE } from './rig'

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
}

export const restFace = (): FaceState => ({ open: [1, 1], squint: [0, 0], happy: 0, pupil: [0, 0], pupilSize: 0.7, look: 0, padPush: 0, whisk: 0 })

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

/** Upper lid edge for openness o: interpolates from the top curve (open) to the bottom curve (closed). */
function lidCtrl(g: EyeGeo, o: number): [[number, number], [number, number]] {
  const k = 1 - o
  // the closed lid sits a little above the bottom curve
  const b1: [number, number] = [g.b2[0], g.b2[1] - 0.05]
  const b2: [number, number] = [g.b1[0], g.b1[1] - 0.05]
  return [lerp2(g.t1, b1, k), lerp2(g.t2, b2, k)]
}

function drawEye(c: CanvasRenderingContext2D, side: -1 | 1, s: FaceState, px: number) {
  const idx = side < 0 ? 0 : 1
  const g = eyeGeo(side, s.look)
  const cx = side * EYE.x
  const cy = EYE.y - s.look * 0.035
  const h = EYE.h
  const open = Math.max(0, Math.min(1, s.open[idx] * (1 - s.happy)))
  const sq = s.squint[idx]
  const [l1, l2] = lidCtrl(g, open)

  const openPath = () => {
    c.beginPath()
    c.moveTo(g.ix, g.iy)
    c.bezierCurveTo(l1[0], l1[1], l2[0], l2[1], g.ox, g.oy)
    c.bezierCurveTo(g.b1[0], g.b1[1], g.b2[0], g.b2[1], g.ix, g.iy)
    c.closePath()
  }
  // soft dark socket rim so the eye sits in the fur
  c.save()
  openPath()
  c.strokeStyle = 'rgba(42,30,24,0.2)'
  c.lineWidth = 2.4 * px
  c.stroke()
  c.restore()

  if (open > 0.04) {
    c.save()
    // clip: eye shape, below the upper lid, above the lower lid
    c.beginPath()
    eyePath(c, g)
    c.clip()
    c.beginPath()
    c.moveTo(g.ix - 0.05, g.iy)
    c.bezierCurveTo(l1[0], l1[1], l2[0], l2[1], g.ox + side * 0.05, g.oy)
    c.lineTo(g.ox + side * 0.05, cy + 0.3)
    c.lineTo(g.ix - side * 0.05, cy + 0.3)
    c.closePath()
    c.clip()
    if (sq > 0.01) {
      c.beginPath()
      c.rect(cx - 0.2, cy - 0.3, 0.4, 0.3 + h * 0.5 - sq * h * 0.45)
      c.clip()
    }
    // iris
    const pxo = cx + s.pupil[0]
    const pyo = cy + s.pupil[1]
    const ig = c.createRadialGradient(pxo, pyo, 0.01, cx, cy, EYE.w * 0.56)
    ig.addColorStop(0, '#D9DE78')
    ig.addColorStop(0.35, '#C9D36A')
    ig.addColorStop(0.78, '#8DB257')
    ig.addColorStop(1, '#5E8240')
    c.fillStyle = ig
    c.fillRect(cx - 0.2, cy - 0.2, 0.4, 0.4)
    // faint radial iris fibres
    c.strokeStyle = 'rgba(70,95,40,0.07)'
    c.lineWidth = 0.6 * px
    c.beginPath()
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2
      c.moveTo(pxo + Math.cos(a) * 0.05, pyo + Math.sin(a) * 0.05)
      c.lineTo(pxo + Math.cos(a) * 0.12, pyo + Math.sin(a) * 0.12)
    }
    c.stroke()
    // pupil
    const pr = (s.pupilSize * h) / 2
    const pg = c.createRadialGradient(pxo, pyo, pr * 0.7, pxo, pyo, pr * 1.08)
    pg.addColorStop(0, '#0F0D0C')
    pg.addColorStop(1, 'rgba(15,13,12,0)')
    c.fillStyle = pg
    c.beginPath()
    c.arc(pxo, pyo, pr * 1.08, 0, Math.PI * 2)
    c.fill()
    // upper lid shadow on the top third
    const lidY = Math.min(l1[1], l2[1]) * 0.75 + cy * 0.25
    const sg = c.createLinearGradient(0, lidY - 0.02, 0, lidY + h * 0.4)
    sg.addColorStop(0, 'rgba(30,22,14,0.5)')
    sg.addColorStop(1, 'rgba(30,22,14,0)')
    c.fillStyle = sg
    c.fillRect(cx - 0.2, cy - 0.2, 0.4, 0.4)
    // catchlights: same side in both eyes (upper-left big, lower-right small)
    c.fillStyle = '#FFFFFF'
    c.beginPath()
    c.ellipse(cx - 0.032, cy - 0.036, 0.034, 0.03, -0.4, 0, Math.PI * 2)
    c.fill()
    c.beginPath()
    c.arc(cx + 0.043, cy + 0.04, 0.014, 0, Math.PI * 2)
    c.fill()
    c.restore()
  }

  // lid line along the eye opening
  c.save()
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.strokeStyle = LID
  if (open > 0.04) {
    c.lineWidth = 1.1 * px
    openPath()
    c.stroke()
    // heavier upper lid edge
    c.lineWidth = 1.5 * px
    c.beginPath()
    c.moveTo(g.ix, g.iy)
    c.bezierCurveTo(l1[0], l1[1], l2[0], l2[1], g.ox, g.oy)
    c.stroke()
  } else {
    // closed: a curved line. happy -> upward arc
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
  }
  c.restore()
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
  ng.addColorStop(0, '#F0ADA6')
  ng.addColorStop(0.55, '#E8958F')
  ng.addColorStop(1, '#C97A74')
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
  // underline
  c.strokeStyle = '#7A4A46'
  c.lineWidth = 1 * px
  c.lineCap = 'round'
  c.beginPath()
  c.moveTo(-nw * 0.3, ny + nh * 0.12)
  c.quadraticCurveTo(0, ny + nh * 0.62, nw * 0.3, ny + nh * 0.12)
  c.stroke()

  // philtrum + "w" mouth
  const mTop = ny + nh / 2
  const my = mTop + 0.03
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

/** Whiskers: drawn last, over everything else of the cat. */
export function drawWhiskers(c: CanvasRenderingContext2D, s: FaceState, px: number) {
  const ny = NOSE.y - s.look * 0.05
  const my = ny + NOSE.h / 2 + 0.03
  c.save()
  c.lineCap = 'round'
  const lens = [0.68, 0.7, 0.63, 0.56]
  const angs = [-0.2, -0.05, 0.1, 0.25]
  const pass = (shadow: boolean) => {
    c.strokeStyle = shadow ? 'rgba(60,42,30,0.22)' : 'rgba(255,253,246,0.88)'
    c.lineWidth = (shadow ? 1.4 : 1.0) * px
    c.beginPath()
    for (const sd of [-1, 1])
      for (let k = 0; k < 4; k++) {
        const x0 = sd * (0.11 + s.padPush * 0.02)
        const y0 = my - 0.012 + k * 0.014
        const a = angs[k] + s.whisk * sd
        const L = lens[k]
        const ox = shadow ? 0.6 * px : 0
        const oy = shadow ? 0.9 * px : 0
        const ex = x0 + sd * Math.cos(a) * L
        const ey = y0 + Math.sin(a) * L + 0.06
        c.moveTo(x0 + ox, y0 + oy)
        c.quadraticCurveTo(x0 + sd * Math.cos(a) * L * 0.5 + ox, y0 + Math.sin(a) * L * 0.5 - 0.01 + oy, ex + ox, ey + oy)
      }
    // brow whiskers
    for (const sd of [-1, 1])
      for (let k = 0; k < 3; k++) {
        const x0 = sd * (0.14 + k * 0.035)
        const y0 = EYE.y - EYE.h * 0.62 - s.look * 0.035
        const a = -1.05 + k * 0.18
        const L = 0.15 + k * 0.025
        const ox = shadow ? 0.6 * px : 0
        const oy = shadow ? 0.9 * px : 0
        c.moveTo(x0 + ox, y0 + oy)
        c.quadraticCurveTo(x0 + sd * Math.cos(a) * L * 0.5 + ox, y0 + Math.sin(a) * L * 0.5 + oy, x0 + sd * Math.cos(a) * L + sd * 0.03 + ox, y0 + Math.sin(a) * L + 0.03 + oy)
      }
    c.stroke()
  }
  pass(true)
  pass(false)
  c.restore()
}
