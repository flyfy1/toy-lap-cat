// Debug overlays, loaded on demand: ?bones=1 (the rig over the cat) and ?stats=1 (the perf readout).

import type { Cat } from './cat'
import { HIND, LEG_FAR, type Mat, type V2 } from './rig'

const LEG_F_REST: V2 = [LEG_FAR.W[0], LEG_FAR.W[1]]

export function drawBones(cat: Cat, ctx: CanvasRenderingContext2D, dev: Mat) {
  ctx.setTransform(dev[0], dev[1], dev[2], dev[3], dev[4], dev[5])
  const px = 1 / cat.HW
  ctx.lineWidth = 2 * px
  const dot = (p: V2, r: number, c: string) => {
    ctx.fillStyle = c
    ctx.beginPath()
    ctx.arc(p[0], p[1], r * px, 0, Math.PI * 2)
    ctx.fill()
  }
  const line = (ps: V2[], c: string) => {
    ctx.strokeStyle = c
    ctx.beginPath()
    ctx.moveTo(ps[0][0], ps[0][1])
    for (const p of ps.slice(1)) ctx.lineTo(p[0], p[1])
    ctx.stroke()
  }
  for (const f of cat.fl) {
    line([f.S, f.E, f.W], 'rgba(0,160,255,0.9)')
    line([f.W, [f.W[0] + Math.cos(f.pa) * 0.25 * f.g.s, f.W[1] + Math.sin(f.pa) * 0.25 * f.g.s]], 'rgba(0,200,120,0.9)')
    dot(f.S, 4, '#06f')
    dot(f.E, 4, '#f80')
    dot(f.W, 4, '#0c6')
    if (f.goal) {
      ctx.strokeStyle = '#f0f'
      ctx.beginPath()
      ctx.arc(f.goal.W[0], f.goal.W[1], 6 * px, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  dot(LEG_F_REST, 3, '#ff0')
  for (const h of cat.hl) {
    line([h.K, h.E, h.W], 'rgba(255,60,60,0.9)')
    dot(h.K, 4, '#f80')
    dot(h.E, 4, '#f80')
    dot(h.W, 4, '#0c6')
  }
  dot(HIND.toe, 3, '#ff0')
  dot(HIND.H, 4, '#f00')
  line(
    cat.tailNodes.map((n) => n.p),
    'rgba(255,200,0,0.9)',
  )
}
/** ?stats=1: fps, frame time, tufts, bake and mood in the top left corner. */
export function drawStats(ctx: CanvasRenderingContext2D, dpr: number, cat: Cat, fps: number, workMs: number) {
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
