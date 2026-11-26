import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { applyMeta, t, type Key } from './i18n'
import { startAnalytics, track } from './analytics'
import { COATS, type Coat, arrive, catFromUrl, landing, offer, parseName, stats as shareStats, syncCatToUrl, trackLanding } from './share'
import { Hint } from './components/Hint'
import { MoreMenu, pillClass } from './components/MoreMenu'
import { IconPaw, IconReceipt, IconSpeaker } from './components/CatIcons'
import { startGame, type CatStats, type GameApi } from './game'
import { applyCoat } from './cat/palette'
import { audio } from './engine/AudioEngine'
import { haptic } from './engine/juice'

const OG = new URLSearchParams(location.search).get('og') === '1'
/** a mouse (or trackpad): petting needs the button held, so the hint says so */
const MOUSE = matchMedia('(pointer: fine)').matches
/** recipients only: the tag loads on demand, so the first load stays as it was */
const PurrTag = lazy(() => import('./components/PurrTag').catch(() => ({ default: () => null })))
const SWATCH: Record<Coat, string> = { tabby: '#8A7360', orange: '#D98B4A', tux: '#2B2522', void: '#121014' }

/** The monologue: one line under the cat, cross-faded. */
function Line({ k, y }: { k: { key: Key; id: number } | null; y: number }) {
  const [prev, setPrev] = useState<{ key: Key; id: number } | null>(null)
  const cur = useRef(k)
  useEffect(() => {
    if (cur.current && k && cur.current.id !== k.id) setPrev(cur.current)
    cur.current = k
  }, [k])
  const cls = 'pointer-events-none fixed inset-x-0 z-10 mx-auto max-w-[30ch] px-2 text-center font-[ui-rounded,system-ui,sans-serif] text-[15px] leading-[22px] text-[#4A3A2C]/80'
  return (
    <>
      {prev && (
        <div key={'p' + prev.id} className={`${cls} mono-out`} style={{ top: y }}>
          {t(prev.key)}
        </div>
      )}
      {k && (
        <div key={k.id} className={`${cls} mono-in`} style={{ top: y }}>
          {t(k.key)}
        </div>
      )}
    </>
  )
}

