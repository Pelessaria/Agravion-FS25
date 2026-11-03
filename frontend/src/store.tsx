import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  apiCreateWorkspace,
  apiDeleteHostAccess,
  apiIsLive,
  apiLogin,
  apiLogout,
  apiMe,
  apiUsers,
  apiProbeHostAccess,
  apiSaveHostAccess,
  apiSelectSavegame,
  apiSyncWorkspace,
  apiUpdateWorkspace,
  apiWorkspaces,
  type HostAccessPayload,
} from "./api"
import { seedActivity, seedFarms, seedUsers, seedVehicles, seedWorkspaces, demoCode } from "./demo"
import { seedGroups } from "./groups"
import { defaultMailSettings, normalizeMailSettings } from "./mail"
import { normalizeModuleGrants } from "./modules"
import type {
  AccessGroup,
  ActivityItem,
  AppUser,
  Farm,
  GlobalRole,
  MailSettings,
  ModuleAccess,
  ModuleGrant,
  ToastItem,
  Vehicle,
  Workspace,
  WorkspaceRole,
} from "./types"

const STORAGE_KEY = "fs25.prototype.v1"
const FARM_SELECTION_KEY = "fs25.farmSelection.v1"

interface Persisted {
  users: AppUser[]
  workspaces: Workspace[]
  vehicles: Vehicle[]
  activity: ActivityItem[]
  groups: AccessGroup[]
  mailSettings: MailSettings
  sessionUserId: string | null
  viewUserId: string | null
}

export type ProfilePatch = Partial<
  Pick<
    AppUser,
    "firstName" | "lastName" | "alias" | "notificationEmail" | "avatarDataUrl" | "twoFactorEnabled" | "name"
  >
>

interface Store {
  users: AppUser[]
  workspaces: Workspace[]
  farms: Farm[]
  vehicles: Vehicle[]
  activity: ActivityItem[]
  groups: AccessGroup[]
  mailSettings: MailSettings
  sessionUserId: string | null
  viewUserId: string | null
  actor: AppUser | null
  accessibleWorkspaces: Workspace[]
  selectedFarmByWorkspace: Record<string, string>
  reveals: Record<string, string>
  toasts: ToastItem[]
  /** true when talking to Laravel /api; false = local demo prototype */
  liveMode: boolean
  /** false until first API probe finished */
  ready: boolean
  signIn: (email: string, password: string) => Promise<"ok" | "failed">
  signOut: () => Promise<void>
  setViewUser: (id: string) => void
  canOpen: (workspaceId: string) => boolean
  canManageWorkspace: (workspaceId: string) => boolean
  canManageUsers: () => boolean
  canCreateWorkspace: () => boolean
  accessibleFarms: (workspaceId: string) => Farm[]
  selectedFarm: (workspaceId: string) => Farm | null
  setSelectedFarm: (workspaceId: string, farmId: string) => void
  farmByGameId: (workspaceId: string, gameFarmId: number | null) => Farm | null
  createWorkspace: (name: string) => Promise<{ workspace: Workspace; code: string }>
  renameWorkspace: (id: string, name: string) => Promise<void>
  setFeedUrl: (id: string, feedUrl: string) => Promise<{ ok: boolean; error?: string }>
  setHostAccess: (
    id: string,
    payload: HostAccessPayload,
  ) => Promise<{ ok: boolean; error?: string; workspace?: Workspace }>
  probeHostAccess: (id: string) => Promise<{ ok: boolean; error?: string; workspace?: Workspace }>
  selectSavegame: (
    workspaceId: string,
    savegameId: number | string,
  ) => Promise<{ ok: boolean; error?: string; workspace?: Workspace }>
  clearHostAccess: (id: string) => Promise<void>
  setDisabled: (id: string, disabled: boolean) => Promise<void>
  testConnection: (id: string) => Promise<"ok" | "offline" | "unpaired" | "disabled">
  refreshWorkspaces: (options?: { sync?: boolean }) => Promise<void>
  upsertWorkspace: (workspace: Workspace) => void
  replaceWorkspaceFarms: (workspaceId: string, farms: Farm[]) => void
  replaceWorkspaceVehicles: (workspaceId: string, vehicles: Vehicle[]) => void
  revealCode: (id: string) => string
  hideCode: (id: string) => void
  createUser: (name: string, email: string) => string | "taken"
  setUserActive: (id: string, active: boolean) => void
  setGlobalRole: (id: string, role: GlobalRole) => void
  updateProfile: (id: string, patch: ProfilePatch) => void
  setMailSettings: (settings: MailSettings) => void
  assign: (userId: string, workspaceId: string, role: WorkspaceRole) => void
  setModuleAccess: (userId: string, workspaceId: string, moduleId: string, access: ModuleAccess | null) => void
  moduleAccess: (workspaceId: string, moduleId: string) => ModuleAccess | null
  unassign: (userId: string, workspaceId: string) => void
  createGroup: (input: Omit<AccessGroup, "id" | "system" | "memberIds">) => string
  updateGroup: (id: string, patch: Partial<Omit<AccessGroup, "id" | "system" | "memberIds">>) => void
  deleteGroup: (id: string) => boolean
  setGroupMember: (groupId: string, userId: string, enabled: boolean) => void
  pushToast: (tone: ToastItem["tone"], text: string) => void
  dismissToast: (id: string) => void
}

