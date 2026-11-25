// The cat: rig state, mood (bliss / irk / sleepy), reactions, idle life and rendering of all parts in order.

import { Baker, type Sprite } from './bake'
import { drawFace, drawWhiskers, restFace, type FaceState } from './face'
import { mulberry32, smoothstep, type Rng } from './noise'
import { COAT, P, css } from './palette'
import { D2R, EAR, EXTENT, EYE, type FrontLeg, sunAt, HEAD_C, HEAD_ROT, HIND, LEG_FAR, LEG_NEAR, type Mat, type PartDef, type PartId, TAIL_LEN, TAIL_U0, type V2, apply, buildRig, catSilhouette, ident, inv, mul, rot, scl, tailCurve, tailR, torsoUV, tr } from './rig'
import { E as Ez, type Node, PAD_C, type PawPose, type PawSprites, Spring2, TOE_BASE, angDiff, blobShadow, boneNodes, creaseAO, drawPaw, drawStrip, ik2, limbShadow, segDist, track } from './limbs'
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

/** where the glass stands on the blanket (cat space, base centre): inside the near paw's reach */
const GLASS: V2 = [-1.12, 0.52]
const KNEAD_D: V2 = [-0.8, 0.6]
const KNEAD_HOME: [V2, V2] = [
  [-0.62, 0.3],
  [-0.52, 0.58],
]
const KICK = 0.155
/** the far front paw is planted here */
const LEG_F_REST: V2 = [LEG_FAR.W[0], LEG_FAR.W[1]]
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const lerp2 = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
const unit2 = (a: V2, b: V2): V2 => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l = Math.hypot(dx, dy) || 1
  return [dx / l, dy / l]
}

/** What a front leg wants this frame. */
interface FrontGoal {
  W: V2
  k: number
  d: number
  /** set the wrist exactly (keyframed strikes) */
  direct?: boolean
  /** absolute paw direction, else forearm direction + flex */
  pa?: number
  flex: number
  splay: number
  top: boolean
  lift: number
  curl: number
  squash?: number
  /** paw angle spring stiffness */
  pk?: number
  /** turning the paw over is allowed now (anticipation / lift) */
  flipOK?: boolean
}

interface FrontState {
  g: FrontLeg
  w: Spring2
  pa: number
  paV: number
  splay: number
  lift: number
  curl: number
  top: boolean
  flipT: number
  flex0: number
  S: V2
  E: V2
  W: V2
  nodes: Node[]
  paw: PawPose
  hist: PawPose[]
  reach: number
  goal?: FrontGoal
}

interface HindState {
  toe: Spring2
  splay: number
  K: V2
  E: V2
  W: V2
  nodes: Node[]
  paw: PawPose
}

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
const FLAT: Partial<Record<PartId, string>> = {
  tailA: '#7E6B57',
  belly: '#ECE5DA',
  torso: '#857160',
  thigh: '#7E6B57',
  chest: '#ECE5DA',
  earL: '#7E6B57',
  earR: '#7E6B57',
  head: '#857160',
}

