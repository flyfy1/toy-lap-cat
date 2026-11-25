// Lap Cat: the cat on its blanket, petting input, purr + haptic purr, one-shot sounds, the monologue and the session counters.
// Debug params (kept in production, harmless): ?pose=rest|bliss|chin|sleep|stretch|belly|trap|irk|swat|knead|groom|yawn|glass
// ?t=<s> (freeze the clock) ?seed=<n> ?fur=0 ?stats=1 ?purr=synth|rec ?stroke=1

import { audio, type Hiss, type Purr } from './engine/AudioEngine'
import { haptic, runLoop } from './engine/juice'
import { Cat, type CatEvent, type Touch } from './cat/cat'
import { COAT } from './cat/palette'
import { HEAD_C, HEAD_ROT, apply, mul, rot, spine, tr } from './cat/rig'
import type { Key } from './i18n'
import type { Hand } from './hand'

/** Counters for the cat-tax receipt (this session). */
export interface CatStats {
  pets: number
  petSec: number
  purrSec: number
  blissSec: number
  biscuits: number
  traps: number
  granted: number
  swats: number
  irks: number
}

export interface GameHooks {
  onFirst(): void
  /** a monologue line (already rate-limited) */
  onLine(key: Key): void
  /** a glass went off the table: show the smash chip */
  onGlass(): void
  onAsleep(asleep: boolean): void
  /** analytics-worthy moments (numbers only) */
  onTrack(event: string, params?: Record<string, number>): void
}

export interface GameApi {
  dispose(): void
  stats: CatStats
  /** staff rating 1..5 in half steps */
  rating(): number
  /** a copy of the blanket and cat, cropped to the rug */
  snapshot(): HTMLCanvasElement
  /** css px y of the line under the cat (for the monologue) */
  lineY(): number
}

const LINE_GAP = 2500

interface Ptr {
  x: number
  y: number
  vx: number
  vy: number
  t: number
  type: string
  down: boolean
}

type W = Window & { __cat?: Record<string, unknown> }

const STROKE_T = 2.7

