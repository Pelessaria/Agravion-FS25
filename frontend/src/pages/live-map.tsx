import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { Minus, Plus } from "lucide-react"
import {
  apiWorkspaceFields,
  apiWorkspaceLiveMap,
  type LiveMapResponse,
  type LivePlace,
  type LivePlayer,
  type LiveVehicle,
} from "../api"
import { EmptyState, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { projectPoint, effectiveMapSize, frameFromContentBox, measureMapContent, terrainFrame, type MapFrame } from "../field-format"
import { useStore } from "../store"
import type { FieldsResponse } from "../types"
import { useWorkspaceRoute } from "../use-workspace"

const PERIOD_TO_MONTH = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2]

type Tab = "vehicles" | "players" | "places"
type MarkerKind = "vehicle" | "player" | "place" | "pin"
type Marker = {
  key: string
  x: number
  y: number
  heading: number | null
  kind: MarkerKind
  label: string
}

function clockLabel(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null
  const ms = value > 0 && value <= 1 ? value * 24 * 60 * 60 * 1000 : value
  if (ms < 0 || ms > 48 * 60 * 60 * 1000) return null
  const minutes = Math.floor(ms / 60000) % (24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

function weatherLabel(raw: string | null) {
  if (!raw) return null
  const words = raw.replace(/[_-]+/g, " ").trim()
  if (!words) return null
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
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
  const { liveMode, moduleAccess, selectedFarm } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "map") : null
  const farm = workspace ? selectedFarm(workspace.id) : null
  const [payload, setPayload] = useState<LiveMapResponse | null>(null)
  const [fields, setFields] = useState<FieldsResponse | null>(null)
  const [loading, setLoading] = useState(liveMode)
  const [contentBox, setContentBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [ownOnly, setOwnOnly] = useState(true)
  const [tab, setTab] = useState<Tab>(pin ? "places" : "vehicles")
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
            vehicles: [],
            players: [],
            places: [],
          })
        }
      } finally {
        if (!cancelled && first) setLoading(false)
      }
    }
    void loadFields()
    void loadLive(true)
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

  const farmId = farm?.gameFarmId ?? null
  const vehicles = (payload?.vehicles ?? []).filter((vehicle) => !ownOnly || farmId == null || vehicle.farmId === farmId)
  const players = payload?.players ?? []
  const places = (payload?.places ?? []).filter((place) => !ownOnly || farmId == null || place.farmId == null || place.farmId === farmId)
  const visibleVehicles = vehicles.filter((vehicle) => matches(query, vehicle.name))
  const visiblePlayers = players.filter((player) => matches(query, player.name))
  const visiblePlaces = places.filter((place) => matches(query, place.name ?? place.type))

  const month = payload?.period != null && payload.period >= 1 && payload.period <= 12 ? PERIOD_TO_MONTH[payload.period - 1] : null
  const clock = clockLabel(payload?.dayTime ?? null)
  const weather = weatherLabel(payload?.weather ?? null)
  const selectedVehicle = vehicles.find((vehicle) => `v:${vehicle.id}` === selected) ?? null
  const selectedPlayer = players.find((player) => `p:${player.id}` === selected) ?? null
  const selectedPlace = places.find((place) => `o:${place.id}` === selected) ?? null

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !access) return <PermissionBlock />

  const rows =
    tab === "vehicles" ? visibleVehicles.length : tab === "players" ? visiblePlayers.length : visiblePlaces.length

  return (
    <div className="page live-page">
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
          onSelect={setSelected}
          onContentBox={setContentBox}
        />
        <div className="live-hud">
          {clock ? (
            <span className="live-chip">
              {clock}
              {payload?.day != null ? ` · ${t("live.day", { day: payload.day })}` : ""}
              {month != null ? ` · ${t(`fields.month.${month}`)}` : ""}
              {payload?.paused ? ` · ${t("live.paused")}` : ""}
            </span>
          ) : null}
          {weather ? (
            <span className="live-chip">
              {weather}
              {payload?.temperature != null ? ` ${payload.temperature.toFixed(1)}°` : ""}
              {payload?.windSpeed != null ? ` · ${payload.windSpeed.toFixed(1)}` : ""}
            </span>
          ) : null}
          {payload?.writtenAt ? (
            <span className="live-chip" title={payload.source === "vehicles" ? t("live.fromVehicles") : undefined}>
              {t("live.updated", { time: stamp(payload.writtenAt, "") })}
            </span>
          ) : null}
        </div>
        <aside className="live-dock">
          <header className="live-dock-head">
            <h1>{t("modules.map")}</h1>
            <p>{t("modules.mapLead")}</p>
          </header>
          <label className="live-search">
            <span className="sr-only">{t("live.search")}</span>
            <input value={query} placeholder={t("live.search")} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="live-tabs" role="tablist">
            <button type="button" className={tab === "vehicles" ? "is-on" : ""} onClick={() => setTab("vehicles")}>
              {t("live.vehicles")}
              <em>{vehicles.length}</em>
            </button>
            <button type="button" className={tab === "players" ? "is-on" : ""} onClick={() => setTab("players")}>
              {t("live.players")}
              <em>{players.length}</em>
            </button>
            <button type="button" className={tab === "places" ? "is-on" : ""} onClick={() => setTab("places")}>
              {t("live.places")}
              <em>{places.length}</em>
            </button>
          </div>
          <button type="button" className={ownOnly ? "chip-check on live-farm" : "chip-check live-farm"} onClick={() => setOwnOnly((value) => !value)}>
            {ownOnly ? t("live.ownFarm") : t("live.allFarms")}
          </button>
          {selected === "pin" && pin ? (
            <div className="live-card">
              <strong>{pin.name || t("stock.places")}</strong>
            </div>
          ) : null}
          {selectedVehicle ? (
            <div className="live-card">
              <strong>{selectedVehicle.name || selectedVehicle.id}</strong>
              <p>
                {selectedVehicle.ai ? t("live.ai") : null}
                {selectedVehicle.driver ? ` ${selectedVehicle.driver}` : null}
              </p>
              {selectedVehicle.id ? (
                <Link to={`/w/${workspace.id}/equipment/${encodeURIComponent(selectedVehicle.id)}`}>{t("modules.equipment")}</Link>
              ) : null}
            </div>
          ) : null}
          {selectedPlayer ? (
            <div className="live-card">
              <strong>{selectedPlayer.name || selectedPlayer.id}</strong>
            </div>
          ) : null}
          {selectedPlace ? (
            <div className="live-card">
              <strong>{selectedPlace.name || selectedPlace.type || selectedPlace.id}</strong>
              {selectedPlace.type ? <p>{selectedPlace.type}</p> : null}
            </div>
          ) : null}
          <ul className="live-list">
            {rows === 0 ? (
              <li className="live-empty">
                {tab === "vehicles" ? t("live.emptyVehicles") : tab === "players" ? t("live.emptyPlayers") : t("live.emptyPlaces")}
              </li>
            ) : null}
            {tab === "vehicles"
              ? visibleVehicles.map((vehicle) => (
                  <li key={vehicle.id || vehicle.name}>
                    <button type="button" className={selected === `v:${vehicle.id}` ? "is-on" : ""} onClick={() => setSelected(`v:${vehicle.id}`)}>
                      <i className="live-dot is-vehicle" />
                      <span>{vehicle.name || vehicle.id}</span>
                      {vehicle.ai ? <em>{t("live.ai")}</em> : null}
                    </button>
                  </li>
                ))
              : null}
            {tab === "players"
              ? visiblePlayers.map((player) => (
                  <li key={player.id}>
                    <button type="button" className={selected === `p:${player.id}` ? "is-on" : ""} onClick={() => setSelected(`p:${player.id}`)}>
                      <i className="live-dot is-player" />
                      <span>{player.name || player.id}</span>
                    </button>
                  </li>
                ))
              : null}
            {tab === "places"
              ? visiblePlaces.map((place) => (
                  <li key={`${place.id}:${place.x}`}>
                    <button type="button" className={selected === `o:${place.id}` ? "is-on" : ""} onClick={() => setSelected(`o:${place.id}`)}>
                      <i className="live-dot is-place" />
                      <span>{place.name || place.type || place.id}</span>
                    </button>
                  </li>
                ))
              : null}
          </ul>
        </aside>
      </div>
    </div>
  )
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

  function apply() {
    const el = stageRef.current
    if (!el) return
    el.style.transform = `translate(${cam.current.x}px, ${cam.current.y}px) scale(${cam.current.k})`
    setZoom((prev) => (prev === cam.current.k ? prev : cam.current.k))
  }

  function zoomAt(next: number, px: number, py: number) {
    const prev = cam.current.k
    const clamped = Math.min(6, Math.max(1, next))
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
      const clamped = Math.min(6, Math.max(1, next))
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
        label: vehicle.name || vehicle.id,
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
        label: player.name || player.id,
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
        label: place.name || place.type || place.id,
      })
    }
    if (pin) {
      const point = projectPoint(pin.x, pin.z, frame)
      next.push({ key: "pin", x: point.x, y: point.y, heading: null, kind: "pin", label: pin.name })
    }
    return next
  }, [frame, pin, places, players, vehicles])

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
          onSelect(node?.getAttribute("data-marker") ?? "")
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
            {shapes.map((points, index) => (
              <polygon key={`shape-${index}`} className="live-field" points={points} />
            ))}
            {markers.map((marker) => {
              const on = marker.key === selected
              const rotation = marker.heading == null ? 0 : (-marker.heading * 180) / Math.PI
              const toMap = (screenPx: number) => (screenPx * 100) / (Math.max(sheet.size, 1) * Math.max(zoom, 1))
              const mark = toMap(on ? 15 : 10)
              return (
                <g key={marker.key} data-marker={marker.key} className={on ? `live-marker is-${marker.kind} is-on` : `live-marker is-${marker.kind}`} transform={`translate(${marker.x} ${marker.y})`}>
                  <g transform={`rotate(${rotation}) scale(${mark})`}>
                    {marker.kind === "vehicle" && marker.heading != null ? (
                      <polygon points="0,0.85 -0.55,-0.6 0.55,-0.6" />
                    ) : marker.kind === "place" || marker.kind === "pin" ? (
                      <polygon points="0,-0.7 0.16,-0.16 0.7,0 0.16,0.16 0,0.7 -0.16,0.16 -0.7,0 -0.16,-0.16" />
                    ) : (
                      <circle r="0.46" />
                    )}
                    <circle className="live-marker-ring" r="0.78" />
                  </g>
                  {on && marker.label ? (
                    <g className="live-caption" transform={`translate(0 ${-toMap(16)}) scale(${toMap(12)})`}>
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