const StoreContext = createContext<Store | null>(null)

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  }
}

function displayName(firstName: string, lastName: string, fallback: string) {
  const combined = `${firstName} ${lastName}`.trim()
  return combined || fallback
}

function normalizeUser(user: AppUser, seed?: AppUser): AppUser {
  const role = String(user.globalRole)
  const fromName = splitName(user.name || seed?.name || "")
  return {
    ...user,
    globalRole: role === "realm_admin" || role === "admin" ? "admin" : "member",
    firstName: user.firstName ?? seed?.firstName ?? fromName.firstName,
    lastName: user.lastName ?? seed?.lastName ?? fromName.lastName,
    alias: user.alias ?? seed?.alias ?? "",
    notificationEmail: user.notificationEmail ?? seed?.notificationEmail ?? user.email,
    avatarDataUrl: user.avatarDataUrl ?? seed?.avatarDataUrl ?? null,
    twoFactorEnabled: user.twoFactorEnabled ?? seed?.twoFactorEnabled ?? false,
    groupIds: Array.isArray(user.groupIds) ? user.groupIds : (seed?.groupIds ?? []),
    memberships: (user.memberships ?? []).map((membership) => {
      const seedMembership = seed?.memberships.find((item) => item.workspaceId === membership.workspaceId)
      const raw = Array.isArray(membership.modules)
        ? membership.modules
        : (seedMembership?.modules ?? [])
      return {
        ...membership,
        farmIds:
          membership.farmIds === undefined
            ? (seedMembership?.farmIds ?? null)
            : membership.farmIds,
        modules: normalizeModuleGrants(raw),
      }
    }),
  }
}

