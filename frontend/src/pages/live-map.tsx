import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { Boxes, Minus, Plus, Tractor, Truck, UserRound, Warehouse, Wheat, Wrench } from "lucide-react"
import {
  apiWorkspaceFields,
  apiWorkspaceLiveMap,
  apiWorkspaceVehicles,
  type LiveMapResponse,
  type LivePlace,
  type LivePlayer,
  type LiveVehicle,
} from "../api"
import { EmptyState, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { projectPoint, effectiveMapSize, frameFromContentBox, measureMapContent, terrainFrame, type MapFrame } from "../field-format"
import { useStore } from "../store"
import type { FieldsResponse, Vehicle } from "../types"
import { useWorkspaceRoute } from "../use-workspace"

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
  count?: number
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

function objectKind(role: MarkerRole): Exclude<ObjectTab, "all"> {
  if (role === "player") return "player"
  if (role === "building") return "building"
  if (role === "tool" || role === "trailer" || role === "pallet") return "implement"
  return "vehicle"
}

function usedPlace(place: LivePlace) {
  const type = `${place.type ?? ""} ${place.name ?? ""}`.toLowerCase()
  return /silo|husband|animal|production|sell|unload|load|bunker|barn|stall|stable|workshop|garage|shed/.test(type)
}

function matches(query: string, value: string | null) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (value ?? "").toLowerCase().includes(needle)
}

