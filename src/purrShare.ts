// Lap Cat's share moment (loaded on demand): the cat-tax receipt goes through the shared sheet.
// At a peak (the first belly trap, 30 s of purring) it is drawn and offered as the slip; the 猫税 button
// draws it fresh and opens the sheet.
import { drawReceipt } from './receipt'
import { openSheet, store } from './share'
import { peakCard, renderCard } from './card'
import type { GameApi } from './game'

export async function receipt(g: GameApi, name: string, open: boolean) {
  const r = g.rating()
  store.toy = 'purr'
  store.done = true
  store.peak = { snap: null, data: { traps: g.stats.traps, rating_x10: Math.round(r * 10) }, card: drawReceipt(g.snapshot(), g.stats, r, name) }
  if (!open) return peakCard('purr', false, performance.now())
  await renderCard('purr')
  openSheet('receipt')
}
