export type MapCamera = { x: number; y: number; k: number }
export type MapSheet = { left: number; top: number; size: number }

type FrameCrop = { scaleX: number; scaleZ: number; padX: number; padZ: number }

export function sheetFor(view: { w: number; h: number }, frame: FrameCrop): MapSheet {
  const cropW = frame.scaleX > 0.05 ? frame.scaleX : 1
  const cropH = frame.scaleZ > 0.05 ? frame.scaleZ : 1
  if (view.w < 8 || view.h < 8) return { left: 0, top: 0, size: Math.max(view.w, view.h, 1) }
  const size = Math.max(view.w / cropW, view.h / cropH)
  return {
    size,
    left: (view.w - size * cropW) / 2 - size * frame.padX,
    top: (view.h - size * cropH) / 2 - size * frame.padZ,
  }
}

/** Keep the map on screen, and still allow a slide when one edge sticks out. */
export function clampCamera(cam: MapCamera, view: { w: number; h: number }, sheet: MapSheet): MapCamera {
  if (view.w < 8 || view.h < 8) return cam
  const k = cam.k
  const right = sheet.left + sheet.size
  const bottom = sheet.top + sheet.size
  const minX = view.w - right * k
  const maxX = -sheet.left * k
  const minY = view.h - bottom * k
  const maxY = -sheet.top * k
  return {
    x: minX <= maxX ? Math.min(maxX, Math.max(minX, cam.x)) : (minX + maxX) / 2,
    y: minY <= maxY ? Math.min(maxY, Math.max(minY, cam.y)) : (minY + maxY) / 2,
    k,
  }
}

function storageKey(userId: string, scope: string) {
  return `agrivision.mapView.${userId}.${scope}`
}

export function readMapView(userId: string | null, scope: string): MapCamera | null {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(storageKey(userId, scope))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MapCamera>
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number" || typeof parsed.k !== "number") return null
    if (![parsed.x, parsed.y, parsed.k].every(Number.isFinite)) return null
    return { x: parsed.x, y: parsed.y, k: Math.min(10, Math.max(1, parsed.k)) }
  } catch {
    return null
  }
}

export function writeMapView(userId: string | null, scope: string, cam: MapCamera | null) {
  if (!userId) return
  const key = storageKey(userId, scope)
  if (cam == null) {
    localStorage.removeItem(key)
    return
  }
  localStorage.setItem(key, JSON.stringify({ x: cam.x, y: cam.y, k: cam.k }))
}
