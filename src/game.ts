// Lap Cat, Phase 1 spike: the cat at rest, head-zone petting, fur that combs, purr + haptic purr.
// Debug params (kept in production): ?pose=rest|bliss|chin ?t=<s> ?seed=<n> ?fur=0 ?stats=1 ?purr=synth|rec ?stroke=1

import { audio, type Hiss, type Purr } from './engine/AudioEngine'
import { haptic, runLoop } from './engine/juice'
import { Cat, type Touch } from './cat/cat'
import { HEAD_C, HEAD_ROT, apply, mul, rot, spine, tr } from './cat/rig'

export interface GameApi {
  dispose(): void
}

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

export function startGame(canvas: HTMLCanvasElement, onFirst: () => void): GameApi {
  const q = new URLSearchParams(location.search)
  const pose = q.get('pose') ?? 'rest'
  const freezeAt = q.has('t') ? Math.max(0, parseFloat(q.get('t') || '0') || 0) : null
  const seed = Math.max(1, parseInt(q.get('seed') || '1', 10) || 1)
  const fur = q.get('fur') !== '0'
  const showStats = q.get('stats') === '1'
  const purrMode = q.get('purr') === 'rec' ? 'rec' : 'synth'
  const stroke = q.get('stroke') === '1'

  const ctx = canvas.getContext('2d', { alpha: false })!
  const cat = new Cat({ seed, fur })
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
  const onResize = () => resize()
  window.addEventListener('resize', onResize)
  const noMenu = (e: Event) => e.preventDefault()
  canvas.addEventListener('contextmenu', noMenu)
  canvas.style.cursor = 'none'

  const dbg: Record<string, unknown> = { ready: false, pose, frozen: freezeAt !== null, tufts: cat.tuftCount, cat, audio }
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
  /** Virtual finger at sim time t (s), or null. */
  const scripted = (t: number): Touch | null => {
    if (pose === 'bliss' || pose === 'chin') {
      const base = pose === 'bliss' ? headPt(-0.4, 0.14) : headPt(0.02, 0.4)
      // a slow little scritch
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
    return lane(-2.7, -1.95, 0.8, 0.2, 0.42) ?? seg(-1.75, -1.15, headPt(0.02, -0.02), headPt(0.06, -0.4)) ?? lane(-0.95, -0.05, 0.14, 0.86, 0.13)
  }

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
      onFirst()
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
    markFirst(e)
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
  const onVis = () => {
    if (document.hidden) {
      stopVibe()
      haptic(0)
      purr?.set(0)
      hiss?.set(0)
    }
  }
  document.addEventListener('visibilitychange', onVis)

  // ---------- loop ----------
  let simT = stroke ? -STROKE_T : 0
  let frozen = false
  let fps = 60
  let workMs = 0
  const frames: number[] = []
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
      if (p.type === 'touch' ? p.down : true) {
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
    // audio + haptics
    if (purr) {
      // bliss drives the level; touching a bliss zone gives an immediate audible floor
      const zoneOn = cat.finger.on && (cat.zone === 'chin' || cat.zone === 'cheek' || cat.zone === 'top')
      purr.set(zoneOn ? Math.max(0.6, cat.bliss) : cat.bliss)
      hiss?.set((maxSpeed / cat.HW) * (125 / 900))
      const lvl = purr.level()
      const now = performance.now()
      if (touchOnCat && lvl > 0.2 && !audio.muted) {
        const ph = purr.phase()
        const exhale = ph > 0.44
        if (now - lastVibe > 600 && (cat.bliss > 0.45 || exhale)) {
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

  const frame = (dtRaw: number) => {
    const now = performance.now()
    const delta = now - lastNow
    lastNow = now
    frames.push(delta)
    if (frames.length > 600) frames.shift()
    fps = fps * 0.9 + (1000 / Math.max(1, delta)) * 0.1
    const a = performance.now()
    cat.baker.step(started ? 6 : 14)
    if (freezeAt !== null) {
      if (!frozen) {
        // fast-forward deterministically in fixed steps, then hold
        const DT = 1 / 60
        while (simT < freezeAt - 1e-6) step(Math.min(DT, freezeAt - simT), now)
        frozen = true
      }
    } else step(dtRaw, now)
    cat.draw(ctx, true)
    if (!reactionPending) ensureVoices()
    workMs = workMs * 0.9 + (performance.now() - a) * 0.1
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
      } else if (now - calmSince > 500) calm.push(delta)
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
    if (showStats) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = 'rgba(40,30,20,0.6)'
      ctx.fillRect(6, 6, 190, 74)
      ctx.fillStyle = '#fff'
      ctx.font = '11px ui-monospace, monospace'
      ctx.fillText(`fps ${fps.toFixed(0)}  frame ${workMs.toFixed(1)} ms`, 12, 22)
      ctx.fillText(`tufts ${cat.tuftCount}${cat.half ? ' (half)' : ''}  ${cat.tuftMs.toFixed(2)} ms`, 12, 36)
      ctx.fillText(`bake ${cat.baker.bakeMs.toFixed(0)} ms  ${cat.baker.totalStrokes} strokes`, 12, 50)
      ctx.fillText(`bliss ${cat.bliss.toFixed(2)}  zone ${cat.zone}  dpr ${dpr}`, 12, 64)
    }
    if (!dbg.firstPaintMs) {
      dbg.firstPaintMs = performance.now()
    }
    if (cat.baker.done && dbg.prepareAt === undefined) {
      // create the (suspended) audio context once the bake is done, so the first touch only resumes it
      dbg.prepareAt = 0
      setTimeout(() => {
        const a = performance.now()
        audio.prepare()
        dbg.prepareAt = [Math.round(a), Math.round(performance.now() - a)]
      }, 30)
    }
    dbg.timings = cat.timings
    if (cat.baker.done && !dbg.ready) {
      dbg.ready = true
      dbg.bakeMs = cat.baker.bakeMs
      dbg.bakeDoneMs = cat.baker.doneAt
      dbg.strokes = cat.baker.totalStrokes
    }
    dbg.fps = fps
    dbg.matchMs = cat.matchMs
    dbg.workMs = workMs
    dbg.tuftMs = cat.tuftMs
    dbg.bliss = cat.bliss
    dbg.zone = cat.zone
    dbg.frames = frames
    dbg.purr = purr ? { mode: purr.mode, level: purr.level(), phase: purr.phase() } : null
  }
  const stop = runLoop(frame)

  return {
    dispose() {
      stop()
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