export function startGame(canvas: HTMLCanvasElement, hooks: GameHooks, keep?: CatStats): GameApi {
  const q = new URLSearchParams(location.search)
  const og = q.get('og') === '1'
  const pose = q.get('pose') ?? (og ? 'bliss' : 'rest')

  const seed = Math.max(1, parseInt(q.get('seed') || '1', 10) || 1)
  const fur = q.get('fur') !== '0'
  // ?stats=1: the perf overlay (a lazy debug chunk)
  let dbgDraw: typeof import('./cat/debug').drawStats | null = null
  if (q.get('stats') === '1') import('./cat/debug').then((m) => (dbgDraw = m.drawStats))
  const purrMode = q.get('purr') === 'rec' ? 'rec' : 'synth'
  const stroke = q.get('stroke') === '1'
  // ?t may be negative with ?stroke=1 (the canned stroke runs from -STROKE_T to 0)
  const freezeAt = og && !q.has('t') ? 1 : q.has('t') ? Math.max(stroke ? -STROKE_T : 0, parseFloat(q.get('t') || '0') || 0) : null

  const tStart = performance.now()
  const ctx = canvas.getContext('2d', { alpha: false })!
  const cat = new Cat({ seed, fur })
  if (q.get('bones') === '1') import('./cat/debug').then((m) => (cat.bones = m.drawBones))
  cat.noTufts = q.get('tufts') === '0'
  let w = 0
  let h = 0
  let dpr = 1
  let dprCap = 2
  const resize = (keepBake = false) => {
    dpr = Math.min(window.devicePixelRatio || 1, dprCap)
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    cat.layout(w, h, dpr, keepBake)
  }
  resize()
  const tLayout = performance.now() - tStart
  const onResize = () => resize()
  window.addEventListener('resize', onResize)
  const noMenu = (e: Event) => e.preventDefault()
  canvas.addEventListener('contextmenu', noMenu)
  // the mouse hand (lazy): the real cursor is hidden only while the hand is drawn; reduced motion keeps a static grab cursor
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  let hand: Hand | null = null
  let handReq = false
  const loadHand = () => {
    if (handReq || still || og) return
    handReq = true
    import('./hand').then((m) => (hand = new m.Hand()), () => {})
  }
  if (matchMedia('(pointer: fine)').matches) loadHand()
  let cursor = ''
  const setCursor = (c: string) => {
    if (c !== cursor) canvas.style.cursor = cursor = c
  }

  const dbg: Record<string, unknown> = { ready: false, pose, frozen: freezeAt !== null, tufts: cat.tuftCount, cat, audio }
  // rest-pose geometry for test harnesses (head centre and rotation in cat space)
  dbg.geo = { hc: HEAD_C, hr: HEAD_ROT }
  dbg.startGame = [Math.round(tStart), Math.round(tLayout)]
  ;(window as W).__cat = dbg

  // ---------- scripted fingers (poses and the canned stroke) ----------
  const restHead = mul(tr(HEAD_C[0], HEAD_C[1]), rot(HEAD_ROT))
  const headPt = (lx: number, ly: number) => {
    const [cx, cy] = apply(restHead, lx, ly)
    return { x: cat.ox + cx * cat.HW, y: cat.oy + cy * cat.HW }
  }
  const catPt = (cx: number, cy: number) => ({ x: cat.ox + cx * cat.HW, y: cat.oy + cy * cat.HW })
  if (pose === 'bliss') cat.bliss = 1
  if (pose === 'chin') cat.bliss = 0.9
  // Phase 2 poses: inject the state directly (screenshots and tests)
  if (pose === 'sleep') {
    cat.fallAsleep()
    cat.sleepPose.x = 1
  }
  if (pose === 'stretch') cat.wakeT = 0.4
  if (pose === 'belly' || pose === 'trap') {
    cat.bliss = 1
    cat.belly = pose === 'trap' ? 'trap' : 'invite'
    cat.openP = 1
    cat.roll.x = 1
    if (pose === 'trap') {
      cat.trapAt = cat.toCat(catPt(0.1, 0.36).x, catPt(0.1, 0.36).y)
      cat.startTrap(9)
    }
  }
  // the invite transition played from the rest pose (and, with &trap=1, a finger landing at t = 1.0)
  const inviteTrap = pose === 'invite' && q.get('trap') === '1'
  if (pose === 'invite') {
    cat.bliss = 1
    cat.belly = 'invite'
    cat.bellyCool = 1e9
    cat.forceTrap = inviteTrap
    // the face already in its bliss state at t = 0 (in play the pupils widen during the stroking before)
    cat.face.pupilSize = 0.81
  }
  if (pose === 'paw') cat.pawHoldForce = true
  if (pose === 'idle') cat.idleShiftAt = 0.5
  if (pose === 'irk') cat.irk = 0.78
  if (pose === 'swat') cat.irk = 1
  if (pose === 'knead') {
    cat.bliss = 1
    cat.kneadHighT = 5.1
  }
  if (pose === 'groom') {
    cat.groomT = 0
    cat.groomDur = 99
  }
  if (pose === 'yawn') cat.yawnT = 0
  if (pose === 'glass') cat.idleT = 19.5
  const POSED = ['sleep', 'stretch', 'belly', 'trap', 'irk', 'swat', 'knead', 'groom', 'yawn', 'glass', 'invite', 'paw', 'idle'].includes(pose)
  if (POSED) {
    // no surprise slow blinks or grooming in a posed screenshot
    cat.restSlowAt = 1e9
    cat.groomAt = pose === 'groom' ? 0 : 1e9
  }
  /** Virtual finger at sim time t (s), or null. */
  const scripted = (t: number): Touch | null => {
    if (pose === 'bliss' || pose === 'chin') {
      const base = pose === 'bliss' ? headPt(-0.4, 0.14) : headPt(0.02, 0.4)
      // a slow little scritch
      const r = 0.02 * cat.HW
      const a = t * 5
      return { x: base.x + Math.cos(a) * r, y: base.y + Math.sin(a) * r * 0.6, vx: -Math.sin(a) * r * 5, vy: Math.cos(a) * r * 3 }
    }
    if (pose === 'trap' || pose === 'belly') return pose === 'trap' ? { ...catPt(0.1, 0.36), vx: 0, vy: 0 } : null
    if (inviteTrap) return t >= 1.0 && t < 3.2 ? { ...catPt(0.1, 0.36), vx: 0, vy: 0 } : null
    if (pose === 'paw') return t > 0.2 ? { ...catPt(-0.84, 0.2), vx: 0, vy: 0 } : null
    if (pose === 'swat') return { ...headPt(-0.3, 0.3), vx: 0, vy: 0 }
    if (pose === 'irk') {
      // fur stroked the wrong way, over and over
      const k = (t * 0.8) % 1
      const a = catPt(0.95 - 0.9 * k, -0.18 + 0.2 * k)
      return { ...a, vx: -0.9 * 0.8 * cat.HW, vy: 0.2 * 0.8 * cat.HW }
    }
    if (pose === 'knead') {
      const base = headPt(0.02, 0.4)
      const r = 0.02 * cat.HW
      const a = t * 5
      return { x: base.x + Math.cos(a) * r, y: base.y + Math.sin(a) * r * 0.6, vx: -Math.sin(a) * r * 5, vy: Math.cos(a) * r * 3 }
    }
    if (!stroke || t >= 0 || t < -STROKE_T) return null
    // three passes, ending at t = 0: against the grain on the flank, then with the grain on the head and the back
    const seg = (t0: number, t1: number, a: { x: number; y: number }, b: { x: number; y: number }): Touch | null => {
      if (t < t0 || t > t1) return null
      const u = (t - t0) / (t1 - t0)
      const e = u * u * (3 - 2 * u)
      const de = 6 * u * (1 - u)
      const dur = t1 - t0
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, vx: ((b.x - a.x) * de) / dur, vy: ((b.y - a.y) * de) / dur }
    }
    // a lane that follows the spine at a fixed depth into the body, from u0 to u1
    const lane = (t0: number, t1: number, u0: number, u1: number, depth: number): Touch | null => {
      if (t < t0 || t > t1) return null
      const k = (t - t0) / (t1 - t0)
      const e = k * k * (3 - 2 * k)
      const at = (u: number) => {
        const { p, t: tg } = spine.at(u)
        return catPt(p[0] - tg[1] * depth, p[1] + tg[0] * depth)
      }
      const a = at(u0 + (u1 - u0) * e)
      const b = at(u0 + (u1 - u0) * Math.min(1, e + 0.01))
      const sp = (6 * k * (1 - k)) / (t1 - t0) / 0.01 + 1e-6
      return { x: a.x, y: a.y, vx: (b.x - a.x) * sp, vy: (b.y - a.y) * sp }
    }
    return lane(-2.7, -1.95, 0.7, 0.12, 0.3) ?? seg(-1.75, -1.15, headPt(0.02, -0.02), headPt(0.06, -0.4)) ?? lane(-0.95, -0.05, 0.1, 0.68, 0.2)
  }

  dbg.scripted = scripted

  // ---------- input ----------
  const ptrs = new Map<number, Ptr>()
  let started = false
  let firstEvt = 0
  let handlerAt = 0
  let reactionPending = false
  let purr: Purr | null = null
  let hiss: Hiss | null = null
  let lastVibe = 0
  let vibing = false

  const startAudio = () => {
    const a = performance.now()
    audio.unlock()
    if (dbg.unlockMs === undefined) dbg.unlockMs = performance.now() - a
  }
  /** Voices are built on the frame after the unlock, so the first touch is never delayed by them. */
  const ensureVoices = () => {
    if (!purr && audio.ctx) {
      purr = purrMode === 'rec' ? audio.purrRec() : audio.purrSynth()
      hiss = audio.hiss()
    }
  }
  const stopVibe = () => {
    if (vibing) haptic(0)
    vibing = false
  }
  const markFirst = (e: PointerEvent) => {
    if (!cat.hit(e.clientX, e.clientY)) return
    if (!started) {
      started = true
      hooks.onFirst()
    }
    if (!dbg.firstReactionMs && !reactionPending) {
      reactionPending = true
      firstEvt = e.timeStamp
      dbg.firstEvtQueueMs = performance.now() - e.timeStamp
      handlerAt = performance.now()
      dbg.firstEvtType = e.type
    }
  }
  const onDown = (e: PointerEvent) => {
    startAudio()
    canvas.setPointerCapture?.(e.pointerId)
    if (ptrs.size >= 2 && !ptrs.has(e.pointerId)) return
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, vx: 0, vy: 0, t: e.timeStamp, type: e.pointerType, down: true })
    if (e.pointerType !== 'touch') loadHand()
    markFirst(e)
  }
  const onMove = (e: PointerEvent) => {
    let p = ptrs.get(e.pointerId)
    if (!p) {
      if (e.pointerType === 'touch' || ptrs.size >= 2) return
      p = { x: e.clientX, y: e.clientY, vx: 0, vy: 0, t: e.timeStamp, type: e.pointerType, down: false }
      ptrs.set(e.pointerId, p)
    }
    const dt = Math.max(0.004, (e.timeStamp - p.t) / 1000)
    const vx = (e.clientX - p.x) / dt
    const vy = (e.clientY - p.y) / dt
    p.vx = p.vx * 0.4 + vx * 0.6
    p.vy = p.vy * 0.4 + vy * 0.6
    p.x = e.clientX
    p.y = e.clientY
    p.t = e.timeStamp
    // a mouse pets only while its button is held; with the button up the hand hovers
    if (p.down) markFirst(e)
    else loadHand()
  }
  const onUp = (e: PointerEvent) => {
    const p = ptrs.get(e.pointerId)
    if (!p) return
    if (p.type === 'touch') ptrs.delete(e.pointerId)
    else p.down = false
    stopVibe()
  }
  const onLeave = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') ptrs.delete(e.pointerId)
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('pointerleave', onLeave)
  let hiddenAt = 0
  const onVis = () => {
    calm.length = 0
    calmSince = performance.now()
    if (!document.hidden && hiddenAt && performance.now() - hiddenAt >= 30000) cat.fallAsleep()
    hiddenAt = document.hidden ? performance.now() : 0
    if (document.hidden) {
      stopVibe()
      haptic(0)
      purr?.set(0)
      hiss?.set(0)
    }
  }
  document.addEventListener('visibilitychange', onVis)

  // ---------- events: sounds, haptics, counters, monologue ----------
  const stats: CatStats = keep ?? { pets: 0, petSec: 0, purrSec: 0, blissSec: 0, biscuits: 0, traps: 0, granted: 0, swats: 0, irks: 0 }
  const vibe = (p: number | number[]) => {
    if (!audio.muted && freezeAt === null) haptic(p)
  }
  let lineAt = -1e9
  let lineKey: Key | null = null
  let pending: { key: Key; prio: number } | null = null
  const said = new Set<Key>()
  /** prio 2: event lines (shown as soon as the gap allows, replacing a waiting mood line); 1: mood lines */
  const say = (key: Key, prio = 1) => {
    if (key === lineKey) return
    if (!pending || prio >= pending.prio) pending = { key, prio }
  }
  const flushLine = (nowMs: number) => {
    if (!pending || nowMs - lineAt < LINE_GAP) return
    lineKey = pending.key
    pending = null
    lineAt = nowMs
    said.add(lineKey)
    hooks.onLine(lineKey)
  }
  let blissRun = 0
  let blissMaxSent = 0
  cat.onEvent = (e: CatEvent, n: number) => {
    switch (e) {
      case 'pet':
        stats.pets++
        break
      case 'boop':
        vibe(8)
        audio.tone({ freq: 1400, freqEnd: 1900, dur: 0.05, gain: 0.03 })
        say('cat_boop', 2)
        break
      case 'sneeze':
        audio.sneeze()
        break
      case 'beans':
      case 'beans_hold':
        say('cat_beans', 2)
        break
      case 'tail':
        say('cat_tail', 2)
        break
      case 'tailbase':
        say('cat_continue')
        break
      case 'grain':
        say('cat_grain', 2)
        break
      case 'rough':
        say('cat_rough', 2)
        break
      case 'belly_no':
        say('cat_belly_no', 2)
        break
      case 'belly_invite':
        hooks.onTrack('belly_invite')
        break
      case 'trap':
        stats.traps++
        vibe([30, 40, 30, 40, 30, 40, 30])
        purr?.set(0)
        say('cat_trap', 3)
        hooks.onTrack('belly_trap', { n: stats.traps })
        break
      case 'kick':
        audio.thump(0.12)
        break
      case 'release':
        say('cat_noted', 2)
        break
      case 'granted':
        stats.granted++
        say('cat_granted', 3)
        hooks.onTrack('belly_granted', { n: stats.granted })
        break
      case 'warn04':
        stats.irks++
        say('cat_warn', 2)
        break
      case 'warn07':
        stopVibe()
        break
      case 'purr_cut':
        purr?.cut()
        break
      case 'swat':
        stats.swats++
        audio.swat()
        vibe(12)
        say('cat_warned', 3)
        hooks.onTrack('swat', { n: stats.swats })
        break
      case 'thump':
        audio.thump()
        break
      case 'knead_start':
        say('cat_knead', 2)
        hooks.onTrack('knead_start')
        break
      case 'biscuit':
        stats.biscuits++
        if (cat.finger.on) vibe(6)
        audio.thump(0.04)
        break
      case 'knead_end':
        hooks.onTrack('biscuits', { n })
        break
      case 'slow_blink':
        if (!said.has('cat_blink')) say('cat_blink', 2)
        hooks.onTrack('slow_blink')
        break
      case 'sleep':
        say('cat_zzz', 3)
        hooks.onAsleep(true)
        hooks.onTrack('sleep')
        break
      case 'wake':
        say('cat_awake', 3)
        hooks.onAsleep(false)
        hooks.onTrack('wake', { slept_s: n })
        break
      case 'trill':
        audio.trill()
        break
      case 'glass_push':
        audio.clink()
        break
      case 'glass_fall':
        audio.glassFall()
        say('cat_gravity', 3)
        hooks.onGlass()
        hooks.onTrack('glass_knocked', { n: ++glassN })
        break
      case 'zone':
        break
      case 'groom':
        break
    }
  }
  let glassN = 0
  /** mood lines while petting (the meter): what the cat thinks of the current spot */
  const moodLine = () => {
    if (!cat.finger.on || cat.asleep || cat.belly !== 'none' || cat.irkStage > 0) return
    const z = cat.zone
    if (!said.has('cat_coat_orange') && COAT.id === 'orange') return say('cat_coat_orange')
    if (!said.has('cat_coat_tux') && COAT.id === 'tux') return say('cat_coat_tux')
    if (!said.has('cat_coat_void') && COAT.id === 'void') return say('cat_coat_void')
    if (cat.bliss > 0.75 && purr && purr.level() > 0.3 && !said.has('cat_fridge')) return say('cat_fridge')
    if (z === 'chin' && cat.bliss > 0.4) return say('cat_there')
    if (z === 'earbase') return say('cat_ears')
    if (z === 'backWith') return say('cat_stretch')
    if (z === 'cheek') return say(cat.bliss > 0.5 ? 'cat_continue' : 'cat_left')
    if (z === 'top' || z === 'back' || z === 'chest') return say(cat.bliss > 0.6 ? 'cat_continue' : 'cat_ok')
  }
  const rating = () => {
    // bliss time earns, irritation costs; one swat is a whole star
    const r = 2 + Math.min(3, stats.blissSec / 25 + stats.granted * 0.5) - stats.swats * 1 - stats.irks * 0.25 + Math.min(0.5, stats.petSec / 120)
    return Math.max(1, Math.min(5, Math.round(r * 2) / 2))
  }

  // ---------- loop ----------
  let simT = stroke ? -STROKE_T : 0
  let frozen = false
  let fps = 60
  let workMs = 0
  const frames: number[] = []
  /** frames whose work exceeded 30 ms: [start, bake ms, rest ms] */
  const slow: number[][] = []
  dbg.slow = slow
  let lastNow = performance.now()
  let calmSince = 0
  const calm: number[] = []

  const step = (dt: number, nowMs: number) => {
    const touches: Touch[] = []
    let pointer: { x: number; y: number } | null = null
    const sc = scripted(simT)
    if (sc) {
      touches.push(sc)
      pointer = sc
    }
    let maxSpeed = 0
    let touchOnCat = false
    for (const p of ptrs.values()) {
      if (nowMs - p.t > 60) {
        p.vx *= 0.5
        p.vy *= 0.5
      }
      pointer = { x: p.x, y: p.y }
      if (p.down) {
        touches.push({ x: p.x, y: p.y, vx: p.vx, vy: p.vy })
        if (cat.hit(p.x, p.y)) {
          maxSpeed = Math.max(maxSpeed, Math.hypot(p.vx, p.vy))
          if (p.type === 'touch') touchOnCat = true
        }
      }
    }
    const phase = purr && purr.level() > 0.05 ? purr.phase() : null
    cat.update(dt, touches, pointer, phase)
    simT += dt
    if (cat.finger.on) stats.petSec += dt
    if (cat.bliss > 0.6) {
      stats.blissSec += dt
      blissRun += dt
    } else {
      if (blissRun >= 5 && blissRun > blissMaxSent) {
        blissMaxSent = blissRun
        hooks.onTrack('bliss_max', { seconds: Math.round(blissRun) })
      }
      blissRun = 0
    }
    if (cat.asleep) say('cat_zzz')
    else moodLine()
    flushLine(nowMs)
    // audio + haptics
    if (purr) {
      // bliss drives the level; touching a bliss zone gives an immediate audible floor
      const zoneOn = cat.finger.on && cat.irk < 0.4 && (cat.zone === 'chin' || cat.zone === 'cheek' || cat.zone === 'top' || cat.zone === 'earbase')
      // irritation thins the purr out; at 0.7 it stops (cut once by the ladder)
      const target = cat.irkStage >= 2 || cat.belly === 'trap' ? 0 : (zoneOn ? Math.max(0.6, cat.bliss) : cat.bliss) * (1 - 0.6 * Math.min(1, cat.irk / 0.7)) * (cat.asleep ? 0.5 : 1)
      purr.set(target)
      if (purr.level() > 0.2) {
        if (stats.purrSec === 0) hooks.onTrack('purr_start')
        stats.purrSec += dt
      }
      hiss?.set((maxSpeed / cat.HW) * (125 / 900))
      const lvl = purr.level()
      const now = performance.now()
      if (touchOnCat && lvl > 0.2 && !audio.muted) {
        const ph = purr.phase()
        const exhale = ph > 0.44
        if (now - lastVibe > 600 && (cat.bliss > 0.45 || exhale || !vibing)) {
          const on = cat.bliss < 0.45 ? 8 : cat.bliss < 0.75 ? 14 : 22
          const pat: number[] = []
          for (let i = 0; i < 15; i++) pat.push(on, 40 - on)
          haptic(pat)
          vibing = true
          lastVibe = now
        }
      } else if (vibing) stopVibe()
    }
  }

  let sleepAcc = 0
  const frame = (dtRaw: number) => {
    // (a mouse hand that moved in the last 1.5 s keeps the full frame rate)
    if (cat.asleep && freezeAt === null && cat.baker.done && ![...ptrs.values()].some((p) => p.down || (p.type !== 'touch' && performance.now() - p.t < 1500))) {
      // asleep: 20 fps is plenty for breathing and the drifting z
      sleepAcc += dtRaw
      if (sleepAcc < 0.05) return
      dtRaw = Math.min(0.1, sleepAcc)
    }
    sleepAcc = 0
    const now = performance.now()
    const delta = now - lastNow
    lastNow = now
    frames.push(delta)
    if (frames.length > 600) frames.shift()
    fps = fps * 0.9 + (1000 / Math.max(1, delta)) * 0.1
    const a = performance.now()
    cat.baker.step(started ? 4 : 8)
    const bakeSlice = performance.now() - a
    if (freezeAt !== null) {
      if (!frozen) {
        // fast-forward deterministically in fixed steps, then hold
        const DT = 1 / 60
        while (simT < freezeAt - 1e-6) step(Math.min(DT, freezeAt - simT), now)
        frozen = true
      }
    } else if (dtRaw > 0.034) {
      // a 20 fps sleep frame: two half steps keep the springs stable
      step(dtRaw / 2, now)
      step(dtRaw / 2, now)
    } else step(dtRaw, now)
    let mouse: Ptr | null = null
    for (const p of ptrs.values()) if (p.type !== 'touch') mouse = p
    cat.draw(ctx, !(hand && mouse))
    if (hand && mouse) dbg.hand = hand.frame(ctx, dpr, cat, mouse, delta / 1000)
    setCursor(hand && mouse ? 'none' : still ? (mouse?.down ? 'grabbing' : 'grab') : '')
    if (!reactionPending) ensureVoices()
    const work = performance.now() - a
    workMs = workMs * 0.9 + work * 0.1
    if (work > 30) slow.push([Math.round(a), Math.round(bakeSlice), Math.round(work - bakeSlice)])
    if (slow.length > 50) slow.shift()
    if (reactionPending) {
      reactionPending = false
      dbg.firstReactionMs = performance.now() - firstEvt
      dbg.handlerToFrameMs = performance.now() - handlerAt
    }
    // auto-degrade: average frame time over the last second above 20 ms (ignoring bake and start-up)
    if (freezeAt === null && !cat.half) {
      if (!cat.baker.done || document.hidden) {
        calmSince = now
        calm.length = 0
      } else if (now - calmSince > 500 && delta < 100) calm.push(delta)
      if (calm.length > 240) calm.shift()
      {
        let sum = 0
        let n = 0
        for (let i = calm.length - 1; i >= 0 && sum < 1000; i--) {
          sum += calm[i]
          n++
        }
        if (sum >= 1000 && sum / n > 20) {
          dbg.fpsBeforeDegrade = 1000 / (sum / n)
          cat.half = true
          dprCap = Math.min(dprCap, 1.5)
          resize(true)
          dbg.degraded = Math.round(now)
        }
      }
    }
    dbgDraw?.(ctx, dpr, cat, fps, workMs)
    if (!dbg.firstPaintMs) {
      dbg.firstPaintMs = performance.now()
    }
    // all part sprites exist (stand-ins at least): the cat is fully drawn and every part is pettable
    if (!dbg.allPartsMs && cat.baker.sprites.size === cat.defs.length) dbg.allPartsMs = performance.now()
    if (cat.baker.done && dbg.prepareAt === undefined) {
      // create the (suspended) audio context once the bake is done, so the first touch only resumes it
      dbg.prepareAt = 0
      // (the first AudioContext in a browser process costs a one-off native audio-device init that
      // cannot be split; do it right after the bake, so a first touch rarely has to pay it.
      // requestIdleCallback is no good here: with a running rAF loop it only fires on its timeout)
      const prep = () => {
        const a = performance.now()
        audio.prepare()
        dbg.prepareAt = [Math.round(a), Math.round(performance.now() - a), audio.buildMs]
      }
      setTimeout(prep, 30)
    }
    dbg.timings = cat.timings
    if (cat.baker.done && !dbg.ready) {
      dbg.ready = true
      dbg.bakeMs = cat.baker.bakeMs
      dbg.bakeDoneMs = cat.baker.doneAt
      dbg.strokes = cat.baker.totalStrokes
      dbg.maxJobMs = cat.baker.maxJobMs
      dbg.tufts = cat.tuftCount
    }
    dbg.fps = fps
    dbg.boneDev = cat.boneDevMax
    dbg.slices = cat.slices
    dbg.matchMs = cat.matchMs
    dbg.workMs = workMs
    dbg.tuftMs = cat.tuftMs
    dbg.bliss = cat.bliss
    dbg.zone = cat.zone
    dbg.frames = frames
    dbg.purr = purr ? { mode: purr.mode, level: purr.level(), phase: purr.phase() } : null
  }
  const stop = runLoop(frame)
  /** step the sim by dt seconds in 1/60 s steps and redraw (60 fps clips from a frozen page) */
  dbg.advance = (dt: number) => {
    let r = dt
    while (r > 1e-6) {
      const h = Math.min(1 / 60, r)
      step(h, performance.now())
      r -= h
    }
    cat.draw(ctx, true)
    dbg.boneDev = cat.boneDevMax
  }
  dbg.stats = stats

  return {
    stats,
    rating,
    lineY() {
      const r = cat.rugRect(w, h)
      return Math.min(h - 72, r.y1 + 0.1 * cat.HW + 14)
    },
    snapshot() {
      const r = cat.rugRect(w, h)
      const pad = 16
      const x0 = Math.max(0, r.x0 - pad)
      const y0 = Math.max(0, r.y0 - pad)
      const x1 = Math.min(w, r.x1 + pad)
      const y1 = Math.min(h, r.y1 + pad)
      // a clean frame: no finger shadow on the receipt
      cat.draw(ctx, false)
      const out = document.createElement('canvas')
      out.width = Math.round((x1 - x0) * dpr)
      out.height = Math.round((y1 - y0) * dpr)
      out.getContext('2d')!.drawImage(canvas, x0 * dpr, y0 * dpr, out.width, out.height, 0, 0, out.width, out.height)
      return out
    },
    dispose() {
      stop()
      canvas.style.cursor = ''
      purr?.stop()
      hiss?.stop()
      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('contextmenu', noMenu)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVis)
    },
  }
}
