import { useEffect, useRef, useState } from 'react'
import { applyMeta, t, type Key } from './i18n'
import { startAnalytics, track } from './analytics'
import { COATS, type Coat, catFromUrl, parseName, stats as shareStats, syncCatToUrl } from './share'
import { Hint } from './components/Hint'
import { MoreMenu, pillClass } from './components/MoreMenu'
import { startGame, type CatStats, type GameApi } from './game'
import { applyCoat } from './cat/palette'
import { audio } from './engine/AudioEngine'
import { haptic } from './engine/juice'
import { drawReceipt } from './receipt'

const OG = new URLSearchParams(location.search).get('og') === '1'
const SWATCH: Record<Coat, string> = { tabby: '#8A7360', orange: '#D98B4A', tux: '#2B2522', void: '#121014' }

/** The monologue: one line under the cat, cross-faded. */
function Line({ k, y }: { k: { key: Key; id: number } | null; y: number }) {
  const [prev, setPrev] = useState<{ key: Key; id: number } | null>(null)
  const cur = useRef(k)
  useEffect(() => {
    if (cur.current && k && cur.current.id !== k.id) setPrev(cur.current)
    cur.current = k
  }, [k])
  const cls = 'pointer-events-none fixed inset-x-0 z-10 px-6 text-center text-[13px] leading-5 text-[#4A3A2C]/70'
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
  const [chip, setChip] = useState(0)
  const [panel, setPanel] = useState(false)
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem('purr.muted') === '1'
    } catch {
      return false
    }
  })
  const [receipt, setReceipt] = useState<{ url: string; blob: Blob | null } | null>(null)
  const urlTimer = useRef<number | undefined>(undefined)
  const gaTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    applyMeta('purr')
    baseTitle.current = document.title
    if (OG) return
    startAnalytics('purr')
    if (location.search.match(/[?&](n|c)=/)) track('shared_cat_open')
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
    let chipTimer = 0
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
          setChip((c) => c + 1)
          window.clearTimeout(chipTimer)
          chipTimer = window.setTimeout(() => setChip(0), 4000)
        },
        onAsleep(a) {
          document.title = a ? t('title_asleep', { name: nameRef.current || t('name_purr') }) : baseTitle.current
        },
        onTrack: (e, p) => track(e, p),
      },
      statsRef.current,
    )
    statsRef.current = g.stats
    api.current = g
    setLineY(g.lineY())
    const onResize = () => setLineY(g.lineY())
    window.addEventListener('resize', onResize)
    return () => {
      window.clearTimeout(chipTimer)
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

  const openReceipt = () => {
    const g = api.current
    if (!g) return
    const r = g.rating()
    const cv = drawReceipt(g.snapshot(), g.stats, r, nameRef.current)
    track('share_card', { traps: g.stats.traps, rating_x10: Math.round(r * 10) })
    const url = cv.toDataURL('image/png')
    setReceipt({ url, blob: null })
    cv.toBlob((b) => b && setReceipt((x) => (x && x.url === url ? { url, blob: b } : x)), 'image/png')
  }
  const file = () => (receipt?.blob ? new File([receipt.blob], 'cat-tax.png', { type: 'image/png' }) : null)
  const canShareFile = () => {
    const f = file()
    return !!(f && navigator.canShare?.({ files: [f] }))
  }
  const shareReceipt = async () => {
    const f = file()
    if (!f) return
    try {
      await navigator.share({ files: [f], title: t('tax_title'), text: 'purr.integ.life' })
      track('share', { method: 'card' })
    } catch {
      /* cancelled */
    }
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
      <Hint text={t('hint_purr')} hidden={touched || !!line} light />
      {chip > 0 && (
        <a
          href="https://smash.integ.life"
          onPointerDown={(e) => e.stopPropagation()}
          className="mono-in fixed left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-[#4A3A2C]/20 bg-[#FFF8EE]/80 px-4 py-1.5 text-sm font-medium text-[#4A3A2C] backdrop-blur-md"
        >
          {t('cat_smash_chip')}
        </a>
      )}
      <div className="fixed left-3 top-3 z-20 select-none" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" aria-label={t('cat_coat')} onClick={() => setPanel((p) => !p)} className={`${pillClass('purr')} !px-2.5`}>
          🐾{name ? <span className="ml-1.5">{parseName(name)}</span> : null}
        </button>
        {panel && (
          <div className="mt-2 w-64 rounded-2xl border border-[#4A3A2C]/15 bg-[#FFF8EE]/90 p-3 text-[#4A3A2C] shadow-lg backdrop-blur-md">
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
        <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? t('sound_off') : t('sound_on')} title={muted ? t('sound_off') : t('sound_on')} className={`${pillClass('purr')} !px-2.5`}>
          {muted ? '🔇' : '🔊'}
        </button>
      </div>
      <div className="fixed bottom-3 left-3 z-20 select-none" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={openReceipt} className={pillClass('purr')}>
          🧾 {t('tax_button')}
        </button>
      </div>
      <MoreMenu current="purr" />
      {receipt && (
        <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-[#2a1f17]/70 p-4" onPointerDown={(e) => e.stopPropagation()} onClick={() => setReceipt(null)}>
          <img src={receipt.url} alt={t('tax_title')} className="max-h-[78vh] max-w-full rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
            {canShareFile() && (
              <button type="button" onClick={shareReceipt} className="rounded-full bg-[#FFF8EE] px-4 py-2 text-sm font-semibold text-[#4A3A2C] active:scale-95">
                ↗ {t('tax_share')}
              </button>
            )}
            <a href={receipt.url} download="cat-tax.png" className="rounded-full bg-[#FFF8EE] px-4 py-2 text-sm font-semibold text-[#4A3A2C] active:scale-95">
              ⤓ {t('tax_save')}
            </a>
            <button type="button" onClick={() => setReceipt(null)} className="rounded-full border border-[#FFF8EE]/40 px-3.5 py-2 text-sm text-[#FFF8EE]">
              ✕
            </button>
          </div>
        </div>
      )}
    </>
  )
}
