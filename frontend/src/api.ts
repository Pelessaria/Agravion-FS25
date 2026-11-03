import type { AppUser, Farm, FieldsResponse, HostProtocol, Vehicle, Workspace, WorkspaceSavegame } from "./types"

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function readApiErrorMessage(data: Record<string, unknown>, status: number): string {
  if (typeof data.error === "string" && data.error.trim() !== "") return data.error
  if (typeof data.message === "string" && data.message.trim() !== "") {
    // Laravel validation: message + errors bag
    const errors = data.errors
    if (errors && typeof errors === "object") {
      const first = Object.values(errors as Record<string, unknown>)
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .find((value): value is string => typeof value === "string" && value.trim() !== "")
      if (first) return first
    }
    return data.message
  }
  const errors = data.errors
  if (errors && typeof errors === "object") {
    const first = Object.values(errors as Record<string, unknown>)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .find((value): value is string => typeof value === "string" && value.trim() !== "")
    if (first) return first
  }
  return `HTTP ${status}`
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&")}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

async function ensureCsrf(): Promise<void> {
  await fetch("/api/csrf-cookie", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  })
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    await ensureCsrf()
  }

  const headers = new Headers(init.headers)
  headers.set("Accept", "application/json")
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json")
  }
  const xsrf = readCookie("XSRF-TOKEN")
  if (xsrf) headers.set("X-XSRF-TOKEN", xsrf)

  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  })

  if (response.status === 204) {
    return undefined as T
  }

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const message = readApiErrorMessage(data, response.status)
    throw new ApiError(response.status, message)
  }

  return data as T
}

export async function apiUsers(): Promise<AppUser[]> {
  const data = await apiFetch<{ users: AppUser[] }>("/api/users")
  return data.users
}

export async function apiSaveModuleAccess(
  workspaceId: string,
  userId: string,
  moduleId: string,
  access: "none" | "read" | "write",
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/modules/access`, {
    method: "PUT",
    body: JSON.stringify({ userId: Number(userId), moduleId, access }),
  })
}

export async function apiMe(): Promise<AppUser | null> {
  try {
    const data = await apiFetch<{ user: AppUser }>("/api/me")
    return data.user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export async function apiLogin(login: string, password: string): Promise<AppUser> {
  const data = await apiFetch<{ user: AppUser }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ login, email: login, password }),
  })
  return data.user
}

export async function apiLogout(): Promise<void> {
  await apiFetch("/api/logout", { method: "POST", body: "{}" })
}

export type ScheduleStatus = {
  state: "active" | "installed" | "stale" | "missing"
  installed: boolean
  active: boolean
  daemon: "running" | "stopped" | "unknown"
  lastRunAt: string | null
}

export async function apiScheduleStatus(): Promise<ScheduleStatus> {
  return apiFetch("/api/system/schedule")
}

export async function apiWorkspaces(): Promise<Workspace[]> {
  const data = await apiFetch<{ workspaces: Workspace[] }>("/api/workspaces")
  return data.workspaces
}

export async function apiCreateWorkspace(name: string): Promise<{ workspace: Workspace; pairingCode: string }> {
  return apiFetch("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  })
}

export async function apiUpdateWorkspace(
  id: string,
  patch: {
    name?: string
    disabled?: boolean
    feedUrl?: string | null
    keepCode?: boolean
    sync?: boolean
  },
): Promise<{ workspace: Workspace; ok: boolean; error?: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
}

export async function apiSyncWorkspace(
  id: string,
  options?: { light?: boolean },
): Promise<{ workspace: Workspace; ok: boolean; error?: string }> {
  const light = options?.light !== false
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/sync?light=${light ? "1" : "0"}`, {
    method: "POST",
    body: "{}",
  })
}

export type IconSyncResult = {
  downloaded: number
  converted?: number
  skipped: string | null
  pending: number
  errors?: number
  listed?: number
  detail?: string | null
}

export async function apiWorkspaceFields(id: string): Promise<FieldsResponse> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/fields`)
}

export async function apiWorkspaceVehicles(
  id: string,
): Promise<{
  ok: boolean
  error?: string | null
  fetchedAt?: string | null
  vehicles: Vehicle[]
  farms: Farm[]
  iconSync?: IconSyncResult | null
  workspace?: Workspace
}> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/vehicles`)
}

export async function apiWorkspaceSyncIcons(
  id: string,
): Promise<{
  ok: boolean
  iconSync: IconSyncResult
}> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/connector/icons/sync`, {
    method: "POST",
    body: "{}",
  })
}

export async function apiWorkspaceFarms(
  id: string,
  options?: { sync?: boolean },
): Promise<{ farms: Farm[]; workspace?: Workspace }> {
  const sync = options?.sync ? "?sync=1" : ""
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/farms${sync}`)
}

export type HostAccessPayload = {
  protocol: HostProtocol
  host: string
  port?: number | null
  username: string
  password?: string
  keepPassword?: boolean
  remoteRoot?: string
  remoteSavegamePath?: string
  remoteModSettingsPath?: string
  insecureAck?: boolean
  probe?: boolean
}

export async function apiSaveHostAccess(
  id: string,
  payload: HostAccessPayload,
): Promise<{
  ok: boolean
  error?: string | null
  workspace: Workspace
  farms: Farm[]
  savegames: WorkspaceSavegame[]
}> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/host-access`, {
    method: "PUT",
    body: JSON.stringify(payload),
  })
}

export async function apiProbeHostAccess(
  id: string,
): Promise<{
  ok: boolean
  error?: string | null
  workspace: Workspace
  farms: Farm[]
  savegames: WorkspaceSavegame[]
}> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/host-access/probe`, {
    method: "POST",
    body: "{}",
  })
}

