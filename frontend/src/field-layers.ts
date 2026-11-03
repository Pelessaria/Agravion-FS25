import type { TFunction } from "i18next"
import { cropColor } from "./field-format"
import type { FieldSnapshot } from "./types"

export type FieldLayerId =
  | "off"
  | "fruit"
  | "soil"
  | "nitrogen"
  | "ph"
  | "growth"
  | "ground"
  | "weed"
  | "stones"
  | "spray"
  | "lime"

export interface FieldQuery {
  fruit: string
  crop: string
  soil: string
  nitrogen: "" | "low" | "ok"
  ph: "" | "off" | "ok"
  scan: "" | "no" | "yes"
  spray: "" | "open" | "partial" | "done"
  lime: "" | "open" | "done"
  stones: boolean
  weeds: boolean
  joined: boolean
}

export const EMPTY_FIELD_QUERY: FieldQuery = {
  fruit: "",
  crop: "",
  soil: "",
  nitrogen: "",
  ph: "",
  scan: "",
  spray: "",
  lime: "",
  stones: false,
  weeds: false,
  joined: false,
}

const SOIL_COLOR: Record<number, string> = {
  1: "#d2b48c",
  2: "#c4a36a",
  3: "#8c6b45",
  4: "#5c4636",
}

const GROUND_COLOR: Record<number, string> = {
  0: "#6d756c",
  1: "#b08a55",
  2: "#8d6844",
  3: "#c4a36a",
  4: "#6b4a32",
  5: "#d7c39a",
  6: "#a67c52",
  7: "#c9b27a",
  8: "#b7a06a",
  9: "#9aaf62",
  10: "#8f9a4e",
  11: "#d9d3c4",
  12: "#e0b44a",
  13: "#c9843a",
  14: "#5ea84a",
  15: "#8fbf6a",
}

const NEUTRAL = "#5c6560"

export function layersFor(precisionFarming: boolean | null): FieldLayerId[] {
  const shared: FieldLayerId[] = ["off", "fruit", "growth", "ground", "weed", "stones"]
  if (precisionFarming === true) return [...shared, "soil", "nitrogen", "ph"]
  return [...shared, "spray", "lime"]
}

export function paintColor(field: FieldSnapshot, layer: FieldLayerId): string {
  if (layer === "off" || layer === "fruit") return cropColor(field)
  if (layer === "soil") return field.soil != null ? (SOIL_COLOR[field.soil] ?? NEUTRAL) : NEUTRAL
  if (layer === "nitrogen") return scaleToTarget(field.nitrogen, field.nitrogenTarget, "#b64040", "#e0b44a", "#3d9a4a")
  if (layer === "ph") return distanceColor(field.ph, field.phTarget, 1)
  if (layer === "growth") {
    if (field.growth == null || field.growthMax == null || field.growthMax <= 0) return NEUTRAL
    return mix("#6b4a32", "#e0b44a", field.growth / field.growthMax)
  }
  if (layer === "ground") return field.ground != null ? (GROUND_COLOR[field.ground] ?? NEUTRAL) : NEUTRAL
  if (layer === "weed") return levelColor(field.weed, 3, "#3d9a4a", "#e0b44a", "#b64040")
  if (layer === "stones") return levelColor(field.stones, 3, "#3d9a4a", "#c4a574", "#8a8178")
  if (layer === "spray") return levelColor(field.spray, 2, "#b64040", "#e0b44a", "#3d9a4a")
  if (layer === "lime") return levelColor(field.lime, 1, "#b64040", "#d7d3c4", "#d7d3c4")
  return NEUTRAL
}

export function legendStops(layer: FieldLayerId, t: TFunction): { color: string; label: string }[] {
  if (layer === "off") return []
  if (layer === "soil") {
    return [1, 2, 3, 4].map((id) => ({ color: SOIL_COLOR[id], label: t(`fields.soilType.${id}`) }))
  }
  if (layer === "nitrogen" || layer === "ph") {
    return [
      { color: "#b64040", label: t("fields.legendLow") },
      { color: "#e0b44a", label: t("fields.legendMid") },
      { color: "#3d9a4a", label: t("fields.legendOk") },
    ]
  }
  if (layer === "growth") {
    return [
      { color: "#6b4a32", label: t("fields.legendEarly") },
      { color: "#e0b44a", label: t("fields.legendReady") },
    ]
  }
  if (layer === "ground") {
    return [0, 2, 4, 7, 12, 14, 15].map((id) => ({
      color: GROUND_COLOR[id],
      label: t(`fields.groundState.${id}`),
    }))
  }
  if (layer === "fruit") return []
  if (layer === "weed" || layer === "stones") {
    return [
      { color: "#3d9a4a", label: t("fields.legendNone") },
      { color: "#b64040", label: t("fields.legendHigh") },
    ]
  }
  return [
    { color: "#b64040", label: t("fields.legendOpen") },
    { color: "#3d9a4a", label: t("fields.legendDone") },
  ]
}

