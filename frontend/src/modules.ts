export const APP_MODULES = [
  { id: "map", labelKey: "modules.map", path: "m/map", section: "ops" },
  { id: "weather", labelKey: "modules.weather", path: "m/weather", section: "ops" },
  { id: "fields", labelKey: "modules.fields", path: "m/fields", section: "ops" },
  { id: "equipment", labelKey: "modules.equipment", path: "equipment", section: "ops" },
  { id: "animals", labelKey: "modules.animals", path: "m/animals", section: "ops" },
  { id: "storage", labelKey: "modules.storage", path: "m/storage", section: "ops" },
  { id: "finance", labelKey: "modules.finance", path: "m/finance", section: "biz" },
  { id: "trade", labelKey: "modules.trade", path: "m/trade", section: "biz" },
  { id: "farm", labelKey: "modules.farm", path: "m/farm", section: "admin" },
  { id: "server", labelKey: "modules.server", path: "m/server", section: "admin" },
] as const

export type ModuleId = (typeof APP_MODULES)[number]["id"]
export type ModuleSection = "ops" | "biz" | "admin"

export const MODULE_SECTIONS: { id: ModuleSection; labelKey: string }[] = [
  { id: "ops", labelKey: "nav.sectionOps" },
  { id: "biz", labelKey: "nav.sectionBiz" },
  { id: "admin", labelKey: "nav.sectionAdmin" },
]

const LEGACY_MODULE_IDS: Record<string, ModuleId> = {
  invoices: "finance",
  module2: "fields",
  reports: "trade",
  vehicles: "equipment",
}

const READY_MODULES = new Set<ModuleId>(["equipment", "fields", "map", "server", "storage", "weather"])

export function moduleIsReady(id: ModuleId) {
  return READY_MODULES.has(id)
}

export function moduleById(id: string) {
  return APP_MODULES.find((item) => item.id === id) ?? null
}

export const SERVER_CAPS = ["control", "mods", "log"] as const
export type ServerCap = (typeof SERVER_CAPS)[number]

/** Older grants used read and write. Read could see mods and the log, write could also control the server. */
export function serverCapabilities(access: string | null | undefined): Record<ServerCap, boolean> {
  if (access === "write") return { control: true, mods: true, log: true }
  if (access === "read") return { control: false, mods: true, log: true }
  const parts = new Set(
    (access ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  )
  return {
    control: parts.has("control"),
    mods: parts.has("mods"),
    log: parts.has("log"),
  }
}

export function encodeServerCapabilities(caps: Record<ServerCap, boolean>): string | null {
  const on = SERVER_CAPS.filter((cap) => caps[cap])
  return on.length === 0 ? null : on.join(",")
}

export function normalizeModuleId(id: string): ModuleId | null {
  if (moduleById(id)) return id as ModuleId
  return LEGACY_MODULE_IDS[id] ?? null
}

export function normalizeModuleGrants<T extends { moduleId: string; access: string }>(
  grants: T[],
): T[] {
  const map = new Map<string, T>()
  for (const grant of grants) {
    const id = normalizeModuleId(grant.moduleId)
    if (!id) continue
    map.set(id, { ...grant, moduleId: id })
  }
  return [...map.values()]
}
