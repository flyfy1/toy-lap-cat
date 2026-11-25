// The mouse hand: a soft, warm hand seen from above that follows a mouse pointer (lazy chunk, desktop only).
// It floats with a wide soft shadow while the button is up, presses flat on the fur while it is down,
// curls its fingertips on the scratch zones, is held by the paws in the belly trap and flinches from a swat.
// Drawn into a small offscreen canvas each frame; its shadows are the silhouette shrunk and scaled back up.

import type { Cat } from './cat/cat'

export interface HandIn {
  /** css px; velocity in px/s */
  x: number
  y: number
  vx: number
  vy: number
  down: boolean
  onCat: boolean
  /** on a scratch zone (chin, cheek, ear base) */
  scratch: boolean
  /** the belly trap's grip point (css px) or null */
  held: { x: number; y: number } | null
  /** a swat in progress: seconds since it started, or -1 */
  swat: number
  HW: number
}

const SKIN = [232, 180, 148]
const SHADE = [180, 112, 88]
const LIGHT = [254, 226, 204]
const BLUSH = [228, 138, 120]
const KNIT = [132, 148, 168]
const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
/** finger bases (hand space, the unit is 0.1 HW), length, width, rest angle, spring stiffness */
const FINGERS = [
  [1.2, 1.08, 2.3, 0.76, 0.1, 140, -0.1],
  [0.4, 0.84, 2.85, 0.86, 0.035, 170, -0.04],
  [-0.4, 0.78, 3.05, 0.9, -0.01, 200, 0.02],
  [-1.2, 0.96, 2.75, 0.88, -0.06, 240, 0.06],
]
/** the hand points up and to the left, the wrist toward the viewer's lower right */
const ANG = -0.3
const ease = (x: number, to: number, rate: number, dt: number) => x + (to - x) * (1 - Math.exp(-rate * dt))

/** the mouse pointer as game.ts keeps it */
interface Mouse {
  x: number
  y: number
  vx: number
  vy: number
  down: boolean
}

export class Hand {
  /** One frame for a mouse over the canvas: read the cat's zone and mood, draw the hand, then the paws that hold or hit it. */
  frame(ctx: CanvasRenderingContext2D, dpr: number, cat: Cat, m: Mouse, dt: number) {
    const T = cat.belly === 'trap' && cat.trapAt ? { x: cat.ox + cat.trapAt[0] * cat.HW, y: cat.oy + cat.trapAt[1] * cat.HW } : null
    const z = cat.zone
    const on = !!cat.hit(m.x, m.y)
    const swat = cat.swatMode === 'hiss' ? -1 : cat.swatT
    this.draw(ctx, dpr, { x: m.x, y: m.y, vx: m.vx, vy: m.vy, down: m.down, onCat: on, scratch: on && (z === 'chin' || z === 'cheek' || z === 'earbase'), held: m.down ? T : null, swat, HW: cat.HW }, dt)
    if (T) cat.drawFront(ctx, cat.dev(), 1)
    if (T || (swat >= 0 && swat < 0.3 && cat.swatMode === 'hit')) cat.drawFront(ctx, cat.dev(), 0)
    return this.st
  }

  cv = document.createElement('canvas')
  c = this.cv.getContext('2d')!
  /** the tight contact shadow and the soft hover shadow */
  sh = [document.createElement('canvas'), document.createElement('canvas')]
  grain: CanvasPattern
  constructor() {
    const g = document.createElement('canvas')
    g.width = g.height = 64
    const x = g.getContext('2d')!
    for (let k = 0; k < 1400; k++) {
      x.fillStyle = Math.random() < 0.5 ? 'rgba(130,80,60,0.045)' : 'rgba(255,240,225,0.06)'
      x.fillRect(Math.random() * 64, Math.random() * 64, 1, 1)
    }
    this.grain = this.c.createPattern(g, 'repeat')!
  }
  t = 0
  /** lift (1 hovering high, 0 pressed), flatness, scratch, held, finger spread */
  lift = 1
  flat = 0
  scr = 0
  hold = 0
  spread = 1
  /** per-finger lag bend and its velocity */
  bend = [0, 0, 0, 0]
  bv = [0, 0, 0, 0]
  /** swat flinch: offset (along the wrist) and its velocity */
  kick = 0
  kv = 0
  lastSwat = -1
  wig = 0
  rot = 0
  px = 0
  py = 0
  st = ''

