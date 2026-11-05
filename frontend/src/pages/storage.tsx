import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import { LocateFixed, Warehouse } from "lucide-react"
import { apiWorkspaceFields, apiWorkspaceStorage, type StorageFill, type StoragePlace, type StorageResponse } from "../api"
import { cropIconExact } from "../crop-icons"
import { effectiveMapSize, projectPoint, terrainFrame, type MapFrame } from "../field-format"
import { EmptyState, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { useStore } from "../store"
import type { FieldsResponse } from "../types"
import { useWorkspaceRoute } from "../use-workspace"

const PEEK_ZOOM = 18
const COLORS = ["#c6e88a", "#7ec8f0", "#e4b84a", "#e39ad8", "#f0a07a", "#8fd0c4", "#f2d27a", "#9bb7e8", "#f0c2b0", "#b7d48a"]

const DEMO: StorageResponse = {
  ok: true,
  error: null,
  writtenAt: null,
  places: [
    {
      id: "silo:1",
      kind: "silo",
      farmId: 1,
      name: "Hoflager",
      foreign: false,
      level: 186000,
      capacity: 800000,
      used: null,
      slots: null,
      x: 180,
      z: -40,
      fills: [
        { fillType: "WHEAT", title: "Weizen", level: 124000, capacity: 800000, count: null },
        { fillType: "CANOLA", title: "Raps", level: 62000, capacity: 800000, count: null },
      ],
    },
    {
      id: "bale:1",
      kind: "baleStorage",
      farmId: 1,
      name: "Ballenlager",
      foreign: false,
      level: 48000,
      capacity: null,
      used: 12,
      slots: 40,
      x: 210,
      z: 30,
      fills: [{ fillType: "STRAW", title: "Stroh", level: 48000, capacity: null, count: 12, form: "round", size: "125x120" }],
    },
  ],
}

type PlaceFilter = "filled" | "silo" | "bale" | "all"

type GoodPlace = { id: string; name: string; amount: string }
type GoodRow = {
  key: string
  title: string
  fillType: string | null
  level: number
  count: number
  color: string
  places: GoodPlace[]
}

function kindLabel(t: TFunction, kind: string | null) {
  if (kind === "silo") return t("stock.silo")
  if (kind === "siloExtension") return t("stock.siloExtension")
  if (kind === "baleStorage") return t("stock.baleStorage")
  return t("stock.places")
}

function liters(value: number, language: string) {
  return `${Math.round(value).toLocaleString(language)} L`
}

function bulk(value: number, language: string) {
  if (value < 1000) return liters(value, language)
  const tons = value / 1000
  const text = tons.toLocaleString(language, {
    maximumFractionDigits: tons >= 100 ? 0 : 1,
  })
  return `${text} t`
}

function barPercent(level: number | null, capacity: number | null) {
  if (level == null || capacity == null || capacity <= 0) return null
  return Math.max(0, Math.min(100, (level / capacity) * 100))
}

function colorFor(key: string) {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) hash = (hash * 33 + key.charCodeAt(index)) >>> 0
  return COLORS[hash % COLORS.length]
}

function occupied(place: StoragePlace) {
  if (place.fills.length > 0) return true
  if ((place.level ?? 0) > 0) return true
  return place.kind === "baleStorage" && (place.used ?? 0) > 0
}

function formText(t: TFunction, fill: StorageFill) {
  const kind = fill.form === "round" ? t("stock.round") : fill.form === "square" ? t("stock.square") : null
  return [kind, fill.size || null].filter(Boolean).join(" · ")
}

function FillMark({ fillType, title }: { fillType: string | null; title: string }) {
  const icon = cropIconExact(fillType ?? title)
  if (icon) return <img src={icon} alt="" />
  return <span className="stock-mark">{(title || "?").slice(0, 1).toUpperCase()}</span>
}

