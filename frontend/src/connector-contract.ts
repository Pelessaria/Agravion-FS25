/**
 * Mirrors docs/CONNECTOR-CONTRACT.md for the React prototype / future API client.
 * Missing optional fields → UI shows unavailable (never invent values).
 */

export const CONNECTOR_SCHEMA = "1"
export const CONNECTOR_MOD_NAME = "FS25_AgravionConnector"

export type ConnectorFarmSnapshot = {
  gameFarmId: number
  name: string | null
  money: number | null
}

export type ConnectorVehicleSnapshot = {
  uniqueId: string
  filename: string
  farmId: number | null
  name: string | null
  category: string | null
  operatingTime: number | null
  /** Vehicle store-image key (type-level). */
  storeKey: string | null
  /** Mod pack key — later for mod list UI. */
  modKey: string | null
  x: number | null
  y: number | null
  z: number | null
}

export type ConnectorIconEntry = {
  /** storeKey for vehicle icons, or modKey for deferred mod-pack icons. */
  key: string
  name: string
  author: string | null
  version: string | null
  /** Relative path under modSettings connector folder, e.g. icons/store/….png */
  iconFile: string
  kind?: "store" | "mod"
}

export type ConnectorHello = {
  version: string
  schema: string
  generation: number
  writtenAtUtc: string
  gameTimeMs: number | null
  farms: ConnectorFarmSnapshot[]
}

export type VehiclesFullSnapshot = {
  schema: string
  generation: number
  writtenAtUtc: string
  kind: "full"
  vehicles: ConnectorVehicleSnapshot[]
}

export type IconsManifest = {
  schema: string
  generation: number
  writtenAtUtc: string
  scan: "startup" | "modlist-changed" | "vehicles"
  kind?: "store" | "mod"
  mods: ConnectorIconEntry[]
}

/** Merge rules used later by the backend / prototype adapters. */
export const SYNC_POLICY = {
  /** Full vehicle inventory on pair / save reload; deltas while running. */
  vehicles: "full-then-delta" as const,
  /** Icon scan only on server start or mod list change; GC via manifest. */
  icons: "startup-and-modlist" as const,
  /** Primary transport for connector files. */
  transport: "modSettings-file-pull" as const,
  /** Optional later; not required for v0. */
  luaHttps: "probe-only" as const,
} as const
