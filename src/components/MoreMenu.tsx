import { useState } from 'react'
import { openAbout, t, type ToyId } from '../i18n'
import { ShareButton } from './ShareButton'
import { IconClose, IconGrid } from './Icons'

const SITES: { id: ToyId; icon: string }[] = [
  { id: 'charge', icon: '💥' },
  { id: 'void', icon: '🕳️' },
  { id: 'smash', icon: '🔨' },
  { id: 'pop', icon: '🫧' },
  { id: 'knock', icon: '🪵' },
  { id: 'purr', icon: '🐈' },
  { id: 'squish', icon: '🍡' },
]

/** Light toys (pale backgrounds) get dark-ink pills. */
export const LIGHT_TOYS: ToyId[] = ['purr']
export const pillClass = (toy: ToyId) =>
  LIGHT_TOYS.includes(toy)
    ? 'inline-flex min-h-[44px] items-center gap-2 rounded-full border border-[#4A3A2C]/12 bg-[#FFF9F0]/78 px-[14px] text-sm font-medium leading-none text-[#4A3A2C]/90 shadow-[inset_0_1px_0_rgba(255,255,255,.7),0_4px_14px_rgba(74,58,44,.12)] backdrop-blur-md hover:bg-[#FFF9F0]/90 active:scale-95'
    : 'rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-sm font-medium text-white/80 backdrop-blur-md hover:bg-white/20 active:scale-95'

export function MoreMenu({ current }: { current: ToyId }) {
  const [open, setOpen] = useState(false)
  const light = LIGHT_TOYS.includes(current)
  return (
    <div className="fixed bottom-3 right-3 z-20 flex flex-col items-end gap-2 select-none" onPointerDown={(e) => e.stopPropagation()}>
      {open && (
        <div className={light ? 'flex flex-col gap-1 rounded-2xl border border-[#4A3A2C]/15 bg-[#FFF8EE]/90 p-1.5 text-[#4A3A2C] shadow-lg backdrop-blur-md' : 'flex flex-col gap-1 rounded-2xl border border-white/15 bg-black/60 p-1.5 backdrop-blur-md'}>
          {SITES.map((s) => (
            <a
              key={s.id}
              href={s.id === current ? undefined : `https://${s.id}.integ.life`}
              className={
                light
                  ? `flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${s.id === current ? 'bg-[#4A3A2C]/10 font-semibold' : 'text-[#4A3A2C]/85 hover:bg-[#4A3A2C]/5 active:bg-[#4A3A2C]/10'}`
                  : `flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${s.id === current ? 'bg-white/15 text-white' : 'text-white/80 hover:bg-white/10 active:bg-white/20'}`
              }
            >
              {light ? <span className="h-2 w-2 rounded-full bg-[#4A3A2C]/35" /> : <span className="text-lg">{s.icon}</span>}
              <span>{t(`name_${s.id}`)}</span>
            </a>
          ))}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              openAbout()
            }}
            className={light ? 'flex items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-[#4A3A2C]/85 hover:bg-[#4A3A2C]/5' : 'flex items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-white/80 hover:bg-white/10 active:bg-white/20'}
          >
            {light ? <span className="h-2 w-2 rounded-full border border-[#4A3A2C]/50" /> : <span className="text-lg">ⓘ</span>}
            <span>{t('about')}</span>
          </button>
          <a href="https://games.integ.life" className={light ? 'rounded-xl px-3 py-1.5 text-xs text-[#4A3A2C]/55 hover:bg-[#4A3A2C]/5' : 'rounded-xl px-3 py-1.5 text-xs text-white/50 hover:bg-white/10'}>
            {t('more_games')}
          </a>
        </div>
      )}
      <div className={light ? 'flex gap-3' : 'flex gap-2'}>
      <ShareButton toy={current} />
      <button onClick={() => setOpen((o) => !o)} className={pillClass(current)}>
        {light ? open ? <IconClose /> : <><IconGrid />More</> : open ? '✕' : 'More ⚡'}
      </button>
      </div>
    </div>
  )
}
