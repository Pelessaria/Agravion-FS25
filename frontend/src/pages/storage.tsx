import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import { LocateFixed } from "lucide-react"
import { apiWorkspaceStorage, type StorageFill, type StoragePlace, type StorageResponse } from "../api"
import { cropIconExact } from "../crop-icons"
import { EmptyState, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { useStore } from "../store"
import { useWorkspaceRoute } from "../use-workspace"

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
      fills: [{ fillType: "STRAW", title: "Stroh", level: 48000, capacity: null, count: 12 }],
    },
  ],
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

function FillMark({ fill }: { fill: StorageFill }) {
  const icon = cropIconExact(fill.fillType ?? fill.title)
  const label = fill.title || fill.fillType || ""
  if (icon) return <img src={icon} alt="" />
  return <span className="stock-mark">{label.slice(0, 1).toUpperCase()}</span>
}

export function StoragePage() {
  const { t, i18n } = useTranslation()
  const stamp = useTimeLabel()
  const { liveMode, moduleAccess, selectedFarm } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "storage") : null
  const farm = workspace ? selectedFarm(workspace.id) : null
  const [payload, setPayload] = useState<StorageResponse | null>(liveMode ? null : DEMO)
  const [loading, setLoading] = useState(liveMode)

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

  const goods = (() => {
    const map = new Map<string, { key: string; title: string; fillType: string | null; level: number; count: number; places: number }>()
    for (const place of places) {
      if (place.foreign) continue
      const seen = new Set<string>()
      for (const fill of place.fills) {
        const key = (fill.fillType || fill.title || "").toLowerCase()
        if (!key) continue
        const row = map.get(key) ?? {
          key,
          title: fill.title || fill.fillType || key,
          fillType: fill.fillType,
          level: 0,
          count: 0,
          places: 0,
        }
        row.level += fill.level ?? 0
        row.count += fill.count ?? 0
        if (!seen.has(key)) {
          row.places += 1
          seen.add(key)
        }
        map.set(key, row)
      }
    }
    return [...map.values()].sort((a, b) => b.level - a.level || b.count - a.count || a.title.localeCompare(b.title, i18n.language))
  })()

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
      <div className="page-head">
        <div>
          <h1>{t("modules.storage")}</h1>
          <p>{t("stock.lead")}</p>
        </div>
        <p className="faint">
          {payload?.writtenAt
            ? t("stock.updated", { time: stamp(payload.writtenAt, t("unavailable")) })
            : loading
              ? t("stock.loading")
              : null}
        </p>
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
          <div className="stat-grid">
            <div className="stat-tile">
              <span>{t("stock.placeCount")}</span>
              <strong>{own.length.toLocaleString(i18n.language)}</strong>
            </div>
            <div className="stat-tile">
              <span>{t("stock.goodCount")}</span>
              <strong>{goods.length.toLocaleString(i18n.language)}</strong>
            </div>
            <div className="stat-tile">
              <span>{t("stock.freeSpace")}</span>
              <strong>{hasFree ? bulk(freeLiters, i18n.language) : t("unavailable")}</strong>
            </div>
          </div>

          <div className="stock-layout">
            <section className="panel stock-panel">
              <h2>{t("stock.goods")}</h2>
              {goods.length === 0 ? <p className="hint">{t("stock.emptyTitle")}</p> : null}
              <div className="stock-goods">
                {goods.map((good) => {
                  const count = Math.round(good.count)
                  return (
                    <article key={good.key} className="stock-good">
                      <FillMark fill={{ fillType: good.fillType, title: good.title, level: good.level, capacity: null, count }} />
                      <div>
                        <strong>{good.title}</strong>
                        <p className="faint">
                          {good.places === 1
                            ? t("stock.inPlace_one")
                            : t("stock.inPlace_other", { count: good.places })}
                        </p>
                      </div>
                      <div className="stock-amount">
                        <strong>{count > 0 ? (count === 1 ? t("stock.bales_one") : t("stock.bales_other", { count })) : bulk(good.level, i18n.language)}</strong>
                        {count > 0 && good.level > 0 ? <span className="faint">{liters(good.level, i18n.language)}</span> : null}
                        {count === 0 && good.level >= 1000 ? <span className="faint">{liters(good.level, i18n.language)}</span> : null}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>

            <div className="stock-columns">
              <PlaceList title={t("stock.places")} places={own} language={i18n.language} workspaceId={workspace.id} />
              {intake.length > 0 ? (
                <PlaceList title={t("stock.intake")} places={intake} language={i18n.language} workspaceId={workspace.id} />
              ) : null}
            </div>
          </div>
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

function PlaceList({
  title,
  places,
  language,
  workspaceId,
}: {
  title: string
  places: StoragePlace[]
  language: string
  workspaceId: string
}) {
  const { t } = useTranslation()
  if (places.length === 0) return null
  return (
    <section className="panel stock-panel">
      <h2>{title}</h2>
      <div className="stock-places">
        {places.map((place) => {
          const bale = place.kind === "baleStorage"
          const percent = bale ? barPercent(place.used, place.slots) : barPercent(place.level, place.capacity)
          return (
            <article key={place.id} className="stock-place">
              <header>
                <strong>{place.name || kindLabel(t, place.kind)}</strong>
                <span className="badge">{kindLabel(t, place.kind)}</span>
                <Link className="btn btn-secondary stock-map" to={mapTarget(workspaceId, place)}>
                  <LocateFixed className="icon" />
                  {t("stock.showOnMap")}
                </Link>
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
              {place.fills.length === 0 ? <p className="hint">{t("stock.emptyPlace")}</p> : null}
              <ul>
                {place.fills.map((fill, index) => {
                  const count = fill.count != null ? Math.round(fill.count) : 0
                  const label = fill.title || fill.fillType || t("stock.goods")
                  return (
                    <li key={`${place.id}-${index}`}>
                      <FillMark fill={fill} />
                      <span>{label}</span>
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
            </article>
          )
        })}
      </div>
    </section>
  )
}
