import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Home,
  LandPlot,
  Map as MapIcon,
  Minus,
  Plus,
  Search,
  Wheat,
} from "lucide-react"
import { apiWorkspaceFields } from "../api"
import { cropIcon } from "../crop-icons"
import { EmptyState, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { demoFields } from "../demo-fields"
import { farmDisplayName } from "../farm-label"
import {
  cropColor,
  cropKey,
  cropStateLabel,
  effectiveMapSize,
  formatHa,
  formatHarvest,
  formatTarget,
  frameFromContentBox,
  measureMapContent,
  namedValue,
  projectPoint,
  terrainFrame,
  tramlineTracks,
  type MapFrame,
} from "../field-format"
import {
  EMPTY_FIELD_QUERY,
  activeQueryCount,
  layersFor,
  legendStops,
  matchesFieldQuery,
  ownerColor,
  paintColor,
  phScaleStops,
  precisionRasterLayer,
  type FieldLayerId,
  type FieldQuery,
} from "../field-layers"
import { joinedContours } from "../field-outline"
import { clampCamera, readMapView, sheetFor, writeMapView, type MapCamera } from "../map-camera"
import { useStore } from "../store"
import type { FieldSnapshot, FieldsResponse } from "../types"
import { useWorkspaceRoute } from "../use-workspace"

const EMPTY_FIELDS: FieldSnapshot[] = []

type DrawnField = {
  id: number
  color: string
  polygon: string | null
  x: number
  y: number
  box: { x: number; y: number; w: number; h: number } | null
  mine: boolean
  owned: boolean | null
  group: number[] | null
  iconUrl: string | null
  mark: string
  label: string
  tracks: string[]
}

const LABEL_HEIGHT = 2.7
const FIELDS_MIN_ZOOM = 0.35

function groupCaption(field: FieldSnapshot, fields: FieldSnapshot[]) {
  const group = field.group
  if (!group || group.length < 2) {
    return { text: String(field.id), show: true, x: field.labelX ?? field.centerX, z: field.labelZ ?? field.centerZ }
  }
  const primary = Math.min(...group)
  if (field.id !== primary) {
    return { text: "", show: false, x: null, z: null }
  }
  let sx = 0
  let sz = 0
  let count = 0
  for (const id of group) {
    const member = fields.find((item) => item.id === id)
    if (member?.centerX != null && member.centerZ != null) {
      sx += member.centerX
      sz += member.centerZ
      count += 1
    }
  }
  return {
    text: group.join(" · "),
    show: true,
    x: count > 0 ? sx / count : field.centerX,
    z: count > 0 ? sz / count : field.centerZ,
  }
}

function projectFields(
  fields: FieldSnapshot[],
  frame: MapFrame,
  farmId: number | null,
  layer: FieldLayerId,
): DrawnField[] {
  return fields.map((field) => {
    const caption = groupCaption(field, fields)
    const center =
      field.centerX != null && field.centerZ != null
        ? projectPoint(field.centerX, field.centerZ, frame)
        : null
    const labelPoint =
      caption.x != null && caption.z != null
        ? projectPoint(caption.x, caption.z, frame)
        : field.labelX != null && field.labelZ != null
          ? projectPoint(field.labelX, field.labelZ, frame)
          : center
    const projected = field.points.map(([x, z]) => projectPoint(x, z, frame))
    const label = labelPoint ?? (projected.length > 0 ? projected[0] : null)
    const key = cropKey(field.fruitName)
    let boxPoints = projected
    if (caption.show && field.group && field.group.length > 1) {
      boxPoints = []
      for (const id of field.group) {
        const member = fields.find((item) => item.id === id)
        if (member) {
          for (const point of member.points) boxPoints.push(projectPoint(point[0], point[1], frame))
        }
      }
    }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const point of boxPoints) {
      minX = Math.min(minX, point.x)
      maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y)
      maxY = Math.max(maxY, point.y)
    }
    return {
      id: field.id,
      color: layer === "off" ? cropColor(field) : paintColor(field, layer),
      polygon: projected.length >= 3 ? projected.map((point) => `${point.x},${point.y}`).join(" ") : null,
      x: label?.x ?? 50,
      y: label?.y ?? 50,
      box: projected.length > 0 ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null,
      mine: farmId == null || field.farmId === farmId,
      owned: field.owned,
      group: field.group && field.group.length > 1 ? field.group : null,
      iconUrl: field.iconUrl,
      tracks: field.tramline ? tramlineTracks(field.points, field.tramline, frame) : [],
      mark: key,
      label: caption.show ? caption.text : "",
    }
  })
}