export function LiveMapPage() {
  const { t } = useTranslation()
  const stamp = useTimeLabel()
  const [params] = useSearchParams()
  const pin = readPin(params)
  const { liveMode, moduleAccess } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "map") : null
  const [payload, setPayload] = useState<LiveMapResponse | null>(null)
  const [fields, setFields] = useState<FieldsResponse | null>(null)
  const [fleet, setFleet] = useState<Vehicle[]>([])
  const [loading, setLoading] = useState(liveMode)
  const [contentBox, setContentBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [hiddenFarms, setHiddenFarms] = useState<number[]>([])
  const [showFields, setShowFields] = useState(true)
  const [resetToken, setResetToken] = useState(0)
  const [tab, setTab] = useState<ObjectTab>(pin ? "building" : "all")
  const [query, setQuery] = useState(pin?.name ?? "")
  const [selected, setSelected] = useState<string | null>(pin ? "pin" : null)

  useEffect(() => {
    if (!workspace || !allowed || !access || !liveMode) return
    let cancelled = false
    const loadFields = async () => {
      try {
        const next = await apiWorkspaceFields(workspace.id)
        if (!cancelled) setFields(next)
      } catch {
        if (!cancelled) setFields(null)
      }
    }
    const loadLive = async (first: boolean) => {
      if (!first && document.hidden) return
      if (first) setLoading(true)
      try {
        const next = await apiWorkspaceLiveMap(workspace.id)
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
        if (!cancelled && first) setLoading(false)
      }
    }
    const loadFleet = async () => {
      try {
        const next = await apiWorkspaceVehicles(workspace.id)
        if (!cancelled) setFleet(next.vehicles ?? [])
      } catch {
        if (!cancelled) setFleet([])
      }
    }
    void loadFields()
    void loadLive(true)
    void loadFleet()
    const fieldsTimer = window.setInterval(() => void loadFields(), 60_000)
    const liveTimer = window.setInterval(() => void loadLive(false), 20_000)
    return () => {
      cancelled = true
      window.clearInterval(fieldsTimer)
      window.clearInterval(liveTimer)
    }
  }, [access, allowed, liveMode, workspace])

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
    const next: string[] = []
    for (const field of rows) {
      if (field.points.length < 3) continue
      next.push(
        field.points
          .map(([x, z]) => {
            const point = projectPoint(x, z, frame)
            return `${point.x.toFixed(2)},${point.y.toFixed(2)}`
          })
          .join(" "),
      )
    }
    return next
  }, [fields, frame])

  const farmOpen = (id: number | null) => id == null || !hiddenFarms.includes(id)
  const vehicles = (payload?.vehicles ?? []).filter((vehicle) => farmOpen(vehicle.farmId))
  const players = payload?.players ?? []
  const places = (payload?.places ?? []).filter((place) => usedPlace(place) && farmOpen(place.farmId))
  const visibleVehicles = vehicles.filter((vehicle) => matches(query, vehicle.name))
  const visiblePlayers = players.filter((player) => matches(query, player.name))
  const visiblePlaces = places.filter((place) => matches(query, place.name ?? place.type))

  const month = payload?.period != null && payload.period >= 1 && payload.period <= 12 ? PERIOD_TO_MONTH[payload.period - 1] : null
  const clock = clockLabel(payload?.dayTime ?? null)
  const farmColor = (farmId: number | null) => payload?.farms?.find((item) => item.id === farmId)?.color ?? null
  const fleetMatch = (id: string) => fleet.find((item) => item.id === `feed-${workspace?.id ?? ""}-${id}` || item.id === id) ?? null
  const selectedVehicle = vehicles.find((vehicle) => `v:${vehicle.id}` === selected) ?? null

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !access) return <PermissionBlock />

  const roleOf = (vehicle: LiveVehicle) => markerRole("vehicle", fleetMatch(vehicle.id)?.category ?? null)
  const catalog = [
    ...visibleVehicles.map((vehicle) => ({
      key: `v:${vehicle.id}`,
      farmId: vehicle.farmId,
      kind: objectKind(roleOf(vehicle)),
      name: vehicle.name || vehicle.id,
      detail: vehicle.ai ? t("live.ai") : vehicle.driver || t("live.parked"),
      iconUrl: fleetMatch(vehicle.id)?.iconUrl ?? null,
      role: roleOf(vehicle),
    })),
    ...visiblePlayers.map((player) => ({
      key: `p:${player.id}`,
      farmId: null as number | null,
      kind: "player" as const,
      name: player.name || player.id,
      detail: t("live.players"),
      iconUrl: null,
      role: "player" as const,
    })),
    ...visiblePlaces.map((place) => ({
      key: `o:${place.id}`,
      farmId: place.farmId,
      kind: "building" as const,
      name: place.name || place.type || place.id,
      detail: place.type || t("live.buildings"),
      iconUrl: null,
      role: "building" as const,
    })),
  ].filter((row) => tab === "all" || row.kind === tab)
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
      <div className="live-layout">
      <div className="live-stage">
        {loading && !payload ? <p className="live-wait">{t("live.loading")}</p> : null}
        {payload?.error === "failed" && payload.vehicles.length === 0 ? (
          <EmptyState title={t("live.failedTitle")} body={t("live.failedBody")} />
        ) : null}
        {payload && !payload.ok && payload.error === "missing" ? (
          <EmptyState title={t("live.missingTitle")} body={t("live.missingBody")} />
        ) : null}
        <LiveCanvas
          mapUrl={fields?.pdaMap && liveMode ? `/api/workspaces/${workspace.id}/pda-map` : null}
          frame={frame}
          shapes={shapes}
          vehicles={vehicles}
          players={players}
          places={places}
          pin={pin}
          selected={selected}
          showFields={showFields}
          resetToken={resetToken}
          vehicleRole={roleOf}
          vehicleIcon={(vehicle) => fleetMatch(vehicle.id)?.iconUrl ?? null}
          placeColor={(farmId) => farmColor(farmId)}
          onSelect={setSelected}
          onContentBox={setContentBox}
        />
        <div className="live-toolbar">
          <strong>{workspace.mapName || t("modules.map")}</strong>
          <div>
            <button type="button" className={showFields ? "is-on" : ""} onClick={() => setShowFields((value) => !value)}>
              {t("live.fieldsLayer")}
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
      </div>
      <aside className="live-side">
        <section className="panel live-objects">
          <header>
            <h2>{t("live.objects")}</h2>
            <span>{t("live.objectCount", { count: catalog.length })}</span>
          </header>
          <label className="live-search">
            <span className="sr-only">{t("live.search")}</span>
            <input value={query} placeholder={t("live.search")} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="live-tabs" role="tablist">
            {(["all", "vehicle", "implement", "building", "player"] as const).map((id) => (
              <button key={id} type="button" className={tab === id ? "is-on" : ""} onClick={() => setTab(id)}>
                {t(id === "all" ? "live.all" : id === "vehicle" ? "live.vehicles" : id === "implement" ? "live.implements" : id === "building" ? "live.buildings" : "live.players")}
              </button>
            ))}
          </div>
          {selectedVehicle ? (
            <div className="live-card">
              <strong>{selectedVehicle.name || selectedVehicle.id}</strong>
              <p>{selectedVehicle.ai ? t("live.ai") : selectedVehicle.driver}</p>
              {fleetMatch(selectedVehicle.id) ? (
                <Link to={`/w/${workspace.id}/equipment/${encodeURIComponent(fleetMatch(selectedVehicle.id)!.id)}`}>{t("modules.equipment")}</Link>
              ) : null}
            </div>
          ) : null}
          <div className="live-groups">
            {catalog.length === 0 ? <p className="live-empty">{t("live.emptyVehicles")}</p> : null}
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
                      {row.iconUrl ? <img src={row.iconUrl} alt="" /> : <RoleIcon role={row.role} />}
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
        <section className="panel live-stats">
          <h2>{t("live.stats")}</h2>
          <div>
            <span><Tractor className="icon" /><strong>{vehicleCount}</strong><small>{t("live.vehicles")}</small></span>
            <span><Wrench className="icon" /><strong>{implementCount}</strong><small>{t("live.implements")}</small></span>
            <span><Warehouse className="icon" /><strong>{places.length}</strong><small>{t("live.buildings")}</small></span>
            <span><strong>{fields?.fields.length ?? 0}</strong><small>{t("modules.fields")}</small></span>
          </div>
          {payload?.writtenAt ? <p>{t("live.updated", { time: stamp(payload.writtenAt, "") })}</p> : null}
        </section>
      </aside>
      </div>
    </div>
  )
}

