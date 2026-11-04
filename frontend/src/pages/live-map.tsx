import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
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
import {
  effectiveMapSize,
  frameFromContentBox,
  measureMapContent,
  projectPoint,
  terrainFrame,
  type MapFrame,
} from "../field-format"
import { useStore } from "../store"
import type { FieldsResponse } from "../types"
import { useWorkspaceRoute } from "../use-workspace"

const PERIOD_TO_MONTH = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2]

function clockLabel(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null
  const ms = value > 0 && value <= 1 ? value * 24 * 60 * 60 * 1000 : value
  if (ms < 0 || ms > 48 * 60 * 60 * 1000) return null
  const minutes = Math.floor(ms / 60000) % (24 * 60)
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

function weatherLabel(raw: string | null) {
  if (!raw) return null
  const words = raw.replace(/[_-]+/g, " ").trim()
  if (!words) return null
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

type Marker = { key: string; x: number; y: number; heading: number | null; kind: "vehicle" | "player" | "place" }

function placeMarker(x: number, z: number, frame: MapFrame, key: string, heading: number | null, kind: Marker["kind"]): Marker {
  const point = projectPoint(x, z, frame)
  return { key, x: point.x, y: point.y, heading, kind }
}

export function LiveMapPage() {
  const { t } = useTranslation()
  const stamp = useTimeLabel()
  const { liveMode, moduleAccess, selectedFarm } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "map") : null
  const farm = workspace ? selectedFarm(workspace.id) : null
  const [payload, setPayload] = useState<LiveMapResponse | null>(null)
  const [fields, setFields] = useState<FieldsResponse | null>(null)
  const [loading, setLoading] = useState(liveMode)
  const [contentBox, setContentBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [ownOnly, setOwnOnly] = useState(true)
  const [showVehicles, setShowVehicles] = useState(true)
  const [showPlayers, setShowPlayers] = useState(true)
  const [showPlaces, setShowPlaces] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

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

  const farmId = farm?.gameFarmId ?? null
  const vehicles = (payload?.vehicles ?? []).filter((vehicle) => !ownOnly || farmId == null || vehicle.farmId === farmId)
  const players = payload?.players ?? []
  const places = (payload?.places ?? []).filter((place) => !ownOnly || farmId == null || place.farmId == null || place.farmId === farmId)

  const month = payload?.period != null && payload.period >= 1 && payload.period <= 12 ? PERIOD_TO_MONTH[payload.period - 1] : null
  const clock = clockLabel(payload?.dayTime ?? null)
  const weather = weatherLabel(payload?.weather ?? null)

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !access) return <PermissionBlock />

  return (
    <div className="page live-page">
      <header className="page-head">
        <div>
          <h1>{t("modules.map")}</h1>
          <p className="muted">{t("modules.mapLead")}</p>
        </div>
        <p className="muted">{payload?.writtenAt ? t("live.updated", { time: stamp(payload.writtenAt, "") }) : null}</p>
      </header>
      {loading && !payload ? <p className="muted">{t("live.loading")}</p> : null}
      {payload?.error === "failed" && (payload.vehicles.length ?? 0) === 0 ? (
        <EmptyState title={t("live.failedTitle")} body={t("live.failedBody")} />
      ) : null}
      {payload && !payload.ok && payload.error === "missing" ? (
        <EmptyState title={t("live.missingTitle")} body={t("live.missingBody")} />
      ) : null}
      {payload?.source === "vehicles" ? <p className="muted live-note">{t("live.fromVehicles")}</p> : null}
      <div className="live-meta">
        {clock ? (
          <span>
            {t("live.clock")} {clock}
            {payload?.day != null ? ` · ${t("live.day", { day: payload.day })}` : ""}
            {month != null ? ` · ${t(`fields.month.${month}`)}` : ""}
            {payload?.paused ? ` · ${t("live.paused")}` : ""}
          </span>
        ) : null}
        {weather ? (
          <span>
            {t("live.weather")} {weather}
            {payload?.temperature != null ? ` · ${payload.temperature.toFixed(1)} °C` : ""}
            {payload?.windSpeed != null ? ` · ${t("live.wind", { speed: payload.windSpeed.toFixed(1) })}` : ""}
          </span>
        ) : null}
      </div>
      <div className="live-layout">
        <LiveCanvas
          mapUrl={fields?.pdaMap && liveMode ? `/api/workspaces/${workspace.id}/pda-map` : null}
          frame={frame}
          vehicles={showVehicles ? vehicles : []}
          players={showPlayers ? players : []}
          places={showPlaces ? places : []}
          selected={selected}
          onSelect={setSelected}
          onContentBox={setContentBox}
        />
        <aside className="live-side">
          <div className="live-toggles">
            <button type="button" className={showVehicles ? "chip-check on" : "chip-check"} onClick={() => setShowVehicles((value) => !value)}>
              {t("live.showVehicles")}
            </button>
            <button type="button" className={showPlayers ? "chip-check on" : "chip-check"} onClick={() => setShowPlayers((value) => !value)}>
              {t("live.showPlayers")}
            </button>
            <button type="button" className={showPlaces ? "chip-check on" : "chip-check"} onClick={() => setShowPlaces((value) => !value)}>
              {t("live.showPlaces")}
            </button>
            <button type="button" className={ownOnly ? "chip-check on" : "chip-check"} onClick={() => setOwnOnly((value) => !value)}>
              {ownOnly ? t("live.ownFarm") : t("live.allFarms")}
            </button>
          </div>
          <section>
            <h2>{t("live.vehicles")}</h2>
            {vehicles.length === 0 ? <p className="muted">{t("live.emptyVehicles")}</p> : null}
            <ul className="live-list">
              {vehicles.map((vehicle) => (
                <li key={vehicle.id || vehicle.name} className={selected === `v:${vehicle.id}` ? "is-on" : ""}>
                  <button type="button" onClick={() => setSelected(`v:${vehicle.id}`)}>
                    <strong>{vehicle.name || vehicle.id}</strong>
                    {vehicle.ai ? <span>{t("live.ai")}</span> : null}
                    {vehicle.driver ? <span>{vehicle.driver}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>{t("live.players")}</h2>
            {players.length === 0 ? <p className="muted">{t("live.emptyPlayers")}</p> : null}
            <ul className="live-list">
              {players.map((player) => (
                <li key={player.id}>
                  <button type="button" onClick={() => setSelected(`p:${player.id}`)}>
                    <strong>{player.name || player.id}</strong>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>{t("live.places")}</h2>
            {places.length === 0 ? <p className="muted">{t("live.emptyPlaces")}</p> : null}
            <ul className="live-list">
              {places.map((place) => (
                <li key={`${place.id}:${place.x}`}>
                  <button type="button" onClick={() => setSelected(`o:${place.id}`)}>
                    <strong>{place.name || place.type || place.id}</strong>
                    {place.type ? <span>{place.type}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}

function LiveCanvas({
  mapUrl,
  frame,
  vehicles,
  players,
  places,
  selected,
  onSelect,
  onContentBox,
}: {
  mapUrl: string | null
  frame: MapFrame
  vehicles: LiveVehicle[]
  players: LivePlayer[]
  places: LivePlace[]
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

  function apply() {
    const el = stageRef.current
    if (!el) return
    const { x, y, k } = cam.current
    el.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    setZoom((prev) => (prev === k ? prev : k))
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
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const next = cam.current.k * (event.deltaY > 0 ? 0.9 : 1.12)
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
    for (const vehicle of vehicles) next.push(placeMarker(vehicle.x, vehicle.z, frame, `v:${vehicle.id}`, vehicle.heading, "vehicle"))
    for (const player of players) next.push(placeMarker(player.x, player.z, frame, `p:${player.id}`, player.heading, "player"))
    for (const place of places) next.push(placeMarker(place.x, place.z, frame, `o:${place.id}`, null, "place"))
    return next
  }, [frame, places, players, vehicles])

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
    if (!marker || !viewport || !stage) return
    focused.current = selected
    const k = Math.max(cam.current.k, 2.2)
    const px = (marker.x / 100) * viewport.clientWidth
    const py = (marker.y / 100) * viewport.clientHeight
    cam.current = {
      k,
      x: viewport.clientWidth / 2 - px * k,
      y: viewport.clientHeight / 2 - py * k,
    }
    stage.style.transform = `translate(${cam.current.x}px, ${cam.current.y}px) scale(${k})`
    setZoom(k)
  }, [markers, selected])

  return (
    <div className="live-map-frame fields-map-frame">
      <div className="live-zoom">
        <button
          type="button"
          aria-label="+"
          onClick={() => {
            const viewport = viewportRef.current
            if (!viewport) return
            zoomAt(cam.current.k * 1.25, viewport.clientWidth / 2, viewport.clientHeight / 2)
          }}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          aria-label="-"
          onClick={() => {
            const viewport = viewportRef.current
            if (!viewport) return
            zoomAt(cam.current.k / 1.25, viewport.clientWidth / 2, viewport.clientHeight / 2)
          }}
        >
          <Minus size={16} />
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
                const pixels = context.getImageData(0, 0, width, height).data
                onContentBox(measureMapContent(pixels, width, height))
              }}
            />
          ) : (
            <div className="fields-terrain" />
          )}
          <svg viewBox="0 0 100 100">
            {markers.map((marker) => {
              const on = marker.key === selected
              const rotation = marker.heading == null ? 0 : (-marker.heading * 180) / Math.PI
              return (
                <g
                  key={marker.key}
                  data-marker={marker.key}
                  className={on ? `live-marker is-${marker.kind} is-on` : `live-marker is-${marker.kind}`}
                  transform={`translate(${marker.x} ${marker.y}) rotate(${rotation})`}
                >
                  {marker.kind === "vehicle" && marker.heading != null ? (
                    <polygon points="0,1.7 -0.85,-1.05 0.85,-1.05" />
                  ) : marker.kind === "place" ? (
                    <polygon points="0,-1.15 1.15,0 0,1.15 -1.15,0" />
                  ) : (
                    <circle r="0.9" />
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}