export function matchesFieldQuery(field: FieldSnapshot, query: FieldQuery, precisionFarming: boolean | null): boolean {
  if (query.fruit && (field.fruitName ?? "") !== query.fruit) return false
  if (query.crop && (field.crop ?? "") !== query.crop) return false
  if (query.joined && !(field.group && field.group.length > 1)) return false
  if (query.weeds && !(field.weed != null && field.weed > 0)) return false
  if (query.stones && !(field.stones != null && field.stones > 0)) return false
  if (precisionFarming === true) {
    if (query.soil && String(field.soil ?? "") !== query.soil) return false
    if (query.nitrogen === "low" && !belowTarget(field.nitrogen, field.nitrogenTarget)) return false
    if (query.nitrogen === "ok" && !atTarget(field.nitrogen, field.nitrogenTarget)) return false
    if (query.ph === "off" && !offTarget(field.ph, field.phTarget)) return false
    if (query.ph === "ok" && !nearTarget(field.ph, field.phTarget)) return false
    if (query.scan === "no" && field.scanned !== false) return false
    if (query.scan === "yes" && field.scanned !== true) return false
  }
  if (precisionFarming !== true) {
    if (query.spray === "open" && field.spray !== 0) return false
    if (query.spray === "partial" && field.spray !== 1) return false
    if (query.spray === "done" && !(field.spray != null && field.spray >= 2)) return false
    if (query.lime === "open" && field.lime !== 0) return false
    if (query.lime === "done" && !(field.lime != null && field.lime >= 1)) return false
  }
  return true
}

export function activeQueryCount(query: FieldQuery, precisionFarming: boolean | null): number {
  let count = 0
  if (query.fruit) count += 1
  if (query.crop) count += 1
  if (query.joined) count += 1
  if (query.weeds) count += 1
  if (query.stones) count += 1
  if (precisionFarming === true) {
    if (query.soil) count += 1
    if (query.nitrogen) count += 1
    if (query.ph) count += 1
    if (query.scan) count += 1
  }
  if (precisionFarming !== true) {
    if (query.spray) count += 1
    if (query.lime) count += 1
  }
  return count
}

function belowTarget(value: number | null, target: number | null) {
  return value != null && target != null && value < target - 0.5
}

function atTarget(value: number | null, target: number | null) {
  return value != null && target != null && value >= target - 0.5
}

function offTarget(value: number | null, target: number | null) {
  return value != null && target != null && Math.abs(value - target) >= 0.25
}

function nearTarget(value: number | null, target: number | null) {
  return value != null && target != null && Math.abs(value - target) < 0.25
}

function scaleToTarget(
  value: number | null,
  target: number | null,
  low: string,
  mid: string,
  high: string,
) {
  if (value == null || target == null || target <= 0) return NEUTRAL
  const ratio = value / target
  if (ratio >= 1) return mix(high, "#1f6b4a", Math.min(1, ratio - 1))
  return mix(low, mid, Math.max(0, ratio))
}

function distanceColor(value: number | null, target: number | null, span: number) {
  if (value == null || target == null) return NEUTRAL
  const delta = Math.min(1, Math.abs(value - target) / span)
  if (delta < 0.5) return mix("#3d9a4a", "#e0b44a", delta * 2)
  return mix("#e0b44a", "#b64040", (delta - 0.5) * 2)
}

function levelColor(value: number | null, max: number, low: string, mid: string, high: string) {
  if (value == null || max <= 0) return NEUTRAL
  const ratio = Math.min(1, Math.max(0, value / max))
  if (ratio < 0.5) return mix(low, mid, ratio * 2)
  return mix(mid, high, (ratio - 0.5) * 2)
}

function mix(from: string, to: string, amount: number) {
  const start = hex(from)
  const end = hex(to)
  const t = Math.min(1, Math.max(0, amount))
  const channel = start.map((value, index) => Math.round(value + (end[index] - value) * t))
  return `rgb(${channel[0]}, ${channel[1]}, ${channel[2]})`
}

function hex(color: string) {
  const value = color.replace("#", "")
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
}
