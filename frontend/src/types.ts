export type Locale = "de" | "en"

export type LinkState = "online" | "offline" | "unpaired" | "unknown" | "error"

export type WorkspaceRole = "workspace_admin" | "manager" | "operator" | "viewer"

export type ModuleAccess = "read" | "write"

export type GlobalRole = "admin" | "member"

export type VehicleCategory = "tractor" | "harvester" | "trailer" | "tool" | "pallet"

export interface LocalizedText {
  de: string
  en: string
}

export interface Membership {
  workspaceId: string
  role: WorkspaceRole
  modules: ModuleGrant[]
  /** Savegame farm IDs; omit or null = all farms in the workspace. */
  farmIds?: number[] | null
}

export interface ModuleGrant {
  moduleId: string
  access: ModuleAccess
}

export interface AppUser {
  id: string
  name: string
  username?: string | null
  email: string
  firstName: string
  lastName: string
  alias: string
  notificationEmail: string
  avatarDataUrl: string | null
  twoFactorEnabled: boolean
  globalRole: GlobalRole
  active: boolean
  memberships: Membership[]
  groupIds: string[]
}

export type MailEncryption = "none" | "starttls" | "tls"

export interface MailSettings {
  host: string
  port: number
  encryption: MailEncryption
  username: string
  password: string
  fromEmail: string
  fromName: string
}

export interface AccessGroup {
  id: string
  name: string
  description: string
  system: boolean
  grantsPlatformAdmin: boolean
  workspaceRole: WorkspaceRole | null
  modules: ModuleGrant[]
  workspaceIds: string[]
  memberIds: string[]
}

export interface Workspace {
  id: string
  number: number
  name: string
  linkState: LinkState
  disabled: boolean
  mapName: string | null
  playersOnline: number | null
  playerCapacity: number | null
  gameTime: string | null
  gameVersion?: string | null
  lastSeenAt: string | null
  lastSyncAt: string | null
  connectorVersion: string | null
  notice: "unpaired" | "stale" | "feed" | "offline" | "disabled" | null
  /** Origin only (no feed code). */
  feedUrl: string
  feedConfigured?: boolean
  mapPreviewPath?: string | null
  dataMode?: "live" | "demo" | "empty"
  statusNote?: string | null
  hostAccess?: HostAccessInfo | null
  savegames?: WorkspaceSavegame[]
  activeSavegameId?: number | null
  console?: {
    configured: boolean
    username: string
    baseUrl: string
    hasPassword: boolean
  } | null
}

export type SavegameStatus = "ready" | "no_farms" | "error" | "unknown" | string

export interface WorkspaceSavegame {
  id: number
  slotKey: string
  path: string
  name: string | null
  status: SavegameStatus
  statusNote: string | null
  hasFarmsXml: boolean
  hasCareerXml: boolean
  active: boolean
  lastProbedAt: string | null
}

export type HostProtocol = "sftp" | "ftps" | "ftp"

export interface HostAccessInfo {
  configured: boolean
  protocol: HostProtocol
  host: string
  port: number
  username: string
  hasPassword: boolean
  remoteRoot: string | null
  remoteSavegamePath: string | null
  remoteModSettingsPath: string | null
  insecure: boolean
  status: "unconfigured" | "ok" | "error" | string
  lastVerifiedAt: string | null
  lastError: string | null
}

/** In-game farm (Hof) inside a gameserver workspace. */
export interface Farm {
  id: string
  workspaceId: string
  /** Savegame farm ID (1, 2, …). */
  gameFarmId: number
  /** Null until farms.xml / connector supplies a name — UI shows a stub label. */
  name: string | null
  money: number | null
  hectares: number | null
  animals: number | null
  storageFill: number | null
}

export interface Vehicle {
  id: string
  workspaceId: string
  name: string
  category: VehicleCategory
  farmId: number | null
  /** Resolved store-icon URL when locally cached; null = placeholder. */
  iconUrl: string | null
  /** Mod-pack icon URL when locally cached. */
  modIconUrl?: string | null
  /** Vehicle type key for store icons (from connector / filename). */
  storeKey?: string | null
  /** Mod pack folder / zip stem (e.g. FS25_AutoDrive). */
  modKey?: string | null
  /** Store brand (CLAAS, Fendt, …) when known. */
  brand?: string | null
  /** Original vehicle XML path from savegame / connector. */
  filename?: string | null
  x: number | null
  y: number | null
  z: number | null
  /** Current fuel (diesel, electric, or methane), summed across tanks. */
  fuel?: number | null
  fuelCapacity?: number | null
  /** AdBlue / DEF, only when the vehicle has that tank. */
  defLevel?: number | null
  defCapacity?: number | null
  /** Wear / damage, 0–100. */
  wear?: number | null
  /** License plate, when the vehicle has one. */
  plate?: string | null
  fill: LocalizedText | null
  hours: number | null
  observedAt: string
}

export interface FieldSnapshot {
  id: number
  centerX: number | null
  centerZ: number | null
  /** PDA number position (name indicator). Falls back to the field center. */
  labelX?: number | null
  labelZ?: number | null
  areaHa: number | null
  /** World X/Z pairs. Empty when the connector has not sent an outline. */
  points: [number, number][]
  /** Field ids plowed into one area, lowest id first. Null when the field stands alone. */
  group?: number[] | null
  farmId: number | null
  farmlandId: number | null
  owned: boolean | null
  fruitName: string | null
  fruitTitle: string | null
  fruitIcon: string | null
  iconUrl: string | null
  growth: number | null
  growthMax: number | null
  harvestMin: number | null
  harvestMax: number | null
  /** Calendar months 1–12 from the map's growth periods. Absent until the connector can read them. */
  harvestMonths?: number[] | null
  crop: string | null
  ground: number | null
  weed: number | null
  weedFactor: number | null
  stones: number | null
  spray: number | null
  sprayType: number | null
  lime: number | null
  roller: number | null
  plow: number | null
  stubble: number | null
  water: number | null
  scanned: boolean | null
  nitrogen: number | null
  nitrogenTarget: number | null
  ph: number | null
  phTarget: number | null
  soil: number | null
  soilName: string | null
}

export interface FieldsResponse {
  ok: boolean
  error?: string | null
  mapSize: number | null
  /** PDA placement reported by the connector. Absent on older snapshots. */
  mapFrame?: {
    worldX: number
    worldZ: number
    originX: number
    originZ: number
    scaleX: number
    scaleZ: number
    padX: number
    padZ: number
  } | null
  precisionFarming: boolean | null
  geometryAt: string | null
  stateAt: string | null
  /** Sharp in-game PDA texture is cached for this workspace. */
  pdaMap?: boolean
  fields: FieldSnapshot[]
}

export interface ActivityItem {
  id: string
  workspaceId: string
  key: "sync" | "pair" | "stale"
  at: string
}

export interface ToastItem {
  id: string
  tone: "ok" | "warn" | "danger"
  text: string
}
