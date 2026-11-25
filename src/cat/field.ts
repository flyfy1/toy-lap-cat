// A part silhouette rasterised once into a small mask, plus a signed distance field (HW units,
// positive inside). Used for inside tests, fringe detection, pseudo-normals for shading and hit tests.

export type PathFn = (c: CanvasRenderingContext2D | Path2D) => void

export class Field {
  readonly w: number
  readonly h: number
  readonly d: Float32Array
  constructor(
    path: PathFn,
    readonly x0: number,
    readonly y0: number,
    x1: number,
    y1: number,
    readonly res = 56,
  ) {
    this.w = Math.ceil((x1 - x0) * res) + 2
    this.h = Math.ceil((y1 - y0) * res) + 2
    const cv = document.createElement('canvas')
    cv.width = this.w
    cv.height = this.h
    const c = cv.getContext('2d', { willReadFrequently: true })!
    c.setTransform(res, 0, 0, res, -x0 * res, -y0 * res)
    c.beginPath()
    path(c)
    c.fillStyle = '#000'
    c.fill()
    const px = c.getImageData(0, 0, this.w, this.h).data
    const n = this.w * this.h
    const inside = new Uint8Array(n)
    for (let i = 0; i < n; i++) inside[i] = px[i * 4 + 3] > 127 ? 1 : 0
    const din = chamfer(inside, this.w, this.h, 1)
    const dout = chamfer(inside, this.w, this.h, 0)
    this.d = new Float32Array(n)
    for (let i = 0; i < n; i++) this.d[i] = inside[i] ? (din[i] - 0.5) / res : -(dout[i] - 0.5) / res
  }

  /** Bilinear signed distance at a local point (HW). Outside the grid: far outside. */
  sample(x: number, y: number): number {
    const gx = (x - this.x0) * this.res - 0.5
    const gy = (y - this.y0) * this.res - 0.5
    if (gx < 0 || gy < 0 || gx >= this.w - 1 || gy >= this.h - 1) return -1
    const ix = gx | 0
    const iy = gy | 0
    const fx = gx - ix
    const fy = gy - iy
    const i = iy * this.w + ix
    const d = this.d
    const a = d[i] + (d[i + 1] - d[i]) * fx
    const b = d[i + this.w] + (d[i + this.w + 1] - d[i + this.w]) * fx
    return a + (b - a) * fy
  }

  /** Unit gradient of the distance (points inward). */
  grad(x: number, y: number): [number, number] {
    const e = 1.5 / this.res
    const gx = this.sample(x + e, y) - this.sample(x - e, y)
    const gy = this.sample(x, y + e) - this.sample(x, y - e)
    const l = Math.hypot(gx, gy) || 1
    return [gx / l, gy / l]
  }
}

/** 3-4 chamfer distance (in cells) from every cell to the nearest cell whose mask != target. */
function chamfer(mask: Uint8Array, w: number, h: number, target: number): Float32Array {
  const INF = 1e9
  const d = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) d[i] = mask[i] === target ? INF : 0
  const A = 1
  const B = Math.SQRT2
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (d[i] === 0) continue
      let v = d[i]
      if (x > 0) v = Math.min(v, d[i - 1] + A)
      if (y > 0) {
        v = Math.min(v, d[i - w] + A)
        if (x > 0) v = Math.min(v, d[i - w - 1] + B)
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + B)
      }
      d[i] = v
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (d[i] === 0) continue
      let v = d[i]
      if (x < w - 1) v = Math.min(v, d[i + 1] + A)
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + A)
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + B)
        if (x > 0) v = Math.min(v, d[i + w - 1] + B)
      }
      d[i] = v
    }
  // cells on the image border that are "target" with no opposite cell anywhere stay INF; clamp
  for (let i = 0; i < w * h; i++) if (d[i] > 1e8) d[i] = Math.max(w, h)
  return d
}
