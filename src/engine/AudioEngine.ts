// Synthesised audio. Lap Cat adds an optional recorded purr (CC0, lazy-loaded) next to the synth purr.

const PENTA = [0, 2, 4, 7, 9] // major pentatonic, semitones

/** Frequency of the n-th step of a major pentatonic scale above `base`. */
export function pentaFreq(step: number, base = 220): number {
  const oct = Math.floor(step / 5)
  const deg = ((step % 5) + 5) % 5
  return base * Math.pow(2, (PENTA[deg] + 12 * oct) / 12)
}

type Wave = OscillatorType

interface ToneOpts {
  freq: number
  freqEnd?: number
  type?: Wave
  dur?: number
  gain?: number
  attack?: number
  delay?: number
  pan?: number
}

interface NoiseOpts {
  dur?: number
  gain?: number
  filter?: BiquadFilterType
  freq?: number
  freqEnd?: number
  q?: number
  attack?: number
  delay?: number
}

export interface Riser {
  set(p: number): void
  stop(): void
}

/** Persistent purr voice. set(intensity 0..1) each frame; phase() is the breath phase 0..1. */
export interface Purr {
  set(intensity: number): void
  phase(): number
  /** breath period in seconds */
  period(): number
  /** sudden silence (80 ms) */
  cut(): void
  stop(): void
  /** current output level 0..1 (before the master) */
  level(): number
  readonly mode: 'synth' | 'rec'
}

/** Continuous fur-stroke hiss. set(speed 0..1). */
export interface Hiss {
  set(speed: number): void
  stop(): void
}

const PURR_PEAK = 0.125 // about -18 dBFS
const BREATH = { inhale: 0.9, gap: 0.08, exhale: 1.14 }
const BREATH_T = BREATH.inhale + BREATH.exhale + BREATH.gap * 2 // 2.2 s
/** Recorded purr: 3 whole breath cycles trimmed from BigSoundBank #0436 (CC0, Joseph Sardin). */
export const REC_PURR = { url: '/purr.mp3', period: 4.04 / 3 }

class AudioEngine {
  ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private recent: number[] = []

  /** Call from the first pointerdown. Creates/resumes the context. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      const ctx = new AC()
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -14
      comp.knee.value = 12
      comp.ratio.value = 6
      comp.attack.value = 0.002
      comp.release.value = 0.18
      const master = ctx.createGain()
      master.gain.value = 0.8
      master.connect(comp).connect(ctx.destination)
      const len = ctx.sampleRate * 2
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
      this.ctx = ctx
      this.master = master
      this.noiseBuf = buf
    }
    if (this.ctx.state !== 'running') void this.ctx.resume()
  }

  private get ok(): boolean {
    return !!this.ctx && !!this.master
  }

  /** Voice budget for the high-rate sounds only (pop/chime/blip), so a 300-bubble
   *  chain doesn't melt the mixer. Big one-shots (boom/chord/shatter) never go through it. */
  private budget(max = 8, windowS = 0.05): boolean {
    if (!this.ok) return false
    const now = this.ctx!.currentTime
    this.recent = this.recent.filter((t) => now - t < windowS)
    if (this.recent.length >= max) return false
    this.recent.push(now)
    return true
  }