export async function apiSelectSavegame(
  workspaceId: string,
  savegameId: number | string,
): Promise<{
  ok: boolean
  error?: string | null
  workspace: Workspace
  farms: Farm[]
  savegames: WorkspaceSavegame[]
}> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/savegames/select`, {
    method: "POST",
    body: JSON.stringify({ savegameId }),
  })
}

export async function apiDeleteHostAccess(
  id: string,
): Promise<{ ok: boolean; workspace: Workspace }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/host-access`, {
    method: "DELETE",
  })
}

export type ConnectorPackageMeta = {
  available: boolean
  error?: string | null
  version: string | null
  fileName: string
  bytes?: number
}

export async function apiConnectorPackageMeta(): Promise<ConnectorPackageMeta> {
  return apiFetch("/api/system/connector/package/meta")
}

export async function apiDeployConnector(
  workspaceId: string,
  modsPath?: string,
): Promise<{
  ok: boolean
  error?: string | null
  remotePath?: string | null
  bytes?: number | null
  version?: string | null
}> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/connector/deploy`, {
    method: "POST",
    body: JSON.stringify(modsPath ? { modsPath } : {}),
  })
}

export type RequiredModStatus = {
  id: string
  title: string
  zipName: string
  required: boolean
  deployable: boolean
  installed: boolean
  activated: boolean
  installedPath: string | null
  runningVersion: string | null
  packageVersion: string | null
  updateAvailable?: boolean
  status: "active" | "installed" | "missing"
}

export type RequiredModsResponse = {
  mods: RequiredModStatus[]
  checkedAt: string
  packageVersion: string | null
  hostAccess: boolean
  feedModsCount: number
}

export async function apiRequiredMods(workspaceId: string): Promise<RequiredModsResponse> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/required-mods`)
}

/** Trigger authenticated download of the packaged connector zip. */
export async function downloadConnectorPackage(): Promise<void> {
  const response = await fetch("/api/system/connector/package", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/zip" },
  })
  if (!response.ok) {
    throw new Error(`Download HTTP ${response.status}`)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = "FS25_AgriVisionConnector.zip"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export interface ServerModRow {
  name: string
  bytes: number | null
  active: boolean | null
  source: string
  download: boolean
  title?: string
  version?: string
  author?: string
  used?: boolean | null
  mapDependency?: boolean
  hubVersion?: string | null
  hubUrl?: string | null
  updateAvailable?: boolean
}

export interface ServerSettingField {
  name: string
  label: string
  type: "text" | "checkbox" | "select" | string
  value: string
  options: { value: string; label: string }[]
}

export interface ServerSnapshot {
  webConfigured: boolean
  ftpConfigured: boolean
  loggedIn: boolean
  running?: boolean | null
  actions: { id: "start" | "stop" | "restart" | string; label: string }[]
  mods: ServerModRow[]
  settings: ServerSettingField[]
  log: { name: string; text: string; truncated: boolean } | null
  error: string | null
  savegameRead?: boolean
  at?: string | null
  pending?: boolean
}

export interface ServerAccessUser {
  id: string
  name: string
  email: string
  admin: boolean
  access: "read" | "write" | null
}

export async function apiServerSnapshot(workspaceId: string): Promise<ServerSnapshot> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server`)
}

export async function apiSaveServerLogin(
  workspaceId: string,
  body: { username: string; password?: string; keepPassword: boolean },
): Promise<{ ok: boolean; console: NonNullable<import("./types").Workspace["console"]> }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/login`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

export async function apiServerAction(workspaceId: string, action: "start" | "stop" | "restart"): Promise<{ ok: boolean; note?: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/action`, {
    method: "POST",
    body: JSON.stringify({ action }),
  })
}

export async function apiSaveServerSettings(workspaceId: string, values: Record<string, string | boolean>): Promise<{ ok: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/settings`, {
    method: "POST",
    body: JSON.stringify({ values }),
  })
}

export async function apiUploadServerMod(workspaceId: string, file: File): Promise<{ ok: boolean; via: string }> {
  const body = new FormData()
  body.set("file", file)
  const method = "POST"
  await ensureCsrf()
  const headers = new Headers()
  headers.set("Accept", "application/json")
  const xsrf = readCookie("XSRF-TOKEN")
  if (xsrf) headers.set("X-XSRF-TOKEN", xsrf)
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/mods`, {
    method,
    credentials: "include",
    headers,
    body,
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) throw new ApiError(response.status, readApiErrorMessage(data, response.status))
  return data as { ok: boolean; via: string }
}

export async function apiDownloadServerMod(workspaceId: string, name: string): Promise<void> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/server/mod?name=${encodeURIComponent(name)}`,
    { credentials: "include", headers: { Accept: "application/zip" } },
  )
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    throw new ApiError(response.status, readApiErrorMessage(data, response.status))
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export async function apiSetServerModActive(workspaceId: string, name: string, active: boolean): Promise<{ ok: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/mods/active`, {
    method: "POST",
    body: JSON.stringify({ name, active }),
  })
}

export async function apiUpdateServerMod(workspaceId: string, name: string): Promise<{ ok: boolean; note?: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/mods/update`, {
    method: "POST",
    body: JSON.stringify({ name }),
  })
}

export async function apiServerAccess(workspaceId: string): Promise<{ users: ServerAccessUser[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/access`)
}

export async function apiSaveServerAccess(
  workspaceId: string,
  userId: string,
  access: "none" | "read" | "write",
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/access`, {
    method: "PUT",
    body: JSON.stringify({ userId: Number(userId), access }),
  })
}

/** Probe whether the Laravel API is reachable (not just Vite demo). */
export async function apiIsLive(): Promise<boolean> {
  try {
    const response = await fetch("/api/csrf-cookie", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    })
    return response.ok || response.status === 204
  } catch {
    return false
  }
}
