import type { TFunction } from "i18next"
import type { FieldSnapshot } from "./types"

const CROP_COLOR: Record<string, string> = {
  wheat: "#e2c15a",
  barley: "#c9a15a",
  oat: "#ead7a4",
  canola: "#f0d23a",
  sunflower: "#f0b429",
  soybean: "#8fb356",
  corn: "#e6c34a",
  maize: "#e6c34a",
  potato: "#c4a574",
  sugarbeet: "#d07a8a",
  sugarbeetroot: "#d07a8a",
  sugarcane: "#7dae52",
  cotton: "#f4f4ec",
  grass: "#5ea84a",
  grape: "#8a5cb0",
  olive: "#8a9a4a",
  rice: "#d8d09a",
  ricelonggrain: "#e4dcb0",
  poplar: "#3e8a4a",
  oilseedradish: "#c6d46a",
  greenbean: "#3f9a62",
  pea: "#6aaa58",
  spinach: "#2f8a45",
  carrot: "#e0863a",
  parsnip: "#e6d2a0",
  beetroot: "#a33a52",
  sorghum: "#c4883a",
}

export function cropKey(name: string | null | undefined) {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function cropColor(field: Pick<FieldSnapshot, "fruitName" | "owned">) {
  const key = cropKey(field.fruitName)
  if (key && CROP_COLOR[key]) return CROP_COLOR[key]
  return "#8d9792"
}

export function projectPoint(x: number, z: number, mapSize: number) {
  const half = mapSize / 2
  return {
    x: ((x + half) / mapSize) * 100,
    y: (1 - (z + half) / mapSize) * 100,
  }
}

/** Fit outlines when the feed has not reported a map size yet. */
export function boundsMapSize(fields: FieldSnapshot[]) {
  let max = 0
  let any = false
  for (const field of fields) {
    const coords = [...field.points]
    if (field.centerX != null && field.centerZ != null) coords.push([field.centerX, field.centerZ] as [number, number])
    for (const [x, z] of coords) {
      any = true
      max = Math.max(max, Math.abs(x), Math.abs(z))
    }
  }
  if (!any || max <= 0) return null
  return Math.max(256, max * 2 * 1.08)
}

export function effectiveMapSize(mapSize: number | null, fields: FieldSnapshot[]) {
  if (mapSize != null && mapSize > 0) return mapSize
  return boundsMapSize(fields) ?? 2048
}

export function formatHa(value: number | null, language: string) {
  if (value == null || Number.isNaN(value)) return null
  return `${value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`
}

export function formatTarget(
  value: number | null,
  target: number | null,
  language: string,
  digits: number,
  unit: string,
) {
  const fmt = (amount: number) =>
    amount.toLocaleString(language, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  if (value != null && target != null) return `${fmt(value)} / ${fmt(target)} ${unit}`
  if (value != null) return `${fmt(value)} ${unit}`
  if (target != null) return `${fmt(target)} ${unit}`
  return null
}

export function formatGrowth(field: FieldSnapshot) {
  if (field.growth == null) return null
  if (field.growthMax != null && field.growthMax > 0) return `${field.growth} / ${field.growthMax}`
  return String(field.growth)
}

export function formatWindow(min: number | null, max: number | null) {
  if (min == null && max == null) return null
  if (min != null && max != null) return `${min}–${max}`
  return String(min ?? max)
}

export function namedValue(t: TFunction, group: string, value: number | null) {
  if (value == null) return null
  const key = `fields.${group}.${value}`
  const label = t(key)
  if (label === key) return t("fields.level", { value })
  return `${label} · ${value}`
}

export function cropStateLabel(t: TFunction, crop: string | null) {
  if (!crop) return null
  const key = `fields.crop.${crop}`
  const label = t(key)
  return label === key ? crop : label
}

export function levelLabel(t: TFunction, value: number | null) {
  if (value == null) return null
  return t("fields.level", { value })
}