function loadFarmSelection(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(FARM_SELECTION_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeVehicle(vehicle: Vehicle): Vehicle {
  return {
    ...vehicle,
    iconUrl: vehicle.iconUrl ?? null,
    modIconUrl: vehicle.modIconUrl ?? null,
    storeKey: vehicle.storeKey ?? null,
    modKey: vehicle.modKey ?? null,
    filename: vehicle.filename ?? null,
    brand: vehicle.brand ?? null,
    fuel: vehicle.fuel ?? null,
    fuelCapacity: vehicle.fuelCapacity ?? null,
    defLevel: vehicle.defLevel ?? null,
    defCapacity: vehicle.defCapacity ?? null,
    wear: vehicle.wear ?? null,
    plate: vehicle.plate ?? null,
  }
}

function applyGroupTemplate(user: AppUser, group: AccessGroup): AppUser {
  let next: AppUser = {
    ...user,
    groupIds: user.groupIds.includes(group.id) ? user.groupIds : [...user.groupIds, group.id],
  }
  if (group.grantsPlatformAdmin) {
    next = { ...next, globalRole: "admin" }
  }
  if (!group.workspaceRole) return next
  let memberships = [...next.memberships]
  for (const workspaceId of group.workspaceIds) {
    memberships = memberships.filter((item) => item.workspaceId !== workspaceId)
    memberships.push({
      workspaceId,
      role: group.workspaceRole,
      modules: group.modules.map((item) => ({ ...item })),
    })
  }
  return { ...next, memberships }
}

function revokeGroupTemplate(user: AppUser, group: AccessGroup, remaining: AccessGroup[]): AppUser {
  const groupIds = user.groupIds.filter((id) => id !== group.id)
  let next: AppUser = { ...user, groupIds }
  const stillAdmin = remaining.some((item) => item.memberIds.includes(user.id) && item.grantsPlatformAdmin)
  if (group.grantsPlatformAdmin && !stillAdmin) {
    next = { ...next, globalRole: "member" }
  }
  if (!group.workspaceRole) return next
  const covered = new Set(
    remaining
      .filter((item) => item.memberIds.includes(user.id) && item.workspaceRole)
      .flatMap((item) => item.workspaceIds),
  )
  return {
    ...next,
    memberships: next.memberships.filter(
      (membership) => !group.workspaceIds.includes(membership.workspaceId) || covered.has(membership.workspaceId),
    ),
  }
}

function load(): Persisted {
  const fallback: Persisted = {
    users: seedUsers,
    workspaces: seedWorkspaces,
    vehicles: seedVehicles,
    activity: seedActivity,
    groups: seedGroups,
    mailSettings: defaultMailSettings,
    sessionUserId: null,
    viewUserId: null,
  }
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Persisted
    if (!Array.isArray(parsed.workspaces) || !Array.isArray(parsed.users)) return fallback
    const groups = (Array.isArray(parsed.groups) && parsed.groups.length > 0 ? parsed.groups : seedGroups).map(
      (group) => ({
        ...group,
        modules: normalizeModuleGrants(group.modules ?? []),
      }),
    )
    return {
      ...fallback,
      ...parsed,
      groups,
      mailSettings: normalizeMailSettings(parsed.mailSettings),
      workspaces: parsed.workspaces.map((workspace, index) => {
        const seed = seedWorkspaces.find((item) => item.id === workspace.id)
        const connectorVersion =
          workspace.connectorVersion === "0.0.0-demo" && seed ? seed.connectorVersion : (workspace.connectorVersion ?? null)
        return {
          ...workspace,
          number: typeof workspace.number === "number" ? workspace.number : (seed?.number ?? index + 1),
          feedUrl: workspace.feedUrl ?? "",
          disabled: workspace.disabled ?? false,
          connectorVersion,
        }
      }),
      users: parsed.users.map((user) => normalizeUser(user, seedUsers.find((item) => item.id === user.id))),
      vehicles: Array.isArray(parsed.vehicles)
        ? parsed.vehicles.map(normalizeVehicle)
        : seedVehicles,
    }
  } catch {
    return fallback
  }
}

function roleOf(user: AppUser, workspaceId: string): WorkspaceRole | GlobalRole | null {
  if (user.globalRole === "admin" && user.active) return "admin"
  const membership = user.memberships.find((item) => item.workspaceId === workspaceId)
  if (!user.active || !membership) return null
  return membership.role
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const initial = load()
  const [users, setUsers] = useState(initial.users)
  const [workspaces, setWorkspaces] = useState(initial.workspaces)
  const [farms, setFarms] = useState(seedFarms)
  const [vehicles, setVehicles] = useState(initial.vehicles)
  const [activity] = useState(initial.activity)
  const [groups, setGroups] = useState(initial.groups)
  const [mailSettings, setMailSettingsState] = useState(initial.mailSettings)
  const [liveMode, setLiveMode] = useState(false)
  const [ready, setReady] = useState(false)
  const [sessionUserId, setSessionUserId] = useState(initial.sessionUserId)
  const [viewUserId, setViewUserId] = useState(initial.viewUserId)
  const [selectedFarmByWorkspace, setSelectedFarmByWorkspace] = useState(loadFarmSelection)
  const [reveals, setReveals] = useState<Record<string, string>>({})
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const live = await apiIsLive()
      if (cancelled) return
      if (!live) {
        setLiveMode(false)
        setReady(true)
        return
      }
      setLiveMode(true)
      setFarms([])
      setVehicles([])
      try {
        const me = await apiMe()
        if (cancelled) return
        if (me) {
          setUsers([me])
          setSessionUserId(me.id)
          setViewUserId(me.id)
          if (me.globalRole === "admin") {
            try {
              const directory = await apiUsers()
              if (!cancelled && directory.length > 0) setUsers(directory)
            } catch {
              // The signed-in account stays in the list when the directory cannot be loaded.
            }
          }
          const list = await apiWorkspaces()
          if (!cancelled) setWorkspaces(list)
        } else {
          setSessionUserId(null)
          setViewUserId(null)
          setWorkspaces([])
        }
      } catch {
        // API probe succeeded but session hydrate failed — stay logged out in live mode.
        setSessionUserId(null)
        setViewUserId(null)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (liveMode) return
    const payload: Persisted = {
      users,
      workspaces,
      vehicles,
      activity,
      groups,
      mailSettings,
      sessionUserId,
      viewUserId,
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [liveMode, users, workspaces, vehicles, activity, groups, mailSettings, sessionUserId, viewUserId])

  useEffect(() => {
    sessionStorage.setItem(FARM_SELECTION_KEY, JSON.stringify(selectedFarmByWorkspace))
  }, [selectedFarmByWorkspace])

  const actor = useMemo(() => {
    const id = viewUserId ?? sessionUserId
    return users.find((user) => user.id === id) ?? null
  }, [users, viewUserId, sessionUserId])

  const accessibleWorkspaces = useMemo(() => {
    if (!actor?.active) return []
    if (actor.globalRole === "admin") return workspaces
    const allowed = new Set(actor.memberships.map((item) => item.workspaceId))
    return workspaces.filter((workspace) => allowed.has(workspace.id))
  }, [actor, workspaces])

  function accessibleFarms(workspaceId: string) {
    const inWorkspace = farms
      .filter((farm) => farm.workspaceId === workspaceId)
      .sort((a, b) => a.gameFarmId - b.gameFarmId)
    if (!actor?.active) return []
    if (actor.globalRole === "admin") return inWorkspace
    const membership = actor.memberships.find((item) => item.workspaceId === workspaceId)
    if (!membership) return []
    if (membership.role === "workspace_admin") return inWorkspace
    if (membership.farmIds == null) return inWorkspace
    const allowed = new Set(membership.farmIds)
    return inWorkspace.filter((farm) => allowed.has(farm.gameFarmId))
  }

  function selectedFarm(workspaceId: string) {
    const list = accessibleFarms(workspaceId)
    if (list.length === 0) return null
    const chosen = selectedFarmByWorkspace[workspaceId]
    return list.find((farm) => farm.id === chosen) ?? list[0]
  }

  function setSelectedFarm(workspaceId: string, farmId: string) {
    const list = accessibleFarms(workspaceId)
    if (!list.some((farm) => farm.id === farmId)) return
    setSelectedFarmByWorkspace((current) => ({ ...current, [workspaceId]: farmId }))
  }

  function farmByGameId(workspaceId: string, gameFarmId: number | null) {
    if (gameFarmId === null) return null
    return farms.find((farm) => farm.workspaceId === workspaceId && farm.gameFarmId === gameFarmId) ?? null
  }

  function pushToast(tone: ToastItem["tone"], text: string) {
    const id = crypto.randomUUID()
    setToasts((current) => [...current, { id, tone, text }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id))
    }, 4200)
  }

  function moduleAccess(workspaceId: string, moduleId: string): ModuleAccess | null {
    if (!actor?.active) return null
    if (actor.globalRole === "admin") return "write"
    const membership = actor.memberships.find((item) => item.workspaceId === workspaceId)
    if (!membership) return null
    if (membership.role === "workspace_admin") return "write"
    return membership.modules.find((item) => item.moduleId === moduleId)?.access ?? null
  }

  function canOpen(workspaceId: string) {
    if (!actor) return false
    return roleOf(actor, workspaceId) !== null
  }

  function canManageWorkspace(workspaceId: string) {
    if (!actor) return false
    const role = roleOf(actor, workspaceId)
    return role === "admin" || role === "workspace_admin" || role === "manager"
  }

  function canManageUsers() {
    return actor?.globalRole === "admin" && actor.active
  }

  function canCreateWorkspace() {
    return canManageUsers()
  }

  const value: Store = {
    users,
    workspaces,
    farms,
    vehicles,
    activity,
    groups,
    mailSettings,
    sessionUserId,
    viewUserId,
    actor,
    accessibleWorkspaces,
    selectedFarmByWorkspace,
    reveals,
    toasts,
    liveMode,
    ready,
    signIn: async (email, password) => {
      if (!liveMode) {
        if (password === "wrong-password") return "failed"
        setSessionUserId("mira")
        setViewUserId("mira")
        return "ok"
      }
      try {
        const me = await apiLogin(email, password)
        setUsers([me])
        setSessionUserId(me.id)
        setViewUserId(me.id)
        const list = await apiWorkspaces()
        setWorkspaces(list)
        return "ok"
      } catch {
        return "failed"
      }
    },
    signOut: async () => {
      if (liveMode) {
        try {
          await apiLogout()
        } catch {
          /* ignore */
        }
      }
      setSessionUserId(null)
      setViewUserId(null)
      if (liveMode) setWorkspaces([])
    },
    setViewUser: (id) => setViewUserId(id),
    canOpen,
    canManageWorkspace,
    canManageUsers,
    canCreateWorkspace,
    accessibleFarms,
    selectedFarm,
    setSelectedFarm,
    farmByGameId,
    moduleAccess,
    createWorkspace: async (name) => {
      if (liveMode) {
        const result = await apiCreateWorkspace(name)
        setWorkspaces((current) => [...current, result.workspace])
        setReveals((current) => ({ ...current, [result.workspace.id]: result.pairingCode }))
        return { workspace: result.workspace, code: result.pairingCode }
      }
      const workspace: Workspace = {
        id: crypto.randomUUID(),
        number: workspaces.reduce((max, item) => Math.max(max, item.number), 0) + 1,
        name,
        linkState: "unpaired",
        disabled: false,
        mapName: null,
        playersOnline: null,
        playerCapacity: null,
        gameTime: null,
        lastSeenAt: null,
        lastSyncAt: null,
        connectorVersion: null,
        notice: "unpaired",
        feedUrl: "",
      }
      setWorkspaces((current) => [workspace, ...current])
      const code = demoCode()
      setReveals((current) => ({ ...current, [workspace.id]: code }))
      return { workspace, code }
    },
    renameWorkspace: async (id, name) => {
      if (liveMode) {
        const result = await apiUpdateWorkspace(id, { name })
        setWorkspaces((current) => current.map((item) => (item.id === id ? result.workspace : item)))
        return
      }
      setWorkspaces((current) =>
        current.map((workspace) => (workspace.id === id ? { ...workspace, name } : workspace)),
      )
    },
    setFeedUrl: async (id, feedUrl) => {
      if (liveMode) {
        const trimmed = feedUrl.trim()
        const existing = workspaces.find((item) => item.id === id)
        const keepCode = Boolean(existing?.feedConfigured && trimmed && !trimmed.includes("code="))
        try {
          const result = await apiUpdateWorkspace(id, {
            feedUrl: trimmed,
            keepCode,
            sync: trimmed !== "",
          })
          setWorkspaces((current) => current.map((item) => (item.id === id ? result.workspace : item)))
          if (!result.ok) return { ok: false, error: result.error }
          return { ok: true }
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "Feed speichern fehlgeschlagen",
          }
        }
      }
      setWorkspaces((current) =>
        current.map((workspace) => (workspace.id === id ? { ...workspace, feedUrl } : workspace)),
      )
      return { ok: true }
    },
    setHostAccess: async (id, payload) => {
      if (!liveMode) return { ok: false, error: "Nur im Live-Modus" }
      try {
        const result = await apiSaveHostAccess(id, payload)
        setWorkspaces((current) => current.map((item) => (item.id === id ? result.workspace : item)))
        if (result.farms) {
          setFarms((current) => [...current.filter((farm) => farm.workspaceId !== id), ...result.farms])
        }
        if (!result.ok) return { ok: false, error: result.error ?? undefined, workspace: result.workspace }
        return { ok: true, workspace: result.workspace }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Dateizugang speichern fehlgeschlagen",
        }
      }
    },
    probeHostAccess: async (id) => {
      if (!liveMode) return { ok: false, error: "Nur im Live-Modus" }
      try {
        const result = await apiProbeHostAccess(id)
        setWorkspaces((current) => current.map((item) => (item.id === id ? result.workspace : item)))
        if (result.farms) {
          setFarms((current) => [...current.filter((farm) => farm.workspaceId !== id), ...result.farms])
        }
        if (!result.ok) return { ok: false, error: result.error ?? undefined, workspace: result.workspace }
        return { ok: true, workspace: result.workspace }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Dateizugang prüfen fehlgeschlagen",
        }
      }
    },
    selectSavegame: async (workspaceId, savegameId) => {
      if (!liveMode) return { ok: false, error: "Nur im Live-Modus" }
      try {
        const result = await apiSelectSavegame(workspaceId, savegameId)
        setWorkspaces((current) =>
          current.map((item) => (item.id === workspaceId ? result.workspace : item)),
        )
        if (result.farms) {
          setFarms((current) => [
            ...current.filter((farm) => farm.workspaceId !== workspaceId),
            ...result.farms,
          ])
        }
        if (!result.ok) return { ok: false, error: result.error ?? undefined, workspace: result.workspace }
        return { ok: true, workspace: result.workspace }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Savegame wechseln fehlgeschlagen",
        }
      }
    },
    clearHostAccess: async (id) => {
      if (!liveMode) return
      const result = await apiDeleteHostAccess(id)
      setWorkspaces((current) => current.map((item) => (item.id === id ? result.workspace : item)))
    },
    setDisabled: async (id, disabled) => {
      if (liveMode) {
        const result = await apiUpdateWorkspace(id, { disabled })
        setWorkspaces((current) => current.map((item) => (item.id === id ? result.workspace : item)))
        return
      }
      setWorkspaces((current) =>
        current.map((workspace) => (workspace.id === id ? { ...workspace, disabled } : workspace)),
      )
    },
    testConnection: async (id) => {
      const workspace = workspaces.find((item) => item.id === id)
      if (!workspace || workspace.disabled) return "disabled"
      if (liveMode) {
        if (!workspace.feedConfigured && !workspace.feedUrl) return "unpaired"
        try {
          const result = await apiSyncWorkspace(id)
          setWorkspaces((current) => current.map((item) => (item.id === id ? result.workspace : item)))
          if (!result.ok) return "offline"
          return result.workspace.linkState === "online" ? "ok" : "offline"
        } catch {
          return "offline"
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700))
      if (workspace.linkState === "unpaired") return "unpaired"
      if (workspace.linkState === "offline" || workspace.linkState === "error") return "offline"
      const stamp = new Date().toISOString()
      setWorkspaces((current) =>
        current.map((item) => (item.id === id ? { ...item, lastSeenAt: stamp } : item)),
      )
      return "ok"
    },
    refreshWorkspaces: async (options) => {
      if (!liveMode) return
      const list = await apiWorkspaces()
      setWorkspaces(list)
      if (!options?.sync) return

      // Fire-and-forget parallel light probes — overview must not wait on dead hosts.
      const targets = list.filter((workspace) => !workspace.disabled && workspace.feedConfigured)
      void Promise.allSettled(
        targets.map(async (workspace) => {
          try {
            const result = await apiSyncWorkspace(workspace.id, { light: true })
            setWorkspaces((current) =>
              current.map((item) => (item.id === workspace.id ? result.workspace : item)),
            )
          } catch {
            // Keep previous row for this host.
          }
        }),
      )
    },
    upsertWorkspace: (workspace) => {
      setWorkspaces((current) => {
        const index = current.findIndex((item) => item.id === workspace.id)
        if (index < 0) return [...current, workspace]
        return current.map((item) => (item.id === workspace.id ? workspace : item))
      })
    },
    replaceWorkspaceFarms: (workspaceId, next) => {
      setFarms((current) => [...current.filter((farm) => farm.workspaceId !== workspaceId), ...next])
    },
    replaceWorkspaceVehicles: (workspaceId, next) => {
      setVehicles((current) => [
        ...current.filter((vehicle) => vehicle.workspaceId !== workspaceId),
        ...next,
      ])
    },
    revealCode: (id) => {
      const code = demoCode()
      setReveals((current) => ({ ...current, [id]: code }))
      return code
    },
    hideCode: (id) => {
      setReveals((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
    },
    createUser: (name, email) => {
      const normalized = email.trim().toLowerCase()
      if (users.some((user) => user.email === normalized)) return "taken"
      const trimmed = name.trim()
      const parts = splitName(trimmed)
      const user: AppUser = {
        id: crypto.randomUUID(),
        name: trimmed,
        email: normalized,
        firstName: parts.firstName,
        lastName: parts.lastName,
        alias: "",
        notificationEmail: normalized,
        avatarDataUrl: null,
        twoFactorEnabled: false,
        globalRole: "member",
        active: true,
        memberships: [],
        groupIds: [],
      }
      setUsers((current) => [...current, user])
      return user.id
    },
    setUserActive: (id, active) => {
      setUsers((current) => current.map((user) => (user.id === id ? { ...user, active } : user)))
    },
    updateProfile: (id, patch) => {
      setUsers((current) =>
        current.map((user) => {
          if (user.id !== id) return user
          const firstName = patch.firstName ?? user.firstName
          const lastName = patch.lastName ?? user.lastName
          const name = patch.name ?? displayName(firstName, lastName, user.name)
          return {
            ...user,
            ...patch,
            firstName,
            lastName,
            name,
          }
        }),
      )
    },
    setMailSettings: (settings) => {
      setMailSettingsState(normalizeMailSettings(settings))
    },
    setGlobalRole: (id, role) => {
      const adminGroup = groups.find((group) => group.grantsPlatformAdmin)
      setGroups((current) =>
        current.map((group) => {
          if (!group.grantsPlatformAdmin) return group
          const memberIds =
            role === "admin"
              ? group.memberIds.includes(id)
                ? group.memberIds
                : [...group.memberIds, id]
              : group.memberIds.filter((memberId) => memberId !== id)
          return { ...group, memberIds }
        }),
      )
      setUsers((current) =>
        current.map((user) => {
          if (user.id !== id) return user
          if (!adminGroup) return { ...user, globalRole: role }
          const groupIds =
            role === "admin"
              ? user.groupIds.includes(adminGroup.id)
                ? user.groupIds
                : [...user.groupIds, adminGroup.id]
              : user.groupIds.filter((groupId) => groupId !== adminGroup.id)
          return { ...user, globalRole: role, groupIds }
        }),
      )
    },
    assign: (userId, workspaceId, role) => {
      setUsers((current) =>
        current.map((user) => {
          if (user.id !== userId) return user
          const previous = user.memberships.find((item) => item.workspaceId === workspaceId)
          const memberships = user.memberships.filter((item) => item.workspaceId !== workspaceId)
          return {
            ...user,
            memberships: [
              ...memberships,
              {
                workspaceId,
                role,
                modules: previous?.modules ?? [],
                farmIds: previous?.farmIds ?? null,
              },
            ],
          }
        }),
      )
    },
    setModuleAccess: (userId, workspaceId, moduleId, access) => {
      setUsers((current) =>
        current.map((user) => {
          if (user.id !== userId) return user
          const membership = user.memberships.find((item) => item.workspaceId === workspaceId)
          if (!membership) return user
          const modules = membership.modules.filter((item) => item.moduleId !== moduleId)
          return {
            ...user,
            memberships: user.memberships.map((item) =>
              item.workspaceId === workspaceId
                ? { ...item, modules: access ? [...modules, { moduleId, access }] : modules }
                : item,
            ),
          }
        }),
      )
    },
    unassign: (userId, workspaceId) => {
      setUsers((current) =>
        current.map((user) =>
          user.id === userId
            ? { ...user, memberships: user.memberships.filter((item) => item.workspaceId !== workspaceId) }
            : user,
        ),
      )
    },
    createGroup: (input) => {
      const id = crypto.randomUUID()
      const group: AccessGroup = { ...input, id, system: false, memberIds: [] }
      setGroups((current) => [...current, group])
      return id
    },
    updateGroup: (id, patch) => {
      setGroups((current) =>
        current.map((group) => {
          if (group.id !== id) return group
          return {
            ...group,
            ...patch,
            name: patch.name?.trim() || group.name,
            modules: patch.modules
              ? normalizeModuleGrants(patch.modules as ModuleGrant[])
              : group.modules,
          }
        }),
      )
    },
    deleteGroup: (id) => {
      const group = groups.find((item) => item.id === id)
      if (!group || group.system) return false
      setGroups((current) => current.filter((item) => item.id !== id))
      setUsers((current) =>
        current.map((user) =>
          user.groupIds.includes(id)
            ? revokeGroupTemplate(user, group, groups.filter((item) => item.id !== id))
            : user,
        ),
      )
      return true
    },
    setGroupMember: (groupId, userId, enabled) => {
      const group = groups.find((item) => item.id === groupId)
      if (!group) return
      const nextGroup: AccessGroup = {
        ...group,
        memberIds: enabled
          ? group.memberIds.includes(userId)
            ? group.memberIds
            : [...group.memberIds, userId]
          : group.memberIds.filter((id) => id !== userId),
      }
      const nextGroups = groups.map((item) => (item.id === groupId ? nextGroup : item))
      setGroups(nextGroups)
      setUsers((current) =>
        current.map((user) => {
          if (user.id !== userId) return user
          return enabled
            ? applyGroupTemplate(user, nextGroup)
            : revokeGroupTemplate(user, group, nextGroups)
        }),
      )
    },
    pushToast,
    dismissToast: (id) => setToasts((current) => current.filter((item) => item.id !== id)),
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

// oxlint-disable-next-line react/only-export-components -- hook sits beside the provider
export function useStore() {
  const store = useContext(StoreContext)
  if (!store) throw new Error("Store missing")
  return store
}
