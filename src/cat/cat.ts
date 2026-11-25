// The cat: rig state, mood (bliss / irk / sleepy), reactions, idle life and rendering of all parts in order.

import { Baker, type Sprite } from './bake'
import { drawFace, drawWhiskers, restFace, type FaceState } from './face'
import { mulberry32, smoothstep, type Rng } from './noise'
import { COAT, P, css } from './palette'
import { D2R, EAR, EXTENT, EYE, FOOT, HEAD_C, HEAD_ROT, type Mat, PAW_FAR, PAW_NEAR, type PartDef, type PartId, TAIL_TIP_JOINT, type V2, apply, buildRig, catSilhouette, ident, inv, mul, rot, scl, tailCurve, torsoUV, tr } from './rig'
import { Groom, TuftLayer } from './tufts'

export type Zone = 'none' | 'chest' | 'back' | 'backWith' | 'tailbase' | 'top' | 'cheek' | 'earbase' | 'chin' | 'nose' | 'backAgainst' | 'paw' | 'tail' | 'belly'
/** when two fingers touch two zones, the later one in this list wins */
const RANK: Zone[] = ['none', 'chest', 'back', 'backWith', 'tailbase', 'top', 'cheek', 'earbase', 'chin', 'nose', 'backAgainst', 'paw', 'tail', 'belly']

export type CatEvent =
  | 'pet'
  | 'zone'
  | 'boop'
  | 'sneeze'
  | 'beans'
  | 'beans_hold'
  | 'tail'
  | 'tailbase'
  | 'grain'
  | 'rough'
  | 'belly_no'
  | 'belly_invite'
  | 'trap'
  | 'kick'
  | 'release'
  | 'granted'
  | 'warn04'
  | 'warn07'
  | 'purr_cut'
  | 'swat'
  | 'thump'
  | 'knead_start'
  | 'biscuit'
  | 'knead_end'
  | 'groom'
  | 'slow_blink'
  | 'sleep'
  | 'wake'
  | 'trill'
  | 'glass_push'
  | 'glass_fall'

/** shoulders the front legs rotate about when reaching */
const SHOULDER_N: V2 = [-0.3, 0.02]
const SHOULDER_F: V2 = [-0.2, 0.36]
/** where the glass stands on the blanket (cat space, base centre) */
const GLASS: V2 = [-1.24, 0.9]

export interface Touch {
  /** css px */
  x: number
  y: number
  /** css px / s */
  vx: number
  vy: number
}

class Spring {
  v = 0
  constructor(
    public x = 0,
    public k = 120,
    public d = 22,
  ) {}
  step(target: number, dt: number, k = this.k, d = this.d) {
    // semi-implicit Euler, sub-stepped so stiff springs (fast swats) stay stable
    const n = Math.max(1, Math.ceil((dt * Math.max(Math.sqrt(k), d)) / 0.4))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      const a = k * (target - this.x) - d * this.v
      this.v += a * h
      this.x += this.v * h
    }
    return this.x
  }
}

export interface CatOpts {
  seed: number
  fur: boolean
}

/** resting eye openness: sleepy-content, upper lid about 45 % down */
const REST_LID = 0.5

/** flat stand-in colours for parts whose sprite is not built yet */
const FLAT: Record<PartId, string> = {
  tailA: '#7E6B57',
  tailB: '#7E6B57',
  tailC: '#7E6B57',
  belly: '#ECE5DA',
  torso: '#857160',
  thigh: '#7E6B57',
  footNear: '#E6DED2',
  legFar: '#E6DED2',
  chest: '#ECE5DA',
  legNear: '#ECE5DA',
  earL: '#7E6B57',
  earR: '#7E6B57',
  head: '#857160',
}

const TUFT_PARTS: PartId[] = ['head', 'torso', 'thigh']
const HIT_ORDER: PartId[] = ['head', 'earL', 'earR', 'legNear', 'chest', 'legFar', 'tailC', 'tailB', 'footNear', 'belly', 'thigh', 'torso', 'tailA']

export class Cat {
  defs: PartDef[]
  baker!: Baker
  grooms = new Map<PartId, Groom>()
  layers = new Map<PartId, TuftLayer>()
  HW = 100
  ox = 0
  oy = 0
  dpr = 1
  blanket: HTMLCanvasElement | null = null
  headShadow: HTMLCanvasElement | null = null
  rnd: Rng
  half = false
  tuftMs = 0
  tuftCount = 0
  matchMs = 0

  // mood
  bliss = 0
  irk = 0
  sleepy = 0
  asleep = false
  irkStage = 0
  zone: Zone = 'none'
  lastZone: Zone = 'none'
  zoneTime = 0
  idleT = 0
  reversals: number[] = []
  lastV: [number, number] | null = null
  roughSaid = false
  petT = 0
  onEvent?: (e: CatEvent, n: number) => void
  // belly trap
  belly: 'none' | 'invite' | 'soft' | 'trap' | 'granted' = 'none'
  bellyT = 0
  bellyUntil = 0
  bellyCool = 0
  blissHighT = 0
  trapAt: V2 | null = null
  kickT = -1
  kicksLeft = 0
  lastKickAt = 0
  // swat
  swatT = -1
  swatAt: V2 = [0, 0]
  claws: { x: number; y: number; t: number }[] = []
  thumpPhase = 0
  // kneading / grooming / yawning / sleep
  knead = 0
  kneadHighT = 0
  kneadStart = 0
  kneadCool = 0
  kneadPhase = 0
  biscuitsNow = 0
  groomT = -1
  groomDur = 2.2
  groomAt = 30
  yawnT = -1
  wakeT = -1
  sleepStart = 0
  dreamT = -1
  dreamAt = 15
  dreamKind = 0
  // one-offs
  crossT = -1
  sneezeAt = 0
  scratchT = -1
  scratchCool = 0
  pawTaps = 0
  pawT = -1
  pawOnFinger = false
  whipT = -1
  rippleT = -1
  withT = 0
  jig: V2 = [0, 0]
  glass = { state: 'idle' as 'idle' | 'look' | 'push' | 'fall' | 'gone', t: 0, x: GLASS[0], y: GLASS[1], k: 0, pushes: 0, alpha: 1 }
  // pose springs
  earBack = new Spring(0, 120, 18)
  airplane = new Spring(0, 300, 30)
  slit = new Spring(0, 90, 16)
  roll = new Spring(0, 40, 12)
  stretch = new Spring(0, 30, 10)
  hipLift = new Spring(0, 60, 12)
  sleepPose = new Spring(0, 20, 9)
  footRot = new Spring(0, 40, 12)
  kneadAmt = new Spring(0, 30, 11)
  tailTip = new Spring(0, 160, 20)
  aimN: V2 = [PAW_NEAR.x, PAW_NEAR.y]
  aimF: V2 = [PAW_FAR.x, PAW_FAR.y]
  aimNK = new Spring(0, 160, 22)
  aimFK = new Spring(0, 300, 30)
  zoneSide = 0
  contact = 0 // seconds since last contact on the cat (0 = touching now)
  // pose / rig
  face: FaceState = restFace()
  headX = new Spring()
  headY = new Spring()
  headR = new Spring()
  look = new Spring()
  happy = new Spring(0, 90, 19)
  earFold = [new Spring(0, 300, 13), new Spring(0, 300, 13)]
  earTurn = [new Spring(0, 80, 18), new Spring(0, 80, 18)]
  squint = [new Spring(0, 160, 25), new Spring(0, 160, 25)]
  lidBase = new Spring(REST_LID, 60, 14)
  /** seconds since the cat noticed the finger (-1: not noticing) */
  noticeT = -1
  ptrSeenAt = -99
  restSlowAt = 7
  slideX = new Spring(0, 120, 14)
  slideY = new Spring(0, 120, 14)
  breath = 0 // 0..1 phase
  breathAmp = 0.022
  t = 0
  blinkAt = 3
  blinkT = -1
  slowBlinkAt = 8
  slowBlinkT = -1
  slowBlinks = 0
  twitchAt = 10
  twitchT = -1
  twitchSide = 0
  pupil: [number, number] = [0, 0]
  finger: { x: number; y: number; on: boolean } = { x: 0, y: 0, on: false }
  onSlowBlink?: () => void
  onTufts?: () => void
  /** one tuft colour match (a sprite readback) per frame at most */
  private matchedThisFrame = false

  constructor(private o: CatOpts) {
    this.defs = buildRig({ seed: o.seed })
    this.rnd = mulberry32(o.seed * 991 + 7)
    this.blinkAt = 2.5 + this.rnd() * 3
    this.twitchAt = 8 + this.rnd() * 12
  }

  /** Recompute layout; rebakes sprites when the scale changes. */
  timings: Record<string, number> = {}
  layout(w: number, h: number, dpr: number, keepBake = false) {
    // fit the whole cat (with whiskers) to ~96 % of the width, centred at 45 % of the height
    const ew = EXTENT.x1 - EXTENT.x0
    const eh = EXTENT.y1 - EXTENT.y0
    const HW = Math.min((w * 0.96) / ew, (h * 0.56) / eh)
    this.ox = w / 2 - HW * ((EXTENT.x0 + EXTENT.x1) / 2)
    this.oy = h * 0.45 - HW * ((EXTENT.y0 + EXTENT.y1) / 2)
    const changed = !this.baker || (!keepBake && Math.abs(HW * dpr - this.HW * this.dpr) > 1) || Math.abs(HW - this.HW) > 1
    this.HW = HW
    this.dpr = dpr
    const tm = (k: string, f: () => void) => {
      const a = performance.now()
      f()
      this.timings[k] = performance.now() - a
    }
    if (changed) {
      const ppu = Math.min(HW * dpr, 400)
      tm('baker', () => (this.baker = new Baker(this.defs, { ppu, seed: this.o.seed, fur: this.o.fur })))
      // tufts need the parts' distance fields: built as bake jobs, one part per job
      if (!this.grooms.size) for (const id of TUFT_PARTS) this.baker.add(() => this.buildTufts(id))
      else for (const l of this.layers.values()) l.matched = false
      tm('headShadow', () => this.buildHeadShadow())
    }
    tm('blanket', () => this.buildBlanket(w, h, dpr))
  }

