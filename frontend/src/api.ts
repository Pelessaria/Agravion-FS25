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
  access: string,
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

export type StorageFill = {
  fillType: string | null
  title: string | null
  level: number | null
  capacity: number | null
  count: number | null
  form?: string | null
  size?: string | null
}

export type StoragePlace = {
  id: string
  kind: string | null
  farmId: number | null
  name: string | null
  foreign: boolean
  level: number | null
  capacity: number | null
  used: number | null
  slots: number | null
  x: number | null
  z: number | null
  iconUrl?: string | null
  fills: StorageFill[]
}

export type StorageResponse = {
  ok: boolean
  error: string | null
  writtenAt: string | null
  places: StoragePlace[]
}

export async function apiWorkspaceStorage(id: string): Promise<StorageResponse> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/storage`)
}

export type LiveVehicle = {
  id: string
  name: string | null
  farmId: number | null
  x: number
  z: number
  heading: number | null
  ai: boolean
  driver: string | null
  controlled?: boolean
  attachments?: string | null
}

export type LivePlayer = {
  id: string
  name: string | null
  x: number
  z: number
  heading: number | null
}

export type LivePlace = {
  id: string
  name: string | null
  type: string | null
  farmId: number | null
  x: number
  z: number
}

export type LiveFarmColor = {
  id: number
  name: string | null
  color: string | null
}

export type LiveForecastHour = {
  time: number | null
  type: string | null
  temperature: number | null
  windSpeed: number | null
}

export type LiveForecastDay = {
  day: number | null
  type: string | null
  high: number | null
  low: number | null
  windSpeed: number | null
}

export type LiveMapResponse = {
  ok: boolean
  error: string | null
  source: "live" | "vehicles" | null
  writtenAt: string | null
  day: number | null
  period: number | null
  dayTime: number | null
  timeScale: number | null
  paused: boolean
  weather: string | null
  temperature: number | null
  windSpeed: number | null
  windDirection: number | null
  year: number | null
  dayInPeriod: number | null
  daysPerPeriod: number | null
  rain: number | null
  clouds: number | null
  humidity: number | null
  fog: number | null
  snow: number | null
  vehicles: LiveVehicle[]
  players: LivePlayer[]
  places: LivePlace[]
  farms: LiveFarmColor[]
  hours: LiveForecastHour[]
  days: LiveForecastDay[]
}

export async function apiWorkspaceLiveMap(id: string): Promise<LiveMapResponse> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/live-map`)
}

export async function apiWorkspaceLiveFleet(
  id: string,
): Promise<{
  ok: boolean
  error?: string | null
  fetchedAt?: string | null
  vehicles: Vehicle[]
}> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(id)}/live-fleet`)
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
  restarted?: boolean
  note?: string | null
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

export async function apiRequiredMods(workspaceId: string, fresh = false): Promise<RequiredModsResponse> {
  const query = fresh ? "?fresh=1" : ""
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/required-mods${query}`)
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
  anchor.download = "FS25_AgravionConnector.zip"
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

/** Live re-list from FTP + dedicated-server UI (invalidates the mods_list cache). */
export async function apiServerRefresh(workspaceId: string): Promise<ServerSnapshot> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/refresh`, {
    method: "POST",
    body: JSON.stringify({}),
  })
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

interface SaveHandle {
  createWritable: () => Promise<WritableStream>
  remove?: () => Promise<void>
}

function savePicker(): ((options: { suggestedName: string }) => Promise<SaveHandle>) | null {
  const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveHandle> }).showSaveFilePicker
  return typeof picker === "function" ? picker.bind(window) : null
}

function startBrowserDownload(url: string, name: string) {
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export async function apiDownloadServerMod(workspaceId: string, name: string): Promise<void> {
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/server/mod?name=${encodeURIComponent(name)}`
  const picker = savePicker()
  if (picker) {
    let handle: SaveHandle
    try {
      handle = await picker({ suggestedName: name })
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return
      startBrowserDownload(url, name)
      return
    }
    const response = await fetch(url, { credentials: "include", headers: { Accept: "application/zip" } })
    if (!response.ok || response.body === null) {
      await handle.remove?.()
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
      throw new ApiError(response.status, readApiErrorMessage(data, response.status))
    }
    const writable = await handle.createWritable()
    await response.body.pipeTo(writable)
    return
  }
  startBrowserDownload(url, name)
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

export async function apiUpdateServerMods(
  workspaceId: string,
  names: string[],
): Promise<{ ok: boolean; updated: number; failed: { name: string; error: string }[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/mods/updates`, {
    method: "POST",
    body: JSON.stringify({ names }),
  })
}

export async function apiDownloadServerMods(workspaceId: string, names: string[]): Promise<void> {
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/server/mods/download`
  const picker = savePicker()
  if (picker) {
    let handle: SaveHandle
    try {
      handle = await picker({ suggestedName: "mods.zip" })
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return
      await saveModArchive(url, names, null)
      return
    }
    await saveModArchive(url, names, handle)
    return
  }
  await saveModArchive(url, names, null)
}

async function saveModArchive(url: string, names: string[], handle: SaveHandle | null): Promise<void> {
  await ensureCsrf()
  const headers = new Headers({ Accept: "application/zip", "Content-Type": "application/json" })
  const xsrf = readCookie("XSRF-TOKEN")
  if (xsrf) headers.set("X-XSRF-TOKEN", xsrf)
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ names }),
  })
  if (!response.ok || response.body === null) {
    await handle?.remove?.()
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    throw new ApiError(response.status, readApiErrorMessage(data, response.status))
  }
  if (handle) {
    const writable = await handle.createWritable()
    await response.body.pipeTo(writable)
    return
  }
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  startBrowserDownload(objectUrl, "mods.zip")
  URL.revokeObjectURL(objectUrl)
}

export async function apiDeleteServerMods(workspaceId: string, names: string[]): Promise<{ ok: boolean; deleted: number }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/mods/delete`, {
    method: "POST",
    body: JSON.stringify({ names }),
  })
}

export async function apiServerAccess(workspaceId: string): Promise<{ users: ServerAccessUser[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/server/access`)
}

export async function apiSaveServerAccess(
  workspaceId: string,
  userId: string,
  access: string,
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