function RoleIcon({ role }: { role: MarkerRole }) {
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
  return <Icon className="icon" aria-hidden="true" />
}

function MarkerGlyph({ role }: { role: MarkerRole }) {
  if (role === "building") return <polygon points="0,-0.78 0.66,-0.16 0.66,0.62 -0.66,0.62 -0.66,-0.16" />
  if (role === "player") {
    return (
      <g>
        <circle cy="-0.32" r="0.24" />
        <path d="M-0.42,0.58 Q0,0.02 0.42,0.58 Z" />
      </g>
    )
  }
  if (role === "trailer") return <rect x="-0.68" y="-0.3" width="1.36" height="0.6" rx="0.14" />
  if (role === "tool") return <polygon points="0,-0.66 0.66,0 0,0.66 -0.66,0" />
  if (role === "harvester") return <polygon points="-0.74,-0.32 0.28,-0.32 0.74,0.08 0.28,0.42 -0.74,0.42" />
  if (role === "pallet") return <rect x="-0.34" y="-0.34" width="0.68" height="0.68" />
  if (role === "pin") return <polygon points="0,-0.72 0.16,-0.16 0.72,0 0.16,0.16 0,0.72 -0.16,0.16 -0.72,0 -0.16,-0.16" />
  if (role === "tractor") return <polygon points="0,0.72 -0.5,-0.48 0.5,-0.48" />
  return <circle r="0.42" />
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
  resetToken,
  vehicleRole,
  vehicleIcon,
  placeColor,
  onSelect,
  onContentBox,
}: {
  mapUrl: string | null
  frame: MapFrame
  shapes: string[]
  vehicles: LiveVehicle[]
  players: LivePlayer[]
  places: LivePlace[]
  pin: { x: number; z: number; name: string } | null
  selected: string | null
  showFields: boolean
  resetToken: number
  vehicleRole: (vehicle: LiveVehicle) => MarkerRole
  vehicleIcon: (vehicle: LiveVehicle) => string | null
  placeColor: (farmId: number | null) => string | null
  onSelect: (id: string) => void
  onContentBox: (box: { x: number; y: number; w: number; h: number } | null) => void
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const cam = useRef({ x: 0, y: 0, k: 1 })
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [mapFailed, setMapFailed] = useState(false)
  const [view, setView] = useState({ w: 0, h: 0 })

  useEffect(() => {
    cam.current = { x: 0, y: 0, k: 1 }
    const el = stageRef.current
    if (el) el.style.transform = "translate(0px, 0px) scale(1)"
    setZoom(1)
  }, [resetToken])

  function apply() {
    const el = stageRef.current
    if (!el) return
    el.style.transform = `translate(${cam.current.x}px, ${cam.current.y}px) scale(${cam.current.k})`
    setZoom((prev) => (prev === cam.current.k ? prev : cam.current.k))
  }

  function zoomAt(next: number, px: number, py: number) {
    const prev = cam.current.k
    const clamped = Math.min(10, Math.max(1, next))
    if (clamped === 1) {
      cam.current = { x: 0, y: 0, k: 1 }
      apply()
      return
    }
    const ratio = clamped / prev
    cam.current.x = px - (px - cam.current.x) * ratio
    cam.current.y = py - (py - cam.current.y) * ratio
    cam.current.k = clamped
    apply()
  }

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => setView({ w: viewport.clientWidth, h: viewport.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const sheet = useMemo(() => {
    const cropW = frame.scaleX > 0.05 ? frame.scaleX : 1
    const cropH = frame.scaleZ > 0.05 ? frame.scaleZ : 1
    if (view.w < 8 || view.h < 8) return { left: 0, top: 0, size: Math.max(view.w, view.h) }
    const size = Math.max(view.w / cropW, view.h / cropH)
    return {
      size,
      left: (view.w - size * cropW) / 2 - size * frame.padX,
      top: (view.h - size * cropH) / 2 - size * frame.padZ,
    }
  }, [frame, view])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const next = cam.current.k * (event.deltaY > 0 ? 1 / 1.12 : 1.12)
      const prev = cam.current.k
      const clamped = Math.min(10, Math.max(1, next))
      if (clamped === 1) {
        cam.current = { x: 0, y: 0, k: 1 }
      } else {
        const ratio = clamped / prev
        const px = event.clientX - rect.left
        const py = event.clientY - rect.top
        cam.current.x = px - (px - cam.current.x) * ratio
        cam.current.y = py - (py - cam.current.y) * ratio
        cam.current.k = clamped
      }
      const el = stageRef.current
      if (el) el.style.transform = `translate(${cam.current.x}px, ${cam.current.y}px) scale(${cam.current.k})`
      setZoom(cam.current.k)
    }
    viewport.addEventListener("wheel", onWheel, { passive: false })
    return () => viewport.removeEventListener("wheel", onWheel)
  }, [])

  const markers = useMemo(() => {
    const next: Marker[] = []
    for (const vehicle of vehicles) {
      const point = projectPoint(vehicle.x, vehicle.z, frame)
      next.push({
        key: `v:${vehicle.id}`,
        x: point.x,
        y: point.y,
        heading: vehicle.heading,
        kind: "vehicle",
        role: vehicleRole(vehicle),
        farmColor: placeColor(vehicle.farmId),
        label: vehicle.name || vehicle.id,
        icon: vehicleIcon(vehicle),
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
        farmColor: null,
        label: player.name || player.id,
        icon: null,
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
        icon: null,
      })
    }
    if (pin) {
      const point = projectPoint(pin.x, pin.z, frame)
      next.push({ key: "pin", x: point.x, y: point.y, heading: null, kind: "pin", role: "pin", farmColor: null, label: pin.name, icon: null })
    }
    return next
  }, [frame, pin, placeColor, places, players, vehicleIcon, vehicleRole, vehicles])

  const draw = useMemo(() => {
    const kept = markers.filter((marker) => marker.key === selected || marker.kind === "pin")
    const pool = markers.filter((marker) => marker.key !== selected && marker.kind !== "pin")
    const used = new Array(pool.length).fill(false)
    const placed: Marker[] = [...kept]
    const stageOf = (marker: Marker) => ({
      x: sheet.left + (marker.x / 100) * sheet.size,
      y: sheet.top + (marker.y / 100) * sheet.size,
    })
    for (let i = 0; i < pool.length; i += 1) {
      if (used[i]) continue
      const group = [i]
      const origin = stageOf(pool[i])
      for (let j = i + 1; j < pool.length; j += 1) {
        if (used[j]) continue
        const other = stageOf(pool[j])
        if (Math.hypot(origin.x - other.x, origin.y - other.y) * Math.max(zoom, 1) > 18) continue
        used[j] = true
        group.push(j)
      }
      const leadIndex = group.find((index) => pool[index].kind === "vehicle") ?? group[0]
      const lead = pool[leadIndex]
      placed.push(group.length > 1 ? { ...lead, count: group.length } : lead)
    }
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
    cam.current = {
      k,
      x: viewport.clientWidth / 2 - px * k,
      y: viewport.clientHeight / 2 - py * k,
    }
    stage.style.transform = `translate(${cam.current.x}px, ${cam.current.y}px) scale(${k})`
    setZoom(k)
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
          if (cam.current.k <= 1) return
          cam.current.x = start.cx + dx
          cam.current.y = start.cy + dy
          apply()
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
              onError={() => setMapFailed(true)}
              onLoad={(event) => {
                const image = event.currentTarget
                const canvas = document.createElement("canvas")
                const width = Math.min(image.naturalWidth, 480)
                const height = Math.round((image.naturalHeight / image.naturalWidth) * width)
                canvas.width = width
                canvas.height = height
                const context = canvas.getContext("2d")
                if (!context) return
                context.drawImage(image, 0, 0, width, height)
                onContentBox(measureMapContent(context.getImageData(0, 0, width, height).data, width, height))
              }}
            />
          ) : (
            <div className="fields-terrain" />
          )}
          <svg className="live-sheet" style={{ left: sheet.left, top: sheet.top, width: sheet.size, height: sheet.size }} viewBox="0 0 100 100">
            {showFields
              ? shapes.map((points, index) => <polygon key={`shape-${index}`} className="live-field" points={points} />)
              : null}
            {draw.map((marker) => {
              const on = marker.key === selected
              const rotation = marker.heading == null ? 0 : (-marker.heading * 180) / Math.PI
              const toMap = (screenPx: number) => (screenPx * 100) / (Math.max(sheet.size, 1) * Math.max(zoom, 1))
              const mark = toMap(marker.icon ? (on ? 22 : 18) : on ? 16 : 13)
              return (
                <g key={marker.key} data-marker={marker.key} className={on ? `live-marker is-${marker.role} is-on` : `live-marker is-${marker.role}`} transform={`translate(${marker.x} ${marker.y})`}>
                  <g transform={`rotate(${marker.icon ? 0 : rotation}) scale(${mark})`}>
                    <circle r="0.92" className="live-marker-plate" style={marker.farmColor ? { fill: marker.farmColor } : undefined} />
                    {marker.icon ? (
                      <image href={marker.icon} x="-0.72" y="-0.72" width="1.44" height="1.44" />
                    ) : (
                      <MarkerGlyph role={marker.role} />
                    )}
                    <circle className={marker.farmColor ? "live-marker-ring is-farm" : "live-marker-ring"} r="1.02" style={marker.farmColor ? { stroke: marker.farmColor } : undefined} />
                  </g>
                  {marker.count && marker.count > 1 ? (
                    <g className="live-count" transform={`translate(${toMap(9)} ${toMap(-9)}) scale(${toMap(11)})`}>
                      <text textAnchor="middle" y="0.35">
                        {marker.count}
                      </text>
                    </g>
                  ) : null}
                  {on && marker.label ? (
                    <g className="live-caption" transform={`translate(0 ${-toMap(18)}) scale(${toMap(12)})`}>
                      <text textAnchor="middle" y="0">
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