  private sprite(id: PartId): Sprite {
    return this.baker.sprites.get(id)!
  }
  private has(id: PartId) {
    return this.baker.sprites.has(id)
  }

  private buildTufts(id: PartId) {
    const fieldOf = (id: PartId) => this.sprite(id).field
    const covers = (ids: PartId[]) => (x: number, y: number) =>
      ids.some((id) => {
        const def = this.defs.find((d) => d.id === id)!
        const [lx, ly] = apply(inv(def.toCat), x, y)
        return fieldOf(id).sample(lx, ly) > 0.03
      })
    {
      const def = this.defs.find((d) => d.id === id)!
      const [x0, y0, x1, y1] = def.bbox
      const g = new Groom(def, x0, y0, x1, y1)
      this.grooms.set(id, g)
      const exclude =
        id === 'head'
          ? (x: number, y: number) => {
              const ex = (Math.abs(x) - EYE.x) / (EYE.w * 0.62)
              const ey = (y - EYE.y) / (EYE.h * 0.62)
              if (ex * ex + ey * ey < 1) return true
              // nose and mouth
              return Math.abs(x) < 0.09 && y > 0.14 && y < 0.31
            }
          : id === 'torso'
            ? covers(['head', 'legNear', 'legFar', 'chest', 'thigh', 'footNear', 'tailB', 'tailC'])
            : covers(['footNear', 'tailB', 'tailC'])
      const layer = new TuftLayer(def, fieldOf(id), g, this.o.seed * 31 + id.length, exclude)
      this.layers.set(id, layer)
    }
    this.tuftCount = [...this.layers.values()].reduce((a, l) => a + l.tufts.length, 0)
    this.onTufts?.()
  }

  private buildHeadShadow() {
    const def = this.defs.find((d) => d.id === 'head')!
    const ppu = Math.max(20, this.baker.ppu * 0.35)
    const pad = 0.3
    const [x0, y0, x1, y1] = def.bbox
    const cv = document.createElement('canvas')
    cv.width = Math.ceil((x1 - x0 + pad * 2) * ppu)
    cv.height = Math.ceil((y1 - y0 + pad * 2) * ppu)
    const c = cv.getContext('2d')!
    const off = 10000
    c.setTransform(ppu, 0, 0, ppu, (-x0 + pad) * ppu - off, (-y0 + pad) * ppu)
    c.shadowColor = 'rgba(50,34,22,1)'
    c.shadowBlur = 0.09 * ppu
    c.shadowOffsetX = off
    c.fillStyle = '#000'
    c.beginPath()
    def.path(c)
    c.fill()
    this.headShadow = cv
  }

  /** Rug rectangle in css px: a rounded knit patch under the cat, extending a little more in front. */
  rugRect(w: number, h: number) {
    const HW = this.HW
    const rw = Math.min(w * 0.96, HW * 3.8)
    // under the cat, but never off the screen edges
    const cx = Math.max(rw / 2 + w * 0.02, Math.min(w - rw / 2 - w * 0.02, this.ox + HW * -0.12))
    // stays clear of the hint line at the bottom
    const y0 = Math.max(h * 0.02, this.oy - HW * 1.42)
    const y1 = Math.min(h - 100, this.oy + HW * 1.78)
    return { x0: cx - rw / 2, x1: cx + rw / 2, y0, y1 }
  }

