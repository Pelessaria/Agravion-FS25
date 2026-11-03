export const APP_MODULES = [
  { id: "map", labelKey: "modules.map", path: "m/map", section: "ops" },
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

const READY_MODULES = new Set<ModuleId>(["equipment", "fields", "server"])

export function moduleIsReady(id: ModuleId) {
  return READY_MODULES.has(id)
}

export function moduleById(id: string) {
  return APP_MODULES.find((item) => item.id === id) ?? null
}

export function normalizeModuleId(id: string): ModuleId | null {
  if (moduleById(id)) return id as ModuleId
  return LEGACY_MODULE_IDS[id] ?? null
}

export function normalizeModuleGrants<T extends { moduleId: string; access: "read" | "write" }>(
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