export function StoragePage() {
  const { t, i18n } = useTranslation()
  const stamp = useTimeLabel()
  const { liveMode, moduleAccess, selectedFarm } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "storage") : null
  const farm = workspace ? selectedFarm(workspace.id) : null
  const [payload, setPayload] = useState<StorageResponse | null>(liveMode ? null : DEMO)
  const [fields, setFields] = useState<FieldsResponse | null>(null)
  const [loading, setLoading] = useState(liveMode)
  const [filter, setFilter] = useState<PlaceFilter>("filled")

  useEffect(() => {
    if (!workspace || !allowed || !access || !liveMode) return
    let cancelled = false
    const load = async (first: boolean) => {
      if (!first && document.hidden) return
      if (first) setLoading(true)
      try {
        const next = await apiWorkspaceStorage(workspace.id)
        if (!cancelled) setPayload(next)
      } catch {
        if (!cancelled && first) {
          setPayload({ ok: false, error: "failed", writtenAt: null, places: [] })
        }
      } finally {
        if (!cancelled && first) setLoading(false)
      }
    }
    void load(true)
    if (liveMode && workspace) {
      void apiWorkspaceFields(workspace.id)
        .then((next) => {
          if (!cancelled) setFields(next)
        })
        .catch(() => {
          if (!cancelled) setFields(null)
        })
    }
    const timer = window.setInterval(() => void load(false), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [access, allowed, liveMode, workspace])

  const places = useMemo(() => {
    const rows = payload?.places ?? []
    if (!farm) return rows
    return rows.filter((place) => place.farmId != null && Number(place.farmId) === Number(farm.gameFarmId))
  }, [farm, payload])

  const own = places.filter((place) => !place.foreign)
  const intake = places.filter((place) => place.foreign && place.fills.length > 0)
  const language = i18n.language

  const bulkRows = useMemo(() => {
    const map = new Map<string, GoodRow>()
    for (const place of own) {
      if (place.kind === "baleStorage") continue
      for (const fill of place.fills) {
        const key = (fill.fillType || fill.title || "").toLowerCase()
        if (!key || (fill.level ?? 0) <= 0) continue
        const row = map.get(key) ?? {
          key,
          title: fill.title || fill.fillType || key,
          fillType: fill.fillType,
          level: 0,
          count: 0,
          color: colorFor(key),
          places: [],
        }
        row.level += fill.level ?? 0
        row.places.push({
          id: `${place.id}-${key}`,
          name: place.name || kindLabel(t, place.kind),
          amount: bulk(fill.level ?? 0, language),
        })
        map.set(key, row)
      }
    }
    return [...map.values()].sort((a, b) => b.level - a.level || a.title.localeCompare(b.title, language))
  }, [language, own, t])

  const baleRows = useMemo(() => {
    const map = new Map<string, GoodRow>()
    for (const place of own) {
      if (place.kind !== "baleStorage") continue
      for (const fill of place.fills) {
        const count = Math.round(fill.count ?? 0)
        if (count <= 0 && (fill.level ?? 0) <= 0) continue
        const shape = formText(t, fill)
        const crop = fill.title || fill.fillType || t("stock.bales")
        const key = `${(fill.fillType || crop).toLowerCase()}|${fill.form ?? ""}|${fill.size ?? ""}`
        const row = map.get(key) ?? {
          key,
          title: shape ? `${crop} · ${shape}` : crop,
          fillType: fill.fillType,
          level: 0,
          count: 0,
          color: colorFor(key),
          places: [],
        }
        row.level += fill.level ?? 0
        row.count += count
        const amount = count > 0 ? (count === 1 ? t("stock.bales_one") : t("stock.bales_other", { count })) : bulk(fill.level ?? 0, language)
        row.places.push({ id: `${place.id}-${key}`, name: place.name || kindLabel(t, place.kind), amount })
        map.set(key, row)
      }
    }
    const unknown = own.filter((place) => place.kind === "baleStorage" && place.fills.length === 0 && (place.used ?? 0) > 0)
    if (unknown.length > 0) {
      const count = unknown.reduce((sum, place) => sum + Math.round(place.used ?? 0), 0)
      map.set("unknown", {
        key: "unknown",
        title: t("stock.unknownBales"),
        fillType: null,
        level: 0,
        count,
        color: "#8b938c",
        places: unknown.map((place) => ({
          id: place.id,
          name: place.name || kindLabel(t, place.kind),
          amount:
            place.slots != null
              ? t("stock.slots", {
                  used: Math.round(place.used ?? 0).toLocaleString(language),
                  cap: Math.round(place.slots).toLocaleString(language),
                })
              : t("stock.bales_other", { count: Math.round(place.used ?? 0) }),
        })),
      })
    }
    return [...map.values()].sort((a, b) => b.count - a.count || b.level - a.level || a.title.localeCompare(b.title, language))
  }, [language, own, t])

  const visiblePlaces = own.filter((place) => {
    if (filter === "silo") return place.kind !== "baleStorage"
    if (filter === "bale") return place.kind === "baleStorage"
    if (filter === "filled") return occupied(place)
    return true
  })
  const emptyCount = own.filter((place) => !occupied(place)).length

  const freeLiters = own.reduce((sum, place) => {
    if (place.kind === "baleStorage") return sum
    if (place.capacity == null || place.level == null || place.capacity < place.level) return sum
    return sum + (place.capacity - place.level)
  }, 0)
  const hasFree = own.some((place) => place.kind !== "baleStorage" && place.capacity != null && place.level != null)

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !access) return <PermissionBlock />

  const emptyKind =
    payload?.error === "missing"
      ? "missing"
      : payload?.error === "disabled"
        ? "disabled"
        : payload && !payload.ok
          ? "failed"
          : payload?.ok && places.length === 0
            ? "none"
            : null

  return (
    <section className="stock-page">
      <div className="fields-mast">
        <div className="fields-mast-top">
          <h1>{t("modules.storage")}</h1>
          <p className="faint">
            {payload?.writtenAt
              ? t("stock.updated", { time: stamp(payload.writtenAt, t("unavailable")) })
              : loading
                ? t("stock.loading")
                : null}
          </p>
        </div>
        {emptyKind || (loading && !payload) ? null : (
          <div className="fields-stats">
            <p>
              <strong>{own.length.toLocaleString(language)}</strong>
              <span>{t("stock.placeCount")}</span>
            </p>
            <p>
              <strong>{bulkRows.length.toLocaleString(language)}</strong>
              <span>{t("stock.goodCount")}</span>
            </p>
            <p>
              <strong>{hasFree ? bulk(freeLiters, language) : t("unavailable")}</strong>
              <span>{t("stock.freeSpace")}</span>
            </p>
            <p>
              <strong>{baleRows.reduce((sum, row) => sum + row.count, 0).toLocaleString(language)}</strong>
              <span>{t("stock.bales")}</span>
            </p>
          </div>
        )}
      </div>

      {loading && !payload ? (
        <p className="hint">{t("stock.loading")}</p>
      ) : emptyKind === "missing" ? (
        <EmptyState title={t("stock.missingTitle")} body={t("stock.missingBody")} />
      ) : emptyKind === "failed" || emptyKind === "disabled" ? (
        <EmptyState title={t("stock.failedTitle")} body={t("stock.failedBody")} />
      ) : emptyKind === "none" ? (
        <EmptyState title={t("stock.emptyTitle")} body={t("stock.emptyBody")} />
      ) : (
        <>
          <div className="stock-overview">
            <GoodsPanel title={t("stock.bulk")} empty={t("stock.noBulk")} rows={bulkRows} mode="bulk" language={language} />
            <GoodsPanel title={t("stock.bales")} empty={t("stock.noBales")} rows={baleRows} mode="bale" language={language} note={baleRows.some((row) => row.key === "unknown") ? t("stock.unknownBalesBody") : null} />
          </div>

          <section className="stock-places">
            <header>
              <h2>{t("stock.placesTitle")}</h2>
              <div className="stock-filters">
                {(["filled", "silo", "bale", "all"] as PlaceFilter[]).map((id) => (
                  <button key={id} type="button" className={filter === id ? "is-on" : ""} onClick={() => setFilter(id)}>
                    {id === "filled"
                      ? t("stock.occupied")
                      : id === "silo"
                        ? t("stock.silos")
                        : id === "bale"
                          ? t("stock.bales")
                          : emptyCount > 0
                            ? t("stock.showEmpty", { count: emptyCount })
                            : t("stock.allPlaces")}
                  </button>
                ))}
              </div>
            </header>
            <div className="stock-board">
              {visiblePlaces.map((place) => (
                <PlaceCard key={place.id} place={place} language={language} workspaceId={workspace.id} fields={fields} live={liveMode} />
              ))}
              {filter !== "bale"
                ? intake.map((place) => (
                    <PlaceCard key={place.id} place={place} language={language} workspaceId={workspace.id} fields={fields} live={liveMode} intake />
                  ))
                : null}
            </div>
          </section>
        </>
      )}
    </section>
  )
}

