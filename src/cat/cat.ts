// The cat: rig state, reactions (Phase 1: head zones), rendering of all parts in order.

import { Baker, type Sprite } from './bake'
import { drawFace, drawWhiskers, restFace, type FaceState } from './face'
import { mulberry32, smoothstep, type Rng } from './noise'
import { P, css } from './palette'
import { D2R, EAR, EXTENT, EYE, HEAD_C, HEAD_ROT, type Mat, type PartDef, type PartId, TAIL_JOINT, apply, buildRig, catSilhouette, inv, mul, rot, scl, tailCurve, tr } from './rig'
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

/** resting eye openness: sleepy-content, upper lid about 45 % down */
const REST_LID = 0.5

const TUFT_PARTS: PartId[] = ['head', 'torso', 'thigh']
const HIT_ORDER: PartId[] = ['head', 'earL', 'earR', 'legNear', 'chest', 'legFar', 'tailB', 'footNear', 'thigh', 'torso', 'tailA']

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
            ? covers(['head', 'legNear', 'legFar', 'chest', 'thigh', 'footNear', 'tailB'])
            : covers(['footNear', 'tailB'])
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
    const cx = this.ox + HW * -0.12
    const rw = Math.min(w * 1.02, HW * 3.8)
    // stays clear of the hint line at the bottom
    const y0 = Math.max(h * 0.02, this.oy - HW * 1.42)
    const y1 = Math.min(h - 74, this.oy + HW * 1.78)
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
        const e = 0.72
        const wob = 1 + 0.004 * Math.sin(th * 3 + 1.3) + 0.003 * Math.sin(th * 7 + 0.4)
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
    // rug drop shadow on the sofa (it has some thickness)
    c.save()
    c.shadowColor = css(P.shadow, 0.28)
    c.shadowBlur = 0.12 * HW * dpr
    c.shadowOffsetY = 0.04 * HW * dpr
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
    // ribbed edge: darker, rounded-over border band with a highlight on its crest
    const edge = 0.14 * HW
    c.lineJoin = 'round'
    c.strokeStyle = css(P.rugDark, 0.45)
    c.lineWidth = edge * 2
    c.stroke(rugPath())
    c.strokeStyle = css(P.rugHi, 0.35)
    c.lineWidth = 2.2
    c.stroke(rugPath(-edge * 0.95))
    c.strokeStyle = css(P.shadow, 0.18)
    c.lineWidth = 1.5
    c.stroke(rugPath(-edge * 1.08))
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
    fold(r.x0 + (r.x1 - r.x0) * 0.42, r.y1 + 4, r.x1 + 4, r.y0 + (r.y1 - r.y0) * 0.62, r.x0 + (r.x1 - r.x0) * 0.86, r.y1 - (r.y1 - r.y0) * 0.1, 0.2 * HW, 0.3)
    fold(r.x0 - 4, r.y0 + (r.y1 - r.y0) * 0.3, r.x0 + (r.x1 - r.x0) * 0.32, r.y0 - 4, r.x0 + (r.x1 - r.x0) * 0.1, r.y0 + (r.y1 - r.y0) * 0.08, 0.12 * HW, 0.14)
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
    return mul(tr(HEAD_C[0] + this.headX.x, HEAD_C[1] + this.headY.x), rot(HEAD_ROT + this.headR.x))
  }
  earM(side: -1 | 1): Mat {
    const i = side < 0 ? 0 : 1
    const tilt = side * (EAR.tilt + (side < 0 ? EAR.extraLeft : 0))
    const fold = this.earFold[i].x
    const twitch = this.twitchT >= 0 && this.twitchSide === side ? this.twitchAngle() : 0
    const relax = 8 * D2R * Math.max(0, Math.min(1, this.happy.x))
    const r = tilt + side * (fold * 0.4 + relax) + this.earTurn[i].x + side * twitch
    return mul(this.headM(), mul(tr(side * EAR.x, EAR.y + fold * 0.03), mul(rot(r), scl(1 - fold * 0.12, 1 - fold * 0.55))))
  }
  torsoM(): Mat {
    const b = this.breathAmp * (0.5 - 0.5 * Math.cos(this.breath * Math.PI * 2))
    // the belly rests on the blanket: breathing lifts the back, the ground line stays put
    const px = 0.35
    const py = 0.6
    return mul(tr(px + this.slideX.x * 0.5, py + this.slideY.x * 0.5), mul(scl(1 + b * 0.25, 1 + b), tr(-px, -py)))
  }
  tailTipM(): Mat {
    const j = tailCurve.at(TAIL_JOINT).p
    // the wrapped tail lies on the blanket: only a faint drift
    const sway = 1.2 * D2R * Math.sin((this.t / 3.5) * Math.PI * 2)
    return mul(tr(j[0], j[1]), mul(rot(sway), tr(-j[0], -j[1])))
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
      if (!this.has(id)) continue
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
    let lid = REST_LID
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
      lid = 0.42
      if (this.bliss > 0.55) happy = 1
    } else if (z === 'cheek') {
      hr = this.zoneSide * 10 * D2R
      if (this.bliss > 0.55) happy = 1
    } else if (z === 'top') {
      // half-lidded but content: both lids close in a little (a relaxed squint, not a glare)
      lid = 0.4
      // the ear the finger passes over folds flat; the other stays up
      if (this.finger.on) {
        const [fx, fy] = apply(inv(this.headM()), ...this.toCat(this.finger.x, this.finger.y))
        for (let i = 0; i < 2; i++) {
          const ex = (i === 0 ? -1 : 1) * EAR.x
          const d = Math.hypot(fx - ex, fy - (EAR.y - 0.08))
          fold[i] = 0.85 * (1 - smoothstep(0.1, 0.3, d))
        }
      }
    }
    this.headX.step(hx + this.slideX.x * 0.4, dt)
    this.headY.step(hy + this.slideY.x * 0.4, dt)
    this.headR.step(hr, dt)
    this.look.step(lk, dt)
    this.happy.step(happy, dt)
    // noticing: the eyes open wide when a finger first appears, then settle back to sleepy
    if (pointer || this.finger.on) {
      if (this.t - this.ptrSeenAt > 1.5) this.noticeT = 0
      this.ptrSeenAt = this.t
    }
    let notice = 0
    if (this.noticeT >= 0) {
      this.noticeT += dt
      const t = this.noticeT
      notice = t < 0.15 ? t / 0.15 : t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 1.1)
      if (t > 1.8) this.noticeT = -1
    }
    if (notice > 0 && z !== 'chin') lid = lid + (1 - lid) * notice
    if (notice > 0) this.lidBase.step(lid, dt, 400, 40)
    else this.lidBase.step(lid, dt)
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
    } else if (this.bliss <= 0.5 && !this.finger.on && notice === 0 && this.t > this.restSlowAt) {
      // at rest, an occasional slow blink (cat for "I trust you")
      this.slowBlinkT = 0
      this.restSlowAt = this.t + 9 + this.rnd() * 6
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
    // sleepy-content: a little lower-lid lift whenever the eyes are heavy (not when wide awake)
    const restSq = 0.6 * smoothstep(0.85, 0.6, lb) * (1 - f.happy)
    f.squint = [Math.max(this.squint[0].x, restSq), Math.max(this.squint[1].x, restSq)]
    f.happy = smoothstep(0.15, 0.85, this.happy.x)
    f.pupil = [this.pupil[0], this.pupil[1]]
    f.pupilSize = 0.66 + 0.15 * this.bliss + 0.14 * notice
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
    this.matchedThisFrame = false
    const sprite = (id: PartId) => {
      if (!this.has(id)) return null
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
    for (const d of this.defs) {
      if (d.id === 'earL' || d.id === 'earR' || d.id === 'head') continue
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
