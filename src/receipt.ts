// The cat-tax receipt: a 1080 x 1350 till receipt lying on the blanket, with a snapshot of the cat.

import { locale, t } from './i18n'
import type { CatStats } from './game'

const W = 1080
const H = 1350
const INK = '#3B2E24'
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "PingFang SC", "Noto Sans SC", monospace'

export const ratingLabel = (r: number) => t(`tax_r${Math.max(1, Math.min(5, Math.floor(r)))}` as 'tax_r1')

export function drawReceipt(snap: HTMLCanvasElement, s: CatStats, rating: number, name: string): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const c = cv.getContext('2d')!
  // blanket: warm oatmeal with a soft knit of tiny V stitches
  c.fillStyle = '#E4CFB6'
  c.fillRect(0, 0, W, H)
  c.strokeStyle = 'rgba(120,84,56,0.10)'
  c.lineWidth = 3
  for (let y = 10; y < H; y += 26)
    for (let x = (y / 26) % 2 ? 0 : 13; x < W; x += 26) {
      c.beginPath()
      c.moveTo(x - 7, y - 6)
      c.lineTo(x, y + 4)
      c.lineTo(x + 7, y - 6)
      c.stroke()
    }
  // the paper, very slightly turned
  const pw = 760
  const ph = 1260
  c.save()
  c.translate(W / 2, H / 2)
  c.rotate(-0.012)
  c.translate(-pw / 2, -ph / 2)
  const paper = new Path2D()
  const tooth = 20
  paper.moveTo(0, tooth / 2)
  for (let x = 0; x < pw; x += tooth) {
    paper.lineTo(x + tooth / 2, 0)
    paper.lineTo(x + tooth, tooth / 2)
  }
  paper.lineTo(pw, ph - tooth / 2)
  for (let x = pw; x > 0; x -= tooth) {
    paper.lineTo(x - tooth / 2, ph)
    paper.lineTo(x - tooth, ph - tooth / 2)
  }
  paper.closePath()
  c.shadowColor = 'rgba(70,45,25,0.28)'
  c.shadowBlur = 30
  c.shadowOffsetY = 10
  c.fillStyle = '#FFFCF5'
  c.fill(paper)
  c.shadowColor = 'transparent'

  // the cat, as it is right now
  const pad = 44
  const iw = pw - pad * 2
  const ih = Math.min(400, (iw * snap.height) / snap.width)
  const sw = (snap.width * ih) / snap.height
  c.save()
  const clip = new Path2D()
  clip.roundRect(pad, 46, iw, ih, 22)
  c.clip(clip)
  c.fillStyle = '#E9D8C3'
  c.fillRect(pad, 46, iw, ih)
  c.drawImage(snap, pad + (iw - Math.max(sw, iw)) / 2, 46 + (ih - Math.max(ih, (snap.height * iw) / snap.width)) / 2, Math.max(sw, iw), Math.max(ih, (snap.height * iw) / snap.width))
  c.restore()

  c.fillStyle = INK
  c.textBaseline = 'alphabetic'
  let y = 46 + ih + 86
  c.textAlign = 'center'
  // long titles (es, fr) shrink to fit the paper
  let fs = 52
  c.font = `800 ${fs}px ${MONO}`
  while (fs > 30 && c.measureText(t('tax_title')).width > pw - pad * 2) c.font = `800 ${--fs}px ${MONO}`
  c.fillText(t('tax_title'), pw / 2, y)
  y += 46
  c.font = `500 26px ${MONO}`
  c.globalAlpha = 0.7
  const date = new Date().toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  c.fillText(name ? `${t('tax_cat', { name })}  ·  ${date}` : date, pw / 2, y)
  c.globalAlpha = 1
  const rule = (yy: number) => {
    c.save()
    c.setLineDash([10, 9])
    c.strokeStyle = 'rgba(59,46,36,0.45)'
    c.lineWidth = 2
    c.beginPath()
    c.moveTo(pad, yy)
    c.lineTo(pw - pad, yy)
    c.stroke()
    c.restore()
  }
  y += 34
  rule(y)
  y += 56
  const row = (label: string, value: string, bold = false) => {
    let rf = 32
    c.font = `${bold ? 800 : 500} ${rf}px ${MONO}`
    while (rf > 22 && c.measureText(label + value).width > pw - pad * 2 - 60) c.font = `${bold ? 800 : 500} ${--rf}px ${MONO}`
    c.textAlign = 'left'
    c.fillText(label, pad + 6, y)
    c.textAlign = 'right'
    c.fillText(value, pw - pad - 6, y)
    // dot leaders
    const lw = c.measureText(value).width
    c.textAlign = 'left'
    const x0 = pad + 6 + c.measureText(label).width + 16
    const x1 = pw - pad - 6 - lw - 16
    c.globalAlpha = 0.35
    for (let x = x0; x < x1; x += 16) c.fillRect(x, y - 6, 4, 4)
    c.globalAlpha = 1
    y += 54
  }
  const nf = new Intl.NumberFormat(locale)
  row(t('tax_pets'), nf.format(s.pets))
  row(t('tax_purr'), t('tax_sec', { n: nf.format(Math.round(s.purrSec)) }))
  row(t('tax_biscuits'), nf.format(s.biscuits))
  row(t('tax_traps'), nf.format(s.traps))
  row(t('tax_swats'), nf.format(s.swats))
  y -= 14
  rule(y)
  y += 60
  row(t('tax_rating'), `${rating.toFixed(1)} / 5`, true)
  c.textAlign = 'center'
  c.font = `italic 600 34px ${MONO}`
  c.fillText(`“${ratingLabel(rating)}”`, pw / 2, y - 6)
  y += 34
  rule(y)
  // barcode and footer
  y += 30
  let x = pad + 90
  let k = 7
  while (x < pw - pad - 90) {
    k = (k * 1103515245 + 12345) & 0x7fffffff
    const bw = 2 + (k % 4) * 2
    c.fillRect(x, y, bw, 52)
    x += bw + 3 + ((k >> 4) % 3) * 2
  }
  c.font = `700 30px ${MONO}`
  c.fillText('purr.integ.life', pw / 2, Math.min(ph - 40, y + 98))
  c.restore()
  return cv
}