const TUFT_PARTS: PartId[] = ['head', 'torso', 'thigh']
const HIT_ORDER: PartId[] = ['head', 'earL', 'earR', 'legNear', 'chest', 'legFar', 'tail', 'hindNear', 'belly', 'thigh', 'torso', 'tailA']
const LIMBS: PartId[] = ['legNear', 'legFar', 'tail', 'hindNear', 'hindFar']

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
  swatCool = 0
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
  /** harness: the next bean touch always gets the paw-on-finger */
  pawHoldForce = false
  /** harness: ?tufts=0 hides the live tufts (to tell baked fur from live fur) */
  noTufts = false
  /** harness: an invited belly touch always traps */
  forceTrap = false
  whipT = -1
  rippleT = -1
  withT = 0
  jig: V2 = [0, 0]
  glass = { state: 'idle' as 'idle' | 'look' | 'reach' | 'tap' | 'shove' | 'fall' | 'gone', t: 0, x: GLASS[0], y: GLASS[1], k: 0, pushes: 0, alpha: 1, from: [0, 0] as V2, rock: new Spring(0, 220, 5), dir: [-0.85, 0.52] as V2 }
  // pose springs
  earBack = new Spring(0, 120, 18)
  airplane = new Spring(0, 300, 30)
  slit = new Spring(0, 90, 16)
  roll = new Spring(0, 40, 12)
  stretch = new Spring(0, 30, 10)
  hipLift = new Spring(0, 60, 12)
  sleepPose = new Spring(0, 20, 9)
  kneadAmt = new Spring(0, 30, 11)
  tailTip = new Spring(0, 160, 20)
  // ---- limbs (polish v2) ----
  fl: [FrontState, FrontState]
  hl: [HindState, HindState]
  /** hip flexion of the haunch (+ = knee toward the head) */
  hipA = new Spring(0, 300, 30)
  /** shoulder shift toward a far reach, and the head following it */
  shift = new Spring2([0, 0], 90, 16)
  headFollow = new Spring2([0, 0], 140, 22)
  /** contact reaction: torso scale-y impulse */
  react = new Spring(0, 260, 12)
  tailBoost = 0
  tailAmp = 7 * D2R
  tailHz = 0.28
  tailLast = 0
  tailPh = 0
  tailLift = 0
  tailNodes: Node[] = []
  private tailRest: { p: V2[]; a: number[]; l: number[]; u: number[] }
  /** invite progress 0..1 (eased into roll.x) */
  openP = 0
  swatFrom: V2 = [0, 0]
  swatMode: 'hit' | 'air' | 'hiss' = 'hit'
  kneadT = -1
  kneadCs: [number, number] = [0, 0]
  kneadCl: [number, number] = [1.3, 1.3]
  kneadOn: [boolean, boolean] = [false, false]
  ridge: [number, number] = [0, 0]
  ridgeAt: [V2, V2] = [
    [0, 0],
    [0, 0],
  ]
  trapT = -1
  kickFrom: { toe: [V2, V2]; hip: number } | null = null
  idleShiftT = -1
  idleShiftAt = 25
  boneDev = 0
  bones = false
  /** slice count drawn last frame (perf checks) */
  slices = 0
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
    this.idleShiftAt = 20 + mulberry32(o.seed * 13 + 5)() * 20
    const front = (g: FrontLeg): FrontState => {
      const { E, W } = ik2(g.S, g.W, g.L1, g.L2, -1)
      const fa = Math.atan2(W[1] - E[1], W[0] - E[0])
      const flex0 = angDiff(g.pawA, fa)
      const paw: PawPose = { W, a: g.pawA, splay: 0.15, top: g === LEG_FAR, flip: 1, s: g.s, lift: 0, curl: 1, squash: 1 }
      return { g, w: new Spring2([g.W[0], g.W[1]]), pa: g.pawA, paV: 0, splay: 0.15, lift: 0, curl: 1, top: g === LEG_FAR, flipT: -1, flex0, S: g.S, E, W, nodes: [], paw, hist: [], reach: 0 }
    }
    this.fl = [front(LEG_NEAR), front(LEG_FAR)]
    const hind = (off: V2): HindState => {
      const toe: V2 = [HIND.toe[0] + off[0], HIND.toe[1] + off[1]]
      return { toe: new Spring2(toe, 300, 34), splay: 0.1, K: HIND.K, E: [0, 0], W: toe, nodes: [], paw: { W: toe, a: Math.PI, splay: 0.1, top: true, flip: 1, s: HIND.s, lift: 0, curl: 1, squash: 1 } }
    }
    this.hl = [hind([0, 0]), hind(HIND.far)]
    // rest centreline of the tail strip
    const N = 24
    const p: V2[] = []
    const u: number[] = []
    for (let i = 0; i <= N; i++) {
      const uu = TAIL_U0 + ((1 - TAIL_U0) * i) / N
      p.push(tailCurve.at(uu).p)
      u.push(i / N)
    }
    const a: number[] = []
    const l: number[] = []
    for (let i = 0; i < N; i++) {
      a.push(Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]))
      l.push(Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]))
    }
    this.tailRest = { p, a, l, u }
    this.solveLimbs(0)
  }

  /** Recompute layout; rebakes sprites when the scale changes. */
  timings: Record<string, number> = {}
  layout(w: number, h: number, dpr: number, keepBake = false) {
    // fit the whole cat (with whiskers) to ~96 % of the width, centred at 45 % of the height
    const ew = EXTENT.x1 - EXTENT.x0
    const eh = EXTENT.y1 - EXTENT.y0
    const HW = Math.min((w * 0.96) / ew, (h * 0.52) / eh)
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
            ? (x: number, y: number) => covers(['head', 'chest', 'thigh'])(x, y) || this.limbAt(x, y, 0.01) !== null
            : (x: number, y: number) => this.limbAt(x, y, 0.01) !== null
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
    const y1 = Math.min(h - 128, this.oy + HW * 1.78)
    return { x0: cx - rw / 2, x1: cx + rw / 2, y0, y1 }
  }

  private buildBlanket(w: number, h: number, dpr: number) {
    const cv = document.createElement('canvas')
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const c = cv.getContext('2d')!
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    // the surface: warm oak floorboards, 0.9 HW wide, running 8 deg off horizontal
    {
      const HW0 = this.HW
      c.fillStyle = '#E2CCAE'
      c.fillRect(0, 0, w, h)
      const nr = mulberry32(5)
      const pw = 0.9 * HW0
      const ang = -8 * D2R
      c.save()
      c.translate(w / 2, h / 2)
      c.rotate(ang)
      const R = Math.hypot(w, h) / 2 + pw
      for (let y = -R; y < R; y += pw) {
        // staggered end joints
        let x = -R - nr() * 3 * HW0
        while (x < R) {
          const L = (3.2 + nr() * 3.5) * HW0
          const tone = (nr() - 0.5) * 0.07
          c.fillStyle = tone > 0 ? `rgba(255,246,232,${tone * 2.2})` : `rgba(150,110,70,${-tone * 1.6})`
          c.fillRect(x, y, L, pw)
          // grain: a few long low-contrast streaks per plank
          const n = 3 + Math.floor(nr() * 3)
          for (let k = 0; k < n; k++) {
            const gy = y + pw * (0.12 + 0.76 * nr())
            c.strokeStyle = nr() < 0.5 ? 'rgba(160,118,78,0.10)' : 'rgba(255,245,228,0.12)'
            c.lineWidth = 0.6 + nr() * 1.4
            c.beginPath()
            c.moveTo(x + 4, gy)
            c.bezierCurveTo(x + L * 0.3, gy + (nr() - 0.5) * pw * 0.2, x + L * 0.7, gy + (nr() - 0.5) * pw * 0.2, x + L - 4, gy + (nr() - 0.5) * pw * 0.1)
            c.stroke()
          }
          // the end joint
          c.fillStyle = 'rgba(184,150,116,0.5)'
          c.fillRect(x + L - 0.8, y, 1.6, pw)
          x += L
        }
        // the gap between boards
        c.fillStyle = 'rgba(184,150,116,0.5)'
        c.fillRect(-R, y - 0.9, 2 * R, 1.8)
        c.fillStyle = 'rgba(255,248,236,0.25)'
        c.fillRect(-R, y + 0.9, 2 * R, 1)
      }
      c.restore()
    }
    const lg = c.createLinearGradient(0, 0, w, h)
    lg.addColorStop(0, 'rgba(250,242,230,0.25)')
    lg.addColorStop(0.5, 'rgba(250,242,230,0)')
    lg.addColorStop(1, 'rgba(120,90,60,0.12)')
    c.fillStyle = lg
    c.fillRect(0, 0, w, h)

    const HW = this.HW
    const r = this.rugRect(w, h)
    /** A point on the rug edge at angle th (k: outset in css px). */
    const rugPt = (th: number, k = 0): [number, number] => {
      // a soft superellipse with a slight hand-made wobble
      const cx = (r.x0 + r.x1) / 2
      const cy = (r.y0 + r.y1) / 2
      const rx = (r.x1 - r.x0) / 2 + k
      const ry = (r.y1 - r.y0) / 2 + k
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
      return [cx + xr, cy + y]
    }
    const rugPath = (k = 0) => {
      const p = new Path2D()
      const N = 160
      for (let i = 0; i <= N; i++) {
        const [x, y] = rugPt((i / N) * Math.PI * 2, k)
        if (i === 0) p.moveTo(x, y)
        else p.lineTo(x, y)
      }
      p.closePath()
      return p
    }
    // yarn fringe on the two short ends, following the edge (drawn first; the throw covers the roots)
    {
      const nr = mulberry32(11)
      c.save()
      c.lineCap = 'round'
      for (const mid of [-Math.PI / 2, Math.PI / 2]) {
        let th = mid - 0.62
        while (th < mid + 0.62) {
          const [x0, y0] = rugPt(th, -0.05 * HW)
          const [ex, ey] = rugPt(th, 0)
          const [ox, oy] = rugPt(th, 1)
          let nx = ox - ex
          let ny = oy - ey
          const nl = Math.hypot(nx, ny) || 1
          nx /= nl
          ny /= nl
          // short soft yarn ends, a little uneven, as on a hand-knitted throw
          const L = 0.05 * HW + 0.075 * HW * (0.75 + 0.5 * nr())
          const sway = (nr() - 0.5) * 0.06 * HW
          const tx = x0 + nx * L - ny * sway
          const ty = y0 + ny * L + nx * sway
          c.strokeStyle = css(P.rugDark, 0.55)
          c.lineWidth = Math.max(1.2, 0.02 * HW)
          c.beginPath()
          c.moveTo(x0, y0)
          c.quadraticCurveTo(x0 + nx * L * 0.5 - ny * sway * 0.2, y0 + ny * L * 0.5 + nx * sway * 0.2, tx, ty)
          c.stroke()
          c.strokeStyle = css(P.rugHi, 0.35)
          c.lineWidth = Math.max(0.6, 0.008 * HW)
          c.stroke()
          // step along the edge by arc length
          const [bx, by] = rugPt(th + 0.01)
          const ds = Math.max(1, Math.hypot(bx - ex, by - ey) / 0.01)
          th += (0.05 * HW * (0.8 + 0.4 * nr())) / ds
        }
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
      // soft edges from nested strokes (no blur filter: it costs a full raster pass per fold)
      c.save()
      c.lineCap = 'round'
      for (const k of [1.25, 1, 0.75, 0.5]) {
        c.strokeStyle = `rgba(90,50,35,${dark * 0.3})`
        c.lineWidth = width * k
        c.stroke(p)
      }
      c.translate(-width * 0.55, -width * 0.6)
      for (const k of [0.9, 0.65, 0.4]) {
        c.strokeStyle = `rgba(255,236,222,${dark * 0.2})`
        c.lineWidth = width * k
        c.stroke(p)
      }
      c.restore()
    }
    // three narrow folds radiating from under the belly and haunch, where the cat's weight pulls the knit
    {
      const at = (x: number, y: number): [number, number] => [this.ox + x * HW, this.oy + y * HW]
      const folds: { a: [number, number]; b: [number, number]; q: [number, number]; wd: number }[] = [
        { a: at(0.1, 0.62), b: at(-0.2, 1.75), q: at(0.0, 1.2), wd: 0.09 },
        { a: at(0.55, 0.66), b: at(0.95, 1.8), q: at(0.68, 1.3), wd: 0.1 },
        { a: at(1.05, 0.5), b: at(1.95, 1.05), q: at(1.5, 0.66), wd: 0.08 },
      ]
      for (const f of folds) fold(f.a[0], f.a[1], f.b[0], f.b[1], f.q[0], f.q[1], f.wd * HW, 0.18)
      // the knit is not perfectly even: slow +-4 % tone drift
      const nr = mulberry32(21)
      for (let i = 0; i < 26; i++) {
        const x = r.x0 + nr() * (r.x1 - r.x0)
        const y = r.y0 + nr() * (r.y1 - r.y0)
        const rr = (0.3 + nr() * 0.5) * HW
        const g = c.createRadialGradient(x, y, 0, x, y, rr)
        const lite = nr() < 0.5
        g.addColorStop(0, lite ? 'rgba(255,236,224,0.07)' : 'rgba(90,40,30,0.06)')
        g.addColorStop(1, 'rgba(0,0,0,0)')
        c.fillStyle = g
        c.fillRect(x - rr, y - rr, rr * 2, rr * 2)
      }
    }
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

    // afternoon sun from a window at the upper left, across floor, rug and cat
    {
      const S = 8
      const sw = Math.ceil(w / S)
      const sh = Math.ceil(h / S)
      const img = new ImageData(sw, sh)
      for (let j = 0; j < sh; j++)
        for (let i = 0; i < sw; i++) {
          const k = sunAt((i * S + S / 2 - this.ox) / HW, (j * S + S / 2 - this.oy) / HW)
          const q = (j * sw + i) * 4
          img.data[q] = 255
          img.data[q + 1] = 233
          img.data[q + 2] = 196
          img.data[q + 3] = 255 * k
        }
      // one source-over pass: warm light inside the patch, a soft shade veil outside it
      for (let q = 0; q < img.data.length; q += 4) {
        const k = img.data[q + 3] / 255
        const wa = 0.2 * k
        const sa = 0.14 * (1 - k)
        const al = wa + sa
        img.data[q] = (255 * wa + 92 * sa) / (al || 1)
        img.data[q + 1] = (228 * wa + 70 * sa) / (al || 1)
        img.data[q + 2] = (186 * wa + 62 * sa) / (al || 1)
        img.data[q + 3] = 255 * al
      }
      const t = document.createElement('canvas')
      t.width = sw
      t.height = sh
      t.getContext('2d')!.putImageData(img, 0, 0)
      c.save()
      c.imageSmoothingQuality = 'high'
      c.drawImage(t, 0, 0, sw * S, sh * S)
      c.restore()
    }
    // the cat sinks into the rug: a pressed-down hollow under it, with the knit bunched up round it
    const off = 20000
    c.save()
    c.clip(rugPath())
    c.shadowOffsetX = off * dpr
    c.fillStyle = '#000'
    c.shadowColor = 'rgba(255,232,215,0.25)'
    c.shadowBlur = 0.1 * HW * dpr
    c.setTransform(dpr * HW * 1.05, 0, 0, dpr * HW * 1.05, dpr * (this.ox - off - 0.04 * HW), dpr * (this.oy - 0.05 * HW))
    // limbs and the tail strip cast live shadows (drawn with them); only the body is baked here
    const body = this.defs.filter((d) => d.id === 'torso' || d.id === 'thigh' || d.id === 'tailA' || d.id === 'head' || d.id === 'chest')
    catSilhouette(body, c)
    // directional body shadow: offset down-right, away from the window, stretched along the light
    c.shadowColor = css(P.shadow, 0.36)
    c.shadowBlur = 0.12 * HW * dpr
    {
      const sx = 0.09 * HW
      const sy = 0.12 * HW
      // stretch 1.12x along the light direction about the cat's middle
      const lx = 0.6
      const ly = 0.8
      const k = 0.12
      const a = 1 + k * lx * lx
      const b = k * lx * ly
      const d = 1 + k * ly * ly
      const cx = 0.2
      const cy = 0.2
      const m: Mat = mul([a, b, b, d, cx - a * cx - b * cy, cy - b * cx - d * cy], ident)
      c.setTransform(dpr * HW * m[0], dpr * HW * m[1], dpr * HW * m[2], dpr * HW * m[3], dpr * (this.ox + sx - off + m[4] * HW), dpr * (this.oy + sy + m[5] * HW))
    }
    catSilhouette(body, c)
    c.restore()
    // tighter, darker contact core
    c.save()
    c.shadowOffsetX = off * dpr
    c.fillStyle = '#000'
    c.shadowColor = css(P.shadow, 0.5)
    c.shadowBlur = 0.03 * HW * dpr
    c.setTransform(dpr * HW * 0.985, 0, 0, dpr * HW * 0.985, dpr * (this.ox + 0.02 * HW - off), dpr * (this.oy + 0.035 * HW))
    catSilhouette(
      this.defs.filter((d) => d.id === 'torso' || d.id === 'thigh' || d.id === 'tailA'),
      c,
    )
    c.restore()
    // one toy: a grey-blue felt mouse at the lower right of the rug, out of every limb's reach (spec C5)
    {
      const rr = this.rugRect(w, h)
      const s0 = this.HW * 0.3
      const mx = rr.x1 - this.HW * 0.62
      const my = rr.y1 - this.HW * 0.42
      if (my > this.oy + this.HW * 1.0) {
        c.save()
        c.translate(mx, my)
        c.rotate(-0.5)
        // soft shadow to the lower right
        for (const k of [1.2, 1.05, 0.9]) {
          c.fillStyle = 'rgba(80,46,36,0.08)'
          c.beginPath()
          c.ellipse(s0 * 0.08, s0 * 0.14, s0 * 0.5 * k, s0 * 0.28 * k, 0, 0, Math.PI * 2)
          c.fill()
        }
        // string tail
        c.strokeStyle = 'rgba(92,80,74,0.85)'
        c.lineWidth = Math.max(1, s0 * 0.025)
        c.lineCap = 'round'
        c.beginPath()
        c.moveTo(s0 * 0.46, 0)
        c.bezierCurveTo(s0 * 0.75, s0 * 0.12, s0 * 0.8, -s0 * 0.22, s0 * 1.08, -s0 * 0.12)
        c.stroke()
        // body: a felt teardrop, nose to the left
        const body = new Path2D()
        body.moveTo(-s0 * 0.5, 0)
        body.bezierCurveTo(-s0 * 0.3, -s0 * 0.26, s0 * 0.35, -s0 * 0.3, s0 * 0.5, 0)
        body.bezierCurveTo(s0 * 0.35, s0 * 0.3, -s0 * 0.3, s0 * 0.26, -s0 * 0.5, 0)
        const bg = c.createLinearGradient(-s0 * 0.2, -s0 * 0.3, s0 * 0.2, s0 * 0.3)
        bg.addColorStop(0, '#A9B4C2')
        bg.addColorStop(0.55, '#8693A4')
        bg.addColorStop(1, '#6A7586')
        c.fillStyle = bg
        c.fill(body)
        // felt texture: short random fibres
        c.save()
        c.clip(body)
        const rnd = mulberry32(77)
        c.lineWidth = Math.max(0.6, s0 * 0.008)
        for (let i = 0; i < 160; i++) {
          const x = (rnd() - 0.5) * s0
          const y = (rnd() - 0.5) * s0 * 0.6
          const a = rnd() * Math.PI
          const l = s0 * 0.03
          c.strokeStyle = rnd() < 0.5 ? 'rgba(220,228,238,0.35)' : 'rgba(60,68,82,0.3)'
          c.beginPath()
          c.moveTo(x, y)
          c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l)
          c.stroke()
        }
        c.restore()
        // seam along the back
        c.strokeStyle = 'rgba(70,78,92,0.45)'
        c.lineWidth = Math.max(0.8, s0 * 0.012)
        c.setLineDash([s0 * 0.03, s0 * 0.025])
        c.beginPath()
        c.moveTo(-s0 * 0.36, -s0 * 0.02)
        c.quadraticCurveTo(0, -s0 * 0.08, s0 * 0.46, 0)
        c.stroke()
        c.setLineDash([])
        // pink ears and a dark bead eye
        for (const [ex, ey] of [
          [-s0 * 0.2, -s0 * 0.17],
          [-s0 * 0.16, s0 * 0.17],
        ]) {
          c.fillStyle = '#E4A3A6'
          c.beginPath()
          c.ellipse(ex, ey, s0 * 0.075, s0 * 0.06, 0, 0, Math.PI * 2)
          c.fill()
          c.strokeStyle = 'rgba(150,90,96,0.5)'
          c.lineWidth = Math.max(0.6, s0 * 0.01)
          c.stroke()
        }
        c.fillStyle = '#2A2424'
        c.beginPath()
        c.arc(-s0 * 0.33, -s0 * 0.06, Math.max(1, s0 * 0.025), 0, Math.PI * 2)
        c.fill()
        c.fillStyle = '#D98C92'
        c.beginPath()
        c.arc(-s0 * 0.5, 0, Math.max(1, s0 * 0.022), 0, Math.PI * 2)
        c.fill()
        c.restore()
      }
    }
    // vignette
    const vg = c.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.4, w / 2, h * 0.45, Math.hypot(w, h) * 0.6)
    vg.addColorStop(0, 'rgba(107,84,64,0)')
    vg.addColorStop(1, 'rgba(107,84,64,0.22)')
    c.fillStyle = vg
    c.fillRect(0, 0, w, h)
    this.blanket = cv
  }


  // ---------- transforms (cat space) ----------

  /** torso lift from breathing at a cat-space y (for the breath ride) */
  private breathB() {
    return this.breathAmp * (this.asleep ? 1.35 : 1) * (0.5 - 0.5 * Math.cos(this.breath * Math.PI * 2))
  }
  headM(): Mat {
    const st = this.stretch.x
    const sl = this.sleepPose.x
    // the head rides the breath a little (0.2 of the torso lift there) and follows the shoulder
    const ride = -0.2 * this.breathB() * 0.96
    const hf = this.headFollow.p
    return mul(tr(HEAD_C[0] + this.headX.x - 0.1 * st + this.jig[0] + hf[0], HEAD_C[1] + this.headY.x + 0.045 * sl + this.jig[1] + ride + hf[1]), rot(HEAD_ROT + this.headR.x - 5 * D2R * sl))
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
    const b = this.breathB()
    // the belly rests on the blanket: breathing lifts the back, the ground line stays put
    const px = 0.35
    const py = 0.6
    const rip = this.rippleT >= 0 ? 0.025 * Math.sin(this.rippleT * 25) * Math.max(0, 1 - this.rippleT / 0.25) : 0
    // the belly relaxes when the cat opens up (+3 %), and contact events give a small squash
    const open = 0.03 * this.roll.x + this.react.x
    let m: Mat = mul(tr(px + this.slideX.x * 0.5 + this.jig[0], py + this.slideY.x * 0.5 + this.jig[1]), mul(scl(1 + b * 0.25, 1 + b + rip + open), tr(-px, -py)))
    // stretch: the body lengthens toward the head (pivot at the hips)
    const st = this.stretch.x
    if (st > 0.001) m = mul(tr(1.0, 0.3), mul(scl(1 + 0.08 * st, 1 - 0.02 * st), mul(tr(-1.0, -0.3), m)))
    // "pat the butt": hips lift (rotate about the chest)
    const hip = this.hipLift.x
    if (Math.abs(hip) > 0.001) m = mul(tr(-0.4, 0.5), mul(rot(-3 * D2R * hip), mul(tr(0.4, -0.5), m)))
    // trap: the C tightens round the finger
    if (this.trapT >= 0) {
      const k = Math.min(1, this.trapT / 0.12) * this.roll.x
      m = mul(tr(0.2, 0.3), mul(rot(-3 * D2R * k), mul(tr(-0.2, -0.3), m)))
    }
    return m
  }
  /** the haunch: rigid, rotating about the hip */
  thighM(): Mat {
    const H = HIND.H
    return mul(this.torsoM(), mul(tr(H[0], H[1]), mul(rot(this.hipA.x), tr(-H[0], -H[1]))))
  }
  /** chest fluff rides the torso and the shoulder shift */
  chestM(): Mat {
    const s = this.shift.p
    return mul(tr(s[0], s[1]), this.torsoM())
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
      case 'belly':
        return this.torsoM()
      case 'chest':
        return this.chestM()
      case 'thigh':
        return this.thighM()
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
      if (LIMBS.includes(id)) {
        // a paw that is reaching out (swat, clamp) is not a new touch on the beans
        if (id === 'legNear' && this.nearBusy) continue
        if (this.limbHit(id, cx, cy, 0.025)) return { id, lx: cx, ly: cy }
        continue
      }
      if (!this.has(id)) continue
      if (id === 'belly' && this.roll.x < 0.5) continue
      const m = this.partM(id)
      const [lx, ly] = apply(inv(m), cx, cy)
      const d = this.sprite(id).field.sample(lx, ly)
      if (d > -0.025) return { id, lx, ly }
    }
    return null
  }
  /** true while the near leg is doing something other than resting (no bean touches then) */
  nearBusy = false

  /** Capsule test against a limb in its current pose (cat space). */
  private limbHit(id: PartId, x: number, y: number, pad: number): boolean {
    const p: V2 = [x, y]
    if (id === 'legNear' || id === 'legFar') {
      const f = this.fl[id === 'legNear' ? 0 : 1]
      if (segDist(p, f.E, f.W) < 0.09 * f.g.s + pad) return true
      const pc: V2 = [f.W[0] + Math.cos(f.pa) * 0.13 * f.g.s, f.W[1] + Math.sin(f.pa) * 0.13 * f.g.s]
      return Math.hypot(x - pc[0], y - pc[1]) < 0.12 * f.g.s + pad
    }
    if (id === 'hindNear' || id === 'hindFar') {
      const h = this.hl[id === 'hindNear' ? 0 : 1]
      if (segDist(p, h.E, h.W) < 0.085 + pad) return true
      if (this.unfold() > 0.3 && segDist(p, h.K, h.E) < 0.08 + pad) return true
      return Math.hypot(x - h.W[0], y - h.W[1]) < 0.1 + pad
    }
    if (id === 'tail') {
      const n = this.tailNodes
      for (let i = 0; i < n.length - 1; i++) if (segDist(p, n[i].p, n[i + 1].p) < tailR(TAIL_U0 + (1 - TAIL_U0) * (n[i].x / TAIL_LEN)) + pad) return true
    }
    return false
  }
  /** Which limb (if any) covers a cat-space point in the current pose. */
  limbAt(x: number, y: number, pad = 0): PartId | null {
    for (const id of LIMBS) if (this.limbHit(id, x, y, pad)) return id
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
    if (id === 'legNear' || id === 'legFar' || id === 'hindNear' || id === 'hindFar') return { z: 'paw', side: 0 }
    if (id === 'tail') return { z: 'tail', side: 0 }
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
      else if (this.belly === 'none' && (this.glass.state === 'idle' || this.glass.state === 'gone')) {
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
    if (this.swatCool > 0) this.swatCool -= dt
    switch (this.belly) {
      case 'none':
        // the cat offers the belly when the petting pauses while it is blissed out
        if (this.blissHighT > 3 && this.contact > 0.8 && this.irk < 0.3 && this.knead === 0 && this.t > this.bellyCool && this.glass.state === 'idle') {
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
          if (!this.forceTrap && rnd() < 1 / 6) {
            this.belly = 'granted'
            this.emit('granted')
          } else {
            this.belly = 'trap'
            this.startTrap(6 + Math.floor(rnd() * 4))
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
    if (this.belly === 'trap' && this.trapT >= 0) {
      // kick cycles of 155 ms start 120 ms after the grab; the kick lands at 60 ms of each cycle
      const before = this.trapT
      this.trapT += dt
      if (this.kicksLeft > 0) {
        const c0 = Math.floor((before - 0.12 - 0.06) / KICK)
        const c1 = Math.floor((this.trapT - 0.12 - 0.06) / KICK)
        if (c1 > c0 && this.trapT >= 0.18) {
          this.kicksLeft--
          this.kickT = this.trapT
          this.impulse(0.012)
          this.emit('kick', this.kicksLeft)
        }
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
      // overstimulation: the same spot for a long time slowly wears thin
      if (this.zoneTime > 12) irkRate = Math.max(irkRate, 0.03)
      if (rough) irkRate = Math.max(irkRate, 0.25)
    } else if (this.finger.on && this.asleep) blissRate = 0.15
    if (this.belly === 'trap') irkRate = 0
    const irkK = (COAT.id === 'tux' ? 1.3 : 1) * (this.swatCool > 0 ? 0.35 : 1)
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
        this.pawOnFinger = this.pawHoldForce || (this.pawTaps >= 3 && rnd() < 0.2)
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
      this.swatFrom = [this.fl[0].w.p[0], this.fl[0].w.p[1]]
      const S = this.fl[0].S
      const D = Math.hypot(fingerCat[0] - S[0], fingerCat[1] - S[1])
      // pad lands on the finger within reach; a warning swipe that falls short beyond; a hiss past that
      this.swatMode = D <= 0.83 * this.fl[0].g.s + 0.02 ? 'hit' : D <= 1.15 ? 'air' : 'hiss'
      if (this.swatMode === 'hiss') this.whipT = 0
      this.irk = 0.35
      this.swatCool = 3
      this.emit('swat')
    }
    if (this.swatT >= 0) {
      this.swatT += dt
      if (this.swatT > 0.17 && this.swatT - dt <= 0.17 && this.swatMode !== 'hiss') {
        this.impulse(0.01)
        if (this.swatMode === 'hit') {
          const f = this.fl[0]
          this.claws.push({ x: f.W[0] + Math.cos(f.pa) * PAD_C * f.g.s, y: f.W[1] + Math.sin(f.pa) * PAD_C * f.g.s, t: 0 })
        }
      }
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
      const before = Math.floor(this.thumpPhase)
      this.thumpPhase += dt * 2.2
      if (Math.floor(this.thumpPhase) > before) this.emit('thump')
    }

    // ---- kneading (bliss >= 0.85 for 5 s) ----
    this.kneadHighT = this.bliss >= 0.85 && !this.asleep && (this.belly === 'none' || this.belly === 'granted') ? this.kneadHighT + dt : 0
    if (this.knead === 0 && this.kneadHighT > 5 && this.t > this.kneadCool) {
      this.knead = 1
      this.kneadStart = this.t
      this.biscuitsNow = 0
      this.emit('knead_start')
    }
    if (this.knead && this.kneadT < 0) {
      this.kneadT = 0
      // entry 450 ms, then the paws alternate, 180 deg apart
      this.kneadCs = [0.45, 0.45 + 0.65]
      this.kneadCl = [1.3, 1.3 * (0.92 + 0.16 * rnd())]
      this.kneadOn = [true, true]
    }
    if (this.kneadT >= 0) {
      const before = this.kneadT
      this.kneadT += dt
      for (let i = 0; i < 2; i++) {
        if (!this.kneadOn[i]) continue
        const ms0 = ((before - this.kneadCs[i]) / this.kneadCl[i]) * 1300
        const ms1 = ((this.kneadT - this.kneadCs[i]) / this.kneadCl[i]) * 1300
        // a biscuit is counted at the start of the press
        if (ms0 < 480 && ms1 >= 480) {
          this.biscuitsNow++
          this.impulse(0.006)
          this.emit('biscuit')
        }
        if (ms1 >= 1300) {
          if (this.knead) {
            this.kneadCs[i] += this.kneadCl[i]
            this.kneadCl[i] = 1.3 * (0.92 + 0.16 * rnd())
          } else this.kneadOn[i] = false
        }
      }
      if (!this.knead && !this.kneadOn[0] && !this.kneadOn[1]) this.kneadT = -1
    }
    if (this.knead) {
      if (this.bliss < 0.7 || this.irk > 0.3 || this.t - this.kneadStart > 10 || this.contact > 1.2 || this.asleep || rolled) {
        this.knead = 0
        this.kneadCool = this.t + 20
        // a paw that has not started its press yet stops where it is
        for (let i = 0; i < 2; i++) if (this.kneadT < this.kneadCs[i]) this.kneadOn[i] = false
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
    // glass: eye contact before the reach and between the taps; the cat leans toward the glass
    let lean = 0
    {
      const gs = this.glass.state
      if (gs === 'look' || gs === 'reach' || gs === 'tap' || gs === 'shove') {
        lookAtViewer = gs === 'look' || (gs === 'tap' && this.glass.t > 0.25)
        lid = Math.max(lid, 0.75)
      }
      if (gs === 'reach' || gs === 'tap' || gs === 'shove' || (gs === 'fall' && this.glass.t < 0.5)) {
        lean = -0.12
        hx -= 0.03
      }
    }

    // springs
    this.headX.step(hx + this.slideX.x * 0.4, dt)
    this.headY.step(hy + this.slideY.x * 0.4, dt)
    this.headR.step(hr, dt)
    this.look.step(lk, dt)
    this.happy.step(happy, dt)
    this.slideX.step(slide[0] + lean, dt)
    this.slideY.step(slide[1], dt)
    this.earBack.step(earBack, dt)
    this.airplane.step(air, dt, 300, 30)
    this.slit.step(slit, dt)
    this.openP = clamp01(this.openP + (roll > 0 ? dt : -dt) / 0.6)
    this.roll.x = Ez.inOutSine(this.openP)
    this.stretch.step(stretch, dt, 30, 10)
    this.hipLift.step(hip, dt, 60, 12)
    this.sleepPose.step(this.asleep ? 1 : 0, dt, 20, 9)
    this.kneadAmt.step(this.knead, dt, 30, 11)
    for (let i = 0; i < 2; i++) {
      const f = this.earFold[i]
      if (fold[i] > f.x) f.step(fold[i], dt, 1400, 75)
      else f.step(fold[i], dt, 300, 13)
      this.squint[i].step(sq[i], dt)
    }

    // ---- limbs ----
    this.driveLimbs(dt, { zone, fingerCat, groomK, lick, curlK, clampK })
    if (this.pawT >= 0) {
      this.pawT += dt
      if (this.pawT > 1.6) this.pawT = -1
    }

    // ---- tail: a wave travelling to the tip, plus a curl / whip / thump ----
    let tip = 0
    let amp = 7 * D2R
    let hz = 0.28
    let last = 0
    if (this.bliss > 0.6) {
      amp = 10 * D2R
      hz = 0.2
      tip = -10 * D2R
    }
    if (stage === 1) {
      amp = 14 * D2R
      hz = 3
      last = 1
    }
    if (stage === 2) {
      amp = 4 * D2R
      tip = 22 * D2R * Math.sign(Math.sin(this.thumpPhase * Math.PI * 2)) * 0.9
    }
    if (this.whipT >= 0) {
      this.whipT += dt
      tip = 38 * D2R * Math.min(1, this.whipT / 0.12)
      if (this.whipT > 0.9 && !(this.finger.on && zone === 'tail')) this.whipT = -1
    }
    if (hip > 0) tip = -30 * D2R
    if (this.stretch.x > 0.3) tip = Math.min(tip, -15 * D2R)
    if (rolled) {
      amp *= 0.6
      hz *= 0.7
    }
    if (this.asleep) {
      tip = 0
      amp = 3 * D2R
      hz = 0.2
    }
    this.tailBoost = Math.max(0, this.tailBoost - dt / 0.3)
    this.tailAmp += (amp * (1 + 0.3 * this.tailBoost) - this.tailAmp) * Math.min(1, dt * 4)
    this.tailHz += (hz - this.tailHz) * Math.min(1, dt * 3)
    this.tailLast += (last - this.tailLast) * Math.min(1, dt * 4)
    this.tailPh += dt * this.tailHz * Math.PI * 2
    this.tailTip.step(tip, dt, stage === 2 ? 500 : 160, stage === 2 ? 30 : 20)
    // thump: the tail lifts and drops onto the rug
    this.tailLift = stage === 2 ? Math.max(0, Math.sin(this.thumpPhase * Math.PI * 2)) : Math.max(0, this.tailLift - dt * 4)

    // jiggle while kicking (the cat moves, never the screen)
    if (this.belly === 'trap' && this.trapT > 0.12 && this.kicksLeft > 0) {
      const ph = ((this.trapT - 0.12) % KICK) / KICK
      const a = 0.01 * Math.sin(ph * Math.PI * 2 - 1.2)
      this.jig = [a, a * 0.5]
    } else this.jig = [0, 0]
    this.react.step(0, dt)
    this.solveLimbs(dt)
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
    this.stepWhiskers(dt)
  }

  /** whisker tips trail head motion by about 60 ms and settle with one small overshoot */
  private wtipP: V2[] = [
    [0, 0],
    [0, 0],
  ]
  private wtipV: V2[] = [
    [0, 0],
    [0, 0],
  ]
  private lastHeadM: Mat | null = null
  private lastHeadV: V2[] = [
    [0, 0],
    [0, 0],
  ]
  private stepWhiskers(dt: number) {
    if (dt <= 0) return
    const hm = this.headM()
    const ih = inv(hm)
    for (let i = 0; i < 2; i++) {
      const sd = i ? 1 : -1
      const anchor: V2 = [sd * 0.7, 0.4]
      const now = apply(hm, anchor[0], anchor[1])
      const prev = this.lastHeadM ? apply(this.lastHeadM, anchor[0], anchor[1]) : now
      // head velocity at the whisker tips, in head space
      const vx = (now[0] - prev[0]) / dt
      const vy = (now[1] - prev[1]) / dt
      const lv: V2 = [ih[0] * vx + ih[2] * vy, ih[1] * vx + ih[3] * vy]
      const p = this.wtipP[i]
      const v = this.wtipV[i]
      // inertia: a change in head velocity pushes the tips the other way
      v[0] -= lv[0] - this.lastHeadV[i][0]
      v[1] -= lv[1] - this.lastHeadV[i][1]
      this.lastHeadV[i] = lv
      const k = 420
      const d = 2 * Math.sqrt(k) * 0.42
      const n = Math.max(1, Math.ceil(dt / 0.004))
      const h = dt / n
      for (let j = 0; j < n; j++) {
        v[0] += (-k * p[0] - d * v[0]) * h
        v[1] += (-k * p[1] - d * v[1]) * h
        p[0] += v[0] * h
        p[1] += v[1] * h
      }
      const l = Math.hypot(p[0], p[1])
      if (l > 0.06) {
        p[0] *= 0.06 / l
        p[1] *= 0.06 / l
      }
      this.face.wtip[i] = [p[0], p[1]]
    }
    this.lastHeadM = hm
  }

  /** contact reaction: a small squash of the torso and a livelier tail */
  private impulse(k: number) {
    this.react.v += k * 26
    this.tailBoost = 1
  }

  startTrap(kicks: number) {
    this.trapT = 0
    this.kickT = 0
    this.kicksLeft = kicks
    this.lastKickAt = this.t
    this.kickFrom = { toe: [[...this.hl[0].toe.p] as V2, [...this.hl[1].toe.p] as V2], hip: this.hipA.x }
  }

  /** how far the hind legs are unfolded from their tucked rest (0..1) */
  unfold() {
    const h = this.hl[0]
    const d = Math.hypot(h.W[0] - HIND.toe[0], h.W[1] - HIND.toe[1])
    return clamp01(Math.max(d / 0.1, Math.abs(this.hipA.x) / (8 * D2R)))
  }

  /** near wrist at rest: it lies on the chest and rides it at 0.6 */
  private restNear(): V2 {
    const g = LEG_NEAR
    const r = apply(this.torsoM(), g.W[0], g.W[1])
    return [g.W[0] + 0.6 * (r[0] - g.W[0]), g.W[1] + 0.6 * (r[1] - g.W[1])]
  }

  private softUntil = 0

  /** Choose what every limb wants this frame and step its springs (spec section 3). */
  private driveLimbs(dt: number, o: { zone: Zone; fingerCat: V2 | null; groomK: number; lick: number; curlK: number; clampK: number }) {
    const [N, F] = this.fl
    for (let i = 0; i < 2; i++) this.ridge[i] = Math.max(0, this.ridge[i] - dt / 0.25)
    const rest = (f: FrontState, W: V2): FrontGoal => {
      const wrong = f.top !== (f === F)
      // a paw in the wrong view lifts a little and turns over as it settles
      return { W, k: 120, d: 22, flex: f.flex0, splay: 0.15, top: f === F, lift: wrong ? 0.02 : 0, curl: 1, flipOK: wrong }
    }
    let gN = rest(N, this.restNear())
    let gF = rest(F, LEG_F_REST)
    let busy = false
    const hm = this.headM()
    const mouth = apply(hm, 0, 0.34)
    const chin = apply(hm, 0, 0.42)
    const soft = this.t < this.softUntil
    let press = [0, 0]
    const g = this.glass
    if (this.swatT >= 0 && this.swatMode !== 'hiss') {
      busy = true
      gN = this.swatGoal(N, chin)
      if (this.swatT > 0.5) this.softUntil = this.t + 0.4
    } else if (o.clampK > 0 && this.trapAt) {
      busy = true
      const T = this.trapAt
      const grab = this.trapT < 0.12
      // both paws hug the finger from its upper left (the hand covers everything below it on a phone)
      const wN: V2 = [T[0] - 0.24, T[1] - 0.1]
      const wF: V2 = [T[0] - 0.26, T[1] + 0.03]
      gN = { W: wN, k: grab ? 520 : 380, d: grab ? 24 : 38, pa: Math.atan2(T[1] - 0.03 - wN[1], T[0] - wN[0]), flex: 0, splay: grab ? 1 : 0.4, top: true, lift: 0.02, curl: 1, flipOK: true, pk: 500 }
      gF = { W: wF, k: grab ? 520 : 380, d: grab ? 24 : 38, pa: Math.atan2(T[1] + 0.02 - wF[1], T[0] - wF[0]), flex: 0, splay: grab ? 1 : 0.4, top: true, lift: 0.02, curl: 1, flipOK: true, pk: 500 }
    } else if (g.state === 'reach' || g.state === 'tap' || g.state === 'shove' || (g.state === 'fall' && g.t < 0.3)) {
      busy = true
      gN = this.glassGoal(N)
    } else if (this.pawOnFinger && this.pawT >= 0 && this.pawT < 1.4 && o.fingerCat) {
      busy = true
      gN = { W: [o.fingerCat[0] + 0.03, o.fingerCat[1] - 0.02], k: 250, d: 32, flex: 0, splay: 0.2, top: true, lift: 0.02, curl: 1, flipOK: true }
    } else if (o.groomK > 0) {
      busy = true
      // paw up under the mouth, sole to the mouth, toes curled; it counter-moves with each lick
      const lk = this.groomT > 0.04 ? Math.max(0, Math.sin((this.groomT - 0.04) * Math.PI * 2 * 2.6)) : 0
      const W: V2 = [mouth[0] + 0.03 + 0.015 * lk, mouth[1] + 0.1 - 0.01 * lk]
      const pa = Math.atan2(mouth[1] - W[1], mouth[0] - W[0]) - 20 * D2R + 5 * D2R * lk
      gN = { W, k: soft ? 60 : 110, d: soft ? 14 : 20, pa, flex: 0, splay: 0.1, top: false, lift: 0, curl: 0.72, pk: 200 }
    } else if (this.finger.on && o.zone === 'belly' && this.belly === 'none' && o.fingerCat) {
      busy = true
      // a polite push-away: the same reach at 45 %, two slow pats
      const S = N.S
      const u = unit2(S, o.fingerCat)
      const D = Math.min(0.97 * (N.g.L1 + N.g.L2), Math.hypot(o.fingerCat[0] - S[0], o.fingerCat[1] - S[1]) * 0.45 + 0.25)
      const pat = 0.03 * Math.max(0, Math.sin(this.t * Math.PI * 2 * 0.9))
      gN = { W: [S[0] + u[0] * (D + pat), S[1] + u[1] * (D + pat)], k: 90, d: 18, flex: 0, splay: 0.2, top: true, lift: 0.02, curl: 1, flipOK: true }
    } else if (o.curlK > 0) {
      // invite: the legs lift off the belly, the near paw limp
      const p = this.roll.x
      gN = { W: lerp2(this.restNear(), [-0.5, -0.02], p), k: 80, d: 18, flex: N.flex0 + 14 * D2R * p, splay: 0, top: false, lift: 0, curl: 1 - 0.25 * p }
      gF = { W: lerp2(LEG_F_REST, [-0.34, 0.3], p), k: 80, d: 18, flex: F.flex0 + 30 * D2R * p, splay: 0, top: true, lift: 0, curl: 1 - 0.2 * p }
    } else if (this.pawT >= 0 && this.pawT < 0.6 && !this.pawOnFinger) {
      // touched beans: toes spread at once, then the paw is drawn back and tucked
      const t = this.pawT * 1000
      const back = track(t, [[0, 0], [150, 0], [300, 0.06, Ez.outCubic], [600, 0, Ez.inOutSine]])
      const u = unit2(N.g.W, N.g.S)
      const R = this.restNear()
      gN = { W: [R[0] + u[0] * back, R[1] + u[1] * back], k: 300, d: 30, flex: N.flex0 + 10 * D2R * (back / 0.06), splay: track(t, [[0, 0.15], [50, 1, Ez.outCubic], [250, 1], [450, 0.1, Ez.inOutSine]]), top: false, lift: back * 0.3, curl: 1 - 2 * back }
    }
    if (this.kneadT >= 0 && !busy) {
      for (let i = 0; i < 2; i++) {
        const goal = this.kneadGoal(i)
        if (!goal) continue
        if (i === 0) gN = goal.g
        else gF = goal.g
        press[i] = goal.press
      }
    } else if (!busy && this.idleShiftT >= 0) {
      // idle weight shift: the near paw re-settles, toes splay and relax
      const t = this.idleShiftT * 1000
      gN.lift = track(t, [[0, 0], [150, 0.02, Ez.outCubic], [300, 0, Ez.inOutSine]])
      gN.splay = track(t, [[0, 0.15], [200, 0.5, Ez.outCubic], [600, 0.15, Ez.inOutSine]])
      gN.W = [gN.W[0] - 0.012 * Math.sin(Math.min(1, t / 300) * Math.PI), gN.W[1] - 0.008 * Math.sin(Math.min(1, t / 300) * Math.PI)]
      gN.k = 400
      gN.d = 40
    }
    this.nearBusy = busy
    this.stepFront(N, gN, dt)
    this.stepFront(F, gF, dt)

    // ---- shoulder shift toward a far reach (and the knead press), the head follows ----
    let sh: V2 = [0, 0]
    {
      const S0 = apply(this.torsoM(), N.g.S[0], N.g.S[1])
      const T = gN.W
      const r = Math.hypot(T[0] - S0[0], T[1] - S0[1]) / (N.g.L1 + N.g.L2)
      const k = clamp01((r - 0.8) / 0.2) * 0.05
      const u = unit2(S0, T)
      sh = [u[0] * k, u[1] * k]
      for (let i = 0; i < 2; i++)
        if (press[i] > 0) {
          sh[0] += KNEAD_D[0] * 0.018 * press[i] * 0.8
          sh[1] += KNEAD_D[1] * 0.018 * press[i] * 0.8
        }
    }
    this.shift.step(sh, dt)
    this.headFollow.step([this.shift.p[0] * 0.25, this.shift.p[1] * 0.25 + 0.012 * (press[0] + press[1])], dt)

    // ---- hind legs ----
    const restToe: [V2, V2] = [HIND.toe, [HIND.toe[0] + HIND.far[0], HIND.toe[1] + HIND.far[1]]]
    let toe: [V2, V2] = [restToe[0], restToe[1]]
    let hip = 0
    let hk = 200
    let hd = 26
    let direct = false
    let hsplay = [0.1, 0.1]
    if (this.belly === 'trap' && this.trapT >= 0 && this.trapAt) {
      const T = this.trapAt
      const load: V2 = [T[0] + 0.26, T[1] + 0.1]
      if (this.trapT < 0.12 || this.kicksLeft <= 0) {
        toe = [load, [load[0] + HIND.far[0], load[1] + HIND.far[1]]]
        hip = 26 * D2R
        hk = 500
        hd = 40
      } else {
        direct = true
        for (let i = 0; i < 2; i++) {
          const tt = this.trapT - 0.12 - i * 0.025
          if (tt < 0) {
            toe[i] = this.hl[i].toe.p
            continue
          }
          const cyc = Math.floor(tt / KICK)
          const m = (tt - cyc * KICK) * 1000
          const off = i ? HIND.far : ([0, 0] as V2)
          const from: V2 = cyc === 0 && this.kickFrom ? this.kickFrom.toe[i] : [load[0] + off[0], load[1] + off[1]]
          const X = (lx: number, sx: number, fx: number, f0: number) =>
            track(m, [[0, f0], [60, lx, Ez.outCubic], [95, sx, Ez.inCubic], [115, fx, Ez.linear], [155, lx, Ez.inOutSine]])
          toe[i] = [X(T[0] + 0.26 + off[0], T[0] + 0.12 + off[0], T[0] + 0.2 + off[0], from[0]), X(T[1] + 0.1 + off[1], T[1] + 0.2 + off[1], T[1] + 0.34 + off[1], from[1])]
          hsplay[i] = track(m, [[0, 0.2], [60, 0.2], [95, 1, Ez.inCubic], [115, 1], [155, 0.3, Ez.inOutSine]])
          if (i === 0) {
            const h0 = cyc === 0 && this.kickFrom ? this.kickFrom.hip : 26 * D2R
            hip = track(m, [[0, h0], [60, 26 * D2R, Ez.outCubic], [95, 8 * D2R, Ez.inCubic], [115, 0, Ez.linear], [155, 26 * D2R, Ez.inOutSine]])
          }
        }
      }
    } else if (this.roll.x > 0.01) {
      const p = this.roll.x
      hip = 10 * D2R * p
      toe = [lerp2(restToe[0], [0.4, 0.62], p), lerp2(restToe[1], [0.5, 0.7], p)]
      hk = 120
      hd = 22
    }
    if (this.scratchT >= 0) {
      const k = Math.max(0, Math.sin(this.scratchT * Math.PI * 2 * 7))
      toe[0] = [toe[0][0] - 0.03 * k, toe[0][1] - 0.05 * k]
      hip += 4 * D2R * k
    }
    if (direct) {
      const v = (hip - this.hipA.x) / Math.max(dt, 1e-3)
      this.hipA.x = hip
      this.hipA.v = v
    } else this.hipA.step(hip, dt, hk, hd)
    for (let i = 0; i < 2; i++) {
      const h = this.hl[i]
      if (direct) {
        const p = h.toe.p
        h.toe.set(toe[i], [(toe[i][0] - p[0]) / Math.max(dt, 1e-3), (toe[i][1] - p[1]) / Math.max(dt, 1e-3)])
      } else h.toe.step(toe[i], dt, hk, hd)
      h.splay += (hsplay[i] - h.splay) * (direct ? 1 : Math.min(1, dt * 12))
    }
    // idle weight shift timer (only when nothing else is going on)
    if (this.idleShiftT >= 0) {
      this.idleShiftT += dt
      if (this.idleShiftT > 0.7) this.idleShiftT = -1
    } else if (this.idleT > this.idleShiftAt && !busy && this.kneadT < 0 && !this.asleep && this.belly === 'none') {
      this.idleShiftT = 0
      this.idleShiftAt = this.idleT + 20 + ((this.t * 7.31) % 1) * 20
    }
  }

  private stepFront(f: FrontState, g: FrontGoal, dt: number) {
    f.goal = g
    const prev: V2 = [f.w.p[0], f.w.p[1]]
    if (g.direct) f.w.set(g.W, [(g.W[0] - prev[0]) / Math.max(dt, 1e-3), (g.W[1] - prev[1]) / Math.max(dt, 1e-3)])
    else f.w.step(g.W, dt, g.k, g.d)
    const sk = g.direct ? 1 : Math.min(1, dt * 14)
    f.splay += (g.splay - f.splay) * sk
    f.lift += (g.lift - f.lift) * Math.min(1, dt * 16)
    f.curl += (g.curl - f.curl) * Math.min(1, dt * 12)
    // turning the paw over: width 1 -> 0.5 -> 1 in 90 ms, sprites swap at the narrowest frame
    if (f.flipT >= 0) {
      f.flipT += dt
      if (f.flipT >= 0.045 && f.top !== g.top && f.flipT - dt < 0.045) f.top = g.top
      if (f.flipT >= 0.09) f.flipT = -1
    } else if (f.top !== g.top) {
      const sp = Math.hypot(f.w.v[0], f.w.v[1])
      if (sp > 2 || g.flipOK || f.lift > 0.015) f.flipT = 0
    }
  }

  /** Swat keyframes (spec 3.2): cock, accelerating arc, 2-frame contact hold, guard, tremor. */
  private swatGoal(f: FrontState, chin: V2): FrontGoal {
    const ms = this.swatT * 1000
    const T = this.swatAt
    const S = f.S
    const s = f.g.s
    const u = unit2(S, T)
    const D = Math.hypot(T[0] - S[0], T[1] - S[1])
    const R = Math.min(D - PAD_C * s, 0.97 * (f.g.L1 + f.g.L2))
    const C: V2 = [S[0] + u[0] * R, S[1] + u[1] * R]
    const Cov: V2 = [C[0] + u[0] * 0.03, C[1] + u[1] * 0.03]
    const W0 = this.swatFrom
    const ut = unit2(W0, T)
    const uc = unit2(W0, [-0.42, 0.08])
    const cock: V2 = [W0[0] - ut[0] * 0.09 + uc[0] * 0.05, W0[1] - ut[1] * 0.09 + uc[1] * 0.05]
    const guard: V2 = [chin[0] + 0.04, chin[1] - 0.14]
    let W: V2
    let splay = 0
    let sq = 1
    let lift = 0
    let flex = -4 * D2R
    if (ms < 110) {
      const k = Ez.outCubic(ms / 110)
      W = lerp2(W0, cock, k)
      splay = 0.15 * (1 - k)
      lift = 0.03 * k
      flex = 18 * D2R * k
    } else if (ms < 170) {
      const k = Ez.inCubic((ms - 110) / 60)
      const base = lerp2(cock, Cov, k)
      // the strike arcs away from the body, not along a straight line
      let n: V2 = [-(Cov[1] - cock[1]), Cov[0] - cock[0]]
      const nl = Math.hypot(n[0], n[1]) || 1
      n = [n[0] / nl, n[1] / nl]
      const mid = lerp2(cock, Cov, 0.5)
      if ((mid[0] - 0.1) * n[0] + (mid[1] - 0.2) * n[1] < 0) n = [-n[0], -n[1]]
      const b = 0.1 * Math.sin(Math.PI * k)
      W = [base[0] + n[0] * b, base[1] + n[1] * b]
      splay = k
      lift = 0.03 * (1 - k)
      flex = 18 * D2R * (1 - k) - 4 * D2R * k
    } else if (ms < 205) {
      W = Cov
      splay = 1
      sq = 0.9
    } else if (ms < 330) {
      const k = Ez.outCubic((ms - 205) / 125)
      W = lerp2(Cov, guard, k)
      splay = 1 - 0.7 * k
      lift = 0.03 * k
      flex = -4 * D2R + 14 * D2R * k
    } else {
      // guard: a small tremor that dies away
      const a = 1.5 * D2R * Math.exp(-(ms - 330) / 160) * Math.sin(((ms - 330) / 1000) * Math.PI * 2 * 11)
      const dx = guard[0] - S[0]
      const dy = guard[1] - S[1]
      W = [S[0] + dx * Math.cos(a) - dy * Math.sin(a), S[1] + dx * Math.sin(a) + dy * Math.cos(a)]
      splay = 0.3
      lift = 0.03
      flex = 10 * D2R
    }
    return { W, k: 0, d: 0, direct: true, flex, splay, top: true, lift, curl: 1, squash: sq, pk: 1400, flipOK: ms < 110 }
  }

  /** Glass reach (spec 3.3): reach, three taps, the shove, follow-through. */
  private glassGoal(f: FrontState): FrontGoal {
    const g = this.glass
    const s = f.g.s
    const S = f.S
    const G: V2 = [g.x, g.y]
    const toS = unit2(G, S)
    const Cpt: V2 = [G[0] + toS[0] * 0.1, G[1] + toS[1] * 0.1]
    const u = unit2(S, Cpt)
    const touch: V2 = [Cpt[0] - u[0] * PAD_C * s, Cpt[1] - u[1] * PAD_C * s]
    const ms = g.t * 1000
    let fwd = 0
    let W: V2 = touch
    let k = 400
    let d = 40
    if (g.state === 'reach') {
      // from rest out to the glass, decelerating
      const e = Ez.outCubic(Math.min(1, ms / 420))
      W = lerp2(g.from, touch, e)
      return { W, k: 0, d: 0, direct: true, flex: 0, splay: 0.2, top: true, lift: 0.02 * (1 - e), curl: 1, flipOK: ms < 90, pk: 400 }
    }
    if (g.state === 'tap') fwd = track(ms, [[0, 0], [70, 0.04, Ez.outCubic], [160, 0, Ez.inOutSine]])
    if (g.state === 'shove') fwd = track(ms, [[0, 0], [160, 0.1, Ez.inCubic]])
    if (g.state === 'fall') {
      fwd = 0.1
      k = 300
      d = 34
    }
    W = [touch[0] + u[0] * fwd, touch[1] + u[1] * fwd]
    return { W, k, d, direct: g.state !== 'fall', flex: 0, splay: g.state === 'shove' ? 0.5 : 0.25, top: true, lift: 0, curl: 1, pk: 400 }
  }

  /** Kneading keyframes for one paw (spec 3.1), or null when this paw is not kneading. */
  private kneadGoal(i: number): { g: FrontGoal; press: number } | null {
    const home = KNEAD_HOME[i]
    const dl = Math.hypot(KNEAD_D[0], KNEAD_D[1])
    const d: V2 = [KNEAD_D[0] / dl, KNEAD_D[1] / dl]
    const T = this.kneadT
    if (T < 0.45 && this.knead) {
      // entry: to the knead home, the near paw turns over during a small lift
      const e = T / 0.45
      return { g: { W: home, k: 70, d: 16, flex: 0, splay: 0.15, top: true, lift: 0.04 * Math.sin(Math.PI * e), curl: 1, flipOK: true }, press: 0 }
    }
    if (!this.kneadOn[i] || T < this.kneadCs[i]) return this.knead ? { g: { W: home, k: 120, d: 22, flex: 0, splay: 0.15, top: true, lift: 0, curl: 1 }, press: 0 } : null
    const ms = ((T - this.kneadCs[i]) / this.kneadCl[i]) * 1300
    const along = track(ms, [[0, 0], [110, -0.025, Ez.outCubic], [480, 0.115, Ez.inOutSine], [650, 0.135, Ez.outCubic], [760, 0.135, Ez.hold], [1120, 0.01, Ez.inOutSine], [1300, 0, Ez.outCubic]])
    const splay = track(ms, [[0, 0.15], [110, 0.05, Ez.outCubic], [480, 0.6, Ez.inOutSine], [650, 1, Ez.outCubic], [760, 1, Ez.hold], [1120, 0.1, Ez.inOutSine], [1300, 0.15, Ez.outCubic]])
    const pitch = track(ms, [[0, 0], [110, 6, Ez.outCubic], [480, -4, Ez.inOutSine], [650, -8, Ez.outCubic], [760, -8, Ez.hold], [1120, 8, Ez.inOutSine], [1300, 0, Ez.outCubic]])
    const lift = track(ms, [[0, 0], [110, 0.02, Ez.outCubic], [480, 0, Ez.inOutSine]])
    const press = clamp01((along - 0.1) / 0.035) * (ms < 900 ? 1 : 0)
    if (press > this.ridge[i]) {
      this.ridge[i] = press
      this.ridgeAt[i] = [home[0] + d[0] * (along + 0.3), home[1] + d[1] * (along + 0.3)]
    }
    const W: V2 = [home[0] + d[0] * along, home[1] + d[1] * along]
    return { g: { W, k: 0, d: 0, direct: true, flex: 0, splay, top: true, lift, curl: 1 - Math.max(0, pitch) * 0.025 + Math.max(0, -pitch) * 0.006, flipOK: true }, press }
  }

  /** IK for all limbs from the current wrist / toe positions; centrelines for drawing and hit tests. */
  solveLimbs(dt: number) {
    const tm = this.torsoM()
    let dev = 0
    for (let i = 0; i < 2; i++) {
      const f = this.fl[i]
      const g = f.g
      const s0 = apply(tm, g.S[0], g.S[1])
      const sk = i === 0 ? 1 : 0.5
      const S: V2 = [s0[0] + this.shift.p[0] * sk, s0[1] + this.shift.p[1] * sk]
      const { E, W, reach } = ik2(S, f.w.p, g.L1, g.L2, -1)
      f.S = S
      f.E = E
      f.W = W
      f.reach = reach
      const fa = Math.atan2(W[1] - E[1], W[0] - E[0])
      const goal = f.goal
      const tgt = goal?.pa ?? fa + (goal ? goal.flex : f.flex0)
      const pk = goal?.pk ?? 260
      const pd = 2 * Math.sqrt(pk) * 0.68
      if (dt > 0) {
        const n = Math.max(1, Math.ceil((dt * Math.sqrt(pk)) / 0.3))
        const h = dt / n
        for (let j = 0; j < n; j++) {
          f.paV += (pk * angDiff(tgt, f.pa) - pd * f.paV) * h
          f.pa += f.paV * h
        }
      } else f.pa = tgt
      const flip = f.flipT >= 0 ? 1 - 0.5 * Math.sin((Math.PI * Math.min(0.09, f.flipT)) / 0.09) : 1
      if (f.hist.length > 2) f.hist.shift()
      f.hist.push(f.paw)
      f.paw = { W, a: f.pa, splay: f.splay, top: f.top, flip, s: g.s, lift: f.lift, curl: f.curl, squash: goal?.squash ?? 1 }
      f.nodes = boneNodes(S, E, W, g.L1, g.L2, 0.6 * 0.21 * g.s)
      dev = Math.max(dev, Math.abs(Math.hypot(E[0] - S[0], E[1] - S[1]) / g.L1 - 1), Math.abs(Math.hypot(W[0] - E[0], W[1] - E[1]) / g.L2 - 1))
    }
    const thm = this.thighM()
    for (let i = 0; i < 2; i++) {
      const h = this.hl[i]
      const k0 = apply(thm, HIND.K[0], HIND.K[1])
      const K: V2 = i ? [k0[0] + HIND.far[0], k0[1] + HIND.far[1]] : k0
      const { E, W } = ik2(K, h.toe.p, HIND.L1, HIND.L2, -1)
      h.K = K
      h.E = E
      h.W = W
      const a = Math.atan2(W[1] - E[1], W[0] - E[0])
      const ps = HIND.s * 0.95
      h.paw = { W: [W[0] - Math.cos(a) * TOE_BASE * ps, W[1] - Math.sin(a) * TOE_BASE * ps], a, splay: h.splay, top: true, flip: 1, s: ps, lift: 0, curl: 1, squash: 1 }
      h.nodes = boneNodes(K, E, W, HIND.L1, HIND.L2, 0.6 * 0.17)
      dev = Math.max(dev, Math.abs(Math.hypot(E[0] - K[0], E[1] - K[1]) / HIND.L1 - 1), Math.abs(Math.hypot(W[0] - E[0], W[1] - E[1]) / HIND.L2 - 1))
    }
    this.boneDev = Math.max(this.boneDev * 0, dev)
    this.boneDevMax = Math.max(this.boneDevMax, dev)
    // tail: per-node angle offsets, a wave travelling to the tip; the tip curls with tailTip
    const R = this.tailRest
    const n = R.p.length
    const out: Node[] = [{ x: 0, p: [R.p[0][0] + this.jig[0], R.p[0][1] + this.jig[1]] }]
    let x = R.p[0][0] + this.jig[0]
    let y = R.p[0][1] + this.jig[1]
    for (let i = 0; i < n - 1; i++) {
      const u = R.u[i + 1]
      const wLast = 1 - this.tailLast + this.tailLast * smoothstep(0.55, 0.85, u) * 2.2
      const th = this.tailAmp * Math.pow(u, 1.6) * Math.sin(this.tailPh - 2.2 * u) * wLast + this.tailTip.x * smoothstep(0.45, 1, u) * 1.1
      const a = R.a[i] + th
      x += Math.cos(a) * R.l[i]
      y += Math.sin(a) * R.l[i]
      const lift = this.tailLift * 0.05 * smoothstep(0.2, 1, u)
      out.push({ x: (TAIL_LEN * (i + 1)) / (n - 1), p: [x, y - lift] })
    }
    this.tailNodes = out
  }
  boneDevMax = 0

  private endBelly(trapped: boolean) {
    this.belly = 'none'
    this.bellyT = 0
    this.kicksLeft = 0
    this.kickT = -1
    this.trapT = -1
    this.kickFrom = null
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
    g.rock.step(0, dt)
    const busy = this.asleep || this.belly !== 'none' || this.knead > 0 || this.groomT >= 0 || this.irk > 0.3
    const active = g.state === 'look' || g.state === 'reach' || g.state === 'tap' || g.state === 'shove'
    if (g.state === 'idle') {
      g.alpha = Math.min(1, g.alpha + dt * 2)
      if (this.idleT > 20 && !busy) {
        g.state = 'look'
        g.t = 0
        g.pushes = 0
      }
    } else if (active) {
      if (tapped) {
        // tapping the glass slides it back; the cat will try again
        g.x = GLASS[0]
        g.y = GLASS[1]
        g.pushes = 0
        g.state = 'look'
        g.t = 0
      } else if (this.finger.on || this.asleep || this.belly !== 'none') {
        g.state = 'idle'
      } else if (g.state === 'look' && g.t > 1.2) {
        g.state = 'reach'
        g.t = 0
        g.from = [this.fl[0].w.p[0], this.fl[0].w.p[1]]
        g.dir = unit2(this.fl[0].S, [g.x, g.y])
      } else if (g.state === 'reach' && g.t > 0.42) {
        g.state = 'tap'
        g.t = 0
      } else if (g.state === 'tap') {
        if (g.t > 0.07 && g.t - dt <= 0.07) {
          // each tap slides the glass 3 % of a head away and sets it rocking
          g.pushes++
          g.x += g.dir[0] * 0.03
          g.y += g.dir[1] * 0.03
          g.rock.v += (g.pushes % 2 ? 1 : -1) * 1.0
          this.emit('glass_push', g.pushes)
        }
        if (g.t > 0.76) {
          g.t = 0
          if (g.pushes >= 3) g.state = 'shove'
        }
      } else if (g.state === 'shove' && g.t > 0.16) {
        g.state = 'fall'
        g.t = 0
        g.x += g.dir[0] * 0.04
        g.y += g.dir[1] * 0.04
        this.emit('glass_push', 4)
      }
    } else if (g.state === 'fall') {
      // tips over about its base edge (220 ms), then rolls off the rug and out of frame (450 ms)
      if (g.t > 0.67) {
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

  /** The near leg is drawn over the face while the wrist is above the chin line (swat, groom). */
  private legOnTop() {
    if (this.groomT >= 0) return true
    if (this.swatT < 0) return false
    const chin = apply(this.headM(), 0, 0.42)
    return this.fl[0].W[1] < chin[1]
  }

  /** Knead: a bunched ridge of rug in front of each pressing paw and a dimple under the toes. */
  private drawKneadRidges(ctx: CanvasRenderingContext2D, dev: Mat) {
    const dl = Math.hypot(KNEAD_D[0], KNEAD_D[1])
    const ang = Math.atan2(KNEAD_D[1] / dl, KNEAD_D[0] / dl)
    for (let i = 0; i < 2; i++) {
      const h = this.ridge[i]
      if (h < 0.01) continue
      const [x, y] = this.ridgeAt[i]
      const m = mul(dev, mul(tr(x, y), rot(ang)))
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      // the ridge runs across the push direction (local y): a soft lit crest and a soft shadow behind it,
      // radial gradients squashed along the ridge so no edge shows
      const s = 0.85 + 0.15 * h
      ctx.save()
      ctx.scale(1, 2.4 * s)
      const crest = ctx.createRadialGradient(-0.004, 0, 0, -0.004, 0, 0.045)
      crest.addColorStop(0, `rgba(255,232,214,${0.3 * h})`)
      crest.addColorStop(1, 'rgba(255,232,214,0)')
      ctx.fillStyle = crest
      ctx.fillRect(-0.05, -0.05, 0.1, 0.1)
      const sh = ctx.createRadialGradient(0.032, 0, 0, 0.032, 0, 0.045)
      sh.addColorStop(0, `rgba(90,50,35,${0.22 * h})`)
      sh.addColorStop(1, 'rgba(90,50,35,0)')
      ctx.fillStyle = sh
      ctx.fillRect(-0.015, -0.05, 0.1, 0.1)
      ctx.restore()
      // dimple where the toes press
      const g = ctx.createRadialGradient(-0.12, 0, 0, -0.12, 0, 0.1)
      g.addColorStop(0, `rgba(90,50,35,${0.16 * h})`)
      g.addColorStop(1, 'rgba(90,50,35,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(-0.12, 0, 0.07, 0.1, 0, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /** Three thin claw lines where a swat landed; they fade over 1.2 s. */
  private drawClaws(ctx: CanvasRenderingContext2D, dev: Mat) {
    for (const c of this.claws) {
      const a = Math.max(0, 1 - c.t / 1.2)
      const m = mul(dev, mul(tr(c.x, c.y), rot(-0.5)))
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      ctx.strokeStyle = `rgba(214,138,136,${0.7 * a})`
      ctx.lineWidth = 0.01
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

  /** The glass seen from above (spec C4): rim circle larger than the base, the inside and the water surface
   *  visible, the knit refracted through it, a caustic on the side away from the light, the shadow to the
   *  lower right. Tipping foreshortens the rim toward the push; after that it rolls as a lying cylinder. */
  private drawGlass(ctx: CanvasRenderingContext2D, dev: Mat) {
    const g = this.glass
    if (g.state === 'gone') return
    let { x, y } = g
    let a = g.alpha
    let tip = 0
    let spin = 0
    if (g.state === 'fall') {
      tip = Ez.inCubic(Math.min(1, g.t / 0.22)) * (Math.PI / 2)
      const r = Math.max(0, (g.t - 0.22) / 0.45)
      const d = 1.5 * r * r + 0.25 * r
      x += g.dir[0] * d
      y += g.dir[1] * d
      spin = r * 5
      a *= 1 - smoothstep(0.6, 1, r)
    }
    if (a < 0.01) return
    const R = 0.1 // rim radius
    const Rb = 0.078 // base radius (further from the eye, so smaller)
    const H = 0.3
    const da = Math.atan2(g.dir[1], g.dir[0])
    // local frame: +x along the push; the rock tilts the rim a little toward the paw and back
    const rockS = g.rock.x * 0.07
    const st = Math.sin(tip)
    const ct = Math.cos(tip)
    // rim centre relative to the base centre (projected), and the rim's foreshortening along the push
    // the eye is above the middle of the screen, left of and above the glass's far side: the rim sits a
    // little outward from the base, so a sliver of wall shows (cat space (-0.035, -0.02), in the push frame)
    const pc = Math.cos(-da)
    const ps = Math.sin(-da)
    const px0 = -0.035 * pc + 0.02 * ps
    const py0 = -0.035 * ps - 0.02 * pc
    const rx = H * st + Math.sin(rockS) * H * 0.4 + px0 * ct
    const ry = py0 * ct
    const rimA = R
    const rimB = Math.max(0.012, R * ct)
    const lying = tip > 1.2
    const m = mul(dev, mul(tr(x, y), rot(da)))
    const HWs = Math.hypot(dev[0], dev[1])
    ctx.save()
    ctx.globalAlpha = a
    // shadow to the lower right (scene light), drawn in cat space so its offset does not turn with the push
    {
      const sm = mul(dev, tr(x + 0.06 + Math.cos(da) * rx * 0.5, y + 0.08 + Math.sin(da) * rx * 0.5))
      ctx.setTransform(sm[0], sm[1], sm[2], sm[3], sm[4], sm[5])
      for (const k of [1.25, 1.1, 0.95]) {
        ctx.fillStyle = 'rgba(80,50,38,0.11)'
        ctx.beginPath()
        ctx.ellipse(0, 0, R * k * (1 + 0.6 * st), R * k * 0.9, da, 0, Math.PI * 2)
        ctx.fill()
      }
      // caustic: a bright crescent on the side away from the light, only while it stands
      if (tip < 0.6) {
        ctx.globalAlpha = a * (1 - tip / 0.6)
        const cg = ctx.createRadialGradient(0.012, 0.016, 0.01, 0, 0, R * 0.95)
        cg.addColorStop(0, 'rgba(255,250,226,0.95)')
        cg.addColorStop(1, 'rgba(255,246,214,0)')
        ctx.fillStyle = cg
        ctx.beginPath()
        ctx.ellipse(-0.03, -0.04, R * 0.62, R * 0.4, -Math.PI / 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = a
      }
    }
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    // the wall: hull of the base circle and the rim ellipse
    const body = new Path2D()
    if (!lying) {
      body.ellipse(0, 0, Rb, Rb * (0.6 + 0.4 * ct), 0, 0, Math.PI * 2)
      body.closePath()
      body.ellipse(rx, ry, rimB, rimA, 0, 0, Math.PI * 2)
      // the wall: tangent hull between base and rim
      body.moveTo(0, -Rb)
      body.lineTo(rx, ry - rimA)
      body.lineTo(rx, ry + rimA)
      body.lineTo(0, Rb)
      body.closePath()
    } else {
      // lying cylinder: a rounded rectangle along the push
      body.roundRect(-0.02, -R * 0.92, H + 0.02, R * 1.84, R * 0.35)
    }
    ctx.fillStyle = 'rgba(236,244,248,0.28)'
    ctx.fill(body, 'nonzero')
    ctx.strokeStyle = 'rgba(90,110,120,0.35)'
    ctx.lineWidth = 1 / HWs
    ctx.stroke(body)
    if (!lying) {
      // inside the rim: the knit refracted (6 % larger, shifted 0.01) and the water
      const rim = new Path2D()
      rim.ellipse(rx, ry, rimB, rimA, 0, 0, Math.PI * 2)
      const water = 1 - smoothstep(0.15, 0.7, tip)
      if (water > 0.01 && this.blanket) {
        ctx.save()
        ctx.clip(rim)
        const [cx, cy] = apply(m, rx, ry)
        ctx.setTransform(1.06, 0, 0, 1.06, cx - 1.06 * cx + 0.01 * HWs, cy - 1.06 * cy + 0.01 * HWs)
        ctx.globalAlpha = a * water
        ctx.drawImage(this.blanket, 0, 0)
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
        ctx.fillStyle = 'rgba(170,214,232,0.16)'
        ctx.fill(rim)
        // the base ring seen through the water
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'
        ctx.lineWidth = 1 / HWs
        ctx.beginPath()
        ctx.ellipse(0, 0, Rb, Rb, 0, 0, Math.PI * 2)
        ctx.stroke()
        // the water surface, between base and rim, with its meniscus line
        ctx.strokeStyle = 'rgba(200,232,246,0.6)'
        ctx.beginPath()
        ctx.ellipse(rx * 0.6, ry * 0.6, rimB * 0.9, rimA * 0.9, 0, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
        ctx.globalAlpha = a
      }
      // inner wall shading on the lit side, then the rim: a bright lip
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1.6 / HWs
      ctx.stroke(rim)
      ctx.strokeStyle = 'rgba(120,140,150,0.3)'
      ctx.lineWidth = 0.8 / HWs
      ctx.beginPath()
      ctx.ellipse(rx, ry, Math.max(0.006, rimB - 0.008), rimA - 0.008, 0, 0, Math.PI * 2)
      ctx.stroke()
      // specular glint on the rim toward the light
      const L = -Math.PI * 0.75 - da
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.lineWidth = 2.4 / HWs
      ctx.beginPath()
      ctx.ellipse(rx, ry, rimB, rimA, 0, L - 0.35, L + 0.35)
      ctx.stroke()
    } else {
      // rolling: a highlight stripe that runs round the cylinder
      const ph = Math.sin(spin * 2.2)
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'
      ctx.lineWidth = 2 / HWs
      ctx.beginPath()
      ctx.moveTo(0.01, ph * R * 0.6)
      ctx.lineTo(H - 0.01, ph * R * 0.6)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.beginPath()
      ctx.ellipse(H, 0, 0.018, R * 0.9, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }

  // ---------- drawing ----------

  private pawSprites(): PawSprites | null {
    if (!this.has('palmTop') || !this.has('palmSole') || !this.has('toeTop') || !this.has('toeSole')) return null
    return { palmTop: this.sprite('palmTop'), palmSole: this.sprite('palmSole'), toeTop: this.sprite('toeTop'), toeSole: this.sprite('toeSole') }
  }

  private drawFront(ctx: CanvasRenderingContext2D, dev: Mat, i: number) {
    const f = this.fl[i]
    const id: PartId = i === 0 ? 'legNear' : 'legFar'
    if (!this.has(id)) return
    const s = f.g.s
    const p = f.paw
    // live contact shadow: limb as one path, the paw as a blob; less dark where it falls on fur
    const k = i === 0 ? (this.belly !== 'none' ? 1.15 : 0.9) : 1
    limbShadow(ctx, dev, [lerp2(f.S, f.E, 0.5), f.E, f.W], 0.082 * s, f.lift, k)
    blobShadow(ctx, dev, [f.W[0] + Math.cos(p.a) * 0.12 * s, f.W[1] + Math.sin(p.a) * 0.12 * s], 0.12 * s, 0.095 * s * p.flip, p.a, f.lift, k * 0.85)
    const st = { slices: 0 }
    drawStrip(ctx, dev, this.sprite(id), f.nodes, 0.18 * s, -1e9, 1e9, st)
    this.slices += st.slices
    creaseAO(ctx, dev, f.S, f.E, f.W, 0.1 * s)
    const ps = this.pawSprites()
    if (!ps) return
    // smear: the two previous paw positions during the strike
    if (i === 0 && this.swatT >= 0.11 && this.swatT < 0.205 && this.swatMode !== 'hiss')
      for (let h = 0; h < f.hist.length - 1; h++) drawPaw(ctx, dev, ps, f.hist[h], h === f.hist.length - 2 ? 0.22 : 0.1)
    drawPaw(ctx, dev, ps, p)
  }

  /** a hind leg; [from, to) is the strip range (the shank goes under the haunch, the foot over it) */
  private drawHind(ctx: CanvasRenderingContext2D, dev: Mat, i: number, from: number, to: number, paw: boolean) {
    const h = this.hl[i]
    const id: PartId = i === 0 ? 'hindNear' : 'hindFar'
    if (!this.has(id)) return
    if (from < -1e8) {
      const a = h.paw.a
      const tipP: V2 = [h.W[0] + Math.cos(a) * 0.07, h.W[1] + Math.sin(a) * 0.07]
      limbShadow(ctx, dev, this.unfold() > 0.3 ? [h.K, h.E, h.W, tipP] : [h.E, h.W, tipP], 0.08, 0.004 * this.unfold(), 1.1)
    }
    const st = { slices: 0 }
    drawStrip(ctx, dev, this.sprite(id), h.nodes, 0.155, from, to, st)
    this.slices += st.slices
    if (paw) {
      const ps = this.pawSprites()
      if (ps) drawPaw(ctx, dev, ps, h.paw)
    }
  }

  private drawTail(ctx: CanvasRenderingContext2D, dev: Mat) {
    if (!this.has('tail')) return
    const n = this.tailNodes
    const pts: V2[] = []
    for (let i = 2; i < n.length; i += 2) pts.push(n[i].p)
    limbShadow(ctx, dev, pts, 0.075, this.tailLift * 0.02, 1)
    const st = { slices: 0 }
    drawStrip(ctx, dev, this.sprite('tail'), n, 0.145, -1e9, 1e9, st)
    this.slices += st.slices
  }

  private drawBones(ctx: CanvasRenderingContext2D, dev: Mat) {
    ctx.setTransform(dev[0], dev[1], dev[2], dev[3], dev[4], dev[5])
    const px = 1 / this.HW
    ctx.lineWidth = 2 * px
    const dot = (p: V2, r: number, c: string) => {
      ctx.fillStyle = c
      ctx.beginPath()
      ctx.arc(p[0], p[1], r * px, 0, Math.PI * 2)
      ctx.fill()
    }
    const line = (ps: V2[], c: string) => {
      ctx.strokeStyle = c
      ctx.beginPath()
      ctx.moveTo(ps[0][0], ps[0][1])
      for (const p of ps.slice(1)) ctx.lineTo(p[0], p[1])
      ctx.stroke()
    }
    for (const f of this.fl) {
      line([f.S, f.E, f.W], 'rgba(0,160,255,0.9)')
      line([f.W, [f.W[0] + Math.cos(f.pa) * 0.25 * f.g.s, f.W[1] + Math.sin(f.pa) * 0.25 * f.g.s]], 'rgba(0,200,120,0.9)')
      dot(f.S, 4, '#06f')
      dot(f.E, 4, '#f80')
      dot(f.W, 4, '#0c6')
      if (f.goal) {
        ctx.strokeStyle = '#f0f'
        ctx.beginPath()
        ctx.arc(f.goal.W[0], f.goal.W[1], 6 * px, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    dot(LEG_F_REST, 3, '#ff0')
    for (const h of this.hl) {
      line([h.K, h.E, h.W], 'rgba(255,60,60,0.9)')
      dot(h.K, 4, '#f80')
      dot(h.E, 4, '#f80')
      dot(h.W, 4, '#0c6')
    }
    dot(HIND.toe, 3, '#ff0')
    dot(HIND.H, 4, '#f00')
    line(
      this.tailNodes.map((n) => n.p),
      'rgba(255,200,0,0.9)',
    )
  }

  // ---------- drawing ----------

  draw(ctx: CanvasRenderingContext2D, fingerShadow: boolean) {
    const dev = this.dev()
    const unit = this.dpr * this.HW
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (this.blanket) ctx.drawImage(this.blanket, 0, 0)
    this.matchedThisFrame = false
    this.slices = 0
    const sprite = (id: PartId) => {
      if (!this.has(id)) {
        const col = FLAT[id]
        if (!col) return null
        // not built yet (first frames, or right after a rebake): a flat silhouette in the coat colour
        const def = this.defs.find((d) => d.id === id)!
        const m = mul(dev, this.partM(id))
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
        ctx.fillStyle = col
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
    const part = (id: PartId) => {
      const m = sprite(id)
      if (m && TUFT_PARTS.includes(id) && !this.noTufts) {
        const a = performance.now()
        tufts(id, m)
        tuftT += performance.now() - a
      }
      return m
    }
    this.drawKneadRidges(ctx, dev)
    part('tailA')
    part('torso')
    {
      // the belly fur comes up as the cat opens (never pops: alpha follows the invite progress)
      const a = this.roll.x
      if (a > 0.01) {
        ctx.globalAlpha = a
        sprite('belly')
        ctx.globalAlpha = 1
      }
    }
    // hind legs come out from under the haunch; a lifted foot goes over the tail, a tucked one under it
    const uf = this.unfold()
    const split = HIND.L1 - 0.6 * 0.17
    if (uf > 0.05) this.drawHind(ctx, dev, 1, -1e9, 1e9, true)
    this.drawHind(ctx, dev, 0, -1e9, split, false)
    part('thigh')
    if (uf < 0.3) {
      this.drawHind(ctx, dev, 0, split, 1e9, true)
      this.drawTail(ctx, dev)
    } else {
      this.drawTail(ctx, dev)
      this.drawHind(ctx, dev, 0, split, 1e9, true)
    }
    this.drawFront(ctx, dev, 1)
    part('chest')
    const onTop = this.legOnTop()
    if (!onTop) this.drawFront(ctx, dev, 0)
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
    const hm = part('head')
    if (!hm) return
    ctx.setTransform(hm[0], hm[1], hm[2], hm[3], hm[4], hm[5])
    const px = 1 / this.HW
    drawFace(ctx, this.face, px)
    drawWhiskers(ctx, this.face, px)
    if (onTop) this.drawFront(ctx, dev, 0)
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
    if (this.bones) this.drawBones(ctx, dev)
    this.tuftMs = tuftT
  }
}