function GoodsPanel({
  title,
  empty,
  rows,
  mode,
  language,
  note,
}: {
  title: string
  empty: string
  rows: GoodRow[]
  mode: "bulk" | "bale"
  language: string
  note?: string | null
}) {
  const { t } = useTranslation()
  const total = rows.reduce((sum, row) => sum + (mode === "bale" ? Math.max(row.count, 0) : row.level), 0)
  const max = Math.max(...rows.map((row) => (mode === "bale" ? Math.max(row.count, row.level) : row.level)), 1)
  const summary =
    rows.length === 0
      ? null
      : mode === "bale"
        ? t("stock.bales_other", { count: rows.reduce((sum, row) => sum + row.count, 0) })
        : bulk(total, language)
  return (
    <section className="stock-panel">
      <header>
        <h2>{title}</h2>
        {summary ? <span>{summary}</span> : null}
      </header>
      {rows.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <>
          <div className="stock-chart">
            <div
              className="stock-donut"
              style={{
                background: `conic-gradient(${rows
                  .map((row) => {
                    const value = mode === "bale" ? Math.max(row.count, 0) : row.level
                    return { color: row.color, value }
                  })
                  .filter((part) => part.value > 0 && total > 0)
                  .reduce<{ cursor: number; stops: string[] }>(
                    (state, part) => {
                      const start = state.cursor
                      const next = state.cursor + (part.value / total) * 100
                      state.stops.push(`${part.color} ${start}% ${next}%`)
                      state.cursor = next
                      return state
                    },
                    { cursor: 0, stops: [] },
                  )
                  .stops.join(", ")})`,
              }}
              aria-hidden="true"
            >
              <div>
                <strong>{summary}</strong>
              </div>
            </div>
            <ul className="stock-legend">
              {rows.map((row) => {
                const value = mode === "bale" ? Math.max(row.count, 0) : row.level
                const share = total > 0 ? Math.round((value / total) * 100) : 0
                const amount =
                  mode === "bale" && row.count > 0
                    ? row.count === 1
                      ? t("stock.bales_one")
                      : t("stock.bales_other", { count: row.count })
                    : bulk(row.level, language)
                return (
                  <li key={row.key}>
                    <i style={{ background: row.color }} />
                    <span>{row.title}</span>
                    <strong>{amount}</strong>
                    <em>{share}%</em>
                  </li>
                )
              })}
            </ul>
          </div>
          <ul className="stock-types">
            {rows.map((row) => {
              const value = mode === "bale" ? Math.max(row.count, row.level) : row.level
              const amount =
                mode === "bale" && row.count > 0
                  ? row.count === 1
                    ? t("stock.bales_one")
                    : t("stock.bales_other", { count: row.count })
                  : bulk(row.level, language)
              return (
                <li key={row.key} className="stock-type">
                  <FillMark fillType={row.fillType} title={row.title} />
                  <div>
                    <div className="stock-type-top">
                      <span>{row.title}</span>
                      <strong>{amount}</strong>
                    </div>
                    <div className="stock-bar" aria-hidden="true">
                      <span style={{ width: `${Math.max(4, (value / max) * 100)}%`, background: row.color }} />
                    </div>
                    <small>{t("stock.inStores", { count: row.places.length })}</small>
                  </div>
                  <div className="stock-tip" role="tooltip">
                    {row.places.map((place) => (
                      <p key={place.id}>
                        <span>{place.name}</span>
                        <strong>{place.amount}</strong>
                      </p>
                    ))}
                  </div>
                </li>
              )
            })}
          </ul>
          {note ? <p className="hint">{note}</p> : null}
        </>
      )}
    </section>
  )
}