export function FieldsPage() {
  const { t, i18n } = useTranslation()
  const { liveMode, moduleAccess, selectedFarm, farmByGameId, sessionUserId } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "fields") : null
  const farm = workspace ? selectedFarm(workspace.id) : null
  const demo = useMemo(() => demoFields(), [])
  const [payload, setPayload] = useState<FieldsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const stamp = useTimeLabel()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [onlyMine, setOnlyMine] = useState(false)
  const [showUnowned, setShowUnowned] = useState(false)
  const [query, setQuery] = useState("")
  const [focusToken, setFocusToken] = useState(0)
  const [contentBox, setContentBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [layer, setLayer] = useState<FieldLayerId>("fruit")
  const [showTramlines, setShowTramlines] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [fieldQuery, setFieldQuery] = useState<FieldQuery>(EMPTY_FIELD_QUERY)

  useEffect(() => {
    if (!workspace || !allowed || !access || !liveMode) return

    let cancelled = false
    const load = async (first: boolean) => {
      if (!first && document.hidden) return
      if (first) setLoading(true)
      try {
        const next = await apiWorkspaceFields(workspace.id)
        if (!cancelled) setPayload(next)
      } catch {
        if (!cancelled && first) {
          setPayload({
            ok: false,
            error: "failed",
            mapSize: null,
            precisionFarming: null,
            geometryAt: null,
            stateAt: null,
            fields: [],
          })
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

  const source = liveMode ? payload : demo
  const fields = source?.fields ?? EMPTY_FIELDS
  const mapSize = effectiveMapSize(source?.mapSize ?? null, fields)
  const reported = source?.mapFrame ?? null
  const frame = useMemo(() => {
    // The connector reads the PDA placement from the running map. That frame
    // covers the playable terrain. A brightness box also includes the painted
    // border around the terrain, so it is only the fallback.
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
  const precisionFarming = source?.precisionFarming ?? null
  const availableLayers = layersFor(precisionFarming)
  const activeLayer = availableLayers.includes(layer) ? layer : "off"
  const drawn = useMemo(
    () => projectFields(fields, frame, farm?.gameFarmId ?? null, activeLayer),
    [activeLayer, farm?.gameFarmId, fields, frame],
  )
  const visible = useMemo(
    () =>
      drawn.filter((field) => {
        if (onlyMine && farm && !field.mine) return false
        if (!showUnowned && field.owned === false) return false
        const sourceField = fields.find((item) => item.id === field.id)
        if (sourceField && !matchesFieldQuery(sourceField, fieldQuery, precisionFarming)) return false
        return true
      }),
    [drawn, farm, fieldQuery, fields, onlyMine, precisionFarming, showUnowned],
  )
  const outlines = useMemo(() => {
    const shown = new Set(visible.map((field) => field.id))
    const groups = new Map<string, { ids: number[]; polygons: [number, number][][] }>()
    for (const field of fields) {
      if (!shown.has(field.id) || !field.group || field.group.length < 2 || field.points.length < 3) continue
      const key = field.group.join(",")
      const row = groups.get(key) ?? { ids: [], polygons: [] }
      row.ids.push(field.id)
      row.polygons.push(field.points)
      groups.set(key, row)
    }
    const result: { key: string; ids: number[]; polygon: string }[] = []
    for (const [key, row] of groups) {
      if (row.polygons.length < 2) continue
      joinedContours(row.polygons).forEach((ring, index) => {
        result.push({
          key: `${key}-${index}`,
          ids: row.ids,
          polygon: ring
            .map(([x, z]) => {
              const point = projectPoint(x, z, frame)
              return `${point.x},${point.y}`
            })
            .join(" "),
        })
      })
    }
    return result
  }, [fields, frame, visible])
  const selected = fields.find((field) => field.id === selectedId) ?? null
  const ownedAll = fields.filter((field) => field.owned === true).length
  const owned = farm
    ? fields.filter((field) => field.farmId === farm.gameFarmId).length
    : ownedAll
  const harvestFields = fields.filter((field) => field.crop === "harvestReady")
  const harvest = harvestFields.length
  const harvestGrass = harvestFields.filter(
    (field) => field.fruitName != null && GRASS_FRUIT.has(field.fruitName.toUpperCase()),
  ).length
  const knownArea = fields.reduce((sum, field) => sum + (field.areaHa ?? 0), 0)
  const missingArea = fields.some((field) => field.areaHa == null)

  function choose(nextId: number, focus: boolean) {
    setSelectedId(nextId)
    if (focus) setFocusToken((value) => value + 1)
  }

  function jumpToNumber() {
    const nextId = Number(query)
    const match = fields.find((field) => field.id === nextId)
    if (!match) return
    if (onlyMine && farm && match.farmId !== farm.gameFarmId) setOnlyMine(false)
    if (!showUnowned && match.owned === false) setShowUnowned(true)
    setFieldQuery(EMPTY_FIELD_QUERY)
    choose(nextId, true)
  }

  const fruitOptions = [...new Map(
    fields
      .filter((field) => field.fruitName)
      .map((field) => [field.fruitName as string, field.fruitTitle || field.fruitName || ""]),
  ).entries()].sort((a, b) => a[1].localeCompare(b[1], i18n.language))
  const filterCount = activeQueryCount(fieldQuery, precisionFarming)
  const filterBadge = filterCount + (showTramlines ? 1 : 0) + (onlyMine ? 1 : 0) + (showUnowned ? 1 : 0)
  const ownerLegend = [...new Set(
    fields.map((field) => field.farmId).filter((id): id is number => id != null && id > 0),
  )]
    .sort((a, b) => a - b)
    .map((id) => {
      const known = workspace ? farmByGameId(workspace.id, id) : null
      return {
        color: ownerColor(id, true),
        label: known ? farmDisplayName(known, t) : t("farm.stubName", { id }),
      }
    })
  if (fields.some((field) => field.owned === false || field.farmId == null || field.farmId <= 0)) {
    ownerLegend.push({ color: ownerColor(null, false), label: t("fields.ownedNo") })
  }
  const legend = [
    ...(activeLayer === "owner" ? ownerLegend : legendStops(activeLayer, t)),
    ...(showTramlines ? [{ color: "#f7f1e4", label: t("fields.layerName.tramline") }] : []),
  ]
  const cropFilters = ["harvestReady", "growing", "planted", "cut", "withered", "noCrop"]

  function patchQuery(patch: Partial<FieldQuery>) {
    setFieldQuery((current) => ({ ...current, ...patch }))
  }

  function stepLayer(direction: -1 | 1) {
    const index = availableLayers.indexOf(activeLayer)
    const next = (index + direction + availableLayers.length) % availableLayers.length
    setLayer(availableLayers[next] ?? "off")
  }

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !access) return <PermissionBlock />

  const emptyKind =
    source?.error === "missing"
      ? "missing"
      : source?.error === "disabled"
        ? "disabled"
        : source && !source.ok
          ? "failed"
          : source?.ok && fields.length === 0
            ? "none"
            : null

  return (
    <section className="fields-page">
      <div className="fields-mast">
        <h1>{t("modules.fields")}</h1>
        <div className="fields-stats">
        <p>
          <MapIcon className="fields-stat-icon" aria-hidden="true" />
          <strong>{fields.length.toLocaleString(i18n.language)}</strong>
          <span>{t("fields.count")}</span>
        </p>
        <p>
          <Home className="fields-stat-icon" aria-hidden="true" />
          <strong>{owned.toLocaleString(i18n.language)}</strong>
          <span>{t("fields.owned")}</span>
        </p>
        <p>
          <Building2 className="fields-stat-icon" aria-hidden="true" />
          <strong>{ownedAll.toLocaleString(i18n.language)}</strong>
          <span>{t("fields.allFarms")}</span>
        </p>
        <p className={harvestGrass > 0 ? "has-note" : undefined}>
          <Wheat className="fields-stat-icon" aria-hidden="true" />
          <strong>{harvest.toLocaleString(i18n.language)}</strong>
          <span>
            {t("fields.harvest")}
            {harvestGrass > 0 ? <em>{t("fields.harvestGrass", { count: harvestGrass })}</em> : null}
          </span>
        </p>
        <p>
          <LandPlot className="fields-stat-icon" aria-hidden="true" />
          <strong>
            {fields.length === 0 ? t("unavailable") : formatHa(knownArea, i18n.language)}
            {missingArea && fields.length > 0 ? " +" : ""}
          </strong>
          <span>{t("fields.area")}</span>
        </p>
        <p>
          <Clock3 className="fields-stat-icon" aria-hidden="true" />
          <strong>
            {source?.stateAt ? stamp(source.stateAt, t("unavailable")) : loading ? "…" : t("unavailable")}
          </strong>
          <span>{t("fields.asOf")}</span>
        </p>
        </div>
      </div>

      {emptyKind ? (
        <EmptyState title={t(`fields.${emptyKind}Title`)} body={t(`fields.${emptyKind}Body`)} />
      ) : (
        <div className="fields-layout">
          <div className="fields-map-card">
            <div className="fields-toolbar">
              <div className="layer-switch" role="group" aria-label={t("fields.layer")}>
                <button
                  type="button"
                  aria-label={t("fields.layerPrev")}
                  onClick={() => stepLayer(-1)}
                >
                  <ChevronLeft className="icon" />
                </button>
                <LayerMenu
                  label={t(`fields.layerName.${activeLayer}`)}
                  value={activeLayer}
                  options={availableLayers.map((id) => ({ id, label: t(`fields.layerName.${id}`) }))}
                  onChange={setLayer}
                />
                <button
                  type="button"
                  aria-label={t("fields.layerNext")}
                  onClick={() => stepLayer(1)}
                >
                  <ChevronRight className="icon" />
                </button>
              </div>
              <button
                type="button"
                className={filtersOpen ? "chip-check on fields-filter-toggle" : "chip-check fields-filter-toggle"}
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((value) => !value)}
              >
                {t("fields.filters")}
                {filterBadge > 0 ? <em>{filterBadge}</em> : null}
                <ChevronDown className="icon" />
              </button>
              <form
                className="fields-jump"
                onSubmit={(event) => {
                  event.preventDefault()
                  jumpToNumber()
                }}
              >
                <label>
                  <span>{t("fields.fieldShort")}</span>
                  <input
                    inputMode="numeric"
                    maxLength={3}
                    placeholder=" "
                    value={query}
                    aria-label={t("fields.fieldNumber")}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <button type="submit" aria-label={t("fields.pick")}>
                  <Search className="icon" />
                </button>
              </form>
            </div>
            {filtersOpen ? (
            <div className="fields-filters">
              <div className="fields-seg-row">
                {precisionFarming === true ? (
                  <div className="fields-seg">
                    <button
                      type="button"
                      className={showTramlines ? "is-on" : ""}
                      aria-pressed={showTramlines}
                      onClick={() => setShowTramlines((value) => !value)}
                    >
                      {t("fields.layerName.tramline")}
                    </button>
                  </div>
                ) : null}
                <div className="fields-seg">
                  <button
                    type="button"
                    className={onlyMine ? "is-on" : ""}
                    aria-pressed={onlyMine}
                    disabled={!farm}
                    onClick={() => setOnlyMine((value) => !value)}
                  >
                    {t("fields.thisFarm")}
                  </button>
                  <button
                    type="button"
                    className={showUnowned ? "is-on" : ""}
                    aria-pressed={showUnowned}
                    onClick={() => setShowUnowned((value) => !value)}
                  >
                    {t("fields.showUnowned")}
                  </button>
                </div>
                <div className="fields-seg">
                  <button
                    type="button"
                    className={fieldQuery.crop === "harvestReady" ? "is-on" : ""}
                    aria-pressed={fieldQuery.crop === "harvestReady"}
                    onClick={() => patchQuery({ crop: fieldQuery.crop === "harvestReady" ? "" : "harvestReady" })}
                  >
                    {t("fields.crop.harvestReady")}
                  </button>
                  <button
                    type="button"
                    className={fieldQuery.joined ? "is-on" : ""}
                    aria-pressed={fieldQuery.joined}
                    onClick={() => patchQuery({ joined: !fieldQuery.joined })}
                  >
                    {t("fields.filterJoined")}
                  </button>
                  <button
                    type="button"
                    className={fieldQuery.weeds ? "is-on" : ""}
                    aria-pressed={fieldQuery.weeds}
                    onClick={() => patchQuery({ weeds: !fieldQuery.weeds })}
                  >
                    {t("fields.filterWeeds")}
                  </button>
                  <button
                    type="button"
                    className={fieldQuery.stones ? "is-on" : ""}
                    aria-pressed={fieldQuery.stones}
                    onClick={() => patchQuery({ stones: !fieldQuery.stones })}
                  >
                    {t("fields.filterStones")}
                  </button>
                </div>
                <div className="fields-seg">
                  {precisionFarming === true ? (
                    <>
                      <button
                        type="button"
                        className={fieldQuery.nitrogen === "low" ? "is-on" : ""}
                        aria-pressed={fieldQuery.nitrogen === "low"}
                        onClick={() => patchQuery({ nitrogen: fieldQuery.nitrogen === "low" ? "" : "low" })}
                      >
                        {t("fields.filterNitrogenLow")}
                      </button>
                      <button
                        type="button"
                        className={fieldQuery.ph === "off" ? "is-on" : ""}
                        aria-pressed={fieldQuery.ph === "off"}
                        onClick={() => patchQuery({ ph: fieldQuery.ph === "off" ? "" : "off" })}
                      >
                        {t("fields.filterPhOff")}
                      </button>
                      <button
                        type="button"
                        className={fieldQuery.scan === "no" ? "is-on" : ""}
                        aria-pressed={fieldQuery.scan === "no"}
                        onClick={() => patchQuery({ scan: fieldQuery.scan === "no" ? "" : "no" })}
                      >
                        {t("fields.filterUnscanned")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={fieldQuery.spray === "open" ? "is-on" : ""}
                        aria-pressed={fieldQuery.spray === "open"}
                        onClick={() => patchQuery({ spray: fieldQuery.spray === "open" ? "" : "open" })}
                      >
                        {t("fields.filterSprayOpen")}
                      </button>
                      <button
                        type="button"
                        className={fieldQuery.lime === "open" ? "is-on" : ""}
                        aria-pressed={fieldQuery.lime === "open"}
                        onClick={() => patchQuery({ lime: fieldQuery.lime === "open" ? "" : "open" })}
                      >
                        {t("fields.filterLimeOpen")}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="fields-seg-row">
              <FilterMenu
                label={t("fields.filterFruit")}
                value={fieldQuery.fruit}
                options={[
                  { id: "", label: t("fields.filterFruit") },
                  ...fruitOptions.map(([name, title]) => ({ id: name, label: title })),
                ]}
                onChange={(fruit) => patchQuery({ fruit })}
              />
              <FilterMenu
                label={t("fields.filterCrop")}
                value={fieldQuery.crop}
                options={[
                  { id: "", label: t("fields.filterCrop") },
                  ...cropFilters.map((crop) => ({ id: crop, label: t(`fields.crop.${crop}`) })),
                ]}
                onChange={(crop) => patchQuery({ crop })}
              />
              {precisionFarming === true ? (
                <FilterMenu
                  label={t("fields.filterSoil")}
                  value={fieldQuery.soil}
                  options={[
                    { id: "", label: t("fields.filterSoil") },
                    ...[1, 2, 3, 4].map((soil) => ({ id: String(soil), label: t(`fields.soilType.${soil}`) })),
                  ]}
                  onChange={(soil) => patchQuery({ soil })}
                />
              ) : null}
              <span className="fields-filter-count">
                {t("fields.shown", {
                  shown: visible.length.toLocaleString(i18n.language),
                  total: drawn.length.toLocaleString(i18n.language),
                })}
              </span>
              {filterCount > 0 ? (
                <button type="button" className="fields-filter-reset" onClick={() => setFieldQuery(EMPTY_FIELD_QUERY)}>
                  {t("fields.filterReset")}
                </button>
              ) : null}
              </div>
            </div>
            ) : null}
            {activeLayer === "ph" ? <PhScale language={i18n.language} /> : null}
            {legend.length > 0 ? (
              <div className="layer-legend" aria-label={t("fields.legend")}>
                {legend.map((stop) => (
                  <span key={stop.label}>
                    <i style={{ background: stop.color }} />
                    {stop.label}
                  </span>
                ))}
              </div>
            ) : null}
            <FieldMap
              fields={visible}
              outlines={outlines}
              painted={activeLayer !== "off"}
              frame={frame}
              viewUserId={sessionUserId}
              viewScope={`${workspace.id}.fields`}
              raster={
                liveMode && precisionRasterLayer(activeLayer)
                  ? {
                      href: `/api/workspaces/${workspace.id}/precision-layer/${activeLayer}`,
                      x: frame.padX * 100,
                      y: frame.padZ * 100,
                      w: frame.scaleX * 100,
                      h: frame.scaleZ * 100,
                    }
                  : null
              }
              showTracks={showTramlines}
              tracks={
                liveMode && showTramlines
                  ? {
                      href: `/api/workspaces/${workspace.id}/precision-layer/tramline`,
                      x: frame.padX * 100,
                      y: frame.padZ * 100,
                      w: frame.scaleX * 100,
                      h: frame.scaleZ * 100,
                    }
                  : null
              }
              mapUrl={
                source?.pdaMap
                  ? `/api/workspaces/${workspace.id}/pda-map`
                  : liveMode && workspace.mapPreviewPath
                    ? `${workspace.mapPreviewPath}?size=1024&quality=70`
                    : null
              }
              live={liveMode}
              selectedId={selectedId}
              focusToken={focusToken}
              label={workspace.mapName ?? t("fields.mapLabel")}
              onSelect={(nextId) => choose(nextId, false)}
              onContentBox={setContentBox}
            >
              <FieldDetail
            field={selected}
            precisionFarming={source?.precisionFarming ?? null}
            farmName={
              selected?.farmId == null
                ? null
                : farmByGameId(workspace.id, selected.farmId)
                  ? farmDisplayName(farmByGameId(workspace.id, selected.farmId)!, t)
                  : t("farm.stubName", { id: selected.farmId })
            }
              />
            </FieldMap>
          </div>
        </div>
      )}
    </section>
  )
}

function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { id: string; label: string }[]
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find((option) => option.id === value)?.label ?? label
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", close)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("pointerdown", close)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])
  return (
    <div className="fields-filter-menu" ref={rootRef}>
      <button
        type="button"
        className={value ? "is-set" : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <span>{current}</span>
        <ChevronDown className="icon" aria-hidden="true" />
      </button>
      {open ? (
        <ul role="listbox">
          {options.map((option) => (
            <li key={option.id || "all"}>
              <button
                type="button"
                role="option"
                aria-selected={option.id === value}
                className={option.id === value ? "is-on" : undefined}
                onClick={() => {
                  onChange(option.id)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function PhScale({ language }: { language: string }) {
  const stops = phScaleStops()
  const min = stops[0][0]
  const max = stops[stops.length - 1][0]
  const gradient = stops
    .map(([value, color]) => `${color} ${((value - min) / (max - min)) * 100}%`)
    .join(", ")
  const marks = [4.5, 6.5, 8]
  const text = (value: number) =>
    value.toLocaleString(language, { minimumFractionDigits: value % 1 === 0 ? 0 : 1, maximumFractionDigits: 1 })
  return (
    <div className="layer-scale" aria-label="pH">
      <span>pH</span>
      <div>
        <i style={{ background: `linear-gradient(90deg, ${gradient})` }} />
        <ol>
          {marks.map((value) => (
            <li key={value} style={{ left: `${((value - min) / (max - min)) * 100}%` }}>
              {text(value)}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function LayerMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: FieldLayerId
  options: { id: FieldLayerId; label: string }[]
  onChange: (id: FieldLayerId) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", close)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("pointerdown", close)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])
  return (
    <div className="layer-menu" ref={rootRef}>
      <button
        type="button"
        className="layer-menu-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <ChevronDown className="icon" aria-hidden="true" />
      </button>
      {open ? (
        <ul className="layer-menu-list" role="listbox">
          {options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={option.id === value}
                className={option.id === value ? "is-on" : undefined}
                onClick={() => {
                  onChange(option.id)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function labelWidth(chars: number, withIcon: boolean) {
  return (withIcon ? 2.55 : 0.7) + chars * 1.02 + 0.5
}

function labelHot(field: DrawnField, hoverId: number | null, selectedId: number | null) {
  const hot = hoverId ?? selectedId
  if (hot == null) return false
  if (field.id === hot) return true
  return field.group != null && field.label !== "" && field.group.includes(hot)
}

function inActiveGroup(field: DrawnField, hoverId: number | null, selectedId: number | null) {
  if (field.group == null) return false
  if (hoverId != null && field.group.includes(hoverId)) return true
  return selectedId != null && field.group.includes(selectedId)
}

/** Larger on the way in. Zooming out shrinks the numbers, and they stay on the field. */
function labelScreenPx(zoom: number) {
  if (zoom <= 1) return Math.max(14, 30 * (0.46 + 0.54 * zoom))
  return Math.min(54, 30 + 11 * (zoom - 1))
}

function visibleLabels(fields: DrawnField[], zoom: number, sidePx: number) {
  if (sidePx <= 0) return { scale: 0, ids: new Set<number>() }
  const scale = (labelScreenPx(zoom) / (sidePx * Math.max(zoom, FIELDS_MIN_ZOOM))) * 100 / LABEL_HEIGHT
  const ids = new Set<number>()
  for (const field of fields) {
    if (field.label) ids.add(field.id)
  }
  return { scale, ids }
}

function FieldMap({
  fields,
  outlines,
  painted,
  raster,
  showTracks,
  tracks,
  mapUrl,
  live,
  selectedId,
  focusToken,
  label,
  frame,
  viewUserId,
  viewScope,
  onSelect,
  onContentBox,
  children,
}: {
  fields: DrawnField[]
  outlines: { key: string; ids: number[]; polygon: string }[]
  painted: boolean
  raster: { href: string; x: number; y: number; w: number; h: number } | null
  showTracks: boolean
  tracks: { href: string; x: number; y: number; w: number; h: number } | null
  mapUrl: string | null
  live: boolean
  selectedId: number | null
  focusToken: number
  label: string
  frame: { scaleX: number; scaleZ: number; padX: number; padZ: number }
  viewUserId: string | null
  viewScope: string
  onSelect: (id: number) => void
  onContentBox: (box: { x: number; y: number; w: number; h: number } | null) => void
  children?: ReactNode
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const savedView = useRef(readMapView(viewUserId, viewScope, FIELDS_MIN_ZOOM))
  const cam = useRef<MapCamera>(savedView.current ?? { x: 0, y: 0, k: 1 })
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null)
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const [mapFailed, setMapFailed] = useState(false)
  const [loadedRasters, setLoadedRasters] = useState<ReadonlySet<string>>(() => new Set())
  const [failedRaster, setFailedRaster] = useState<string | null>(null)
  const [tracksReady, setTracksReady] = useState(false)
  const [tracksFailed, setTracksFailed] = useState(false)
  const [brokenIcons, setBrokenIcons] = useState<ReadonlySet<string>>(() => new Set())
  const rasterReady = raster != null && failedRaster !== raster.href && loadedRasters.has(raster.href)
  const [zoom, setZoom] = useState(cam.current.k)
  const [view, setView] = useState({ w: 0, h: 0 })
  const [hoverId, setHoverId] = useState<number | null>(null)
  const viewRef = useRef(view)
  const sheet = useMemo(() => sheetFor(view, frame), [frame, view])
  const sheetRef = useRef(sheet)
  viewRef.current = view
  sheetRef.current = sheet
  const sidePx = sheet.size
  const fieldsRef = useRef(fields)
  const selectedRef = useRef(selectedId)
  const labels = useMemo(
    () => visibleLabels(fields, zoom, sidePx),
    [fields, sidePx, zoom],
  )
  function apply() {
    const el = stageRef.current
    if (!el) return
    const { x, y, k } = cam.current
    el.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    setZoom((prev) => (prev === k ? prev : k))
    writeMapView(viewUserId, viewScope, cam.current)
  }

  function commit(next: MapCamera) {
    cam.current = clampCamera(next, viewRef.current, sheetRef.current)
    apply()
  }

  function zoomAt(next: number, px: number, py: number) {
    const prev = cam.current.k
    const clamped = Math.min(6, Math.max(FIELDS_MIN_ZOOM, next))
    const ratio = clamped / prev
    commit({
      k: clamped,
      x: px - (px - cam.current.x) * ratio,
      y: py - (py - cam.current.y) * ratio,
    })
  }

  function focusField(field: DrawnField | undefined) {
    const viewport = viewportRef.current
    const placed = sheetRef.current
    if (!viewport || !field || placed.size < 8) return
    const k = 2.6
    const px = placed.left + (field.x / 100) * placed.size
    const py = placed.top + (field.y / 100) * placed.size
    commit({
      k,
      x: viewport.clientWidth / 2 - px * k,
      y: viewport.clientHeight / 2 - py * k,
    })
  }

  useEffect(() => {
    apply()
  }, [])

  useEffect(() => {
    fieldsRef.current = fields
    selectedRef.current = selectedId
  }, [fields, selectedId])

  useEffect(() => {
    if (focusToken === 0) return
    focusField(fieldsRef.current.find((field) => field.id === selectedRef.current))
  }, [focusToken])

  useEffect(() => {
    if (!mapFailed) return
    const timer = window.setTimeout(() => setMapFailed(false), 20_000)
    return () => window.clearTimeout(timer)
  }, [mapFailed])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => {
      const next = { w: viewport.clientWidth, h: viewport.clientHeight }
      setView((prev) => (prev.w === next.w && prev.h === next.h ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (view.w < 8) return
    cam.current = clampCamera(cam.current, view, sheet)
    apply()
  }, [sheet, view])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      zoomAt(cam.current.k * factor, event.clientX - rect.left, event.clientY - rect.top)
    }
    viewport.addEventListener("wheel", onWheel, { passive: false })
    return () => viewport.removeEventListener("wheel", onWheel)
  }, [])

  return (
    <div className="fields-map-frame">
      <div
        ref={viewportRef}
        className={dragging ? "fields-viewport is-drag" : "fields-viewport"}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            cx: cam.current.x,
            cy: cam.current.y,
            moved: false,
          }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const current = drag.current
          if (current) {
            const dx = event.clientX - current.x
            const dy = event.clientY - current.y
            if (Math.abs(dx) + Math.abs(dy) > 4) current.moved = true
            commit({ x: current.cx + dx, y: current.cy + dy, k: cam.current.k })
            return
          }
          const hit = document
            .elementsFromPoint(event.clientX, event.clientY)
            .find((node) => node instanceof Element && node.closest("[data-field]"))
          const node = hit instanceof Element ? hit.closest("[data-field]") : null
          const nextId = Number(node?.getAttribute("data-field"))
          const hover = Number.isFinite(nextId) ? nextId : null
          setHoverId((prev) => (prev === hover ? prev : hover))
        }}
        onPointerLeave={() => setHoverId(null)}
        onPointerUp={(event) => {
          const current = drag.current
          drag.current = null
          setDragging(false)
          if (!current || current.moved) return
          const hit = document
            .elementsFromPoint(event.clientX, event.clientY)
            .find((node) => node instanceof Element && node.closest("[data-field]"))
          const node = hit instanceof Element ? hit.closest("[data-field]") : null
          const nextId = Number(node?.getAttribute("data-field"))
          if (Number.isFinite(nextId)) onSelect(nextId)
        }}
      >
        <div ref={stageRef} className="fields-stage">
          {mapUrl && !mapFailed ? (
            <img
              className="live-sheet"
              src={mapUrl}
              alt=""
              draggable={false}
              style={{ left: sheet.left, top: sheet.top, width: sheet.size, height: sheet.size }}
              onError={() => {
                setMapFailed(true)
                onContentBox(null)
              }}
              onLoad={(event) => {
                const image = event.currentTarget
                if (image.src.includes("/pda-map")) {
                  onContentBox(null)
                  return
                }
                const canvas = document.createElement("canvas")
                const sample = Math.min(image.naturalWidth, image.naturalHeight, 512)
                canvas.width = sample
                canvas.height = sample
                const ctx = canvas.getContext("2d", { willReadFrequently: true })
                if (!ctx) {
                  onContentBox(null)
                  return
                }
                try {
                  ctx.drawImage(image, 0, 0, sample, sample)
                  onContentBox(measureMapContent(ctx.getImageData(0, 0, sample, sample).data, sample, sample))
                } catch {
                  onContentBox(null)
                }
              }}
            />
          ) : live ? (
            <p className="fields-map-note">{t("fields.mapUnavailable")}</p>
          ) : (
            <div className="fields-terrain" aria-hidden="true" />
          )}
          <svg
            className="live-sheet"
            viewBox="0 0 100 100"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={label}
            style={{ left: sheet.left, top: sheet.top, width: sheet.size, height: sheet.size, "--map-zoom": zoom } as CSSProperties}
          >
            {raster ? (
              <g clipPath="url(#precision-fields)">
                <clipPath id="precision-fields">
                  {fields.map((field) =>
                    field.polygon && !field.group ? <polygon key={field.id} points={field.polygon} /> : null,
                  )}
                  {outlines.map((outline) => (
                    <polygon key={outline.key} points={outline.polygon} />
                  ))}
                </clipPath>
                <image
                  key={raster.href}
                  className={rasterReady ? "precision-raster" : "precision-raster is-pending"}
                  href={raster.href}
                  x={raster.x}
                  y={raster.y}
                  width={raster.w}
                  height={raster.h}
                  preserveAspectRatio="none"
                  onLoad={() => {
                    const href = raster.href
                    setLoadedRasters((current) => {
                      if (current.has(href)) return current
                      const next = new Set(current)
                      next.add(href)
                      return next
                    })
                  }}
                  onError={() => setFailedRaster(raster.href)}
                />
              </g>
            ) : null}
            {outlines.map((outline) => {
              const fillGap = painted && (raster == null || failedRaster === raster?.href)
              const member = fields.find((field) => field.id === outline.ids[0])
              return (
                <polygon
                  key={`join-${outline.key}`}
                  data-field={outline.ids[0]}
                  className={fillGap ? "field-shape is-painted field-joined-hit" : "field-joined-hit"}
                  points={outline.polygon}
                  fill={fillGap ? (member?.color ?? "transparent") : "transparent"}
                />
              )
            })}
            {fields.map((field) => {
              const showRaster = raster != null && rasterReady
              const holdForRaster = raster != null && !showRaster && failedRaster !== raster.href
              const className = [
                "field-shape",
                showRaster || holdForRaster ? "is-raster" : "",
                painted && !showRaster && !holdForRaster ? "is-painted" : "",
                field.group ? "is-joined" : "",
                inActiveGroup(field, hoverId, selectedId) ? "is-group-hot" : "",
                field.id === selectedId ? "is-selected" : "",
                field.mine ? "" : "is-other",
              ]
                .filter(Boolean)
                .join(" ")
              return field.polygon ? (
                <polygon
                  key={field.id}
                  data-field={field.id}
                  className={className}
                  points={field.polygon}
                  fill={showRaster ? "transparent" : field.color}
                />
              ) : (
                <circle key={field.id} data-field={field.id} className={className} cx={field.x} cy={field.y} r="1.1" fill={field.color} />
              )
            })}
            {outlines.map((outline) => {
              const hot = outline.ids.some((id) => id === hoverId || id === selectedId)
              return (
                <polygon
                  key={outline.key}
                  className={hot ? "field-outline is-hot" : "field-outline"}
                  points={outline.polygon}
                />
              )
            })}
            {showTracks && tracks && !tracksFailed ? (
              <image
                className="tram-raster"
                href={tracks.href}
                x={tracks.x}
                y={tracks.y}
                width={tracks.w}
                height={tracks.h}
                preserveAspectRatio="none"
                onLoad={() => setTracksReady(true)}
                onError={() => setTracksFailed(true)}
              />
            ) : null}
            {showTracks && !tracksReady
              ? fields.map((field) =>
                  field.tracks.map((points, index) => (
                    <g key={`tram-${field.id}-${index}`} className="field-tramlines">
                      <polyline className="field-tram is-halo" points={points} />
                      <polyline className="field-tram is-on" points={points} />
                    </g>
                  )),
                )
              : null}
            {fields.map((field) => {
              const hot = labelHot(field, hoverId, selectedId)
              if (!field.label || labels.scale <= 0 || (!labels.ids.has(field.id) && !hot)) return null
              const pack = cropIcon(field.mark)
              const game = field.iconUrl && !brokenIcons.has(field.iconUrl) ? field.iconUrl : null
              const icon = game ?? pack
              const withIcon = icon != null
              const digits = field.label.length
              const width = labelWidth(digits, withIcon)
              const iconX = -width / 2 + 0.28
              const textX = withIcon ? iconX + 2.35 + (digits * 1.02) / 2 : 0
              return (
                <g
                  key={`label-${field.id}`}
                  data-field={field.id}
                  className={field.mine ? "field-label" : "field-label is-other"}
                  transform={`translate(${field.x} ${field.y}) scale(${labels.scale})`}
                >
                  <rect x={-width / 2} y={-1.35} width={width} height={LABEL_HEIGHT} rx="0.45" />
                  {icon ? (
                    <image
                      href={icon}
                      x={iconX}
                      y={-1.05}
                      width="2.1"
                      height="2.1"
                      onError={() => {
                        const href = field.iconUrl
                        if (!href || href !== icon) return
                        setBrokenIcons((current) => {
                          if (current.has(href)) return current
                          const next = new Set(current)
                          next.add(href)
                          return next
                        })
                      }}
                    />
                  ) : null}
                  <text x={textX} y="0.55" textAnchor="middle" fontSize="1.7">
                    {field.label}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      </div>
      <div className="fields-zoom">
        <button
          type="button"
          className="btn btn-secondary"
          aria-label={t("fields.zoomIn")}
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
          aria-label={t("fields.zoomOut")}
          onClick={() => {
            const viewport = viewportRef.current
            if (!viewport) return
            zoomAt(cam.current.k / 1.25, viewport.clientWidth / 2, viewport.clientHeight / 2)
          }}
        >
          <Minus className="icon" />
        </button>
      </div>
      {children}
    </div>
  )
}

function FieldDetail({
  field,
  precisionFarming,
  farmName,
}: {
  field: FieldSnapshot | null
  precisionFarming: boolean | null
  farmName: string | null
}) {
  const { t, i18n } = useTranslation()
  if (!field) {
    return (
      <aside className="fields-detail">
        <h2>{t("modules.fields")}</h2>
        <p className="muted">{t("fields.selectHint")}</p>
      </aside>
    )
  }

  const fruit = field.fruitTitle || field.fruitName
  const pack = cropIcon(cropKey(field.fruitName))
  const harvest = formatHarvest(field, t)
  const grassFruit = field.fruitName != null && GRASS_FRUIT.has(field.fruitName.toUpperCase())
  const grassGround = field.ground === 14 || field.ground === 15
  const soilLabel =
    field.soilName != null
      ? field.soilName
      : namedValue(t, "soilType", field.soil)
  const nitrogenText = formatTarget(field.nitrogen, field.nitrogenTarget, i18n.language, 0, "kg/ha")
  const phText = formatTarget(field.ph, field.phTarget, i18n.language, 2, "pH")

  return (
    <aside className="fields-detail">
      <header className="fields-detail-head">
        {field.iconUrl || pack ? (
          <span className="fields-detail-mark" aria-hidden="true">
            <img
              src={field.iconUrl ?? pack ?? undefined}
              alt=""
              onError={(event) => {
                const img = event.currentTarget
                if (pack && img.dataset.fallback !== "1") {
                  img.dataset.fallback = "1"
                  img.src = pack
                  return
                }
                img.style.display = "none"
              }}
            />
          </span>
        ) : null}
        <div>
          <h2>{t("fields.numberValue", { id: field.id })}</h2>
          <p>{fruit ?? t("fields.crop.noCrop")}</p>
        </div>
      </header>
      {field.points.length < 3 ? <p className="hint">{t("fields.outlineMissing")}</p> : null}
      <dl className="fields-facts">
        <Fact label={t("fields.number")} value={String(field.id)} />
        {field.group && field.group.length > 1 ? <Fact label={t("fields.merged")} value={field.group.join(", ")} /> : null}
        <Fact label={t("fields.fruit")} value={fruit} />
        <Fact label={t("fields.areaHa")} value={formatHa(field.areaHa, i18n.language)} />
        <Fact label={t("fields.farm")} value={farmName} />
        <Fact
          label={t("fields.ownership")}
          value={field.owned == null ? null : field.owned ? t("fields.ownedYes") : t("fields.ownedNo")}
        />
        <Fact label={t("fields.farmland")} value={field.farmlandId == null ? null : String(field.farmlandId)} />
        <Fact label={t("fields.cropState")} value={cropStateLabel(t, field.crop)} />
        <div>
          <dt>{t("fields.growth")}</dt>
          <dd>
            <GrowthMeter
              growth={field.growth}
              max={field.growthMax}
              harvestMin={field.harvestMin}
              harvestMax={field.harvestMax}
            />
          </dd>
        </div>
        <div>
          <dt>{t("fields.harvestWindow")}</dt>
          <dd>{harvest.text ?? t("unavailable")}</dd>
        </div>
        <div title={t("fields.groundHint")}>
          <dt>{t("fields.ground")}</dt>
          <dd>
            <span className="swatch-row">
              {field.ground != null ? <i className="swatch" style={{ background: paintColor(field, "ground") }} /> : null}
              {namedValue(t, "groundState", field.ground) ?? t("unavailable")}
            </span>
          </dd>
        </div>
        {grassGround && !grassFruit ? (
          <div className="fields-note">
            {t("fields.groundGrassNote", {
              fruit: fruit ?? t("fields.crop.unknown"),
              soil: soilLabel ?? t("unavailable"),
            })}
          </div>
        ) : null}
        <MeterFact label={t("fields.weed")} value={field.weed} max={3} text={namedValue(t, "weedState", field.weed)} color="#c47a3a" />
        <MeterFact label={t("fields.stones")} value={field.stones} max={3} text={namedValue(t, "stoneState", field.stones)} color="#9aa3ad" />
        {precisionFarming === true ? null : (
          <>
            <MeterFact label={t("fields.spray")} value={field.spray} max={2} text={namedValue(t, "levelOnly", field.spray)} color="#6fbf73" />
            <MeterFact label={t("fields.lime")} value={field.lime} max={2} text={namedValue(t, "levelOnly", field.lime)} color="#d7d3c4" />
          </>
        )}
        <Fact label={t("fields.rollerNeeded")} value={field.roller == null ? null : field.roller > 0 ? t("no") : t("yes")} />
        <Fact label={t("fields.plowNeeded")} value={field.plow == null ? null : field.plow > 0 ? t("no") : t("yes")} />
      </dl>
      {precisionFarming === true ? (
        <>
          <h3>{t("fields.sectionPrecision")}</h3>
          {field.scanned === false ? (
            <p className="muted">{t("fields.scannedNo")}</p>
          ) : (
            <dl className="fields-facts">
              <div>
                <dt>{t("fields.soil")}</dt>
                <dd>
                  <span className="swatch-row">
                    {field.soil != null ? <i className="swatch" style={{ background: paintColor(field, "soil") }} /> : null}
                    {soilLabel ?? t("unavailable")}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t("fields.nitrogen")}</dt>
                <dd>
                  <RatioBar
                    value={field.nitrogen}
                    target={field.nitrogenTarget}
                    text={nitrogenText}
                    color={paintColor(field, "nitrogen")}
                  />
                </dd>
              </div>
              <div>
                <dt>{t("fields.ph")}</dt>
                <dd>
                  <RatioBar value={field.ph} target={field.phTarget} text={phText} color={paintColor(field, "ph")} />
                </dd>
              </div>
              <Fact label={t("fields.scanned")} value={field.scanned == null ? null : field.scanned ? t("yes") : t("no")} />
            </dl>
          )}
          {field.tramline ? (
            <dl className="fields-facts">
              <Fact label={t("fields.tramlineWidth")} value={`${Math.round(field.tramline.width)} m`} />
            </dl>
          ) : null}
        </>
      ) : null}
      {precisionFarming === true ? (
        <details className="fields-hidden">
          <summary>{t("fields.hiddenSection")}</summary>
          <p>{t("fields.hiddenBecausePf")}</p>
          <dl className="fields-facts">
            <MutedFact label={t("fields.spray")} reason={t("fields.hiddenBecausePf")} />
            <MutedFact label={t("fields.lime")} reason={t("fields.hiddenBecausePf")} />
          </dl>
        </details>
      ) : null}
    </aside>
  )
}

const GRASS_FRUIT = new Set(["GRASS", "MEADOW", "FIELDGRASS", "GREENRYE", "VETCHRYE"])

function Fact({ label, value }: { label: string; value: string | null }) {
  const { t } = useTranslation()
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? t("unavailable")}</dd>
    </div>
  )
}

function MutedFact({ label, reason }: { label: string; reason: string }) {
  const { t } = useTranslation()
  return (
    <div className="is-muted" title={reason}>
      <dt>{label}</dt>
      <dd>{t("fields.hiddenValue")}</dd>
    </div>
  )
}

function MeterFact({
  label,
  value,
  max,
  text,
  color,
}: {
  label: string
  value: number | null
  max: number
  text: string | null
  color: string
}) {
  const { t } = useTranslation()
  const count = Math.max(max, value ?? 0, 1)
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className="meter-line">
          <span className="pips" style={{ "--meter": color } as CSSProperties}>
            {Array.from({ length: count }, (_, index) => (
              <i key={index} className={value != null && index < value ? "is-on" : ""} />
            ))}
          </span>
          <span>{text ?? (value == null ? t("unavailable") : String(value))}</span>
        </span>
      </dd>
    </div>
  )
}

function GrowthMeter({
  growth,
  max,
  harvestMin,
  harvestMax,
}: {
  growth: number | null
  max: number | null
  harvestMin: number | null
  harvestMax: number | null
}) {
  const { t } = useTranslation()
  if (growth == null) return t("unavailable")
  const count = Math.max(max ?? growth, growth, 1)
  return (
    <span className="meter-line">
      <span className="pips" style={{ "--meter": "#e0b44a" } as CSSProperties}>
        {Array.from({ length: count }, (_, index) => {
          const stage = index + 1
          const harvest = harvestMin != null && harvestMax != null && stage >= harvestMin && stage <= harvestMax
          return <i key={stage} className={[stage <= growth ? "is-on" : "", harvest ? "is-harvest" : ""].filter(Boolean).join(" ")} />
        })}
      </span>
      <span>{max != null && max > 0 ? `${growth} / ${max}` : String(growth)}</span>
    </span>
  )
}

function RatioBar({
  value,
  target,
  text,
  color,
}: {
  value: number | null
  target: number | null
  text: string | null
  color: string
}) {
  const { t } = useTranslation()
  if (text == null) return t("unavailable")
  const top = Math.max(value ?? 0, target ?? 0, 1)
  return (
    <span className="meter-line">
      <span className="ratio">
        <span style={{ width: `${((value ?? 0) / top) * 100}%`, background: color }} />
        {target != null ? <em style={{ left: `${(target / top) * 100}%` }} /> : null}
      </span>
      <span>{text}</span>
    </span>
  )
}
