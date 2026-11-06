import type { VehicleCategory } from "./types"

/** Gold silhouettes for base-game and DLC vehicles that have no store icon. */
const ICONS = {
  tractor: "/vehicle-icons/tractor.png",
  truck: "/vehicle-icons/truck.png",
  harvester: "/vehicle-icons/harvester.png",
  implement: "/vehicle-icons/trailer.png",
} as const

type IconSource = {
  category?: VehicleCategory | string | null
  name?: string | null
  filename?: string | null
  storeKey?: string | null
}

function isTruck(vehicle: IconSource) {
  if (vehicle.category !== "tractor") return false
  const hay = `${vehicle.name ?? ""} ${vehicle.filename ?? ""} ${vehicle.storeKey ?? ""}`.toLowerCase()
  return /truck|lkw/.test(hay)
}

export function vehicleFallbackIcon(vehicle: IconSource) {
  if (isTruck(vehicle)) return ICONS.truck
  if (vehicle.category === "harvester") return ICONS.harvester
  if (vehicle.category === "tractor") return ICONS.tractor
  if (vehicle.category === "trailer" || vehicle.category === "tool") return ICONS.implement
  return null
}