function mapTarget(workspaceId: string, place: StoragePlace) {
  const params = new URLSearchParams()
  if (place.x != null && place.z != null) {
    params.set("x", String(place.x))
    params.set("z", String(place.z))
  }
  if (place.name) params.set("name", place.name)
  params.set("bin", place.id)
  return `/w/${workspaceId}/m/map?${params.toString()}`
}

function mapFrame(fields: FieldsResponse | null): MapFrame | null {
  if (!fields) return null
  const reported = fields.mapFrame
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
  return terrainFrame(effectiveMapSize(fields.mapSize, fields.fields))
}

function PlaceCard({
  place,
  language,
  workspaceId,
  fields,
  live,
  intake,
}: {
  place: StoragePlace
  language: string
  workspaceId: string
  fields: FieldsResponse | null
  live: boolean
  intake?: boolean
}) {
  const { t } = useTranslation()
  const bale = place.kind === "baleStorage"
  const percent = bale ? barPercent(place.used, place.slots) : barPercent(place.level, place.capacity)
  const frame = mapFrame(fields)
  const point = place.x != null && place.z != null && frame ? projectPoint(place.x, place.z, frame) : null
  const mapUrl = fields?.pdaMap && live ? `/api/workspaces/${workspaceId}/pda-map` : null
  return (
    <article className={intake ? "stock-card is-intake" : "stock-card"}>
      <div className="stock-card-main">
        <div className="stock-store">
          {place.iconUrl ? <img src={place.iconUrl} alt="" /> : <Warehouse className="icon" aria-hidden="true" />}
        </div>
        <div className="stock-card-copy">
          <header>
            <h2>{place.name || kindLabel(t, place.kind)}</h2>
            <span className="badge">{intake ? t("stock.intake") : kindLabel(t, place.kind)}</span>
          </header>
          {percent != null ? (
            <div className="stock-meter">
              <div className="stock-bar" aria-hidden="true">
                <span style={{ width: `${percent}%` }} />
              </div>
              <p className="faint">
                {bale
                  ? t("stock.slots", {
                      used: Math.round(place.used ?? 0).toLocaleString(language),
                      cap: Math.round(place.slots ?? 0).toLocaleString(language),
                    })
                  : t("stock.ofCapacity", {
                      used: bulk(place.level ?? 0, language),
                      cap: bulk(place.capacity ?? 0, language),
                    })}
              </p>
            </div>
          ) : null}
          {place.fills.length === 0 && !(bale && (place.used ?? 0) > 0) ? <p className="hint">{t("stock.emptyPlace")}</p> : null}
          <ul>
            {place.fills.map((fill, index) => {
              const count = fill.count != null ? Math.round(fill.count) : 0
              const label = fill.title || fill.fillType || t("stock.goods")
              const shape = formText(t, fill)
              return (
                <li key={`${place.id}-${index}`}>
                  <FillMark fillType={fill.fillType} title={label} />
                  <span>{shape ? `${label} · ${shape}` : label}</span>
                  <strong>
                    {count > 0
                      ? count === 1
                        ? t("stock.bales_one")
                        : t("stock.bales_other", { count })
                      : fill.level != null
                        ? bulk(fill.level, language)
                        : t("unavailable")}
                  </strong>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
      {place.x != null && place.z != null ? (
        <Link className="stock-peek" to={mapTarget(workspaceId, place)} aria-label={t("stock.showOnMap")}>
          {mapUrl && point ? (
            <span className="stock-peek-map" aria-hidden="true">
              <img
                src={mapUrl}
                alt=""
                style={{
                  width: `${PEEK_ZOOM * 100}%`,
                  height: `${PEEK_ZOOM * 100}%`,
                  left: `${50 - point.x * PEEK_ZOOM}%`,
                  top: `${50 - point.y * PEEK_ZOOM}%`,
                }}
              />
              <i />
            </span>
          ) : (
            <LocateFixed className="icon" />
          )}
        </Link>
      ) : null}
    </article>
  )
}
