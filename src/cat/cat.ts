// The cat: rig state, reactions (Phase 1: head zones), rendering of all parts in order.

import { Baker, type Sprite } from './bake'
import { drawFace, drawWhiskers, restFace, type FaceState } from './face'
import { mulberry32, smoothstep, type Rng } from './noise'
import { P, css } from './palette'
import { D2R, EAR, EYE, HEAD_C, HEAD_ROT, type Mat, type PartDef, type PartId, TAIL_JOINT, apply, buildRig, catSilhouette, inv, mul, rot, scl, tailCurve, tr } from './rig'
import { Groom, TuftLayer } from './tufts'

export type Zone = 'chin' | 'cheek' | 'top' | 'nose' | 'body' | 'none'

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
    const a = k * (target - this.x) - d * this.v
    this.v += a * dt
    this.x += this.v * dt
    return this.x
  }
}

export interface CatOpts {
  seed: number
  fur: boolean
}

const TUFT_PARTS: PartId[] = ['head', 'torso', 'thigh']
const HIT_ORDER: PartId[] = ['head', 'earL', 'earR', 'legNear', 'chest', 'legFar', 'footNear', 'thigh', 'torso', 'footFar', 'tailB', 'tailA']

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
  zone: Zone = 'none'
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
  lidBase = new Spring(0.9, 120, 22)
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

  constructor(private o: CatOpts) {
    this.defs = buildRig({ seed: o.seed })
    this.rnd = mulberry32(o.seed * 991 + 7)
    this.blinkAt = 2.5 + this.rnd() * 3
    this.twitchAt = 8 + this.rnd() * 12
  }

  /** Recompute layout; rebakes sprites when the scale changes. */
  timings: Record<string, number> = {}
  layout(w: number, h: number, dpr: number, keepBake = false) {
    const HW = Math.min(w / 3.55, h / 3.4)
    this.ox = w / 2 + HW * 0.02
    this.oy = h * 0.47
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
      if (!this.grooms.size) tm('tufts', () => this.buildTufts())
      else for (const l of this.layers.values()) l.matched = false
      tm('headShadow', () => this.buildHeadShadow())
    }
    tm('blanket', () => this.buildBlanket(w, h, dpr))
  }

  private sprite(id: PartId): Sprite {
    return this.baker.sprites.get(id)!
  }

  private buildTufts() {
    const fieldOf = (id: PartId) => this.sprite(id).field
    const covers = (ids: PartId[]) => (x: number, y: number) =>
      ids.some((id) => {
        const def = this.defs.find((d) => d.id === id)!
        const [lx, ly] = apply(inv(def.toCat), x, y)
        return fieldOf(id).sample(lx, ly) > 0.03
      })
    for (const id of TUFT_PARTS) {
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
            ? covers(['head', 'legNear', 'legFar', 'chest', 'thigh', 'footNear'])
            : covers(['footNear'])
      const layer = new TuftLayer(def, fieldOf(id), g, this.o.seed * 31 + id.length, exclude)
      this.layers.set(id, layer)
    }
    this.tuftCount = [...this.layers.values()].reduce((a, l) => a + l.tufts.length, 0)
  }

  private buildHeadShadow() {
    const def = this.defs.find((d) => d.id === 'head')!
    const ppu = Math.max(20, this.baker.sprites.get('head')!.ppu * 0.35)
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

  private buildBlanket(w: number, h: number, dpr: number) {
    const cv = document.createElement('canvas')
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const c = cv.getContext('2d')!
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.fillStyle = css(P.blanket)
    c.fillRect(0, 0, w, h)
    // soft top-left light
    const lg = c.createLinearGradient(0, 0, w, h)
    lg.addColorStop(0, 'rgba(250,242,230,0.55)')
    lg.addColorStop(0.5, 'rgba(250,242,230,0)')
    lg.addColorStop(1, 'rgba(120,90,60,0.12)')
    c.fillStyle = lg
    c.fillRect(0, 0, w, h)
    // knitted rows: columns of small V stitches (10 px pitch)
    const pitch = 10
    const sw = pitch * 0.5
    const n = mulberry32(5)
    for (let pass = 0; pass < 2; pass++) {
      c.strokeStyle = pass === 0 ? css(P.stitch, 0.55) : css(P.blanketHi, 0.7)
      c.lineWidth = pass === 0 ? 1.6 : 1.1
      c.lineCap = 'round'
      c.beginPath()
      const oy = pass === 0 ? 0.8 : -0.4
      for (let y = -pitch; y < h + pitch; y += pitch * 0.72) {
        for (let x = -pitch; x < w + pitch; x += pitch) {
          const jx = (n() - 0.5) * 0.6
          const jy = (n() - 0.5) * 0.6
          const cx = x + jx
          const cy = y + jy + oy
          c.moveTo(cx - sw * 0.5, cy - sw * 0.45)
          c.quadraticCurveTo(cx - sw * 0.35, cy + sw * 0.15, cx - 0.4, cy + sw * 0.45)
          c.moveTo(cx + sw * 0.5, cy - sw * 0.45)
          c.quadraticCurveTo(cx + sw * 0.35, cy + sw * 0.15, cx + 0.4, cy + sw * 0.45)
        }
      }
      c.globalAlpha = 0.5
      c.stroke()
      c.globalAlpha = 1
    }
    // gentle fabric folds
    const nz = mulberry32(11)
    for (let k = 0; k < 7; k++) {
      const x = nz() * w
      const y = nz() * h
      const r = (0.3 + nz() * 0.5) * Math.max(w, h)
      const g = c.createRadialGradient(x, y, 0, x, y, r)
      const dark = k % 2 === 0
      g.addColorStop(0, dark ? 'rgba(120,90,60,0.06)' : 'rgba(255,248,236,0.08)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      c.fillStyle = g
      c.fillRect(0, 0, w, h)
    }
    // contact shadow under the cat
    const HW = this.HW
    const off = 20000
    c.save()
    c.shadowColor = css(P.shadow, 0.35)
    c.shadowBlur = 0.25 * HW * dpr
    c.shadowOffsetX = off * dpr
    c.setTransform(dpr * HW, 0, 0, dpr * HW, dpr * (this.ox + 0.05 * HW - off), dpr * (this.oy + 0.08 * HW))
    c.fillStyle = '#000'
    catSilhouette(this.defs, c)
    // tighter, darker contact core
    c.shadowColor = css(P.shadow, 0.3)
    c.shadowBlur = 0.05 * HW * dpr
    c.setTransform(dpr * HW * 0.985, 0, 0, dpr * HW * 0.985, dpr * (this.ox + 0.02 * HW - off), dpr * (this.oy + 0.035 * HW))
    catSilhouette(
      this.defs.filter((d) => d.id !== 'head' && d.id !== 'earL' && d.id !== 'earR'),
      c,
    )
    c.restore()
    // vignette
    const vg = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6)
    vg.addColorStop(0, 'rgba(107,84,64,0)')
    vg.addColorStop(1, 'rgba(107,84,64,0.25)')
    c.fillStyle = vg
    c.fillRect(0, 0, w, h)
    this.blanket = cv
  }

  // ---------- transforms (cat space) ----------

  headM(): Mat {
    return mul(tr(HEAD_C[0] + this.headX.x, HEAD_C[1] + this.headY.x), rot(HEAD_ROT + this.headR.x))
  }
  earM(side: -1 | 1): Mat {
    const i = side < 0 ? 0 : 1
    const tilt = side * (EAR.tilt + (side < 0 ? EAR.extraLeft : 0))
    const fold = this.earFold[i].x
    const twitch = this.twitchT >= 0 && this.twitchSide === side ? this.twitchAngle() : 0
    const relax = 8 * D2R * Math.max(0, Math.min(1, this.happy.x))
    const r = tilt + side * (fold * 0.55 + relax) + this.earTurn[i].x + side * twitch
    return mul(this.headM(), mul(tr(side * EAR.x, EAR.y + fold * 0.03), mul(rot(r), scl(1 - fold * 0.12, 1 - fold * 0.55))))
  }
  torsoM(): Mat {
    const b = this.breathAmp * (0.5 - 0.5 * Math.cos(this.breath * Math.PI * 2))
    const px = 0.35
    const py = -0.76
    return mul(tr(px + this.slideX.x * 0.5, py + this.slideY.x * 0.5), mul(scl(1 + b * 0.25, 1 + b), tr(-px, -py)))
  }
  legM(): Mat {
    const b = this.breathAmp * 0.4 * (0.5 - 0.5 * Math.cos(this.breath * Math.PI * 2))
    return mul(tr(0, -0.4), mul(scl(1, 1 + b), tr(0, 0.4)))
  }
  tailTipM(): Mat {
    const j = tailCurve.at(TAIL_JOINT).p
    const sway = 8 * D2R * Math.sin((this.t / 3.5) * Math.PI * 2)
    return mul(tr(j[0], j[1]), mul(rot(sway * 0.6), tr(-j[0], -j[1])))
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
        return this.torsoM()
      case 'thigh':
        return mul(this.torsoM(), tr(0, 0))
      case 'legNear':
      case 'legFar':
        return this.legM()
      case 'tailB':
        return this.tailTipM()
      default:
        return [1, 0, 0, 1, 0, 0]
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

  // ---------- simulation ----------

  /** dt seconds. touches in css px. breathPhase from the purr when purring (else null). */
  update(dt: number, touches: Touch[], pointer: { x: number; y: number } | null, breathPhase: number | null) {
    this.t += dt
    // breathing
    if (breathPhase !== null) this.breath = breathPhase
    else this.breath = (this.breath + dt / 2.4) % 1

    // contact & zones
    let zone: Zone = 'none'
    let side = 0
    let leanTo: [number, number] | null = null
    let slide: [number, number] = [0, 0]
    this.finger.on = false
    for (const tch of touches) {
      const h = this.hit(tch.x, tch.y)
      if (!h) continue
      this.finger = { x: tch.x, y: tch.y, on: true }
      const [cx, cy] = this.toCat(tch.x, tch.y)
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
      if (sp > 0.01) slide = [(cvx / sp) * Math.min(0.02, sp * 0.004), (cvy / sp) * Math.min(0.02, sp * 0.004)]
      let z: Zone = 'body'
      if (h.id === 'head' || h.id === 'earL' || h.id === 'earR') {
        let lx = h.lx
        let ly = h.ly
        if (h.id !== 'head') {
          const [hx, hy] = apply(inv(this.headM()), cx, cy)
          lx = hx
          ly = hy
        }
        if (h.id !== 'head' || ly < -0.1) z = 'top'
        else if (ly > 0.3) z = 'chin'
        else if (Math.abs(lx) > 0.2) z = 'cheek'
        else if (ly > 0.12) z = 'nose'
        else z = 'top'
        side = lx < 0 ? -1 : 1
        if (z === 'cheek') leanTo = [cx, cy]
      }
      const rank = (q: Zone) => ['none', 'body', 'nose', 'top', 'cheek', 'chin'].indexOf(q)
      if (rank(z) > rank(zone)) zone = z
    }
    this.contact = this.finger.on ? 0 : this.contact + dt
    if (zone !== 'none') {
      this.zone = zone
      this.zoneSide = side
    } else if (this.contact > 0.3) this.zone = 'none'

    const rate = { chin: 0.3, cheek: 0.25, top: 0.2, nose: 0, body: 0, none: 0 }[this.finger.on ? zone : 'none']
    if (rate > 0) this.bliss = Math.min(1, this.bliss + rate * dt)
    else if (!this.finger.on) this.bliss = Math.max(0, this.bliss - 0.05 * dt)

    // grooming decay
    for (const g of this.grooms.values()) g.decay(dt)

    // reactions
    const z = this.zone
    let hx = 0
    let hy = 0
    let hr = 0
    let lk = 0
    let lid = 0.9
    let happy = 0
    const fold = [0, 0]
    const sq = [0, 0]
    if (z === 'chin') {
      // head lifts and tilts back, neck extends, eyes close to happy arcs
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
      lid = 0.85
      if (this.bliss > 0.55) happy = 1
    } else if (z === 'cheek') {
      hr = this.zoneSide * 10 * D2R
      if (this.bliss > 0.55) happy = 1
    } else if (z === 'top') {
      lid = 0.5
      // fold the ears; the one under the finger most
      fold[0] = this.zoneSide <= 0 ? 1 : 0.6
      fold[1] = this.zoneSide >= 0 ? 1 : 0.6
      if (this.finger.on) {
        const [fx] = apply(inv(this.headM()), ...this.toCat(this.finger.x, this.finger.y))
        if (Math.abs(fx) < 0.12) fold[0] = fold[1] = 1
      }
    }
    this.headX.step(hx + this.slideX.x * 0.4, dt)
    this.headY.step(hy + this.slideY.x * 0.4, dt)
    this.headR.step(hr, dt)
    this.look.step(lk, dt)
    this.happy.step(happy, dt)
    this.lidBase.step(lid, dt)
    this.slideX.step(slide[0], dt)
    this.slideY.step(slide[1], dt)
    for (let i = 0; i < 2; i++) {
      const f = this.earFold[i]
      // fold fast (90 ms), spring back with overshoot (220 ms)
      if (fold[i] > f.x) f.step(fold[i], dt, 1400, 75)
      else f.step(fold[i], dt, 300, 13)
      this.squint[i].step(sq[i], dt)
    }

    // ears and pupils follow the pointer
    const tgtPupil: [number, number] = [0, 0]
    const turn = [0, 0]
    if (pointer) {
      const [pcx, pcy] = this.toCat(pointer.x, pointer.y)
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

    // blinks
    let blink = 1
    if (this.blinkT >= 0) {
      this.blinkT += dt
      const t = this.blinkT
      blink = t < 0.08 ? 1 - t / 0.08 : Math.min(1, (t - 0.08) / 0.12)
      if (t > 0.2) this.blinkT = -1
    } else if (this.t > this.blinkAt) {
      this.blinkT = 0
      this.blinkAt = this.t + 4 + this.rnd() * 5
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
    } else if (this.bliss > 0.5 && this.t > this.slowBlinkAt && this.happy.x < 0.3) {
      this.slowBlinkT = 0
      this.slowBlinks++
      this.slowBlinkAt = this.t + 6 + this.rnd() * 4
      this.onSlowBlink?.()
    } else if (this.bliss <= 0.5) this.slowBlinkAt = Math.max(this.slowBlinkAt, this.t + 2)

    // ear twitch
    if (this.twitchT >= 0) {
      this.twitchT += dt
      if (this.twitchT > 0.2) this.twitchT = -1
    } else if (this.t > this.twitchAt) {
      this.twitchT = 0
      this.twitchSide = this.rnd() < 0.5 ? -1 : 1
      this.twitchAt = this.t + 8 + this.rnd() * 12
    }

    const f = this.face
    const lb = Math.max(0, Math.min(1, this.lidBase.x))
    f.open = [Math.min(lb, blink) * (1 - this.squint[0].x * 0.35), Math.min(lb, blink) * (1 - this.squint[1].x * 0.35)]
    f.squint = [this.squint[0].x, this.squint[1].x]
    f.happy = smoothstep(0.15, 0.85, this.happy.x)
    f.pupil = [this.pupil[0], this.pupil[1]]
    f.pupilSize = 0.7 + 0.15 * this.bliss
    f.look = Math.max(0, this.look.x)
    f.padPush = this.squint[0].x + this.squint[1].x > 0.1 ? 1 : 0
    f.whisk = this.twitchT >= 0 ? 0.05 : 0
  }

  // ---------- drawing ----------

  draw(ctx: CanvasRenderingContext2D, fingerShadow: boolean) {
    const dev = this.dev()
    const unit = this.dpr * this.HW
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (this.blanket) ctx.drawImage(this.blanket, 0, 0)
    const sprite = (id: PartId) => {
      const sp = this.sprite(id)
      const m = mul(dev, this.partM(id))
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      ctx.drawImage(sp.cv, sp.x0, sp.y0, sp.bw, sp.bh)
      return m
    }
    const tufts = (id: PartId, m: Mat) => {
      const layer = this.layers.get(id)
      if (!layer || !this.o.fur) return
      if (!layer.matched && this.baker.done) {
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
    sprite('tailA')
    sprite('tailB')
    sprite('footFar')
    timed('torso', sprite('torso'))
    timed('thigh', sprite('thigh'))
    sprite('footNear')
    sprite('legFar')
    sprite('chest')
    sprite('legNear')
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
    timed('head', hm)
    ctx.setTransform(hm[0], hm[1], hm[2], hm[3], hm[4], hm[5])
    const px = 1 / this.HW
    drawFace(ctx, this.face, px)
    drawWhiskers(ctx, this.face, px)
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