  private buildBlanket(w: number, h: number, dpr: number) {
    const cv = document.createElement('canvas')
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const c = cv.getContext('2d')!
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    // the surface: a warm linen sofa
    c.fillStyle = css(P.blanket)
    c.fillRect(0, 0, w, h)
    const lg = c.createLinearGradient(0, 0, w, h)
    lg.addColorStop(0, 'rgba(250,242,230,0.55)')
    lg.addColorStop(0.5, 'rgba(250,242,230,0)')
    lg.addColorStop(1, 'rgba(120,90,60,0.12)')
    c.fillStyle = lg
    c.fillRect(0, 0, w, h)
    {
      // fine linen weave from a small tile
      const t = document.createElement('canvas')
      const ts = 96
      t.width = ts
      t.height = ts
      const tc = t.getContext('2d')!
      const id = tc.createImageData(ts, ts)
      const nr = mulberry32(3)
      for (let i = 0; i < id.data.length; i += 4) {
        const v = nr()
        id.data[i] = v < 0.5 ? 110 : 255
        id.data[i + 1] = v < 0.5 ? 85 : 250
        id.data[i + 2] = v < 0.5 ? 60 : 240
        id.data[i + 3] = 255 * 0.05 * Math.abs(v - 0.5) * 2
      }
      tc.putImageData(id, 0, 0)
      const pat = c.createPattern(t, 'repeat')!
      c.save()
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.fillStyle = pat
      c.fillRect(0, 0, cv.width, cv.height)
      c.restore()
    }

    const HW = this.HW
    const r = this.rugRect(w, h)
    const rugPath = (k = 0) => {
      // a soft superellipse with a slight hand-made wobble
      const p = new Path2D()
      const cx = (r.x0 + r.x1) / 2
      const cy = (r.y0 + r.y1) / 2
      const rx = (r.x1 - r.x0) / 2 + k
      const ry = (r.y1 - r.y0) / 2 + k
      const N = 160
      for (let i = 0; i <= N; i++) {
        const th = (i / N) * Math.PI * 2
        const ct = Math.cos(th)
        const st = Math.sin(th)
        const e = 0.8
        // a throw lies a little unevenly: slow waves along the edge where the fabric drapes
        const wob = 1 + 0.008 * Math.sin(th * 2 + 0.7) + 0.006 * Math.sin(th * 5 + 1.9) + 0.003 * Math.sin(th * 11 + 0.4)
        let x = rx * wob * Math.sign(ct) * Math.pow(Math.abs(ct), e)
        let y = ry * wob * Math.sign(st) * Math.pow(Math.abs(st), e)
        // a touch of perspective (front edge wider) and a slight casual tilt
        x *= 1 + 0.045 * (y / ry)
        const tilt = -0.035
        const xr = x * Math.cos(tilt) - y * Math.sin(tilt)
        y = x * Math.sin(tilt) + y * Math.cos(tilt)
        x = cx + xr
        y = cy + y
        if (i === 0) p.moveTo(x, y)
        else p.lineTo(x, y)
      }
      p.closePath()
      return p
    }
    // yarn fringe on the two short ends (drawn first; the throw covers the roots)
    {
      const nr = mulberry32(11)
      const cx = (r.x0 + r.x1) / 2
      const span = (r.x1 - r.x0) * 0.3
      const step = Math.max(4, 0.05 * HW)
      c.save()
      c.lineCap = 'round'
      for (const [yy, dir] of [
        [r.y0, -1],
        [r.y1, 1],
      ] as const)
        for (let x = cx - span; x <= cx + span; x += step * (0.8 + 0.4 * nr())) {
          // short soft yarn ends, a little uneven, as on a hand-knitted throw
          const L = 0.075 * HW * (0.75 + 0.5 * nr())
          const sway = (nr() - 0.5) * 0.06 * HW
          const y0 = yy - dir * 0.05 * HW
          c.strokeStyle = css(P.rugDark, 0.55)
          c.lineWidth = Math.max(1.2, 0.02 * HW)
          c.beginPath()
          c.moveTo(x, y0)
          c.quadraticCurveTo(x + sway * 0.2, yy + dir * L * 0.5, x + sway, yy + dir * L)
          c.stroke()
          c.strokeStyle = css(P.rugHi, 0.35)
          c.lineWidth = Math.max(0.6, 0.008 * HW)
          c.stroke()
        }
      c.restore()
    }
    // a thin knitted throw: only a soft, close shadow on the sofa
    c.save()
    c.shadowColor = css(P.shadow, 0.2)
    c.shadowBlur = 0.07 * HW * dpr
    c.shadowOffsetY = 0.015 * HW * dpr
    c.fillStyle = css(P.rugDark)
    c.fill(rugPath())
    c.restore()
    // knitted stockinette: columns of V stitches, from one shaded stitch tile
    {
      const pitch = Math.max(8, 0.085 * HW) * dpr
      const rowH = pitch * 0.72
      const t = document.createElement('canvas')
      t.width = Math.round(pitch)
      t.height = Math.round(rowH)
      const tc = t.getContext('2d')!
      const tw = t.width
      const th = t.height
      tc.fillStyle = css(P.rugDark)
      tc.fillRect(0, 0, tw, th)
      // each stitch is a V of two slim slanted loops; loops overlap the row below, so draw the
      // neighbours above and below too and the tile wraps seamlessly
      for (const dy of [-th, 0, th])
        for (const side of [-1, 1]) {
          const lx = tw / 2 + side * tw * 0.2
          const ly = th * 0.5 + dy
          const rx = tw * 0.17
          const ry = th * 0.88
          const rot = side * 0.5
          const g = tc.createLinearGradient(lx - side * rx, ly - ry, lx + side * rx, ly + ry)
          g.addColorStop(0, css(P.rugHi))
          g.addColorStop(0.5, css(P.rug))
          g.addColorStop(1, css(P.rugDark, 0.9))
          tc.fillStyle = g
          tc.beginPath()
          tc.ellipse(lx, ly, rx, ry, rot, 0, Math.PI * 2)
          tc.fill()
          tc.strokeStyle = css(P.rugDark, 0.5)
          tc.lineWidth = Math.max(0.8, tw * 0.025)
          tc.stroke()
          // yarn ply highlight along the loop
          tc.strokeStyle = css(P.rugHi, 0.6)
          tc.lineWidth = Math.max(0.8, tw * 0.035)
          tc.beginPath()
          tc.moveTo(lx - side * rx * 0.1 + Math.sin(rot) * ry * 0.5, ly - ry * 0.5)
          tc.lineTo(lx - side * rx * 0.1 - Math.sin(rot) * ry * 0.1, ly + ry * 0.1)
          tc.stroke()
        }
      const pat = c.createPattern(t, 'repeat')!
      c.save()
      c.clip(rugPath())
      c.setTransform(1, 0, 0, 1, Math.round(((r.x0 + r.x1) / 2) * dpr - tw / 2), Math.round(r.y0 * dpr))
      c.fillStyle = pat
      c.fillRect(-cv.width, -cv.height, cv.width * 3, cv.height * 3)
      c.restore()
    }
    c.save()
    c.clip(rugPath())
    // the edge curls under a little: a soft darkening, no seam, no band
    c.save()
    c.filter = `blur(${(0.05 * HW).toFixed(1)}px)`
    c.strokeStyle = css(P.rugDark, 0.4)
    c.lineWidth = 0.09 * HW
    c.stroke(rugPath())
    c.restore()
    // a soft fold across the front of the rug, and a gentle one behind
    const fold = (ax: number, ay: number, bx: number, by: number, qx: number, qy: number, width: number, dark: number) => {
      const p = new Path2D()
      p.moveTo(ax, ay)
      p.quadraticCurveTo(qx, qy, bx, by)
      c.save()
      c.lineCap = 'round'
      c.filter = `blur(${(width * 0.45).toFixed(1)}px)`
      c.strokeStyle = `rgba(90,50,35,${dark})`
      c.lineWidth = width
      c.stroke(p)
      c.translate(-width * 0.55, -width * 0.6)
      c.strokeStyle = `rgba(255,236,222,${dark * 0.9})`
      c.lineWidth = width * 0.7
      c.stroke(p)
      c.restore()
    }
    fold(r.x0 + (r.x1 - r.x0) * 0.42, r.y1 + 4, r.x1 + 4, r.y0 + (r.y1 - r.y0) * 0.62, r.x0 + (r.x1 - r.x0) * 0.86, r.y1 - (r.y1 - r.y0) * 0.1, 0.22 * HW, 0.38)
    fold(r.x0 - 4, r.y0 + (r.y1 - r.y0) * 0.3, r.x0 + (r.x1 - r.x0) * 0.32, r.y0 - 4, r.x0 + (r.x1 - r.x0) * 0.1, r.y0 + (r.y1 - r.y0) * 0.08, 0.12 * HW, 0.14)
    // loose wrinkles where the cat has pushed the throw about
    fold(r.x0 + (r.x1 - r.x0) * 0.08, r.y0 + (r.y1 - r.y0) * 0.78, r.x0 + (r.x1 - r.x0) * 0.3, r.y1 - 2, r.x0 + (r.x1 - r.x0) * 0.14, r.y0 + (r.y1 - r.y0) * 0.93, 0.09 * HW, 0.12)
    fold(r.x0 + (r.x1 - r.x0) * 0.7, r.y0 + 2, r.x1 - 2, r.y0 + (r.y1 - r.y0) * 0.22, r.x0 + (r.x1 - r.x0) * 0.9, r.y0 + (r.y1 - r.y0) * 0.06, 0.1 * HW, 0.12)
    // light from the top left across the rug
    const rg = c.createLinearGradient(r.x0, r.y0, r.x1, r.y1)
    rg.addColorStop(0, 'rgba(255,240,228,0.16)')
    rg.addColorStop(0.6, 'rgba(255,240,228,0)')
    rg.addColorStop(1, 'rgba(80,45,30,0.12)')
    c.fillStyle = rg
    c.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
    c.restore()

    // the cat sinks into the rug: a pressed-down hollow under it, with the knit bunched up round it
    const off = 20000
    c.save()
    c.clip(rugPath())
    c.shadowOffsetX = off * dpr
    c.fillStyle = '#000'
    c.shadowColor = 'rgba(255,232,215,0.4)'
    c.shadowBlur = 0.1 * HW * dpr
    c.setTransform(dpr * HW * 1.05, 0, 0, dpr * HW * 1.05, dpr * (this.ox - off - 0.04 * HW), dpr * (this.oy - 0.05 * HW))
    catSilhouette(this.defs, c)
    c.shadowColor = css(P.shadow, 0.42)
    c.shadowBlur = 0.22 * HW * dpr
    c.setTransform(dpr * HW, 0, 0, dpr * HW, dpr * (this.ox + 0.05 * HW - off), dpr * (this.oy + 0.07 * HW))
    catSilhouette(this.defs, c)
    c.restore()
    // tighter, darker contact core
    c.save()
    c.shadowOffsetX = off * dpr
    c.fillStyle = '#000'
    c.shadowColor = css(P.shadow, 0.38)
    c.shadowBlur = 0.05 * HW * dpr
    c.setTransform(dpr * HW * 0.985, 0, 0, dpr * HW * 0.985, dpr * (this.ox + 0.02 * HW - off), dpr * (this.oy + 0.035 * HW))
    catSilhouette(
      this.defs.filter((d) => d.id !== 'head' && d.id !== 'earL' && d.id !== 'earR'),
      c,
    )
    c.restore()
    // vignette
    const vg = c.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.4, w / 2, h * 0.45, Math.hypot(w, h) * 0.6)
    vg.addColorStop(0, 'rgba(107,84,64,0)')
    vg.addColorStop(1, 'rgba(107,84,64,0.22)')
    c.fillStyle = vg
    c.fillRect(0, 0, w, h)
    this.blanket = cv
  }


  // ---------- transforms (cat space) ----------

  headM(): Mat {
    const st = this.stretch.x
    const sl = this.sleepPose.x
    return mul(tr(HEAD_C[0] + this.headX.x - 0.1 * st + this.jig[0], HEAD_C[1] + this.headY.x + 0.045 * sl + this.jig[1]), rot(HEAD_ROT + this.headR.x - 5 * D2R * sl))
  }
  earM(side: -1 | 1): Mat {
    const i = side < 0 ? 0 : 1
    const tilt = side * (EAR.tilt + (side < 0 ? EAR.extraLeft : 0))
    const fold = this.earFold[i].x
    const twitch = this.twitchT >= 0 && this.twitchSide === side ? this.twitchAngle() : 0
    const relax = 8 * D2R * Math.max(0, Math.min(1, this.happy.x))
    const back = this.earBack.x
    const air = this.airplane.x
    const r = tilt + side * (fold * 0.4 + relax + back * 20 * D2R + air * 50 * D2R) + this.earTurn[i].x + side * twitch
    return mul(this.headM(), mul(tr(side * EAR.x, EAR.y + fold * 0.03 + air * 0.03), mul(rot(r), scl(1 - fold * 0.12, (1 - fold * 0.55) * (1 - 0.3 * air)))))
  }
  torsoM(): Mat {
    const b = this.breathAmp * (this.asleep ? 1.35 : 1) * (0.5 - 0.5 * Math.cos(this.breath * Math.PI * 2))
    // the belly rests on the blanket: breathing lifts the back, the ground line stays put
    const px = 0.35
    const py = 0.6
    const rip = this.rippleT >= 0 ? 0.025 * Math.sin(this.rippleT * 25) * Math.max(0, 1 - this.rippleT / 0.25) : 0
    let m: Mat = mul(tr(px + this.slideX.x * 0.5 + this.jig[0], py + this.slideY.x * 0.5 + this.jig[1]), mul(scl(1 + b * 0.25, 1 + b + rip), tr(-px, -py)))
    // stretch: the body lengthens toward the head (pivot at the hips)
    const st = this.stretch.x
    if (st > 0.001) m = mul(tr(1.0, 0.3), mul(scl(1 + 0.08 * st, 1 - 0.02 * st), mul(tr(-1.0, -0.3), m)))
    // "pat the butt": hips lift (rotate about the chest)
    const hip = this.hipLift.x
    if (Math.abs(hip) > 0.001) m = mul(tr(-0.4, 0.5), mul(rot(-3 * D2R * hip), mul(tr(0.4, -0.5), m)))
    return m
  }
  /** Rotate a leg about its shoulder so the paw points at a target, sliding out along the way. */
  private aimM(sh: V2, paw: V2, tx: number, ty: number, k: number, maxExt: number): Mat {
    if (k < 0.001) return ident
    const a0 = Math.atan2(paw[1] - sh[1], paw[0] - sh[0])
    const a1 = Math.atan2(ty - sh[1], tx - sh[0])
    let da = a1 - a0
    while (da > Math.PI) da -= Math.PI * 2
    while (da < -Math.PI) da += Math.PI * 2
    const d0 = Math.hypot(paw[0] - sh[0], paw[1] - sh[1])
    const d1 = Math.min(Math.hypot(tx - sh[0], ty - sh[1]), d0 + maxExt)
    const ext = (d1 - d0) * k
    const a = a0 + da * k
    return mul(tr(Math.cos(a) * ext, Math.sin(a) * ext), mul(tr(sh[0], sh[1]), mul(rot(da * k), tr(-sh[0], -sh[1]))))
  }
  legM(near: boolean): Mat {
    const st = this.stretch.x
    const aim = near ? this.aimN : this.aimF
    const k = near ? this.aimNK.x : this.aimFK.x
    let m = this.aimM(near ? SHOULDER_N : SHOULDER_F, near ? [PAW_NEAR.x, PAW_NEAR.y] : [PAW_FAR.x, PAW_FAR.y], aim[0], aim[1], Math.max(0, Math.min(1.1, k)), near ? 0.85 : 0.5)
    // kneading: alternate pushes into the blanket, toes spread
    const kn = this.kneadAmt.x
    if (kn > 0.001) {
      const ph = Math.sin(this.kneadPhase * Math.PI * 2 + (near ? 0 : Math.PI))
      // press: the paw spreads and sinks in; lift: it rises and draws back
      const push = Math.max(0, ph) * kn
      const lift = Math.max(0, -ph) * kn
      const p = near ? PAW_NEAR : PAW_FAR
      m = mul(tr(-0.04 * push + 0.05 * lift, 0.04 * push - 0.11 * lift), mul(tr(p.x, p.y), mul(scl(1 + 0.16 * push, 1 + 0.08 * push), mul(tr(-p.x, -p.y), m))))
    }
    // dream twitch of the near paw
    if (near && this.dreamT >= 0 && this.dreamKind === 0) m = mul(tr(PAW_NEAR.x, PAW_NEAR.y), mul(rot(-8 * D2R * Math.sin(this.dreamT * 30) * Math.max(0, 1 - this.dreamT / 0.4)), mul(tr(-PAW_NEAR.x, -PAW_NEAR.y), m)))
    return mul(tr(-0.1 * st + this.jig[0], this.jig[1]), m)
  }
  footM(): Mat {
    let r = this.footRot.x
    let dx = 0
    let dy = 0
    if (this.trapAt && this.belly === 'trap') {
      // the hind foot swings round toward the captured finger and bunny-kicks at it
      const a0 = Math.atan2(FOOT.ty - FOOT.hy, FOOT.tx - FOOT.hx)
      const a1 = Math.atan2(this.trapAt[1] - FOOT.hy, this.trapAt[0] - FOOT.hx)
      let da = a1 - a0
      while (da > Math.PI) da -= Math.PI * 2
      while (da < -Math.PI) da += Math.PI * 2
      r = da * 0.75 * this.roll.x
      if (this.kickT >= 0 && this.kicksLeft > 0) {
        const k = Math.max(0, Math.sin(this.kickT * Math.PI * 2 * 9))
        dx += Math.cos(a1) * 0.12 * k
        dy += Math.sin(a1) * 0.12 * k
      }
    } else if (this.kickT >= 0 && this.kicksLeft > 0) {
      const k = Math.max(0, Math.sin(this.kickT * Math.PI * 2 * 9))
      dx += -0.1 * k
      dy += -0.06 * k
    }
    if (this.scratchT >= 0) {
      const k = Math.max(0, Math.sin(this.scratchT * Math.PI * 2 * 7))
      dx += -0.03 * k
      dy += -0.08 * k
    }
    return mul(tr(dx + this.jig[0], dy + this.jig[1]), mul(tr(FOOT.hx, FOOT.hy), mul(rot(r), tr(-FOOT.hx, -FOOT.hy))))
  }
  tailTipM(): Mat {
    const j = tailCurve.at(TAIL_TIP_JOINT).p
    return mul(tr(j[0], j[1]), mul(rot(this.tailTip.x), tr(-j[0], -j[1])))
  }
  partM(id: PartId): Mat {
    switch (id) {
      case 'head':
        return this.headM()
      case 'earL':
        return this.earM(-1)
      case 'earR':
        return this.earM(1)
      case 'torso':
      case 'chest':
      case 'belly':
      case 'thigh':
        return this.torsoM()
      case 'legNear':
        return this.legM(true)
      case 'legFar':
        return this.legM(false)
      case 'footNear':
        return this.footM()
      case 'tailC':
        return this.tailTipM()
      default:
        return this.jig[0] || this.jig[1] ? tr(this.jig[0], this.jig[1]) : ident
    }
  }
  /** cat space -> device px */
  dev(): Mat {
    const k = this.dpr * this.HW
    return [k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy]
  }
  /** css px -> cat space */
  toCat(x: number, y: number): [number, number] {
    return [(x - this.ox) / this.HW, (y - this.oy) / this.HW]
  }

  /** Topmost part under a css point, with its local coords. */
  hit(x: number, y: number): { id: PartId; lx: number; ly: number } | null {
    const [cx, cy] = this.toCat(x, y)
    for (const id of HIT_ORDER) {
      if (!this.has(id)) continue
      if (id === 'belly' && this.roll.x < 0.5) continue
      const m = this.partM(id)
      const [lx, ly] = apply(inv(m), cx, cy)
      const d = this.sprite(id).field.sample(lx, ly)
      if (d > -0.025) return { id, lx, ly }
    }
    return null
  }

  private twitchAngle() {
    const t = this.twitchT
    if (t < 0.06) return 18 * D2R * (t / 0.06)
    return 18 * D2R * Math.max(0, 1 - (t - 0.06) / 0.14)
  }

  private emit(e: CatEvent, n = 0) {
    this.onEvent?.(e, n)
  }

  /** Which zone a touch is on (design 1.7), and whether a back stroke goes with or against the fur. */
  private classify(h: { id: PartId; lx: number; ly: number }, cx: number, cy: number, cvx: number, cvy: number): { z: Zone; side: number } {
    const id = h.id
    if (id === 'head' || id === 'earL' || id === 'earR') {
      const [lx, ly] = id === 'head' ? [h.lx, h.ly] : apply(inv(this.headM()), cx, cy)
      const side = lx < 0 ? -1 : 1
      if (id !== 'head') return { z: 'top', side }
      if (ly < -0.16 && Math.abs(lx) > 0.24) return { z: 'earbase', side }
      if (ly < -0.1) return { z: 'top', side }
      if (ly > 0.3) return { z: 'chin', side }
      if (Math.abs(lx) > 0.2) return { z: 'cheek', side }
      if (ly > 0.12) return { z: 'nose', side }
      return { z: 'top', side }
    }
    if (id === 'belly') return { z: 'belly', side: 0 }
    if (id === 'legNear' || id === 'legFar' || id === 'footNear') return { z: 'paw', side: 0 }
    if (id === 'tailB' || id === 'tailC') return { z: 'tail', side: 0 }
    if (id === 'tailA') return { z: 'tailbase', side: 0 }
    if (id === 'chest') return { z: 'chest', side: 0 }
    const [tx, ty] = apply(inv(this.torsoM()), cx, cy)
    const { u, v } = torsoUV(tx, ty)
    if (id === 'torso') {
      if (v > 0.7 && u > 0.25) return { z: 'belly', side: 0 }
      if (u > 0.84 && v < 0.55) return { z: 'tailbase', side: 0 }
    }
    // the back (and the haunch): with or against the grain
    const def = this.defs.find((d) => d.id === id)!
    const a = def.flow(h.lx, h.ly)
    const sp = Math.hypot(cvx, cvy)
    if (sp < 0.4) return { z: 'back', side: 0 }
    const dot = (Math.cos(a) * cvx + Math.sin(a) * cvy) / sp
    return { z: dot > 0.25 ? 'backWith' : dot < -0.25 ? 'backAgainst' : 'back', side: 0 }
  }

  /** Called by the game when the tab comes back after 30 s or more: the cat is asleep. */
  fallAsleep() {
    if (this.asleep) return
    this.asleep = true
    this.sleepy = 1
    this.sleepStart = this.t
    this.emit('sleep')
  }

  // ---------- simulation ----------

  /** dt seconds. touches in css px. breathPhase from the purr when purring (else null). */
  update(dt: number, touches: Touch[], pointer: { x: number; y: number } | null, breathPhase: number | null) {
    this.t += dt
    const rnd = this.rnd
    // breathing
    if (breathPhase !== null) this.breath = breathPhase
    else this.breath = (this.breath + dt / (this.asleep ? 3.2 : 2.4)) % 1

    // ---- contact & zones ----
    let zone: Zone = 'none'
    let side = 0
    let leanTo: [number, number] | null = null
    let slide: [number, number] = [0, 0]
    let speed = 0
    let fingerCat: [number, number] | null = null
    const wasOn = this.finger.on
    this.finger.on = false
    let glassTap = false
    for (const tch of touches) {
      const [cx, cy] = this.toCat(tch.x, tch.y)
      if (this.glass.state !== 'gone' && this.glass.state !== 'fall' && Math.hypot(cx - this.glass.x, cy - (this.glass.y - 0.1)) < 0.2) glassTap = true
      const h = this.hit(tch.x, tch.y)
      if (!h) continue
      this.finger = { x: tch.x, y: tch.y, on: true }
      fingerCat = [cx, cy]
      const cvx = tch.vx / this.HW
      const cvy = tch.vy / this.HW
      // write every groom field the brush overlaps
      for (const [id, g] of this.grooms) {
        const m = this.partM(id)
        const im = inv(m)
        const [lx, ly] = apply(im, cx, cy)
        const lvx = im[0] * cvx + im[2] * cvy
        const lvy = im[1] * cvx + im[3] * cvy
        if (this.sprite(id).field.sample(lx, ly) > -0.16) g.write(lx, ly, lvx, lvy, dt)
      }
      const sp = Math.hypot(cvx, cvy)
      speed = Math.max(speed, sp)
      if (sp > 0.01) slide = [(cvx / sp) * Math.min(0.02, sp * 0.004), (cvy / sp) * Math.min(0.02, sp * 0.004)]
      const c = this.classify(h, cx, cy, cvx, cvy)
      if (c.z === 'cheek') leanTo = [cx, cy]
      if (RANK.indexOf(c.z) > RANK.indexOf(zone)) {
        zone = c.z
        side = c.side
      }
      // rough: very fast, or many direction reversals in a second
      if (sp > 0.6 && this.lastV) {
        if (cvx * this.lastV[0] + cvy * this.lastV[1] < 0) this.reversals.push(this.t)
      }
      if (sp > 0.6) this.lastV = [cvx, cvy]
    }
    while (this.reversals.length && this.t - this.reversals[0] > 1) this.reversals.shift()
    const rough = speed > 10.5 || this.reversals.length > 6
    const onset = this.finger.on && (!wasOn || zone !== this.lastZone)
    if (this.finger.on) {
      this.zoneTime = zone === this.lastZone ? this.zoneTime + dt : 0
      this.lastZone = zone
      // a "pet" is a new touch, a move to another spot, or every 2 s of stroking
      this.petT += dt
      if (onset || this.petT > 2) {
        this.petT = 0
        this.emit('pet')
      }
    } else {
      this.zoneTime = 0
      this.lastZone = 'none'
    }
    this.contact = this.finger.on ? 0 : this.contact + dt
    if (zone !== 'none') {
      this.zone = zone
      this.zoneSide = side
    } else if (this.contact > 0.3) this.zone = 'none'
    const active = this.finger.on || (pointer !== null && this.pointerMoved(pointer))
    if (active) this.idleT = 0
    else this.idleT += dt

    // ---- sleep / wake ----
    if (this.asleep) {
      const gentle = this.finger.on && (zone === 'top' || zone === 'cheek' || zone === 'chin' || zone === 'earbase') && speed < 3
      if (this.finger.on && !gentle) {
        this.asleep = false
        this.sleepy = 0
        this.wakeT = 0
        this.emit('wake', Math.round(this.t - this.sleepStart))
      } else if (this.dreamT < 0 && this.t > this.dreamAt) {
        this.dreamT = 0
        this.dreamKind = Math.floor(rnd() * 3)
        this.dreamAt = this.t + 10 + rnd() * 15
      }
    } else {
      if (active) this.sleepy = 0
      else if (this.belly === 'none' && this.glass.state === 'idle') {
        const before = this.sleepy
        this.sleepy = Math.min(1, this.sleepy + dt / 45)
        if (before < 0.5 && this.sleepy >= 0.5) this.yawnT = 0
        if (this.sleepy >= 1) this.fallAsleep()
      }
    }
    if (this.dreamT >= 0) {
      this.dreamT += dt
      if (this.dreamT > 0.5) this.dreamT = -1
    }
    if (this.wakeT >= 0) {
      this.wakeT += dt
      if (this.wakeT > 0.3 && this.wakeT - dt <= 0.3) {
        this.emit('trill')
        this.yawnT = 0
      }
      if (this.wakeT > 1.9) this.wakeT = -1
    }

    // ---- belly trap (1.10) ----
    const onBelly = this.finger.on && zone === 'belly'
    this.blissHighT = this.bliss > 0.6 && !this.asleep ? this.blissHighT + dt : 0
    switch (this.belly) {
      case 'none':
        if (this.blissHighT > 3 && this.irk < 0.3 && this.knead === 0 && this.t > this.bellyCool && this.glass.state === 'idle') {
          this.belly = 'invite'
          this.bellyT = 0
          this.emit('belly_invite')
        }
        break
      case 'invite':
        this.bellyT += dt
        if (onBelly && this.roll.x > 0.6) {
          this.belly = 'soft'
          this.bellyT = 0
          this.bellyUntil = 0.6 + rnd() * 0.6
        } else if (this.bellyT > 7 && !onBelly) this.endBelly(false)
        break
      case 'soft':
        this.bellyT += dt
        if (!this.finger.on) this.endBelly(false)
        else if (this.bellyT > this.bellyUntil) {
          this.bellyT = 0
          if (rnd() < 1 / 6) {
            this.belly = 'granted'
            this.emit('granted')
          } else {
            this.belly = 'trap'
            this.kickT = 0.25
            this.kicksLeft = 6 + Math.floor(rnd() * 4)
            this.lastKickAt = this.t
            this.emit('trap')
          }
        }
        break
      case 'trap': {
        this.bellyT += dt
        if (fingerCat) this.trapAt = fingerCat
        if (this.kicksLeft > 0) this.lastKickAt = this.t
        const chest = [-0.3, 0.1]
        const far = this.trapAt ? Math.hypot(this.trapAt[0] - chest[0], this.trapAt[1] - chest[1]) > 1.8 : false
        if (!this.finger.on || far || this.t - this.lastKickAt > 2.5) this.endBelly(true)
        break
      }
      case 'granted':
        this.bellyT += dt
        if (this.bellyT > 4 || (!this.finger.on && this.bellyT > 1)) this.endBelly(false)
        break
    }
    if (this.kickT >= 0 && this.kicksLeft > 0) {
      const before = Math.floor(this.kickT * 9)
      this.kickT += dt
      if (Math.floor(this.kickT * 9) > before) {
        this.kicksLeft--
        this.emit('kick', this.kicksLeft)
      }
    }
    const rolled = this.belly !== 'none'

    // ---- mood rates (1.7) ----
    let blissRate = 0
    let irkRate = 0
    if (this.finger.on && !this.asleep) {
      switch (zone) {
        case 'chin':
          blissRate = 0.3
          break
        case 'cheek':
        case 'earbase':
          blissRate = 0.25
          break
        case 'top':
          blissRate = 0.2
          break
        case 'nose':
          irkRate = 0.05
          break
        case 'backWith':
          blissRate = 0.15
          break
        case 'back':
        case 'chest':
          blissRate = 0.08
          break
        case 'backAgainst':
          irkRate = 0.12
          break
        case 'tailbase':
          blissRate = 0.2
          irkRate = 0.04
          break
        case 'tail':
          irkRate = 0.3
          break
        case 'paw':
          irkRate = 0.1
          break
        case 'belly':
          if (this.belly === 'none') irkRate = 0.3
          else blissRate = 0.3
          break
      }
      if (this.zoneTime > 8) irkRate = Math.max(irkRate, 0.06)
      if (rough) irkRate = Math.max(irkRate, 0.25)
    } else if (this.finger.on && this.asleep) blissRate = 0.15
    if (this.belly === 'trap') irkRate = 0
    const irkK = COAT.id === 'tux' ? 1.3 : 1
    irkRate = Math.min(0.3 * irkK, irkRate * irkK)
    if (blissRate > 0) this.bliss = Math.min(1, this.bliss + blissRate * (1 - 0.7 * this.irk) * dt)
    else if (!this.finger.on) this.bliss = Math.max(0, this.bliss - 0.05 * dt)
    if (irkRate > 0) {
      this.irk = Math.min(1, this.irk + irkRate * dt)
      this.bliss = Math.max(0, this.bliss - irkRate * 0.6 * dt)
    } else if (this.swatT < 0) this.irk = Math.max(0, this.irk - (this.finger.on ? 0.03 : 0.08) * dt)

    // one-off zone reactions on first contact
    if (onset && !this.asleep && this.belly !== 'trap' && this.belly !== 'granted') {
      if (zone === 'nose') {
        this.crossT = 0
        this.emit('boop')
        if (rnd() < 0.25) this.sneezeAt = this.t + 0.45
      } else if (zone === 'earbase' && this.t > this.scratchCool) {
        this.scratchT = 0
        this.scratchCool = this.t + 3
      } else if (zone === 'paw') {
        this.pawTaps++
        this.pawT = 0
        this.pawOnFinger = this.pawTaps >= 3 && rnd() < 0.2
        this.emit(this.pawOnFinger ? 'beans_hold' : 'beans')
      } else if (zone === 'tail') {
        this.whipT = 0
        this.emit('tail')
      } else if (zone === 'belly' && this.belly === 'none') this.emit('belly_no')
      else if (zone === 'backAgainst') {
        this.rippleT = 0
        this.emit('grain')
      } else if (zone === 'tailbase') this.emit('tailbase')
      else this.emit('zone', RANK.indexOf(zone))
    }
    if (rough && this.finger.on && !this.roughSaid) {
      this.roughSaid = true
      this.emit('rough')
    } else if (!this.finger.on) this.roughSaid = false
    if (this.sneezeAt > 0 && this.t > this.sneezeAt) {
      this.sneezeAt = 0
      this.emit('sneeze')
    }

    // ---- irk ladder and swat ----
    const stage = this.irk >= 0.7 ? 2 : this.irk >= 0.4 ? 1 : 0
    if (stage > this.irkStage) this.emit(stage === 2 ? 'warn07' : 'warn04')
    if (stage === 2 && this.irkStage < 2) this.emit('purr_cut')
    this.irkStage = stage < this.irkStage && this.irk > (this.irkStage === 2 ? 0.55 : 0.3) ? this.irkStage : stage
    if (this.irk >= 0.995 && this.swatT < 0 && this.finger.on && fingerCat) {
      this.swatT = 0
      this.swatAt = fingerCat
      this.irk = 0.35
      this.emit('swat')
    }
    if (this.swatT >= 0) {
      this.swatT += dt
      if (this.swatT > 0.12 && this.swatT - dt <= 0.12) this.claws.push({ x: this.swatAt[0], y: this.swatAt[1], t: 0 })
      if (this.swatT > 0.6) {
        this.swatT = -1
        this.groomT = 0
        this.groomDur = 2
      }
    }
    for (const c of this.claws) c.t += dt
    this.claws = this.claws.filter((c) => c.t < 1.2)
    // tail thumps at stage 2
    if (stage === 2) {
      const before = Math.floor(this.thumpPhase * 2)
      this.thumpPhase += dt * 2.2
      if (Math.floor(this.thumpPhase * 2) > before) this.emit('thump')
    }

    // ---- kneading (bliss >= 0.85 for 5 s) ----
    this.kneadHighT = this.bliss >= 0.85 && !this.asleep && (this.belly === 'none' || this.belly === 'granted') ? this.kneadHighT + dt : 0
    if (this.knead === 0 && this.kneadHighT > 5 && this.t > this.kneadCool) {
      this.knead = 1
      this.kneadStart = this.t
      this.biscuitsNow = 0
      this.emit('knead_start')
    }
    if (this.knead) {
      const before = Math.floor(this.kneadPhase * 2)
      this.kneadPhase += dt * 1.1
      if (Math.floor(this.kneadPhase * 2) > before) {
        this.biscuitsNow++
        this.emit('biscuit')
      }
      if (this.bliss < 0.7 || this.irk > 0.3 || this.t - this.kneadStart > 10 || this.asleep || rolled) {
        this.knead = 0
        this.kneadCool = this.t + 20
        this.emit('knead_end', this.biscuitsNow)
      }
    }

    // ---- grooming: every 25-40 s without contact ----
    if (this.groomT < 0 && !this.asleep && !rolled && this.knead === 0 && this.glass.state === 'idle' && this.contact > this.groomAt) {
      this.groomT = 0
      this.groomDur = 2.2
      this.groomAt = this.contact + 25 + rnd() * 15
      for (const g of this.grooms.values()) g.reset()
      this.emit('groom')
    }
    if (this.groomT >= 0) {
      this.groomT += dt
      if (this.groomT > this.groomDur || (this.finger.on && this.swatT < 0 && this.groomT > 0.3)) this.groomT = -1
    }
    if (!this.finger.on && this.contact < dt * 1.5) this.groomAt = 25 + rnd() * 15

    // ---- yawn ----
    let yawn = 0
    if (this.yawnT >= 0) {
      this.yawnT += dt
      const t = this.yawnT
      yawn = t < 0.6 ? 1 - Math.pow(1 - t / 0.6, 3) : t < 1.1 ? 1 : t < 1.5 ? 1 - (t - 1.1) / 0.4 : 0
      if (t > 1.5) this.yawnT = -1
    }

    // ---- glass on the blanket (knocks it off when ignored for 20 s) ----
    this.updateGlass(dt, glassTap)

    // ---- pose targets ----
    const z = this.asleep ? 'none' : this.zone
    let hx = 0
    let hy = 0
    let hr = 0
    let lk = 0
    let lid = REST_LID
    let happy = 0
    const fold = [0, 0]
    const sq = [0, 0]
    let pupilBoost = 0
    let lookAtFinger = false
    let lookAtViewer = false
    if (z === 'chin') {
      hr = 14 * D2R
      hx = -0.045
      hy = -0.02
      lk = 1
      happy = 1
    } else if (z === 'cheek' && leanTo) {
      const hc = apply(this.headM(), 0, 0)
      const dx = leanTo[0] - hc[0]
      const dy = leanTo[1] - hc[1]
      const l = Math.hypot(dx, dy) || 1
      hx = (dx / l) * 0.06
      hy = (dy / l) * 0.06
      hr = this.zoneSide * 10 * D2R
      const near = this.zoneSide < 0 ? 0 : 1
      sq[near] = 0.6
      lid = 0.42
      if (this.bliss > 0.55) happy = 1
    } else if (z === 'cheek' || z === 'earbase') {
      hr = this.zoneSide * (z === 'earbase' ? 12 : 10) * D2R
      lid = 0.42
      if (this.bliss > 0.55) happy = 1
    } else if (z === 'top') {
      lid = 0.4
      if (this.finger.on) {
        const [fx, fy] = apply(inv(this.headM()), ...this.toCat(this.finger.x, this.finger.y))
        for (let i = 0; i < 2; i++) {
          const ex = (i === 0 ? -1 : 1) * EAR.x
          const d = Math.hypot(fx - ex, fy - (EAR.y - 0.08))
          fold[i] = 0.85 * (1 - smoothstep(0.1, 0.3, d))
        }
      }
    } else if (z === 'backWith' || z === 'chest' || z === 'back') {
      lid = 0.42
      if (this.bliss > 0.7) happy = 0.8
    }
    // boop: eyes cross, head pulls back
    let cross = 0
    if (this.crossT >= 0) {
      this.crossT += dt
      cross = this.crossT < 0.25 ? 1 : Math.max(0, 1 - (this.crossT - 0.25) / 0.15)
      if (this.crossT < 0.35) hx += 0.03
      if (this.crossT > 0.45) this.crossT = -1
    }
    // irk ladder signals
    let earBack = stage >= 1 ? 1 : 0
    let air = stage >= 2 ? 1 : 0
    let slit = stage >= 2 ? 1 : 0
    if (stage >= 1) {
      happy = 0
      lid = Math.max(lid, stage >= 2 ? 0.85 : 0.6)
    }
    if (stage >= 2) lookAtFinger = true
    // belly roll / trap / granted
    let roll = 0
    let curlK = 0
    let clampK = 0
    let bite = 0
    if (rolled) {
      roll = 1
      curlK = 1
      lid = Math.max(lid, 0.75)
      pupilBoost = Math.max(pupilBoost, 0.2)
      hr += 16 * D2R
      hy += 0.03
      if (this.belly === 'trap') {
        clampK = 1
        bite = 1
        pupilBoost = 0.25
        lookAtFinger = true
        earBack = Math.max(earBack, 0.6)
        happy = 0
        if (this.trapAt) {
          // head curls in toward the captured finger
          const hc = apply(this.headM(), 0, 0)
          const dx = this.trapAt[0] - hc[0]
          const dy = this.trapAt[1] - hc[1]
          const l = Math.hypot(dx, dy) || 1
          hx += (dx / l) * 0.08
          hy += (dy / l) * 0.06
          hr += 8 * D2R
        }
      } else if (this.belly === 'granted') {
        happy = 1
      }
    }
    // stretch on long with-grain strokes; hips lift on the tail base
    this.withT = z === 'backWith' && this.finger.on ? this.withT + dt : Math.max(0, this.withT - dt * 2)
    let stretch = this.withT > 0.5 ? 1 : 0
    if (this.wakeT > 0.4) stretch = Math.max(stretch, Math.sin(Math.min(1, (this.wakeT - 0.4) / 1.4) * Math.PI))
    const hip = z === 'tailbase' && this.finger.on ? 1 : 0
    // grooming / licking the paw
    let lick = 0
    let groomK = 0
    if (this.groomT >= 0) {
      const t = this.groomT
      groomK = Math.min(1, t / 0.35) * Math.min(1, (this.groomDur - t) / 0.35)
      lick = groomK * Math.max(0, Math.sin(t * Math.PI * 2 * 2.5))
      hy += 0.05 * groomK
      hr -= 8 * D2R * groomK
      lid = Math.min(lid, 0.15 + 0.4 * (1 - groomK))
    }
    // sleeping, yawning, waking
    if (this.asleep) {
      lid = 0
      happy = 0
      earBack = 0
    } else if (this.wakeT >= 0 && this.wakeT < 0.3) lid = Math.min(lid, (this.wakeT / 0.3) * 0.5)
    if (yawn > 0) {
      lid = Math.min(lid, 1 - yawn)
      earBack = Math.max(earBack, 0.7 * yawn)
      hr -= 6 * D2R * yawn
    }
    // glass: eye contact before the push
    if (this.glass.state === 'look' || this.glass.state === 'push') {
      lookAtViewer = this.glass.state === 'look' || this.glass.k < 0.2
      lid = Math.max(lid, 0.75)
    }

    // springs
    this.headX.step(hx + this.slideX.x * 0.4, dt)
    this.headY.step(hy + this.slideY.x * 0.4, dt)
    this.headR.step(hr, dt)
    this.look.step(lk, dt)
    this.happy.step(happy, dt)
    this.slideX.step(slide[0], dt)
    this.slideY.step(slide[1], dt)
    this.earBack.step(earBack, dt)
    this.airplane.step(air, dt, 300, 30)
    this.slit.step(slit, dt)
    this.roll.step(roll, dt, 40, 12)
    this.stretch.step(stretch, dt, 30, 10)
    this.hipLift.step(hip, dt, 60, 12)
    this.sleepPose.step(this.asleep ? 1 : 0, dt, 20, 9)
    this.footRot.step(-25 * D2R * roll, dt, 40, 12)
    this.kneadAmt.step(this.knead, dt, 30, 11)
    for (let i = 0; i < 2; i++) {
      const f = this.earFold[i]
      if (fold[i] > f.x) f.step(fold[i], dt, 1400, 75)
      else f.step(fold[i], dt, 300, 13)
      this.squint[i].step(sq[i], dt)
    }

    // ---- legs: one aim target per leg, by priority ----
    const mouth = apply(this.headM(), 0, 0.34)
    let tN: V2 | null = null
    let kN = 0
    let sN = 1 // stiffness scale
    let tF: V2 | null = null
    let kF = 0
    if (this.swatT >= 0 && this.swatT < 0.35) {
      tN = this.swatAt
      kN = 1
      sN = 6
    } else if (clampK > 0 && this.trapAt) {
      tN = [this.trapAt[0] - 0.08, this.trapAt[1] - 0.05]
      kN = 1
      sN = 4
      tF = [this.trapAt[0] + 0.08, this.trapAt[1] + 0.05]
      kF = 1
    } else if (this.glass.state === 'push' && this.glass.k > 0) {
      tN = [this.glass.x + 0.12, this.glass.y - 0.08]
      kN = this.glass.k
      sN = 2.5
    } else if (this.pawOnFinger && this.pawT >= 0 && this.pawT < 1.4 && fingerCat) {
      tN = fingerCat
      kN = 1
      sN = 2
    } else if (groomK > 0) {
      tN = [mouth[0] + 0.02, mouth[1] + 0.1]
      kN = groomK
      sN = 2
    } else if (this.finger.on && zone === 'belly' && this.belly === 'none' && fingerCat) {
      // a polite paw push-away
      tN = fingerCat
      kN = 0.35
    } else if (curlK > 0) {
      tN = [-0.62, -0.1]
      kN = this.roll.x
      tF = [-0.3, 0.12]
      kF = this.roll.x
    } else if (this.pawT >= 0 && this.pawT < 0.6 && !this.pawOnFinger) {
      // touched beans: toes spread, then the paw is pulled back and tucked
      tN = [PAW_NEAR.x + 0.12, PAW_NEAR.y - 0.03]
      kN = 0.8
      sN = 2
    }
    if (this.pawT >= 0) {
      this.pawT += dt
      if (this.pawT > 1.6) this.pawT = -1
    }
    if (tN) {
      const e = 1 - Math.exp(-dt * 25 * sN)
      this.aimN[0] += (tN[0] - this.aimN[0]) * (this.aimNK.x < 0.05 ? 1 : e)
      this.aimN[1] += (tN[1] - this.aimN[1]) * (this.aimNK.x < 0.05 ? 1 : e)
    }
    this.aimNK.step(tN ? kN : 0, dt, 160 * sN * sN, 22 * sN)
    if (tF) {
      const e = 1 - Math.exp(-dt * 25)
      this.aimF[0] += (tF[0] - this.aimF[0]) * (this.aimFK.x < 0.05 ? 1 : e)
      this.aimF[1] += (tF[1] - this.aimF[1]) * (this.aimFK.x < 0.05 ? 1 : e)
    }
    this.aimFK.step(tF ? kF : 0, dt, 300, 30)

    // ---- tail tip ----
    let tip = 8 * D2R * Math.sin((this.t / 3.5) * Math.PI * 2)
    if (this.bliss > 0.6) tip = -10 * D2R + 4 * D2R * Math.sin(this.t * 3)
    if (stage === 1) tip = 12 * D2R * Math.sin(this.t * Math.PI * 2 * 3)
    if (stage === 2) tip = 25 * D2R * Math.sign(Math.sin(this.thumpPhase * Math.PI * 2)) * 0.9
    if (this.whipT >= 0) {
      this.whipT += dt
      tip = 38 * D2R * Math.min(1, this.whipT / 0.12)
      if (this.whipT > 0.9 && !(this.finger.on && zone === 'tail')) this.whipT = -1
    }
    if (hip > 0) tip = -30 * D2R
    if (this.stretch.x > 0.3) tip = Math.min(tip, -15 * D2R)
    if (this.asleep) tip = 0
    this.tailTip.step(tip, dt, stage === 2 ? 500 : 160, stage === 2 ? 30 : 20)

    // jiggle while kicking (the cat moves, never the screen)
    if (this.kickT >= 0 && this.kicksLeft > 0) {
      const a = 0.012 * Math.sin(this.kickT * Math.PI * 2 * 9)
      this.jig = [a, a * 0.5]
    } else this.jig = [0, 0]
    if (this.rippleT >= 0) {
      this.rippleT += dt
      if (this.rippleT > 0.25) this.rippleT = -1
    }
    if (this.scratchT >= 0) {
      this.scratchT += dt
      if (this.scratchT > 0.5) this.scratchT = -1
    }

    // ---- notice, pupils, ears follow the pointer ----
    if (pointer || this.finger.on) {
      if (this.t - this.ptrSeenAt > 1.5 && this.bliss < 0.4 && !this.asleep) this.noticeT = 0
      this.ptrSeenAt = this.t
    }
    let notice = 0
    if (this.noticeT >= 0) {
      this.noticeT += dt
      const t = this.noticeT
      notice = t < 0.15 ? t / 0.15 : t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 1.1)
      if (t > 1.8) this.noticeT = -1
    }
    if (notice > 0 && z !== 'chin' && !rolled) lid = lid + (1 - lid) * notice
    if (notice > 0) this.lidBase.step(lid, dt, 400, 40)
    else this.lidBase.step(lid, dt)

    const tgtPupil: [number, number] = [0, 0]
    const turn = [0, 0]
    const target = lookAtFinger && this.finger.on ? this.finger : pointer
    if (target && !lookAtViewer && !this.asleep) {
      const [pcx, pcy] = this.toCat(target.x, target.y)
      const [lx, ly] = apply(inv(this.headM()), pcx, pcy)
      const ex = lx
      const ey = ly - EYE.y
      const l = Math.hypot(ex, ey) || 1
      const k = Math.min(1, l / 0.6) * 0.03
      tgtPupil[0] = (ex / l) * k
      tgtPupil[1] = (ey / l) * k
      const near = lx < 0 ? 0 : 1
      const sd = near === 0 ? -1 : 1
      const ang = Math.atan2(lx - sd * EAR.x, -(ly - EAR.y))
      const restA = sd * EAR.tilt
      turn[near] = Math.max(-10 * D2R, Math.min(10 * D2R, ang - restA))
    }
    const pk = 1 - Math.exp(-dt / 0.12)
    this.pupil[0] += (tgtPupil[0] - this.pupil[0]) * pk
    this.pupil[1] += (tgtPupil[1] - this.pupil[1]) * pk
    for (let i = 0; i < 2; i++) this.earTurn[i].step(turn[i], dt)

    // ---- blinks ----
    let blink = 1
    if (this.blinkT >= 0) {
      this.blinkT += dt
      const t = this.blinkT
      blink = t < 0.08 ? 1 - t / 0.08 : Math.min(1, (t - 0.08) / 0.12)
      if (t > 0.2) this.blinkT = -1
    } else if (this.t > this.blinkAt) {
      this.blinkT = 0
      this.blinkAt = this.t + 4 + rnd() * 5
    }
    if (this.slowBlinkT >= 0) {
      this.slowBlinkT += dt
      const t = this.slowBlinkT
      const io = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)
      const eo = (x: number) => 1 - Math.pow(1 - x, 3)
      if (t < 0.4) blink = Math.min(blink, 1 - io(t / 0.4))
      else if (t < 0.7) blink = 0
      else if (t < 1.4) blink = Math.min(blink, eo((t - 0.7) / 0.7))
      else this.slowBlinkT = -1
    } else if (this.bliss > 0.5 && this.t > this.slowBlinkAt && this.happy.x < 0.3 && stage === 0 && !this.asleep) {
      this.slowBlinkT = 0
      this.slowBlinks++
      this.slowBlinkAt = this.t + 6 + rnd() * 4
      this.emit('slow_blink')
    } else if (this.bliss <= 0.5 && !this.finger.on && notice === 0 && this.t > this.restSlowAt && !this.asleep && stage === 0) {
      this.slowBlinkT = 0
      this.restSlowAt = this.t + 9 + rnd() * 6
    } else if (this.bliss <= 0.5) this.slowBlinkAt = Math.max(this.slowBlinkAt, this.t + 2)

    // ear twitch (and dream whisker twitches)
    if (this.twitchT >= 0) {
      this.twitchT += dt
      if (this.twitchT > 0.2) this.twitchT = -1
    } else if (this.t > this.twitchAt || (this.dreamT === 0 && this.dreamKind === 1)) {
      this.twitchT = 0
      this.twitchSide = rnd() < 0.5 ? -1 : 1
      this.twitchAt = this.t + 8 + rnd() * 12
    }

    const f = this.face
    const lb = Math.max(0, Math.min(1, this.lidBase.x))
    f.open = [Math.min(lb, blink) * (1 - this.squint[0].x * 0.35), Math.min(lb, blink) * (1 - this.squint[1].x * 0.35)]
    f.happy = smoothstep(0.15, 0.85, this.happy.x)
    // sleepy-content: a little lower-lid lift whenever the eyes are heavy (not when wide awake)
    const restSq = 0.6 * smoothstep(0.85, 0.6, lb) * (1 - f.happy) * (1 - this.slit.x)
    f.squint = [Math.max(this.squint[0].x, restSq), Math.max(this.squint[1].x, restSq)]
    f.pupil = [this.pupil[0], this.pupil[1]]
    f.pupilSize = 0.66 + 0.15 * this.bliss + 0.14 * notice + pupilBoost
    f.look = Math.max(0, this.look.x)
    f.padPush = this.squint[0].x + this.squint[1].x > 0.1 ? 1 : 0
    f.whisk = this.twitchT >= 0 || (this.dreamT >= 0 && this.dreamKind === 2) ? 0.05 * Math.sin(this.t * 40) : 0
    f.slit = this.slit.x
    f.cross = cross
    f.yawn = yawn
    f.bite = bite * this.roll.x
    f.lick = lick
  }

  private endBelly(trapped: boolean) {
    this.belly = 'none'
    this.bellyT = 0
    this.kicksLeft = 0
    this.kickT = -1
    this.trapAt = null
    this.bellyCool = this.t + 12
    this.blissHighT = 0
    if (trapped) {
      // rolls back, licks a paw and slow-blinks innocently
      this.groomT = 0
      this.groomDur = 1.5
      this.slowBlinkAt = this.t + 1.8
      this.emit('release')
    }
  }

  private lastPtr: { x: number; y: number } | null = null
  private pointerMoved(p: { x: number; y: number }) {
    const moved = !this.lastPtr || Math.hypot(p.x - this.lastPtr.x, p.y - this.lastPtr.y) > 0.5
    this.lastPtr = { x: p.x, y: p.y }
    return moved
  }

  private updateGlass(dt: number, tapped: boolean) {
    const g = this.glass
    g.t += dt
    const busy = this.asleep || this.belly !== 'none' || this.knead > 0 || this.groomT >= 0 || this.irk > 0.3
    if (g.state === 'idle') {
      g.alpha = Math.min(1, g.alpha + dt * 2)
      if (this.idleT > 20 && !busy) {
        g.state = 'look'
        g.t = 0
        g.pushes = 0
      }
    } else if (g.state === 'look' || g.state === 'push') {
      if (tapped) {
        // tapping the glass slides it back; the cat will push again
        g.x = GLASS[0]
        g.y = GLASS[1]
        g.pushes = 0
        g.state = 'look'
        g.t = 0
        g.k = 0
      } else if (this.finger.on || this.asleep || this.belly !== 'none') {
        g.state = 'idle'
        g.k = 0
      } else if (g.state === 'look' && g.t > 0.9) {
        g.state = 'push'
        g.t = 0
      } else if (g.state === 'push') {
        // reach 0.35 s, nudge, withdraw, pause 0.6 s
        const t = g.t
        g.k = t < 0.35 ? t / 0.35 : t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.3)
        if (t > 0.35 && t - dt <= 0.35) {
          g.pushes++
          g.x -= 0.1
          g.y += 0.025
          this.emit('glass_push', g.pushes)
          if (g.pushes >= 3) {
            g.state = 'fall'
            g.t = 0
          }
        }
        if (t > 1.45) g.t = 0
      }
    } else if (g.state === 'fall') {
      g.k = Math.max(0, 1 - g.t / 0.3)
      if (g.t > 0.55) {
        g.state = 'gone'
        g.t = 0
        this.emit('glass_fall')
      }
    } else if (g.state === 'gone') {
      g.alpha = 0
      if (g.t > 30) {
        g.state = 'idle'
        g.x = GLASS[0]
        g.y = GLASS[1]
        g.t = 0
        this.idleT = 0
      }
    }
  }

  /** The drinking glass at the blanket's front edge (cat space). */
  /** The near paw is drawn over the face while it is up there (grooming, swatting). */
  private legOnTop() {
    return this.groomT >= 0 || (this.swatT >= 0 && this.swatT < 0.45)
  }

  /** Little dents in the blanket under the paws while kneading. */
  private drawKneadDimples(ctx: CanvasRenderingContext2D, dev: Mat) {
    const kn = this.kneadAmt.x
    if (kn < 0.02) return
    for (const [p, ph] of [
      [PAW_NEAR, 0],
      [PAW_FAR, Math.PI],
    ] as const) {
      const push = Math.max(0, Math.sin(this.kneadPhase * Math.PI * 2 + ph)) * kn
      if (push < 0.02) continue
      const m = mul(dev, tr(p.x - 0.04, p.y + 0.09))
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.16)
      g.addColorStop(0, css(P.shadow, 0.16 * push))
      g.addColorStop(1, css(P.shadow, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(0, 0, 0.16, 0.06, 0, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /** Three thin claw lines where a swat landed; they fade over 1.2 s. */
  private drawClaws(ctx: CanvasRenderingContext2D, dev: Mat) {
    for (const c of this.claws) {
      const a = Math.max(0, 1 - c.t / 1.2)
      const m = mul(dev, mul(tr(c.x, c.y), rot(-0.5)))
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      ctx.strokeStyle = `rgba(196,92,92,${0.7 * a})`
      ctx.lineWidth = 0.016
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let k = -1; k <= 1; k++) {
        ctx.moveTo(k * 0.045 - 0.01, -0.09)
        ctx.quadraticCurveTo(k * 0.045 + 0.012, 0, k * 0.045 - 0.004, 0.09)
      }
      ctx.stroke()
    }
  }

  /** Floating "z" above the sleeping head. */
  private drawZ(ctx: CanvasRenderingContext2D, hm: Mat) {
    ctx.setTransform(hm[0], hm[1], hm[2], hm[3], hm[4], hm[5])
    ctx.textAlign = 'center'
    for (let k = 0; k < 3; k++) {
      const ph = (this.t / 3 + k / 3) % 1
      const a = Math.sin(ph * Math.PI) * 0.55
      ctx.fillStyle = `rgba(74,58,44,${a})`
      ctx.font = `600 ${0.13 + 0.07 * ph}px ui-rounded, system-ui, sans-serif`
      ctx.fillText('z', 0.42 + 0.22 * ph, -0.55 - 0.45 * ph)
    }
  }

  private drawGlass(ctx: CanvasRenderingContext2D, dev: Mat) {
    const g = this.glass
    if (g.state === 'gone') return
    let { x, y } = g
    let a = g.alpha
    let tilt = 0
    let s = 1
    if (g.state === 'fall') {
      const k = Math.min(1, g.t / 0.55)
      x -= 0.35 * k
      y += 0.25 * k * k
      tilt = -1.2 * k
      s = 1 - 0.25 * k
      a *= 1 - k
    }
    if (a < 0.01) return
    const m = mul(dev, mul(tr(x, y), mul(rot(tilt), scl(s, s))))
    ctx.save()
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    ctx.globalAlpha = a
    const W = 0.095
    const Wb = 0.08
    const H = 0.3
    // shadow on the rug
    ctx.fillStyle = 'rgba(70,40,30,0.18)'
    ctx.beginPath()
    ctx.ellipse(0.03, 0.01, W * 1.15, 0.035, 0, 0, Math.PI * 2)
    ctx.fill()
    const body = new Path2D()
    body.moveTo(-W, -H)
    body.lineTo(-Wb, -0.01)
    body.ellipse(0, -0.01, Wb, 0.026, 0, Math.PI, 0, true)
    body.lineTo(W, -H)
    body.ellipse(0, -H, W, 0.03, 0, 0, Math.PI, true)
    body.closePath()
    ctx.fillStyle = 'rgba(232,242,246,0.32)'
    ctx.fill(body)
    // water
    ctx.save()
    ctx.clip(body)
    ctx.fillStyle = 'rgba(160,200,222,0.38)'
    ctx.fillRect(-W, -H * 0.55, W * 2, H)
    ctx.fillStyle = 'rgba(205,232,244,0.55)'
    ctx.beginPath()
    ctx.ellipse(0, -H * 0.55, W * 0.93, 0.024, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    // rim, outline and highlights
    ctx.strokeStyle = 'rgba(90,110,120,0.45)'
    ctx.lineWidth = 0.006
    ctx.stroke(body)
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 0.007
    ctx.beginPath()
    ctx.ellipse(0, -H, W, 0.03, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.lineWidth = 0.012
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'
    ctx.beginPath()
    ctx.moveTo(-W * 0.62, -H * 0.88)
    ctx.lineTo(-Wb * 0.62, -0.05)
    ctx.stroke()
    ctx.restore()
  }

  // ---------- drawing ----------

  draw(ctx: CanvasRenderingContext2D, fingerShadow: boolean) {
    const dev = this.dev()
    const unit = this.dpr * this.HW
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (this.blanket) ctx.drawImage(this.blanket, 0, 0)
    this.matchedThisFrame = false
    const sprite = (id: PartId) => {
      if (!this.has(id)) {
        // not built yet (first frames, or right after a rebake): a flat silhouette in the coat colour
        const def = this.defs.find((d) => d.id === id)!
        const m = mul(dev, this.partM(id))
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
        ctx.fillStyle = FLAT[id]
        ctx.beginPath()
        def.path(ctx)
        ctx.fill()
        return id === 'head' ? m : null
      }
      const sp = this.sprite(id)
      const m = mul(dev, this.partM(id))
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      ctx.drawImage(sp.cv, sp.x0, sp.y0, sp.bw, sp.bh)
      return m
    }
    const tufts = (id: PartId, m: Mat) => {
      const layer = this.layers.get(id)
      if (!layer || !this.o.fur) return
      if (!layer.matched) {
        if (!this.baker.done || this.matchedThisFrame) return
        this.matchedThisFrame = true
        const a = performance.now()
        layer.matchSprite(this.sprite(id))
        this.matchMs += performance.now() - a
      }
      const g = this.grooms.get(id)!
      const tone = g.paint(this.sprite(id).field)
      if (tone) {
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
        ctx.drawImage(tone, g.x0, g.y0, g.cols * g.cell, g.rows * g.cell)
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      layer.draw(ctx, m, unit, this.half, { sleek: 1.0, ruffle: 1.6 })
    }
    let tuftT = 0
    const timed = (id: PartId, m: Mat) => {
      const a = performance.now()
      tufts(id, m)
      tuftT += performance.now() - a
    }
    this.drawKneadDimples(ctx, dev)
    for (const d of this.defs) {
      if (d.id === 'earL' || d.id === 'earR' || d.id === 'head') continue
      if (d.id === 'legNear' && this.legOnTop()) continue
      if (d.id === 'belly') {
        // the belly shows only as the cat rolls
        const a = Math.max(0, Math.min(1, (this.roll.x - 0.15) / 0.6))
        if (a < 0.01) continue
        ctx.globalAlpha = a
        sprite('belly')
        ctx.globalAlpha = 1
        continue
      }
      const m = sprite(d.id)
      if (m && TUFT_PARTS.includes(d.id)) timed(d.id, m)
    }
    // head casts a soft shadow onto the body
    if (this.headShadow) {
      const def = this.defs.find((d) => d.id === 'head')!
      const m = mul(dev, mul(tr(0.035, 0.06), this.headM()))
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      ctx.globalAlpha = 0.32
      const pad = 0.3
      ctx.drawImage(this.headShadow, def.bbox[0] - pad, def.bbox[1] - pad, def.bbox[2] - def.bbox[0] + pad * 2, def.bbox[3] - def.bbox[1] + pad * 2)
      ctx.globalAlpha = 1
    }
    sprite('earL')
    sprite('earR')
    const hm = sprite('head')
    if (!hm) return
    if (this.has('head')) timed('head', hm)
    ctx.setTransform(hm[0], hm[1], hm[2], hm[3], hm[4], hm[5])
    const px = 1 / this.HW
    drawFace(ctx, this.face, px)
    drawWhiskers(ctx, this.face, px)
    // grooming: the paw comes up in front of the face
    if (this.legOnTop()) sprite('legNear')
    this.drawGlass(ctx, dev)
    this.drawClaws(ctx, dev)
    if (this.asleep) this.drawZ(ctx, hm)
    if (fingerShadow && this.finger.on) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      const r = 0.12 * this.HW
      const g = ctx.createRadialGradient(this.finger.x, this.finger.y, 0, this.finger.x, this.finger.y, r * 1.6)
      g.addColorStop(0, css(P.shadow, 0.18))
      g.addColorStop(0.6, css(P.shadow, 0.1))
      g.addColorStop(1, css(P.shadow, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(this.finger.x, this.finger.y, r * 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
    this.tuftMs = tuftT
  }
}
