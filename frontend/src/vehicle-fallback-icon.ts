import harvester from "./assets/vehicle-icons/harvester.png"
import tractor from "./assets/vehicle-icons/tractor.png"
import trailer from "./assets/vehicle-icons/trailer.png"
import truck from "./assets/vehicle-icons/truck.png"
import type { VehicleCategory } from "./types"

/** Gold silhouettes for base-game and DLC vehicles that have no store icon. */
const ICONS = {
  tractor,
  truck,
  harvester,
  implement: trailer,
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