  draw(ctx: CanvasRenderingContext2D, dpr: number, i: HandIn, dt: number) {
    dt = Math.min(dt, 0.05)
    this.t += dt
    const t = this.t
    // ---- state (reuses the cat's zone and mood) ----
    const held = i.held
    const strike = i.swat >= 0.14 && this.lastSwat < 0.14
    this.lastSwat = i.swat
    if (strike) this.kv = 16
    this.kv += (-160 * this.kick - 15 * this.kv) * dt
    this.kick += this.kv * dt
    const sp = Math.hypot(i.vx, i.vy)
    this.st = this.kick > 0.05 ? 'swat' : held ? 'held' : i.down ? (i.scratch ? 'scratch' : 'press') : i.onCat ? 'hover' : 'idle'
    const R = dt
    this.lift = ease(this.lift, held ? 0 : i.down ? (i.scratch ? 0.08 : 0) : i.onCat ? 0.6 : 1, i.down ? 19 : 15, R)
    this.lift = Math.max(this.lift, Math.min(1, this.kick * 2))
    this.flat = ease(this.flat, i.down && !i.scratch && !held ? 1 : 0, 16, R)
    this.scr = ease(this.scr, i.down && i.scratch && !held ? 1 : 0, 14, R)
    this.hold = ease(this.hold, held ? 1 : 0, 12, R)
    this.spread = ease(this.spread, this.kick > 0.05 ? 1.6 : i.down ? 0.55 : held ? 0.9 : 1, 12, R)
    // position: 1:1 with the pointer, except when the paws hold it (it strains toward the pointer)
    let x = i.x
    let y = i.y
    if (held) {
      x = held.x + (i.x - held.x) * 0.22
      y = held.y + (i.y - held.y) * 0.22
    }
    this.px = this.hold > 0.01 && !held ? ease(this.px, x, 18, R) : x
    this.py = this.hold > 0.01 && !held ? ease(this.py, y, 18, R) : y
    x = this.px
    y = this.py
    // wiggle while held and pulling
    const pull = held ? Math.min(1, Math.hypot(i.x - held.x, i.y - held.y) / (0.25 * i.HW) + sp / 900) : 0
    this.wig = ease(this.wig, pull, 10, R)
    const bob = (1 - this.flat) * this.lift
    this.rot = ease(this.rot, Math.max(-0.2, Math.min(0.2, i.vx * 0.00018)), 8, R)
    const ang = ANG + this.rot + 0.025 * Math.sin(t * 1.3) * bob + this.wig * 0.09 * Math.sin(t * 23) - this.kick * 0.25
    const ca = Math.cos(ang)
    const sa = Math.sin(ang)
    // the flinch pulls the hand back along the wrist
    x += -sa * this.kick * 0.3 * i.HW
    y += ca * this.kick * 0.3 * i.HW
    y += Math.sin(t * 2.4) * 2 * bob
    const lift = this.lift + 0.06 * Math.sin(t * 2.4) * bob
    // fingers trail the motion: velocity across the hand bends them the other way, each on its own spring
    const lvx = (i.vx * ca + i.vy * sa) / i.HW
    const lvy = (-i.vx * sa + i.vy * ca) / i.HW
    const drag = 1 - 0.6 * this.lift
    for (let k = 0; k < 4; k++) {
      const K = FINGERS[k][5]
      const to = Math.max(-0.32, Math.min(0.32, -lvx * 0.12 * drag)) + this.wig * 0.12 * Math.sin(t * 19 + k * 1.7)
      this.bv[k] += (K * (to - this.bend[k]) - 2 * Math.sqrt(K) * 0.55 * this.bv[k]) * dt
      this.bend[k] += this.bv[k] * dt
    }
    // ---- paint the hand (offscreen, unrotated device px around the hotspot) ----
    const u = 0.092 * i.HW * (1 + 0.1 * lift)
    const half = Math.ceil(7 * 0.1 * i.HW * 1.1 * dpr)
    const cv = this.cv
    if (cv.width !== half * 2) cv.width = cv.height = half * 2
    const c = this.c
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, half * 2, half * 2)
    c.setTransform(dpr * u * ca, dpr * u * sa, -dpr * u * sa, dpr * u * ca, half, half)
    c.translate(0.3, 1.0)
    // the scene light (from the window, upper left) in hand space
    const lx = -0.55 * ca - 0.83 * sa
    const ly = 0.55 * sa - 0.83 * ca
    c.lineCap = c.lineJoin = 'round'
    const curl0 = 0.16 * (1 - this.flat) * (1 - this.scr) + 0.3 * this.hold + Math.max(0, Math.min(0.25, lvy * 0.05)) * this.flat
    // thumb: lies along the hand when pressed, a little out when relaxed
    {
      this.palm(lx, ly, true)
      const a = -2.3 + 0.25 * this.flat - 0.2 * (this.spread - 1) + 0.15 * this.hold
      this.finger(-1.5, 2.75, Math.cos(a), Math.sin(a), 2.35, 0.98, 0.1 + 0.25 * this.hold, lx, ly, 0.4)
    }
    for (let k = 0; k < 4; k++) {
      const [bx, by, L, w, a0, , b0] = FINGERS[k]
      const a = a0 * this.spread * 1.3 + this.bend[k] * 0.5
      // scratching: each fingertip curls in turn
      const curl = Math.min(0.85, curl0 + this.scr * (0.42 + 0.3 * Math.sin(t * 15 - k * 1.1)) + this.wig * 0.15 * (1 + Math.sin(t * 17 + k)))
      this.finger(bx, by, Math.sin(a), -Math.cos(a), L, w, curl, lx, ly, this.bend[k] * 0.6 + b0 * (1 - this.flat * 0.7))
    }
    this.palm(lx, ly, false)
    // one light over the whole hand: warm from the window, cooler and darker away from it
    c.globalCompositeOperation = 'source-atop'
    const g = c.createLinearGradient(lx * 4, 1.5 + ly * 4, -lx * 4, 1.5 - ly * 4)
    g.addColorStop(0, rgba(LIGHT, 0.28))
    g.addColorStop(0.5, rgba(LIGHT, 0))
    g.addColorStop(1, rgba(SHADE, 0.3))
    c.fillStyle = g
    c.fillRect(-5, -4, 10, 12)
    // a fine painterly grain, like the knit and the fur around it
    c.save()
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.fillStyle = this.grain
    c.fillRect(0, 0, half * 2, half * 2)
    c.restore()
    c.globalCompositeOperation = 'source-over'
    // a soft knitted sleeve cuff; the arm beyond it is out of the picture
    c.fillStyle = rgba(KNIT, 1)
    c.beginPath()
    c.roundRect(-1.7, 4.1, 3.3, 3.2, 0.7)
    c.fill()
    c.lineWidth = 0.16
    for (let k = -1.35; k < 1.5; k += 0.36) {
      c.strokeStyle = rgba([92, 104, 124], 0.45)
      c.beginPath()
      c.moveTo(k, 4.3)
      c.lineTo(k, 7)
      c.stroke()
    }
    const sg = c.createLinearGradient(lx * 2, 5.6 + ly * 2, -lx * 2, 5.6 - ly * 2)
    sg.addColorStop(0, 'rgba(255,245,230,0.3)')
    sg.addColorStop(1, 'rgba(40,40,60,0.3)')
    c.fillStyle = sg
    c.fill()
    c.globalCompositeOperation = 'destination-out'
    const fo = c.createLinearGradient(0, 5.4, 0, 7.3)
    fo.addColorStop(0, 'rgba(0,0,0,0)')
    fo.addColorStop(1, '#000')
    c.fillStyle = fo
    c.fillRect(-3, 5.4, 6, 3)
    c.globalCompositeOperation = 'source-over'
    // ---- composite: shadows from the silhouette shrunk and scaled back up (a cheap, even blur), then the hand ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const W = (half * 2) / dpr
    const HW = i.HW
    const shade = (k: number, a: number, dx: number, dy: number) => {
      if (a < 0.01) return
      const s = this.sh[k]
      const n = k ? 110 : 180
      if (s.width !== n) s.width = s.height = n
      const g = s.getContext('2d')!
      g.globalCompositeOperation = 'copy'
      g.imageSmoothingQuality = 'high'
      g.drawImage(cv, 0, 0, n, n)
      g.globalCompositeOperation = 'source-in'
      g.fillStyle = 'rgb(84,60,44)'
      g.fillRect(0, 0, n, n)
      ctx.globalAlpha = a
      ctx.drawImage(s, x - W / 2 + dx * HW, y - W / 2 + dy * HW, W, W)
    }
    shade(0, 0.6 * Math.max(0, 1 - lift * 2.5), 0.008, 0.014)
    shade(1, 0.5 + 0.15 * Math.min(1, lift * 2), 0.015 + 0.15 * lift, 0.025 + 0.09 * lift)
    ctx.globalAlpha = 1
    ctx.drawImage(cv, x - W / 2, y - W / 2, W, W)
  }

  /** a finger (or the thumb) from base (bx, by) along (dx, dy): two segments, rounded, lit from (lx, ly) */
  private finger(bx: number, by: number, dx: number, dy: number, L: number, w: number, curl: number, lx: number, ly: number, bend: number) {
    const c = this.c
    // curled fingertips go down into the fur: shorter from above
    const len = L * (1 - 0.45 * curl)
    const jx = bx + dx * len * 0.56
    const jy = by + dy * len * 0.56
    const cb = Math.cos(bend)
    const sb = Math.sin(bend)
    const ex = dx * cb - dy * sb
    const ey = dx * sb + dy * cb
    const tx = jx + ex * len * 0.44
    const ty = jy + ey * len * 0.44
    const line = (o: number, width: number, col: string, cut = 0) => {
      c.strokeStyle = col
      c.lineWidth = width
      c.beginPath()
      c.moveTo(bx + lx * o, by + ly * o)
      c.lineTo(jx + lx * o, jy + ly * o)
      c.lineTo(tx - ex * cut + lx * o, ty - ey * cut + ly * o)
      c.stroke()
    }
    // soft darker rim, the body, a lit ridge toward the window
    line(-0.02, w + 0.09, rgba(SHADE, 0.4))
    line(0, w, rgba(SKIN, 1))
    line(w * 0.16, w * 0.5, rgba(LIGHT, 0.22), 0.2)
    // warm blush on the fingertip
    c.fillStyle = rgba(BLUSH, 0.22)
    c.beginPath()
    c.arc(tx - ex * w * 0.15, ty - ey * w * 0.15, w * 0.42, 0, 7)
    c.fill()
    // the curled tip turns away from the light
    if (curl > 0.05) {
      c.fillStyle = rgba(SHADE, curl * 0.45)
      c.beginPath()
      c.arc(tx, ty, w * 0.42, 0, 7)
      c.fill()
    }
    // knuckle crease
    c.strokeStyle = rgba(SHADE, 0.3)
    c.lineWidth = 0.045
    for (const o of [-0.08, 0.08]) {
      c.beginPath()
      c.moveTo(jx - ey * w * 0.18 + ex * o, jy + ex * w * 0.18 + ey * o)
      c.quadraticCurveTo(jx + ex * (o + 0.06), jy + ey * (o + 0.06), jx + ey * w * 0.18 + ex * o, jy - ex * w * 0.18 + ey * o)
      c.stroke()
    }
    // the nail, hidden as the tip curls under
    const na = Math.max(0, 1 - curl * 1.6)
    if (na > 0.02) {
      const nx = tx - ex * w * 0.3
      const ny = ty - ey * w * 0.3
      c.fillStyle = `rgba(246,206,194,${0.75 * na})`
      c.beginPath()
      c.ellipse(nx, ny, w * 0.27, w * 0.36, Math.atan2(ey, ex) + Math.PI / 2, 0, 7)
      c.fill()
      c.fillStyle = `rgba(255,248,242,${0.55 * na})`
      c.beginPath()
      c.arc(nx + lx * w * 0.1, ny + ly * w * 0.12, w * 0.08, 0, 7)
      c.fill()
    }
  }

  /** the back of the hand, slightly cupped: darker at both edges, lit toward the window, knuckle bumps */
  private palm(lx: number, ly: number, rim: boolean) {
    const c = this.c
    const f = 1 + 0.05 * this.flat
    c.save()
    c.scale(f, 1)
    c.beginPath()
    c.moveTo(-1.62, 1.0)
    c.quadraticCurveTo(0, 0.5, 1.55, 1.05)
    c.quadraticCurveTo(1.9, 2.4, 1.35, 3.7)
    c.lineTo(1.15, 5)
    c.lineTo(-1.05, 5)
    c.quadraticCurveTo(-1.3, 3.6, -1.75, 2.6)
    c.quadraticCurveTo(-1.98, 1.6, -1.62, 1.0)
    if (rim) {
      // the soft edge goes under the fingers, so the knuckle line has no seam
      c.strokeStyle = rgba(SHADE, 0.55)
      c.lineWidth = 0.1
      c.stroke()
      c.restore()
      return
    }
    c.fillStyle = rgba(SKIN, 1)
    c.fill()
    c.clip()
    const cup = c.createLinearGradient(-1.9, 0, 1.9, 0)
    const e = 0.3 - 0.15 * this.flat
    cup.addColorStop(0, rgba(SHADE, e))
    cup.addColorStop(0.3, rgba(SHADE, 0))
    cup.addColorStop(0.7, rgba(SHADE, 0))
    cup.addColorStop(1, rgba(SHADE, e + 0.08))
    c.fillStyle = cup
    c.fillRect(-2, 0, 4, 5)
    const hx = lx * 1.1
    const hy = 2 + ly * 1.1
    const hi = c.createRadialGradient(hx, hy, 0, hx, hy, 2.4)
    hi.addColorStop(0, rgba(LIGHT, 0.7))
    hi.addColorStop(1, rgba(LIGHT, 0))
    c.fillStyle = hi
    c.fillRect(-2, 0, 4, 5)
    // knuckles: a lit bump at each finger base, a soft hollow between
    for (let k = 0; k < 4; k++) {
      const [bx, by, , w] = FINGERS[k]
      c.fillStyle = rgba(BLUSH, 0.09)
      c.beginPath()
      c.ellipse(bx, by + 0.3, w * 0.42, w * 0.3, 0, 0, 7)
      c.fill()
      c.fillStyle = rgba(LIGHT, 0.3)
      c.beginPath()
      c.ellipse(bx + lx * 0.1, by + 0.25 + ly * 0.1, w * 0.26, w * 0.18, 0, 0, 7)
      c.fill()
      // a faint tendon ridge toward the wrist
      c.strokeStyle = rgba(LIGHT, 0.14)
      c.lineWidth = 0.22
      c.beginPath()
      c.moveTo(bx, by + 0.55)
      c.lineTo(bx * 0.45, 3.4)
      c.stroke()
    }
    c.restore()
  }
}
