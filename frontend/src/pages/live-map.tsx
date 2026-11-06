import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { Boxes, ChevronLeft, ChevronRight, Loader2, Minus, Plus, Search, Tractor, Truck, UserRound, Warehouse, Wheat, Wrench } from "lucide-react"
import {
  apiWorkspaceFields,
  apiWorkspaceLiveFleet,
  apiWorkspaceLiveMap,
  type LiveMapResponse,
  type LivePlace,
  type LivePlayer,
  type LiveVehicle,
} from "../api"
import { EmptyState, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { cropIcon } from "../crop-icons"
import { cropColor, projectPoint, effectiveMapSize, frameFromContentBox, measureMapContent, terrainFrame, type MapFrame } from "../field-format"
import { clampCamera, readMapView, sheetFor, writeMapView, type MapCamera } from "../map-camera"
import { useStore } from "../store"
import type { FieldsResponse, Vehicle } from "../types"
import { useWorkspaceRoute } from "../use-workspace"

function withAlpha(hex: string, alpha: number) {
  const raw = hex.replace("#", "")
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return hex
  const r = Number.parseInt(raw.slice(0, 2), 16)
  const g = Number.parseInt(raw.slice(2, 4), 16)
  const b = Number.parseInt(raw.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const PERIOD_TO_MONTH = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2]

type ObjectTab = "all" | "vehicle" | "implement" | "building" | "player"
type MarkerKind = "vehicle" | "player" | "place" | "pin"
type MarkerRole = "tractor" | "harvester" | "trailer" | "tool" | "pallet" | "building" | "player" | "pin" | "vehicle"
type Marker = {
  key: string
  x: number
  y: number
  heading: number | null
  kind: MarkerKind
  role: MarkerRole
  farmColor: string | null
  label: string
  icon: string | null
  active: boolean
  occupied: boolean
  attachments: string | null
  priority: number
  busy: string | null
  count?: number
  members?: Marker[]
}

function rolePriority(role: MarkerRole) {
  if (role === "harvester" || role === "tractor") return 40
  if (role === "vehicle") return 30
  if (role === "player") return 25
  if (role === "trailer") return 16
  if (role === "tool" || role === "pallet") return 10
  return 6
}

function vehicleActive(vehicle: LiveVehicle) {
  return vehicle.ai || Boolean(vehicle.driver) || vehicle.controlled === true
}

function vehicleOccupied(vehicle: LiveVehicle) {
  return Boolean(vehicle.driver) || vehicle.controlled === true
}

/** Giants yaw → SVG degrees. Map Y grows with world +Z (south), arrow tip is -Y (north). */
function headingToSvgDegrees(heading: number) {
  return 180 - (heading * 180) / Math.PI
}

function markerRole(kind: MarkerKind, category: string | null): MarkerRole {
  if (kind === "place") return "building"
  if (kind === "player") return "player"
  if (kind === "pin") return "pin"
  if (category === "tractor" || category === "harvester" || category === "trailer" || category === "tool" || category === "pallet") {
    return category
  }
  return "vehicle"
}

function clockLabel(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null
  const ms = value > 0 && value <= 1 ? value * 24 * 60 * 60 * 1000 : value
  if (ms < 0 || ms > 48 * 60 * 60 * 1000) return null
  const minutes = Math.floor(ms / 60000) % (24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

function readPin(params: URLSearchParams) {
  const xs = params.get("x")
  const zs = params.get("z")
  if (xs == null || zs == null || xs === "" || zs === "") return null
  const x = Number(xs)
  const z = Number(zs)
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null
  return { x, z, name: params.get("name") || "" }
}

function readVehicleParam(params: URLSearchParams) {
  const raw = params.get("vehicle")?.trim()
  return raw ? raw : null
}

function objectKind(role: MarkerRole): Exclude<ObjectTab, "all"> {
  if (role === "player") return "player"
  if (role === "building") return "building"
  if (role === "tool" || role === "trailer" || role === "pallet") return "implement"
  return "vehicle"
}

type BuildingFilter = "all" | "silo" | "animal" | "production" | "trade" | "yard"

function placeText(place: LivePlace) {
  return `${place.type ?? ""} ${place.name ?? ""}`.toLowerCase()
}

function usedPlace(place: LivePlace) {
  return /silo|husband|animal|production|sell|unload|load|bunker|barn|stall|stable|workshop|garage|shed/.test(placeText(place))
}

function buildingKind(place: LivePlace): Exclude<BuildingFilter, "all"> {
  const type = placeText(place)
  if (/silo|bunker|tank|lager|storage/.test(type)) return "silo"
  if (/husband|animal|barn|stall|stable/.test(type)) return "animal"
  if (/production/.test(type)) return "production"
  if (/sell|unload|load/.test(type)) return "trade"
  return "yard"
}

function matches(query: string, value: string | null) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (value ?? "").toLowerCase().includes(needle)
}

function onListIconError(event: SyntheticEvent<HTMLImageElement>) {
  const wrap = event.currentTarget.parentElement
  event.currentTarget.remove()
  wrap?.querySelector(".icon-fallback")?.classList.remove("is-hidden")
}

export function LiveMapPage() {
  const { t } = useTranslation()
  const stamp = useTimeLabel()
  const [params] = useSearchParams()
  const pin = readPin(params)
  const vehicleParam = readVehicleParam(params)
  const { liveMode, moduleAccess, sessionUserId } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "map") : null
  const [payload, setPayload] = useState<LiveMapResponse | null>(null)
  const [fields, setFields] = useState<FieldsResponse | null>(null)
  const [fleet, setFleet] = useState<Vehicle[]>([])
  const [bootLoading, setBootLoading] = useState(liveMode)
  const [pdaReadyFor, setPdaReadyFor] = useState<string | null>(null)
  const [contentBox, setContentBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [hiddenFarms, setHiddenFarms] = useState<number[]>([])
  const [showFields, setShowFields] = useState(true)
  const [showCrops, setShowCrops] = useState(true)
  const [showBuildings, setShowBuildings] = useState(pin != null && !vehicleParam)
  const [buildingFilter, setBuildingFilter] = useState<BuildingFilter>("all")
  const [resetToken, setResetToken] = useState(0)
  const [tab, setTab] = useState<ObjectTab>(vehicleParam ? "all" : pin ? "building" : "all")
  const [query, setQuery] = useState(pin?.name ?? "")
  const [objectsOpen, setObjectsOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(vehicleParam ? `v:${vehicleParam}` : pin ? "pin" : null)
  const deepLinkDone = useRef(false)

  useEffect(() => {
    if (!workspace || !allowed || !access || !liveMode) return
    let cancelled = false
    let fieldsDone = false
    let liveDone = false
    const finishBoot = () => {
      if (!cancelled && fieldsDone && liveDone) setBootLoading(false)
    }
    const loadFields = async () => {
      try {
        const next = await apiWorkspaceFields(workspace.id)
        if (!cancelled) setFields(next)
      } catch {
        if (!cancelled) setFields(null)
      } finally {
        fieldsDone = true
        finishBoot()
      }
    }
    const loadLive = async (first: boolean) => {
      if (!first && document.hidden) return
      try {
        const next = await apiWorkspaceLiveMap(workspace.id, { fresh: true })
        if (!cancelled) setPayload(next)
      } catch {
        if (!cancelled && first) {
          setPayload({
            ok: false,
            error: "failed",
            source: null,
            writtenAt: null,
            day: null,
            period: null,
            dayTime: null,
            timeScale: null,
            paused: false,
            weather: null,
            temperature: null,
            windSpeed: null,
            windDirection: null,
            year: null,
            dayInPeriod: null,
            daysPerPeriod: null,
            rain: null,
            clouds: null,
            humidity: null,
            fog: null,
            snow: null,
            vehicles: [],
            players: [],
            places: [],
            farms: [],
            hours: [],
            days: [],
          })
        }
      } finally {
        if (first) {
          liveDone = true
          finishBoot()
        }
      }
    }
    const loadFleet = async () => {
      try {
        // Local connector icons/categories only — no dedicated-server feed roundtrip.
        const next = await apiWorkspaceLiveFleet(workspace.id)
        if (!cancelled) setFleet(next.vehicles ?? [])
      } catch {
        if (!cancelled) setFleet([])
      }
    }
    setBootLoading(true)
    void loadFields()
    void loadLive(true)
    void loadFleet()
    const fieldsTimer = window.setInterval(() => void loadFields(), 60_000)
    // Match connector live write (~2 s busy); FTP pull runs afterResponse server-side.
    const liveTimer = window.setInterval(() => void loadLive(false), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(fieldsTimer)
      window.clearInterval(liveTimer)
    }
  }, [access, allowed, liveMode, workspace])

  useEffect(() => {
    if (deepLinkDone.current || !vehicleParam || !payload) return
    const found = (payload.vehicles ?? []).some((vehicle) => vehicle.id === vehicleParam)
    if (found) {
      setSelected(`v:${vehicleParam}`)
      deepLinkDone.current = true
      return
    }
    if (pin) {
      setSelected("pin")
      deepLinkDone.current = true
    }
  }, [payload, pin, vehicleParam])

  const mapSize = effectiveMapSize(fields?.mapSize ?? null, fields?.fields ?? [])
  const reported = fields?.mapFrame ?? null
  const frame = useMemo(() => {
    if (reported && reported.worldX > 0 && reported.worldZ > 0 && reported.scaleX > 0 && reported.scaleZ > 0) {
      return {
        originX: reported.originX,
        originZ: reported.originZ,
        sizeX: reported.worldX,
        sizeZ: reported.worldZ,
        scaleX: reported.scaleX,
        scaleZ: reported.scaleZ,
        padX: reported.padX,
        padZ: reported.padZ,
      }
    }
    if (contentBox) return frameFromContentBox(mapSize, contentBox)
    return terrainFrame(mapSize)
  }, [contentBox, mapSize, reported])

  const shapes = useMemo(() => {
    const rows = fields?.fields ?? []
    const next: {
      id: number
      points: string
      x: number
      y: number
      color: string
      fruitName: string | null
      iconUrl: string | null
    }[] = []
    for (const field of rows) {
      if (field.points.length < 3) continue
      let sumX = 0
      let sumY = 0
      const points = field.points
        .map(([x, z]) => {
          const point = projectPoint(x, z, frame)
          sumX += point.x
          sumY += point.y
          return `${point.x.toFixed(2)},${point.y.toFixed(2)}`
        })
        .join(" ")
      next.push({
        id: field.id,
        points,
        x: sumX / field.points.length,
        y: sumY / field.points.length,
        color: cropColor(field),
        fruitName: field.fruitName,
        iconUrl: field.iconUrl,
      })
    }
    return next
  }, [fields, frame])

  const farmOpen = (id: number | null) => id == null || !hiddenFarms.includes(id)
  const vehicles = (payload?.vehicles ?? []).filter((vehicle) => farmOpen(vehicle.farmId))
  const players = payload?.players ?? []
  const places = (payload?.places ?? []).filter((place) => usedPlace(place) && farmOpen(place.farmId))
  const buildingCounts = places.reduce<Record<Exclude<BuildingFilter, "all">, number>>(
    (counts, place) => {
      counts[buildingKind(place)] += 1
      return counts
    },
    { silo: 0, animal: 0, production: 0, trade: 0, yard: 0 },
  )
  const filteredPlaces = places.filter(
    (place) => (buildingFilter === "all" || buildingKind(place) === buildingFilter) && matches(query, place.name ?? place.type),
  )
  const mapPlaces = filteredPlaces.filter((place) => {
    if (selected === `o:${place.id}`) return true
    if (tab === "vehicle" || tab === "implement" || tab === "player") return false
    if (tab === "building") return true
    return showBuildings
  })
  const visibleVehicles = vehicles.filter((vehicle) => matches(query, vehicle.name))
  const visiblePlayers = players.filter((player) => matches(query, player.name))

  const month = payload?.period != null && payload.period >= 1 && payload.period <= 12 ? PERIOD_TO_MONTH[payload.period - 1] : null
  const clock = clockLabel(payload?.dayTime ?? null)
  const farmColor = (farmId: number | null) => payload?.farms?.find((item) => item.id === farmId)?.color ?? null
  const fleetById = useMemo(() => {
    const map = new Map<string, Vehicle>()
    const prefix = `feed-${workspace?.id ?? ""}-`
    for (const item of fleet) {
      map.set(item.id, item)
      if (item.id.startsWith(prefix)) map.set(item.id.slice(prefix.length), item)
    }
    return map
  }, [fleet, workspace?.id])
  const fleetMatch = useCallback((id: string) => fleetById.get(id) ?? null, [fleetById])
  const vehicleIconOf = useCallback((vehicle: LiveVehicle) => fleetById.get(vehicle.id)?.iconUrl ?? null, [fleetById])
  const selectedVehicle = vehicles.find((vehicle) => `v:${vehicle.id}` === selected) ?? null

  const mapUrl = workspace && fields?.pdaMap && liveMode ? `/api/workspaces/${workspace.id}/pda-map` : null
  // Compare ready URL instead of a boolean — avoids the race where onLoad finishes
  // before an effect re-arms "loading" and the overlay never clears.
  const pdaPending = mapUrl != null && pdaReadyFor !== mapUrl
  const mapBusy = bootLoading || pdaPending
  const hasMapFrame = Boolean(reported && reported.worldX > 0 && reported.worldZ > 0 && reported.scaleX > 0 && reported.scaleZ > 0)

  // Warm browser cache so SVG <image> markers paint quickly once fleet icons exist.
  useEffect(() => {
    const urls = [...new Set([...fleetById.values()].map((item) => item.iconUrl).filter(Boolean))] as string[]
    for (const url of urls) {
      const img = new Image()
      img.decoding = "async"
      img.src = url
    }
  }, [fleetById])

  useEffect(() => {
    if (!bootLoading) return
    const timer = window.setTimeout(() => setBootLoading(false), 12_000)
    return () => window.clearTimeout(timer)
  }, [bootLoading])

  useEffect(() => {
    if (!mapUrl || pdaReadyFor === mapUrl) return
    const timer = window.setTimeout(() => setPdaReadyFor(mapUrl), 10_000)
    return () => window.clearTimeout(timer)
  }, [mapUrl, pdaReadyFor])

  const onMapReady = useCallback(() => {
    setPdaReadyFor(mapUrl)
  }, [mapUrl])

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !access) return <PermissionBlock />

  const roleOf = (vehicle: LiveVehicle) => markerRole("vehicle", fleetMatch(vehicle.id)?.category ?? null)
  const mapVehicles = visibleVehicles.filter((vehicle) => {
    const kind = objectKind(roleOf(vehicle))
    if (tab === "building" || tab === "player") return false
    if (tab === "all") return true
    return kind === tab
  })
  const mapPlayers = tab === "all" || tab === "player" ? visiblePlayers : []
  const catalog = [
    ...visibleVehicles.map((vehicle) => ({
      key: `v:${vehicle.id}`,
      farmId: vehicle.farmId,
      kind: objectKind(roleOf(vehicle)),
      name: vehicleOccupied(vehicle) ? vehicle.driver || t("live.occupied") : vehicle.name || vehicle.id,
      detail: vehicleOccupied(vehicle)
        ? [vehicle.name, vehicle.attachments].filter(Boolean).join(" · ") || t("live.occupied")
        : vehicle.ai
          ? t("live.ai")
          : t("live.parked"),
      iconUrl: fleetMatch(vehicle.id)?.iconUrl ?? null,
      role: roleOf(vehicle),
    })),
    ...visiblePlayers.map((player) => ({
      key: `p:${player.id}`,
      farmId: player.farmId ?? null,
      kind: "player" as const,
      name: player.name || t("live.players"),
      detail: t("live.onFoot"),
      iconUrl: null,
      role: "player" as const,
    })),
    ...filteredPlaces.map((place) => ({
      key: `o:${place.id}`,
      farmId: place.farmId,
      kind: "building" as const,
      name: place.name || place.type || place.id,
      detail: place.type || t("live.buildings"),
      iconUrl: place.iconUrl ?? null,
      role: "building" as const,
    })),
  ].filter((row) => (tab === "all" ? row.kind !== "building" : row.kind === tab))
  const farmIds = [...new Set(catalog.map((row) => row.farmId))]
  const vehicleCount = vehicles.filter((vehicle) => objectKind(roleOf(vehicle)) === "vehicle").length
  const implementCount = vehicles.filter((vehicle) => objectKind(roleOf(vehicle)) === "implement").length

  return (
    <div className="page live-page">
      <header className="page-head">
        <div>
          <h1>{t("modules.map")}</h1>
          <p>{t("modules.mapLead")}</p>
        </div>
        <div className="live-farm-row">
          <span>{t("live.farms")}</span>
          <button
            type="button"
            className={hiddenFarms.length === 0 ? "chip-check on" : "chip-check"}
            onClick={() => setHiddenFarms(hiddenFarms.length === 0 ? (payload?.farms ?? []).map((item) => item.id) : [])}
          >
            {t("live.all")}
          </button>
          {(payload?.farms ?? []).map((item) => (
            <button
              key={item.id}
              type="button"
              className={hiddenFarms.includes(item.id) ? "chip-check" : "chip-check on"}
              onClick={() =>
                setHiddenFarms((current) => (current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]))
              }
            >
              <i style={{ background: item.color || "var(--accent)" }} />
              {item.name || item.id}
            </button>
          ))}
        </div>
      </header>
      <div className={[objectsOpen ? "live-stage is-objects-open" : "live-stage", mapBusy ? "is-loading" : ""].filter(Boolean).join(" ")}>
        {payload?.error === "failed" && payload.vehicles.length === 0 ? (
          <EmptyState title={t("live.failedTitle")} body={t("live.failedBody")} />
        ) : null}
        {payload && !payload.ok && payload.error === "missing" ? (
          <EmptyState title={t("live.missingTitle")} body={t("live.missingBody")} />
        ) : null}
        <LiveCanvas
          mapUrl={mapUrl}
          frame={frame}
          shapes={shapes}
          vehicles={mapVehicles}
          players={mapPlayers}
          places={mapPlaces}
          viewUserId={sessionUserId}
          viewScope={`${workspace.id}.live`}
          pin={pin}
          selected={selected}
          showFields={showFields}
          showCrops={showCrops}
          resetToken={resetToken}
          vehicleRole={roleOf}
          vehicleIcon={vehicleIconOf}
          placeColor={(farmId) => farmColor(farmId)}
          skipContentBox={hasMapFrame}
          onSelect={setSelected}
          onContentBox={setContentBox}
          onMapReady={onMapReady}
        />
        {mapBusy ? (
          <div className="live-loading" role="status" aria-live="polite">
            <Loader2 className="icon live-loading-spin" aria-hidden="true" />
            <strong>{t("live.loading")}</strong>
            <span>{bootLoading ? t("live.loadingHint") : pdaPending ? t("live.loadingPda") : t("live.loadingHint")}</span>
          </div>
        ) : null}
        <div className="live-toolbar">
          <strong>{workspace.mapName || t("modules.map")}</strong>
          <div>
            <button type="button" className={showFields ? "is-on" : ""} onClick={() => setShowFields((value) => !value)}>
              {t("live.fieldsLayer")}
            </button>
            <button type="button" className={showCrops ? "is-on" : ""} onClick={() => setShowCrops((value) => !value)}>
              {t("live.cropsLayer")}
            </button>
            <button type="button" className={showBuildings ? "is-on" : ""} onClick={() => setShowBuildings((value) => !value)}>
              {t("live.buildings")}
            </button>
            <button type="button" onClick={() => setResetToken((value) => value + 1)}>
              {t("live.resetView")}
            </button>
          </div>
        </div>
        <div className="live-hud">
          {clock ? (
            <span className="live-chip">
              {clock}
              {payload?.day != null ? ` · ${t("live.day", { day: payload.day })}` : ""}
              {month != null ? ` · ${t(`fields.month.${month}`)}` : ""}
              {payload?.paused ? ` · ${t("live.paused")}` : ""}
            </span>
          ) : null}
          {payload?.writtenAt ? (
            <span className="live-chip" title={payload.source === "vehicles" ? t("live.fromVehicles") : undefined}>
              {t("live.updated", { time: stamp(payload.writtenAt, "") })}
            </span>
          ) : null}
        </div>
      <aside className={objectsOpen ? "live-side is-open" : "live-side is-collapsed"}>
        {objectsOpen ? (
          <section className="panel live-objects">
            <header>
              <div>
                <h2>{t("live.objects")}</h2>
                <span>{t("live.objectCount", { count: catalog.length })}</span>
              </div>
              <button
                type="button"
                className="live-side-toggle"
                aria-expanded={true}
                aria-label={t("live.objectsClose")}
                title={t("live.objectsClose")}
                onClick={() => setObjectsOpen(false)}
              >
                <ChevronRight className="icon" />
              </button>
            </header>
            <div className="fields-jump live-jump">
              <label>
                <span>{t("live.searchShort")}</span>
                <input
                  type="search"
                  value={query}
                  placeholder=" "
                  aria-label={t("live.search")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <button type="button" tabIndex={-1} aria-hidden="true">
                <Search className="icon" />
              </button>
            </div>
            <div className="live-tabs" role="tablist">
              {(["all", "vehicle", "implement", "building", "player"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={tab === id ? "is-on" : ""}
                  onClick={() => {
                    setTab(id)
                    if (id === "building") setShowBuildings(true)
                  }}
                >
                  {t(id === "all" ? "live.all" : id === "vehicle" ? "live.vehicles" : id === "implement" ? "live.implements" : id === "building" ? "live.buildings" : "live.players")}
                </button>
              ))}
            </div>
            {tab === "building" ? (
              <div className="live-kind-filters">
                {(["all", "silo", "animal", "production", "trade", "yard"] as const)
                  .filter((id) => id === "all" || buildingCounts[id] > 0)
                  .map((id) => (
                    <button key={id} type="button" className={buildingFilter === id ? "is-on" : ""} onClick={() => setBuildingFilter(id)}>
                      {t(`live.buildingKind.${id}`)}
                      {id === "all" ? null : <em>{buildingCounts[id]}</em>}
                    </button>
                  ))}
              </div>
            ) : null}
            {selectedVehicle ? (
              <div className="live-card">
                <strong>{selectedVehicle.name || selectedVehicle.id}</strong>
                <p>
                  {selectedVehicle.ai
                    ? t("live.ai")
                    : selectedVehicle.driver || (selectedVehicle.controlled ? t("live.occupied") : t("live.parked"))}
                </p>
                {selectedVehicle.attachments ? (
                  <p>
                    {t("live.attachments")}: {selectedVehicle.attachments}
                  </p>
                ) : null}
                {fleetMatch(selectedVehicle.id) ? (
                  <Link to={`/w/${workspace.id}/equipment/${encodeURIComponent(fleetMatch(selectedVehicle.id)!.id)}`}>{t("modules.equipment")}</Link>
                ) : null}
              </div>
            ) : null}
            <div className="live-groups">
              {catalog.length === 0 ? (
                <p className="live-empty">
                  {t(tab === "building" ? "live.emptyPlaces" : tab === "player" ? "live.emptyPlayers" : "live.emptyVehicles")}
                </p>
              ) : null}
              {farmIds.map((groupId) => {
                const group = catalog.filter((row) => row.farmId === groupId)
                if (group.length === 0) return null
                const color = farmColor(groupId)
                const title = (payload?.farms ?? []).find((item) => item.id === groupId)?.name || (groupId == null ? t("live.players") : String(groupId))
                return (
                  <section key={groupId ?? "none"}>
                    <header style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}>
                      <span>{title}</span>
                      <em>{group.length}</em>
                    </header>
                    {group.map((row) => (
                      <button key={row.key} type="button" className={selected === row.key ? "is-on" : ""} onClick={() => setSelected(row.key)}>
                        <span className="live-obj-icon">
                          {row.iconUrl ? (
                            <img src={row.iconUrl} alt="" loading="lazy" decoding="async" onError={onListIconError} />
                          ) : null}
                          <RoleIcon role={row.role} className={row.iconUrl ? "icon-fallback is-hidden" : "icon-fallback"} />
                        </span>
                        <span>
                          <strong>{row.name}</strong>
                          <small>{row.detail}</small>
                        </span>
                      </button>
                    ))}
                  </section>
                )
              })}
            </div>
          </section>
        ) : (
          <button
            type="button"
            className="live-side-toggle is-fab"
            aria-expanded={false}
            aria-label={t("live.objectsOpen")}
            title={t("live.objectsToggle")}
            onClick={() => setObjectsOpen(true)}
          >
            <ChevronLeft className="icon" />
            <span>{t("live.objectsToggle")}</span>
            <em>{catalog.length}</em>
          </button>
        )}
      </aside>
      <div className="live-stats-bar">
        <span><Tractor className="icon" /><strong>{vehicleCount}</strong><small>{t("live.vehicles")}</small></span>
        <span><Wrench className="icon" /><strong>{implementCount}</strong><small>{t("live.implements")}</small></span>
        <span><Warehouse className="icon" /><strong>{places.length}</strong><small>{t("live.buildings")}</small></span>
        <span><strong>{fields?.fields.length ?? 0}</strong><small>{t("modules.fields")}</small></span>
      </div>
      </div>
    </div>
  )
}

function RoleIcon({ role, className }: { role: MarkerRole; className?: string }) {
  const Icon =
    role === "tractor"
      ? Tractor
      : role === "harvester"
        ? Wheat
        : role === "trailer"
          ? Truck
          : role === "tool"
            ? Wrench
            : role === "pallet"
              ? Boxes
              : role === "building"
                ? Warehouse
                : role === "player"
                  ? UserRound
                  : Tractor
  return <Icon className={["icon", className].filter(Boolean).join(" ")} aria-hidden="true" />
}

function MarkerGlyph({ role }: { role: MarkerRole }) {
  // Compact stroke icons (concept-style) so markers stay readable without store art.
  const stroke = { fill: "none", strokeWidth: 0.18, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }
  if (role === "building") {
    return <path {...stroke} d="M-0.55,0.55 V-0.05 L0,-0.55 L0.55,-0.05 V0.55 Z M-0.18,0.55 V0.15 H0.18 V0.55" />
  }
  if (role === "player") {
    return (
      <g {...stroke}>
        <circle cy="-0.28" r="0.22" />
        <path d="M-0.45,0.58 C-0.45,0.1 0.45,0.1 0.45,0.58" />
      </g>
    )
  }
  if (role === "trailer") {
    return (
      <g {...stroke}>
        <rect x="-0.7" y="-0.28" width="1.1" height="0.56" rx="0.1" />
        <path d="M0.4,-0.05 H0.72 L0.9,0.2 V0.28 H0.4" />
        <circle cx="-0.35" cy="0.42" r="0.16" />
        <circle cx="0.55" cy="0.42" r="0.16" />
      </g>
    )
  }
  if (role === "tool") {
    return <path {...stroke} d="M-0.55,-0.45 H0.15 L0.55,0 L0.15,0.45 H-0.55 Z M-0.2,-0.2 V0.2" />
  }
  if (role === "harvester") {
    return (
      <g {...stroke}>
        <path d="M-0.72,-0.15 H0.2 L0.55,0.15 H-0.72 Z" />
        <path d="M-0.35,-0.15 V-0.45 H0.15 L0.35,-0.15" />
        <circle cx="-0.35" cy="0.38" r="0.18" />
        <circle cx="0.28" cy="0.38" r="0.22" />
      </g>
    )
  }
  if (role === "pallet") return <rect {...stroke} x="-0.42" y="-0.42" width="0.84" height="0.84" rx="0.08" />
  if (role === "pin") return <path {...stroke} d="M0,-0.7 L0.18,-0.12 L0.7,0 L0.18,0.12 L0,0.7 L-0.18,0.12 L-0.7,0 L-0.18,-0.12 Z" />
  if (role === "tractor" || role === "vehicle") {
    return (
      <g {...stroke}>
        <path d="M-0.7,0.15 H0.15 L0.45,-0.25 H0.75 V0.15 H0.55" />
        <path d="M-0.55,-0.25 H0.05 L0.25,0.15" />
        <circle cx="-0.35" cy="0.4" r="0.2" />
        <circle cx="0.4" cy="0.4" r="0.24" />
      </g>
    )
  }
  return <circle {...stroke} r="0.42" />
}

function showsHeading(role: MarkerRole, active: boolean, heading: number | null, piled: boolean) {
  if (piled || heading == null) return false
  if (role === "player") return true
  if (!active) return false
  return role === "tractor" || role === "harvester" || role === "vehicle"
}

function LiveCanvas({
  mapUrl,
  frame,
  shapes,
  vehicles,
  players,
  places,
  pin,
  selected,
  showFields,
  showCrops,
  resetToken,
  viewUserId,
  viewScope,
  vehicleRole,
  vehicleIcon,
  placeColor,
  skipContentBox,
  onSelect,
  onContentBox,
  onMapReady,
}: {
  mapUrl: string | null
  frame: MapFrame
  shapes: {
    id: number
    points: string
    x: number
    y: number
    color: string
    fruitName: string | null
    iconUrl: string | null
  }[]
  vehicles: LiveVehicle[]
  players: LivePlayer[]
  places: LivePlace[]
  pin: { x: number; z: number; name: string } | null
  selected: string | null
  showFields: boolean
  showCrops: boolean
  resetToken: number
  viewUserId: string | null
  viewScope: string
  vehicleRole: (vehicle: LiveVehicle) => MarkerRole
  vehicleIcon: (vehicle: LiveVehicle) => string | null
  placeColor: (farmId: number | null) => string | null
  skipContentBox: boolean
  onSelect: (id: string) => void
  onContentBox: (box: { x: number; y: number; w: number; h: number } | null) => void
  onMapReady: () => void
}) {
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const savedView = useRef(readMapView(viewUserId, viewScope, 0.35))
  const cam = useRef<MapCamera>(savedView.current ?? { x: 0, y: 0, k: 1 })
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [zoom, setZoom] = useState(cam.current.k)
  const [mapFailed, setMapFailed] = useState(false)
  const [view, setView] = useState({ w: 0, h: 0 })
  const [cluster, setCluster] = useState<Marker[] | null>(null)
  const [brokenIcons, setBrokenIcons] = useState<ReadonlySet<string>>(() => new Set())
  const resetSeen = useRef(resetToken)
  const sheetRef = useRef(sheetFor(view, frame))
  const viewRef = useRef(view)
  viewRef.current = view
  const sheet = useMemo(() => sheetFor(view, frame), [frame, view])
  sheetRef.current = sheet

  function apply() {
    const el = stageRef.current
    if (!el) return
    el.style.transform = `translate(${cam.current.x}px, ${cam.current.y}px) scale(${cam.current.k})`
    setZoom((prev) => (prev === cam.current.k ? prev : cam.current.k))
    writeMapView(viewUserId, viewScope, cam.current)
  }

  function commit(next: MapCamera) {
    cam.current = clampCamera(next, viewRef.current, sheetRef.current)
    apply()
  }

  function zoomAt(next: number, px: number, py: number) {
    const prev = cam.current.k
    const clamped = Math.min(10, Math.max(0.35, next))
    const ratio = clamped / prev
    commit({
      k: clamped,
      x: px - (px - cam.current.x) * ratio,
      y: py - (py - cam.current.y) * ratio,
    })
  }

  useEffect(() => {
    if (resetSeen.current === resetToken) return
    resetSeen.current = resetToken
    cam.current = clampCamera({ x: 0, y: 0, k: 1 }, viewRef.current, sheetRef.current)
    apply()
  }, [resetToken, viewScope, viewUserId])

  useEffect(() => {
    if (view.w < 8) return
    cam.current = clampCamera(cam.current, view, sheet)
    apply()
  }, [sheet, view])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => setView({ w: viewport.clientWidth, h: viewport.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!mapUrl || mapFailed) onMapReady()
  }, [mapFailed, mapUrl, onMapReady])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const next = cam.current.k * (event.deltaY > 0 ? 1 / 1.12 : 1.12)
      zoomAt(next, event.clientX - rect.left, event.clientY - rect.top)
    }
    viewport.addEventListener("wheel", onWheel, { passive: false })
    return () => viewport.removeEventListener("wheel", onWheel)
  }, [])

  const markers = useMemo(() => {
    const next: Marker[] = []
    for (const vehicle of vehicles) {
      const point = projectPoint(vehicle.x, vehicle.z, frame)
      const occupied = vehicleOccupied(vehicle)
      const role = vehicleRole(vehicle)
      const driverName = vehicle.driver?.trim() || null
      next.push({
        key: `v:${vehicle.id}`,
        x: point.x,
        y: point.y,
        heading: vehicle.heading,
        kind: "vehicle",
        role,
        farmColor: placeColor(vehicle.farmId),
        // Map captions: player name only — never the vehicle name.
        label: occupied ? driverName || t("live.occupied") : vehicle.name || vehicle.id,
        icon: vehicleIcon(vehicle),
        active: vehicleActive(vehicle),
        occupied,
        attachments: vehicle.attachments?.trim() || null,
        priority: occupied ? 100 : rolePriority(role),
        busy: null,
      })
    }
    for (const player of players) {
      const point = projectPoint(player.x, player.z, frame)
      next.push({
        key: `p:${player.id}`,
        x: point.x,
        y: point.y,
        heading: player.heading,
        kind: "player",
        role: "player",
        farmColor: placeColor(player.farmId ?? null),
        label: player.name || t("live.players"),
        icon: null,
        active: true,
        occupied: true,
        attachments: null,
        priority: 90,
        busy: null,
      })
    }
    for (const place of places) {
      const point = projectPoint(place.x, place.z, frame)
      next.push({
        key: `o:${place.id}`,
        x: point.x,
        y: point.y,
        heading: null,
        kind: "place",
        role: "building",
        farmColor: placeColor(place.farmId),
        label: place.name || place.type || place.id,
        icon: place.iconUrl ?? null,
        active: false,
        occupied: false,
        attachments: null,
        priority: rolePriority("building"),
        busy: null,
      })
    }
    if (pin) {
      const point = projectPoint(pin.x, pin.z, frame)
      next.push({
        key: "pin",
        x: point.x,
        y: point.y,
        heading: null,
        kind: "pin",
        role: "pin",
        farmColor: null,
        label: pin.name,
        icon: null,
        active: false,
        occupied: false,
        attachments: null,
        priority: 50,
        busy: null,
      })
    }
    return next
  }, [frame, pin, placeColor, places, players, t, vehicleIcon, vehicleRole, vehicles])

  const draw = useMemo(() => {
    // On-foot players / pin / selection stay alone. Occupied vehicles stay in the
    // pool so nearby implements collapse into the same +N cluster as stacked gear.
    const kept = markers.filter((marker) => marker.key === selected || marker.kind === "pin" || marker.kind === "player")
    const pool = markers.filter((marker) => marker.key !== selected && marker.kind !== "pin" && marker.kind !== "player")
    const used = new Array(pool.length).fill(false)
    const placed: Marker[] = [...kept]
    const stageOf = (marker: Marker) => ({
      x: sheet.left + (marker.x / 100) * sheet.size,
      y: sheet.top + (marker.y / 100) * sheet.size,
    })
    for (let i = 0; i < pool.length; i += 1) {
      if (used[i]) continue
      used[i] = true
      const group = [pool[i]]
      if (pool[i].kind === "vehicle") {
        const origin = stageOf(pool[i])
        for (let j = i + 1; j < pool.length; j += 1) {
          if (used[j] || pool[j].kind !== "vehicle") continue
          const other = stageOf(pool[j])
          // Slightly looser than vehicle stacks so hitch implements join the tractor.
          if (Math.hypot(origin.x - other.x, origin.y - other.y) * Math.max(zoom, 1) > 56) continue
          used[j] = true
          group.push(pool[j])
        }
      }
      const lead = [...group].sort(
        (a, b) => Number(b.occupied) - Number(a.occupied) || b.priority - a.priority || Number(b.active) - Number(a.active),
      )[0]
      if (group.length > 1) {
        placed.push({
          ...lead,
          key: `c:${group.map((item) => item.key).sort().join("|")}`,
          count: group.length,
          members: group,
          // Keep player pulse / heading when the lead is occupied.
          active: lead.occupied ? true : false,
          occupied: lead.occupied,
          priority: Math.max(...group.map((item) => item.priority)),
          attachments: null,
          busy: null,
        })
      } else {
        placed.push(lead)
      }
    }
    placed.sort((a, b) => a.priority - b.priority)
    return placed
  }, [markers, selected, sheet, zoom])

  const focused = useRef<string | null>(null)
  useEffect(() => {
    if (!selected) {
      focused.current = null
      return
    }
    if (focused.current === selected) return
    const marker = markers.find((item) => item.key === selected)
    const viewport = viewportRef.current
    const stage = stageRef.current
    if (!marker || !viewport || !stage || sheet.size < 8) return
    focused.current = selected
    const k = Math.max(cam.current.k, 3.4)
    const px = sheet.left + (marker.x / 100) * sheet.size
    const py = sheet.top + (marker.y / 100) * sheet.size
    commit({
      k,
      x: viewport.clientWidth / 2 - px * k,
      y: viewport.clientHeight / 2 - py * k,
    })
  }, [markers, selected, sheet])

  return (
    <div className="fields-map-frame live-frame">
      <div className="fields-zoom">
        <button
          type="button"
          className="btn btn-secondary"
          aria-label="+"
          onClick={() => {
            const viewport = viewportRef.current
            if (!viewport) return
            zoomAt(cam.current.k * 1.25, viewport.clientWidth / 2, viewport.clientHeight / 2)
          }}
        >
          <Plus className="icon" />
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          aria-label="-"
          onClick={() => {
            const viewport = viewportRef.current
            if (!viewport) return
            zoomAt(cam.current.k / 1.25, viewport.clientWidth / 2, viewport.clientHeight / 2)
          }}
        >
          <Minus className="icon" />
        </button>
      </div>
      {cluster && cluster.length > 0 ? (
        <section className="live-cluster">
          <header>
            <div>
              <strong>{t("live.cluster", { count: cluster.length })}</strong>
              <small>{t("live.clusterHint")}</small>
            </div>
            <button type="button" onClick={() => setCluster(null)} aria-label="×">
              ×
            </button>
          </header>
          <ul>
            {[...cluster]
              .sort((a, b) => b.priority - a.priority || a.label.localeCompare(b.label))
              .map((member) => (
                <li key={member.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setCluster(null)
                      onSelect(member.key)
                    }}
                  >
                    <span className="live-obj-icon">
                      {member.icon && !brokenIcons.has(member.icon) ? (
                        <img
                          src={member.icon}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          onError={() => setBrokenIcons((prev) => new Set(prev).add(member.icon!))}
                        />
                      ) : null}
                      <RoleIcon
                        role={member.role}
                        className={member.icon && !brokenIcons.has(member.icon) ? "icon-fallback is-hidden" : "icon-fallback"}
                      />
                    </span>
                    <span>
                      <strong>{member.label}</strong>
                      <small>
                        {t(`live.role.${member.role}`)}
                        {member.busy === "ai" ? ` · ${t("live.ai")}` : member.busy === "moving" ? ` · ${t("live.moving")}` : member.busy ? ` · ${member.busy}` : ""}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ) : null}
      <div
        ref={viewportRef}
        className={dragging ? "fields-viewport is-drag" : "fields-viewport"}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, y: event.clientY, cx: cam.current.x, cy: cam.current.y, moved: false }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start) return
          const dx = event.clientX - start.x
          const dy = event.clientY - start.y
          if (Math.abs(dx) + Math.abs(dy) > 4) start.moved = true
          commit({ x: start.cx + dx, y: start.cy + dy, k: cam.current.k })
        }}
        onPointerUp={(event) => {
          const start = drag.current
          drag.current = null
          setDragging(false)
          if (!start || start.moved) return
          const hit = document
            .elementsFromPoint(event.clientX, event.clientY)
            .find((node) => node instanceof Element && node.closest("[data-marker]"))
          const node = hit instanceof Element ? hit.closest("[data-marker]") : null
          const id = node?.getAttribute("data-marker") ?? ""
          if (id.startsWith("c:")) {
            const found = draw.find((marker) => marker.key === id)
            setCluster(found?.members ?? null)
            return
          }
          setCluster(null)
          onSelect(id)
        }}
      >
        <div ref={stageRef} className="fields-stage" style={{ "--map-zoom": zoom } as CSSProperties}>
          {mapUrl && !mapFailed ? (
            <img
              className="live-sheet"
              style={{ left: sheet.left, top: sheet.top, width: sheet.size, height: sheet.size }}
              src={mapUrl}
              alt=""
              onError={() => {
                setMapFailed(true)
                onMapReady()
              }}
              onLoad={(event) => {
                onMapReady()
                if (skipContentBox) return
                const image = event.currentTarget
                const canvas = document.createElement("canvas")
                const width = Math.min(image.naturalWidth, 320)
                const height = Math.round((image.naturalHeight / image.naturalWidth) * width)
                canvas.width = width
                canvas.height = height
                const context = canvas.getContext("2d", { willReadFrequently: true })
                if (!context) return
                context.drawImage(image, 0, 0, width, height)
                onContentBox(measureMapContent(context.getImageData(0, 0, width, height).data, width, height))
              }}
            />
          ) : (
            <div className="fields-terrain" />
          )}
          <svg className="live-sheet" style={{ left: sheet.left, top: sheet.top, width: sheet.size, height: sheet.size }} viewBox="0 0 100 100">
            <defs>
              <clipPath id="live-icon-clip" clipPathUnits="objectBoundingBox">
                <circle cx="0.5" cy="0.5" r="0.5" />
              </clipPath>
            </defs>
            {showFields || showCrops
              ? shapes.map((shape) => {
                  const labelSize = (11 * 100) / (Math.max(sheet.size, 1) * Math.max(zoom, 1))
                  const iconSize = (14 * 100) / (Math.max(sheet.size, 1) * Math.max(zoom, 1))
                  const pack = cropIcon(shape.fruitName)
                  const game = shape.iconUrl && !brokenIcons.has(shape.iconUrl) ? shape.iconUrl : null
                  const fruitIcon = showCrops ? game ?? pack : null
                  return (
                    <g key={`shape-${shape.id}`}>
                      <polygon
                        className={showCrops ? "live-field is-crop" : "live-field"}
                        points={shape.points}
                        style={showCrops ? { fill: withAlpha(shape.color, 0.42) } : undefined}
                      />
                      {showFields ? (
                        <text
                          className="live-field-no"
                          x={shape.x}
                          y={fruitIcon ? shape.y + iconSize * 0.55 : shape.y}
                          fontSize={labelSize}
                          strokeWidth={labelSize * 0.16}
                          textAnchor="middle"
                          dominantBaseline="middle"
                        >
                          {shape.id}
                        </text>
                      ) : null}
                      {fruitIcon ? (
                        <image
                          className="live-field-crop"
                          href={fruitIcon}
                          x={shape.x - iconSize / 2}
                          y={shape.y - (showFields ? iconSize * 0.95 : iconSize / 2)}
                          width={iconSize}
                          height={iconSize}
                          preserveAspectRatio="xMidYMid meet"
                          onError={() => {
                            if (!shape.iconUrl || fruitIcon !== shape.iconUrl) return
                            setBrokenIcons((prev) => new Set(prev).add(shape.iconUrl!))
                          }}
                        />
                      ) : null}
                    </g>
                  )
                })
              : null}
            {draw.map((marker) => {
              const on = marker.key === selected
              const rotation = marker.heading == null ? 0 : headingToSvgDegrees(marker.heading)
              const toMap = (screenPx: number) => (screenPx * 100) / (Math.max(sheet.size, 1) * Math.max(zoom, 1))
              const piled = (marker.count ?? 0) > 1
              const implement = marker.role === "tool" || marker.role === "trailer" || marker.role === "pallet"
              const base = piled
                ? 36
                : implement
                  ? 22
                  : marker.role === "building" || marker.role === "player"
                    ? 20
                    : marker.occupied
                      ? 34
                      : marker.active
                        ? 32
                        : 28
              const mark = toMap(on || marker.occupied ? base + 4 : base)
              const ring = marker.farmColor || (marker.role === "player" ? "#f4f1e8" : "#8e9890")
              // Occupied stacks keep a heading arrow even with attached implements in the +N badge.
              const showArrow = showsHeading(marker.role, marker.active || marker.occupied, marker.heading, piled && !marker.occupied)
              const icon = marker.icon && !brokenIcons.has(marker.icon) ? marker.icon : null
              const stateClass = [
                on ? "is-on" : "",
                marker.occupied ? "is-occupied" : marker.active ? "is-active" : "is-idle",
                `is-${marker.role}`,
              ]
                .filter(Boolean)
                .join(" ")
              // Only player names on the map (occupied vehicle or on foot).
              const showCaption = (marker.occupied || marker.kind === "player") && Boolean(marker.label)
              // Keep the name above the plate (mark is the plate radius in map units).
              const captionY = -(mark * 1.12 + toMap(6))
              return (
                <g key={marker.key} data-marker={marker.key} className={`live-marker ${stateClass}`} transform={`translate(${marker.x} ${marker.y})`}>
                  <g transform={`scale(${mark})`}>
                    <circle r="0.94" className="live-marker-plate" />
                    <circle r="0.94" className="live-marker-ring" style={{ stroke: ring }} />
                    {icon ? (
                      <image
                        href={icon}
                        x="-0.72"
                        y="-0.72"
                        width="1.44"
                        height="1.44"
                        clipPath="url(#live-icon-clip)"
                        preserveAspectRatio="xMidYMid meet"
                        onError={() => setBrokenIcons((prev) => new Set(prev).add(icon))}
                      />
                    ) : (
                      <g className="live-glyph">
                        <MarkerGlyph role={marker.role} />
                      </g>
                    )}
                    {showArrow ? (
                      <path className="live-heading" transform={`rotate(${rotation})`} d="M0,-1.78 L0.46,-1.02 L-0.46,-1.02 Z" />
                    ) : null}
                    {on ? <circle r="0.94" className="live-marker-rim" /> : null}
                  </g>
                  {piled ? (
                    <g className="live-count" transform={`translate(${toMap(14)} ${toMap(-14)}) scale(${toMap(16)})`}>
                      <circle r="1.05" />
                      <text textAnchor="middle" y="0.32">
                        {`+${marker.count}`}
                      </text>
                    </g>
                  ) : null}
                  {showCaption ? (
                    <g className="live-caption" transform={`translate(0 ${captionY}) scale(${toMap(11)})`}>
                      <text textAnchor="middle" dominantBaseline="auto" y="0">
                        {marker.label}
                      </text>
                    </g>
                  ) : null}
                </g>
              )
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}