  tone(o: ToneOpts): void {
    if (!this.ok) return
    const ctx = this.ctx!
    const t0 = ctx.currentTime + (o.delay ?? 0)
    const dur = o.dur ?? 0.2
    const attack = o.attack ?? 0.004
    const osc = ctx.createOscillator()
    osc.type = o.type ?? 'sine'
    osc.frequency.setValueAtTime(o.freq, t0)
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), t0 + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.3, t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    let node: AudioNode = osc.connect(g)
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, o.pan))
      node = node.connect(p)
    }
    node.connect(this.master!)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
  }

  noise(o: NoiseOpts): void {
    if (!this.ok) return
    const ctx = this.ctx!
    const t0 = ctx.currentTime + (o.delay ?? 0)
    const dur = o.dur ?? 0.3
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    src.loop = true
    const f = ctx.createBiquadFilter()
    f.type = o.filter ?? 'lowpass'
    f.frequency.setValueAtTime(o.freq ?? 2000, t0)
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + dur)
    f.Q.value = o.q ?? 0.8
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.4, t0 + (o.attack ?? 0.003))
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    src.connect(f).connect(g).connect(this.master!)
    src.start(t0, Math.random() * 1.5)
    src.stop(t0 + dur + 0.02)
  }

  // ---------- presets ----------

  /** Sub-bass drop: the chest punch. */
  subDrop(power = 1): void {
    this.tone({ freq: 140, freqEnd: 32, type: 'sine', dur: 0.9 * power + 0.2, gain: 0.9 * power, attack: 0.003 })
    this.tone({ freq: 70, freqEnd: 28, type: 'triangle', dur: 0.7 * power + 0.2, gain: 0.5 * power })
  }

  /** Big explosion: sub drop + noise blast + bright crack. */
  boom(power = 1): void {
    this.subDrop(power)
    this.noise({ dur: 1.2 * power + 0.2, gain: 0.7 * power, filter: 'lowpass', freq: 6000, freqEnd: 120, attack: 0.002 })
    this.noise({ dur: 0.12, gain: 0.5 * power, filter: 'highpass', freq: 3000 })
  }

  /** Small punchy pop with a pitched body. */
  blip(freq: number, gain = 0.25): void {
    if (!this.budget()) return
    this.tone({ freq: freq * 1.5, freqEnd: freq, type: 'triangle', dur: 0.18, gain })
    this.noise({ dur: 0.05, gain: gain * 0.6, filter: 'bandpass', freq: 2500, q: 1.5 })
    this.tone({ freq: 160, freqEnd: 60, dur: 0.12, gain: gain * 0.9 })
  }

  /** Crisp bell-ish note for pitch escalation. */
  chime(freq: number, gain = 0.18, pan = 0): void {
    if (!this.budget()) return
    this.tone({ freq, type: 'sine', dur: 0.35, gain, pan })
    this.tone({ freq: freq * 2, type: 'triangle', dur: 0.12, gain: gain * 0.35, pan })
  }

  chord(freqs: number[], dur = 1.2, gain = 0.16, spread = 0.03): void {
    freqs.forEach((f, i) => {
      this.tone({ freq: f, type: 'triangle', dur, gain, delay: i * spread, attack: 0.01 })
      this.tone({ freq: f * 1.003, type: 'sine', dur, gain: gain * 0.7, delay: i * spread, attack: 0.01 })
    })
  }

  /** Bubble pop: fast upward sine chirp + click. */
  pop(freq: number, gain = 0.3): void {
    if (!this.budget()) return
    this.tone({ freq: freq * 0.6, freqEnd: freq * 1.9, type: 'sine', dur: 0.07, gain, attack: 0.002 })
    this.noise({ dur: 0.025, gain: gain * 0.5, filter: 'highpass', freq: 4000 })
  }

  /** Tempered-glass knock: thud + inharmonic ping + bright noise tick. */
  glassHit(intensity = 0.5): void {
    const i = Math.min(1, intensity)
    this.tone({ freq: 120, freqEnd: 55, dur: 0.18, gain: 0.55 + 0.3 * i })
    this.noise({ dur: 0.09 + 0.1 * i, gain: 0.35 + 0.35 * i, filter: 'highpass', freq: 2500 })
    const base = 1800 + Math.random() * 1400
    ;[1, 1.73, 2.61, 3.9].forEach((m, k) =>
      this.tone({ freq: base * m, type: 'sine', dur: 0.25 + 0.4 * i - k * 0.05, gain: 0.08 / (k + 1) + 0.05 * i, pan: Math.random() - 0.5 }),
    )
  }

  /** Full shatter: crash + a rain of tinkles over ~1.4 s. */
  shatter(): void {
    this.boom(0.7)
    this.noise({ dur: 1.4, gain: 0.6, filter: 'highpass', freq: 1800, freqEnd: 5000, attack: 0.002 })
    for (let k = 0; k < 40; k++) {
      const d = Math.pow(Math.random(), 1.6) * 1.4
      this.tone({ freq: 2500 + Math.random() * 5500, type: 'sine', dur: 0.08 + Math.random() * 0.25, gain: 0.05 + Math.random() * 0.07, delay: d, pan: Math.random() * 2 - 1 })
    }
  }

  whoosh(gain = 0.35): void {
    this.noise({ dur: 0.3, gain, filter: 'bandpass', freq: 400, freqEnd: 4000, q: 2, attack: 0.08 })
  }

  /** Continuous rising tension tone. set(p) with p in [0,1]. */
  riser(): Riser {
    if (!this.ok) return { set() {}, stop() {} }
    const ctx = this.ctx!
    const t0 = ctx.currentTime
    const out = ctx.createGain()
    out.gain.setValueAtTime(0.0001, t0)
    out.gain.exponentialRampToValueAtTime(0.22, t0 + 0.05)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.Q.value = 6
    const a = ctx.createOscillator()
    a.type = 'sawtooth'
    const b = ctx.createOscillator()
    b.type = 'square'
    const lfo = ctx.createOscillator()
    const lfoG = ctx.createGain()
    lfo.frequency.value = 6
    lfoG.gain.value = 0
    lfo.connect(lfoG).connect(out.gain)
    a.connect(f)
    b.connect(f)
    f.connect(out).connect(this.master!)
    const set = (p: number) => {
      const t = ctx.currentTime
      const fr = 70 * Math.pow(12, p)
      a.frequency.setTargetAtTime(fr, t, 0.03)
      b.frequency.setTargetAtTime(fr * 1.505, t, 0.03)
      f.frequency.setTargetAtTime(300 + 5000 * p * p, t, 0.03)
      lfo.frequency.setTargetAtTime(6 + 30 * p, t, 0.05)
      lfoG.gain.setTargetAtTime(0.12 * p, t, 0.05)
    }
    set(0)
    a.start()
    b.start()
    lfo.start()
    let stopped = false
    return {
      set,
      stop() {
        if (stopped) return
        stopped = true
        const t = ctx.currentTime
        out.gain.cancelScheduledValues(t)
        out.gain.setTargetAtTime(0.0001, t, 0.015)
        ;[a, b, lfo].forEach((o) => o.stop(t + 0.1))
      },
    }
  }

  muted = false
  setMuted(m: boolean): void {
    this.muted = m
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05)
  }

  /** The no-asset purr: a ~25 Hz pulse train whose energy sits at 120-900 Hz (design doc 1.9). */
  purrSynth(dest?: AudioNode, ctxArg?: BaseAudioContext, noiseArg?: AudioBuffer): Purr {
    const ctx = (ctxArg ?? this.ctx) as BaseAudioContext | null
    const out0 = dest ?? this.master
    const noise = noiseArg ?? this.noiseBuf
    if (!ctx || !out0 || !noise) return { set() {}, phase: () => 0, period: () => BREATH_T, cut() {}, stop() {}, level: () => 0, mode: 'synth' }
    const t0 = ctx.currentTime
    const out = ctx.createGain()
    out.gain.value = 0
    const breath = ctx.createGain()
    breath.gain.value = 0.25
    const gate = ctx.createGain()
    gate.gain.value = 0
    // pulse gate: saw at f0 -> shaper -> 35 % duty pulse with ~4 ms raised-cosine edges
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 25
    const shaper = ctx.createWaveShaper()
    const N = 2048
    const curve = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const p = i / (N - 1)
      let v = 0
      if (p < 0.1) v = 0.5 - 0.5 * Math.cos((p / 0.1) * Math.PI)
      else if (p < 0.27) v = 1
      else if (p < 0.37) v = 0.5 + 0.5 * Math.cos(((p - 0.27) / 0.1) * Math.PI)
      curve[i] = v
    }
    shaper.curve = curve
    osc.connect(shaper).connect(gate.gain)
    // per-pulse gain jitter (about +-10 %)
    const jn = ctx.createBufferSource()
    jn.buffer = noise
    jn.loop = true
    const jl = ctx.createBiquadFilter()
    jl.type = 'lowpass'
    jl.frequency.value = 30
    const jg = ctx.createGain()
    jg.gain.value = 0.35
    jn.connect(jl).connect(jg).connect(gate.gain)
    // sources: noise through three bandpasses + the saw through a lowpass
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true
    const bands: BiquadFilterNode[] = []
    for (const [f, q, g] of [
      [180, 1.2, 1.0],
      [420, 2, 0.5],
      [900, 1.5, 0.15],
    ]) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = f
      bp.Q.value = q
      const gg = ctx.createGain()
      gg.gain.value = g * 2.2
      src.connect(bp).connect(gg).connect(gate)
      bands.push(bp)
    }
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 300
    const sg = ctx.createGain()
    sg.gain.value = 0.35 * 0.5
    osc.connect(lp).connect(sg).connect(gate)
    gate.connect(breath).connect(out).connect(out0)
    osc.start(t0)
    src.start(t0, Math.random())
    jn.start(t0, Math.random())

    let next = t0 + 0.02
    const cycle0 = next
    let walk = 0
    const schedule = () => {
      while (next < ctx.currentTime + 0.6) {
        walk = Math.max(-1.5, Math.min(1.5, walk + (Math.random() - 0.5) * 0.8))
        const a = next
        const b = a + BREATH.inhale
        const c = b + BREATH.gap
        const d = c + BREATH.exhale
        const e = d + BREATH.gap
        // inhale: f0 27, filters +15 %, gain 0.8
        osc.frequency.setTargetAtTime(27 + walk, a, 0.05)
        bands.forEach((bp, i) => bp.frequency.setTargetAtTime([180, 420, 900][i] * 1.15, a, 0.08))
        breath.gain.setTargetAtTime(0.8, a, 0.06)
        breath.gain.setTargetAtTime(0.25, b, 0.02)
        // exhale: f0 23.5, gain 1.0
        osc.frequency.setTargetAtTime(23.5 + walk, c, 0.05)
        bands.forEach((bp, i) => bp.frequency.setTargetAtTime([180, 420, 900][i], c, 0.08))
        breath.gain.setTargetAtTime(1.0, c, 0.05)
        breath.gain.setTargetAtTime(0.25, d, 0.02)
        next = e
      }
    }
    schedule()
    let cur = 0
    let isCut = false
    let stopped = false
    return {
      mode: 'synth',
      set(intensity: number) {
        if (stopped) return
        schedule()
        const target = Math.max(0, Math.min(1, intensity)) * PURR_PEAK
        if (isCut && target > 0.01) isCut = false
        if (isCut) return
        if (Math.abs(target - cur) < 1e-4) return
        const now = ctx.currentTime
        out.gain.cancelScheduledValues(now)
        out.gain.setTargetAtTime(target, now, target > cur ? 0.4 : 0.85)
        cur = target
      },
      phase: () => (((ctx.currentTime - cycle0) % BREATH_T) + BREATH_T) % BREATH_T / BREATH_T,
      period: () => BREATH_T,
      level: () => out.gain.value / PURR_PEAK,
      cut() {
        isCut = true
        cur = 0
        const now = ctx.currentTime
        out.gain.cancelScheduledValues(now)
        out.gain.setTargetAtTime(0, now, 0.025)
      },
      stop() {
        if (stopped) return
        stopped = true
        const now = ctx.currentTime
        out.gain.cancelScheduledValues(now)
        out.gain.setTargetAtTime(0, now, 0.05)
        ;[osc, src, jn].forEach((n) => n.stop(now + 0.4))
      },
    }
  }

  private recBuf: AudioBuffer | null = null
  private recLoading: Promise<AudioBuffer | null> | null = null
  /** Lazy-load the recorded purr (after the first touch). */
  loadRecPurr(): Promise<AudioBuffer | null> {
    if (this.recBuf) return Promise.resolve(this.recBuf)
    if (!this.ctx) return Promise.resolve(null)
    if (!this.recLoading)
      this.recLoading = fetch(REC_PURR.url)
        .then((r) => r.arrayBuffer())
        .then((b) => this.ctx!.decodeAudioData(b))
        .then((buf) => (this.recBuf = buf))
        .catch(() => null)
    return this.recLoading
  }

  /** Recorded purr looped with two buffer sources and a 150 ms equal-power crossfade.
   *  The synth plays until the clip is decoded. */
  purrRec(): Purr {
    const synth = this.purrSynth()
    if (!this.ok) return synth
    const ctx = this.ctx!
    const out = ctx.createGain()
    out.gain.value = 0
    out.connect(this.master!)
    let buf: AudioBuffer | null = null
    let next = 0
    let cycle0 = 0
    const XF = 0.15
    const fadeIn = new Float32Array(32).map((_, i) => Math.sin((i / 31) * Math.PI * 0.5))
    const fadeOut = new Float32Array(32).map((_, i) => Math.cos((i / 31) * Math.PI * 0.5))
    const live: AudioBufferSourceNode[] = []
    const schedule = () => {
      if (!buf) return
      while (next < ctx.currentTime + 0.5) {
        const s = ctx.createBufferSource()
        s.buffer = buf
        const g = ctx.createGain()
        g.gain.setValueAtTime(0, next)
        g.gain.setValueCurveAtTime(fadeIn, next, XF)
        const end = next + buf.duration
        g.gain.setValueCurveAtTime(fadeOut, end - XF, XF)
        s.connect(g).connect(out)
        s.start(next)
        s.stop(end + 0.01)
        live.push(s)
        s.onended = () => live.splice(live.indexOf(s), 1)
        next = end - XF
      }
    }
    let cur = 0
    let isCut = false
    let stopped = false
    let target = 0
    void this.loadRecPurr().then((b) => {
      if (!b || stopped) return
      buf = b
      next = ctx.currentTime + 0.05
      cycle0 = next
      schedule()
      synth.set(0)
      cur = -1
    })
    const period = () => (buf ? buf.duration - XF : REC_PURR.period * 3) / 3
    return {
      mode: 'rec',
      set(intensity: number) {
        if (stopped) return
        target = Math.max(0, Math.min(1, intensity))
        if (!buf) return synth.set(intensity)
        schedule()
        const t = target * PURR_PEAK * 1.6
        if (isCut && t > 0.01) isCut = false
        if (isCut || Math.abs(t - cur) < 1e-4) return
        const now = ctx.currentTime
        out.gain.cancelScheduledValues(now)
        out.gain.setTargetAtTime(t, now, t > cur ? 0.4 : 0.85)
        cur = t
      },
      phase: () => (buf ? (((ctx.currentTime - cycle0) % period()) + period()) % period() / period() : synth.phase()),
      period: () => (buf ? period() : synth.period()),
      level: () => (buf ? out.gain.value / (PURR_PEAK * 1.6) : synth.level()),
      cut() {
        synth.cut()
        isCut = true
        cur = 0
        const now = ctx.currentTime
        out.gain.cancelScheduledValues(now)
        out.gain.setTargetAtTime(0, now, 0.025)
      },
      stop() {
        stopped = true
        synth.stop()
        const now = ctx.currentTime
        out.gain.setTargetAtTime(0, now, 0.05)
        live.forEach((s) => s.stop(now + 0.3))
      },
    }
  }

  /** Very quiet fur-stroke hiss: noise bandpassed at 2.5-4 kHz following finger speed. */
  hiss(): Hiss {
    if (!this.ok) return { set() {}, stop() {} }
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    src.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2500
    bp.Q.value = 0.9
    const g = ctx.createGain()
    g.gain.value = 0
    src.connect(bp).connect(g).connect(this.master!)
    src.start()
    let last = -1
    return {
      set(speed: number) {
        const s = Math.max(0, Math.min(1, speed))
        if (Math.abs(s - last) < 0.01) return
        last = s
        const t = ctx.currentTime
        bp.frequency.setTargetAtTime(2500 + 1500 * s, t, 0.05)
        g.gain.setTargetAtTime(0.04 * s, t, 0.06)
      },
      stop() {
        g.gain.setTargetAtTime(0, ctx.currentTime, 0.05)
        src.stop(ctx.currentTime + 0.3)
      },
    }
  }

  /** The shared noise buffer, for offline renders (tests). */
  get noiseBuffer(): AudioBuffer | null {
    return this.noiseBuf
  }
}

export const audio = new AudioEngine()
