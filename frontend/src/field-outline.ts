/**
 * Outer contour of fields the player has joined. The contour follows the
 * parcel polygons. It does not add a bar between the nearest corners — that
 * bar drew triangles the map does not contain.
 */

const CELL_M = 6
const MAX_CELLS = 180000
// Close gaps up to about 48 m, then shrink back so the outer edge stays put.
// That is the strip between joined fields, which was not a field polygon before.
// Bridge the strip between joined parcels without leaving a wide halo outside them.
const CLOSE_DILATE = 3
const CLOSE_ERODE = 3

function inside(points: [number, number][], x: number, z: number) {
  let hit = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i]
    const [xj, zj] = points[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
  }
  return hit
}

function simplify(points: [number, number][], epsilon: number): [number, number][] {
  if (points.length < 5) return points
  const last = points.length - 1
  let far = 1
  let farDist = -1
  for (let i = 1; i < last; i += 1) {
    const dx = points[i][0] - points[0][0]
    const dz = points[i][1] - points[0][1]
    const dist = dx * dx + dz * dz
    if (dist > farDist) {
      farDist = dist
      far = i
    }
  }
  const keep = new Set<number>([0, far, last])
  const mark = (first: number, end: number) => {
    let max = 0
    let index = first
    const ax = points[first][0]
    const az = points[first][1]
    const bx = points[end][0]
    const bz = points[end][1]
    const dx = bx - ax
    const dz = bz - az
    const len2 = dx * dx + dz * dz
    for (let i = first + 1; i < end; i += 1) {
      let t = 0
      if (len2 > 0.0001) t = Math.min(1, Math.max(0, ((points[i][0] - ax) * dx + (points[i][1] - az) * dz) / len2))
      const ex = points[i][0] - (ax + t * dx)
      const ez = points[i][1] - (az + t * dz)
      const dist = Math.hypot(ex, ez)
      if (dist > max) {
        max = dist
        index = i
      }
    }
    if (max > epsilon && index !== first && index !== end) {
      keep.add(index)
      mark(first, index)
      mark(index, end)
    }
  }
  mark(0, far)
  mark(far, last)
  return points.filter((_, index) => keep.has(index))
}

function reshape(grid: Uint8Array, cols: number, rows: number, radius: number, dilate: boolean) {
  const dst = new Uint8Array(grid.length)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let on = dilate ? 0 : 1
      for (let dr = -radius; dr <= radius && (dilate ? on === 0 : on === 1); dr += 1) {
        const rr = r + dr
        if (rr < 0 || rr >= rows) {
          if (!dilate) on = 0
          continue
        }
        for (let dc = -radius; dc <= radius; dc += 1) {
          const cc = c + dc
          if (cc < 0 || cc >= cols) {
            if (!dilate) on = 0
            continue
          }
          const filled = grid[rr * cols + cc] === 1
          if (dilate && filled) {
            on = 1
            break
          }
          if (!dilate && !filled) {
            on = 0
            break
          }
        }
      }
      dst[r * cols + c] = on
    }
  }
  return dst
}

function trace(grid: Uint8Array, cols: number, rows: number, minX: number, minZ: number): [number, number][][] {
  const next = new Map<string, string[]>()
  const add = (ax: number, az: number, bx: number, bz: number) => {
    const key = `${ax},${az}`
    const list = next.get(key)
    if (list) list.push(`${bx},${bz}`)
    else next.set(key, [`${bx},${bz}`])
  }
  const filled = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && grid[r * cols + c] === 1
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (!filled(c, r)) continue
      if (!filled(c - 1, r)) add(c, r + 1, c, r)
      if (!filled(c, r - 1)) add(c, r, c + 1, r)
      if (!filled(c + 1, r)) add(c + 1, r, c + 1, r + 1)
      if (!filled(c, r + 1)) add(c + 1, r + 1, c, r + 1)
    }
  }
  const rings: [number, number][][] = []
  for (const [start, ends] of next) {
    while (ends.length > 0) {
      const ring: [number, number][] = []
      let cursor = start
      let guard = 0
      while (guard < cols * rows * 4) {
        guard += 1
        const [cx, cz] = cursor.split(",").map(Number)
        ring.push([minX + cx * CELL_M, minZ + cz * CELL_M])
        const outs = next.get(cursor)
        if (!outs || outs.length === 0) break
        const step = outs.pop() as string
        if (step === start) break
        cursor = step
      }
      if (ring.length >= 4) rings.push(simplify(ring, CELL_M * 1.4))
    }
  }
  return rings
}

export function joinedContours(polygons: [number, number][][]): [number, number][][] {
  const parts = polygons.filter((points) => points.length >= 3)
  if (parts.length === 0) return []
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const points of parts) {
    for (const [x, z] of points) {
      if (x < minX) minX = x
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (z > maxZ) maxZ = z
    }
  }
  const spanX = maxX - minX
  const spanZ = maxZ - minZ
  if (!Number.isFinite(spanX) || spanX > 8000 || spanZ > 8000) return parts
  const pad = (CLOSE_DILATE + 2) * CELL_M
  minX -= pad
  minZ -= pad
  maxX += pad
  maxZ += pad
  const cols = Math.ceil((maxX - minX) / CELL_M)
  const rows = Math.ceil((maxZ - minZ) / CELL_M)
  if (cols < 2 || rows < 2 || cols * rows > MAX_CELLS) return parts
  const grid = new Uint8Array(cols * rows)
  for (let r = 0; r < rows; r += 1) {
    const z = minZ + (r + 0.5) * CELL_M
    for (let c = 0; c < cols; c += 1) {
      const x = minX + (c + 0.5) * CELL_M
      for (const points of parts) {
        if (inside(points, x, z)) {
          grid[r * cols + c] = 1
          break
        }
      }
    }
  }
  const closed = reshape(reshape(grid, cols, rows, CLOSE_DILATE, true), cols, rows, CLOSE_ERODE, false)
  const rings = trace(closed, cols, rows, minX, minZ)
  return rings.length > 0 ? rings : parts
}