export default function App() {
  const ref = useRef<HTMLCanvasElement>(null)
  const api = useRef<GameApi | null>(null)
  const statsRef = useRef<CatStats | undefined>(undefined)
  const baseTitle = useRef('')
  const [initial] = useState(() => catFromUrl())
  const [name, setName] = useState(initial.name)
  const [coat, setCoat] = useState<Coat>(initial.coat)
  const nameRef = useRef(name)
  const [touched, setTouched] = useState(false)
  const [line, setLine] = useState<{ key: Key; id: number } | null>(null)
  const [lineY, setLineY] = useState(0)
  const [panel, setPanel] = useState(false)
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem('purr.muted') === '1'
    } catch {
      return false
    }
  })
  const urlTimer = useRef<number | undefined>(undefined)
  const gaTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    applyMeta('purr')
    baseTitle.current = document.title
    if (OG) return
    startAnalytics('purr')
    trackLanding()
    // a portal visit: silk's cat has just jumped (its stretch), squish's paw (the next paw touch is held),
    // yoink's orange tabby (this visit only: not in the address bar), scratch's prize (the tag only)
    arrive('purr', ['top-[4.2rem]', 'bg-[#FFFCF5] text-[#3B2E24]']).then((a) => {
      if (a?.from === 'yoink' && !new URLSearchParams(location.search).has('c')) setCoat('orange')
      else if (a) api.current?.arrive(a.from === 'squish' ? 'paw' : a.from === 'silk' ? 'stretch' : '')
    })
    let sent = false
    const onHide = () => {
      if (sent || !statsRef.current) return
      sent = true
      track('session_pet_time', { seconds: Math.round(statsRef.current.petSec) })
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  useEffect(() => {
    audio.setMuted(muted)
    if (muted) haptic(0)
    try {
      localStorage.setItem('purr.muted', muted ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [muted])

  // the game; rebuilt when the coat changes (the rig and the fur are baked from the coat)
  useEffect(() => {
    applyCoat(coat)
    shareStats.coat = coat
    let lineId = 0
    const g = startGame(
      ref.current!,
      {
        onFirst() {
          setTouched(true)
          track('play_start')
        },
        onLine(key) {
          setLine({ key, id: ++lineId + Date.now() })
          setLineY(g.lineY())
        },
        onGlass() {
          // the glass the cat pushed off: a portal to smash, after its 3 s line
          offer('purr', 'glass', () => g.glassAt(), 3000)
        },
        onAsleep(a) {
          document.title = a ? t('title_asleep', { name: nameRef.current || t('name_purr') }) : baseTitle.current
        },
        onTrack: (e, p) => {
          // the peaks: the first belly trap, 30 s of purring (the receipt is offered as the slip)
          if (e === 'purr_30' || (e === 'belly_trap' && p?.n === 1)) receipt(false)
          if (e !== 'purr_30') track(e, p)
        },
      },
      statsRef.current,
    )
    statsRef.current = g.stats
    api.current = g
    setLineY(g.lineY())
    const onResize = () => setLineY(g.lineY())
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      g.dispose()
    }
  }, [coat])

  const onName = (raw: string) => {
    const n = parseName(raw)
    setName(raw.slice(0, 12))
    nameRef.current = n
    shareStats.name = n
    window.clearTimeout(urlTimer.current)
    urlTimer.current = window.setTimeout(() => syncCatToUrl(n, coat), 300)
    window.clearTimeout(gaTimer.current)
    if (n) gaTimer.current = window.setTimeout(() => track('name_set', { len: n.length }), 1500)
  }
  useEffect(() => {
    shareStats.name = parseName(initial.name)
  }, [initial])
  const pickCoat = (c: Coat) => {
    if (c === coat) return
    setCoat(c)
    syncCatToUrl(nameRef.current, c)
    track('coat_set', { coat: c })
  }

  // the receipt (drawn on demand, with the share sheet): `open` from the 猫税 button, a slip at a peak
  const receipt = (open: boolean) => {
    const g = api.current
    if (g) import('./purrShare').then((m) => m.receipt(g, nameRef.current, open), () => {})
  }

  if (OG)
    return (
      <>
        <canvas ref={ref} />
        <div className="pointer-events-none fixed left-[6%] top-[9%] z-10 select-none text-[#4A3A2C]">
          <div className="text-[64px] font-extrabold leading-none tracking-tight">{name ? name : t('name_purr')}</div>
          <div className="mt-3 text-2xl font-semibold opacity-70">purr.integ.life</div>
        </div>
      </>
    )

  return (
    <>
      <canvas ref={ref} />
      <Line k={line} y={lineY} />
      <Hint text={t(MOUSE ? 'hint_purr_m' : 'hint_purr')} hidden={touched || !!line} light />
      <div className="fixed left-3 top-3 z-20 select-none" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" aria-label={t('cat_coat')} onClick={() => setPanel((p) => !p)} className={`${pillClass('purr')} ${name ? '' : '!w-11 justify-center !px-0'}`}>
          <IconPaw />
          {name ? <span>{parseName(name)}</span> : null}
        </button>
        {panel && (
          <div data-busy="" className="mt-2 w-64 rounded-2xl border border-[#4A3A2C]/15 bg-[#FFF8EE]/90 p-3 text-[#4A3A2C] shadow-lg backdrop-blur-md">
            <input
              value={name}
              maxLength={12}
              placeholder={t('cat_name_ph')}
              enterKeyHint="done"
              onChange={(e) => onName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="w-full rounded-full border border-[#4A3A2C]/20 bg-white/70 px-3.5 py-1.5 text-base outline-none placeholder-[#4A3A2C]/40 focus:border-[#4A3A2C]/45"
            />
            <div className="mt-3 mb-1.5 text-xs font-semibold uppercase tracking-widest opacity-60">{t('cat_coat')}</div>
            <div className="grid grid-cols-4 gap-1.5">
              {COATS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => pickCoat(c)}
                  className={`flex flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-[11px] ${c === coat ? 'bg-[#4A3A2C]/10 font-semibold' : 'hover:bg-[#4A3A2C]/5'}`}
                >
                  <span className="h-6 w-6 rounded-full border border-[#4A3A2C]/25" style={{ background: SWATCH[c] }} />
                  {t(`coat_${c}`)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="fixed right-3 top-3 z-20 select-none" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? t('sound_off') : t('sound_on')} title={muted ? t('sound_off') : t('sound_on')} className={`${pillClass('purr')} !w-11 justify-center !px-0`}>
          <IconSpeaker off={muted} />
        </button>
      </div>
      <div className="fixed bottom-3 left-3 z-20 select-none" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => receipt(true)} className={pillClass('purr')}>
          <IconReceipt />
          {t('tax_button')}
        </button>
      </div>
      <MoreMenu current="purr" />
      {landing.recipient && (
        <Suspense fallback={null}>
          <PurrTag name={parseName(initial.name)} />
        </Suspense>
      )}
    </>
  )
}
