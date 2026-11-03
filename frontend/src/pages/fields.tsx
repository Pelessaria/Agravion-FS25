import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeft, ChevronRight, LocateFixed, Minus, Plus } from "lucide-react"
import { apiWorkspaceFields } from "../api"
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
  type MapFrame,
} from "../field-format"
import {
  EMPTY_FIELD_QUERY,
  activeQueryCount,
  layersFor,
  legendStops,
  matchesFieldQuery,
  paintColor,
  precisionRasterLayer,
  type FieldLayerId,
  type FieldQuery,
} from "../field-layers"
import { joinedContours } from "../field-outline"
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
}

const LABEL_HEIGHT = 2.7
const LABELS_FROM_ZOOM = 1.7

function CropMark({ kind }: { kind: string }) {
  if (
    kind === "wheat" ||
    kind === "barley" ||
    kind === "summerbarley" ||
    kind === "oat" ||
    kind === "rye" ||
    kind === "spelt" ||
    kind === "triticale" ||
    kind === "rice" ||
    kind === "ricelonggrain"
  ) {
    return (
      <path
        d="M8 15 V3 M8 5 L5.2 3.2 M8 7.2 L10.8 5.4 M8 9.4 L5.2 7.6 M8 11.6 L10.8 9.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    )
  }
  if (kind === "canola" || kind === "sunflower" || kind === "oilseedradish" || kind === "mustard") {
    return (
      <>
        <circle cx="8" cy="6" r="3.1" fill="currentColor" />
        <path d="M8 9 V15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </>
    )
  }
  if (kind === "maize" || kind === "silagemaize" || kind === "corn" || kind === "sorghum") {
    return <path d="M8 15 V4 M5.5 6.5 H10.5 M5 9 H11 M5.5 11.5 H10.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  }
  if (kind === "grass" || kind === "fieldgrass" || kind === "meadow" || kind === "greenrye" || kind === "vetchrye" || kind === "poplar") {
    return <path d="M4 14 C5 8 6 6 8 3 C10 6 11 8 12 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  }
  if (kind === "potato" || kind === "sugarbeet" || kind === "carrot" || kind === "parsnip" || kind === "beetroot") {
    return <ellipse cx="8" cy="9" rx="4.2" ry="3.2" fill="currentColor" />
  }
  if (kind === "cotton") {
    return <circle cx="8" cy="8" r="3.4" fill="currentColor" />
  }
  if (kind === "onion") {
    return (
      <>
        <circle cx="8" cy="9" r="3.2" fill="currentColor" />
        <path d="M8 6 V3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </>
    )
  }
  if (kind === "soybean" || kind === "pea" || kind === "fieldbean" || kind === "greenbean" || kind === "spinach") {
    return (
      <path
        d="M8 15 V7 M8 9 C4.2 8 3 4.5 6 3.2 M8 10 C12 8.6 13.2 5 10.2 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    )
  }
  if (kind === "grape" || kind === "olive") {
    return (
      <>
        <circle cx="6" cy="8" r="2" fill="currentColor" />
        <circle cx="10" cy="8" r="2" fill="currentColor" />
        <circle cx="8" cy="11.2" r="2" fill="currentColor" />
      </>
    )
  }
  return <path d="M8 14 V7 M8 9 C5 8 4 5 6 4 M8 8 C11 7 12 4 10 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
}

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
      mark: key,
      label: caption.show ? caption.text : "",
    }
  })
}

export function FieldsPage() {
  const { t, i18n } = useTranslation()
  const stamp = useTimeLabel()
  const { liveMode, moduleAccess, selectedFarm, farmByGameId } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "fields") : null
  const farm = workspace ? selectedFarm(workspace.id) : null
  const demo = useMemo(() => demoFields(), [])
  const [payload, setPayload] = useState<FieldsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [onlyMine, setOnlyMine] = useState(false)
  const [showUnowned, setShowUnowned] = useState(false)
  const [query, setQuery] = useState("")
  const [focusToken, setFocusToken] = useState(0)
  const [contentBox, setContentBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [layer, setLayer] = useState<FieldLayerId>("off")
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
  const owned = fields.filter((field) => field.owned).length
  const harvest = fields.filter((field) => field.crop === "harvestReady").length
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
  const legend = legendStops(activeLayer, t)
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
      <div className="page-head">
        <div>
          <h1>{t("modules.fields")}</h1>
          <p>{t("fields.lead")}</p>
        </div>
        <p className="faint">
          {source?.stateAt
            ? t("fields.updated", { time: stamp(source.stateAt, t("unavailable")) })
            : loading
              ? t("fields.loading")
              : null}
        </p>
      </div>

      <div className="stat-grid">
        <div className="stat-tile">
          <span>{t("fields.count")}</span>
          <strong>{fields.length.toLocaleString(i18n.language)}</strong>
        </div>
        <div className="stat-tile">
          <span>{t("fields.owned")}</span>
          <strong>{owned.toLocaleString(i18n.language)}</strong>
        </div>
        <div className="stat-tile">
          <span>{t("fields.harvest")}</span>
          <strong>{harvest.toLocaleString(i18n.language)}</strong>
        </div>
        <div className="stat-tile">
          <span>{t("fields.area")}</span>
          <strong>
            {fields.length === 0 ? t("unavailable") : formatHa(knownArea, i18n.language)}
            {missingArea && fields.length > 0 ? " +" : ""}
          </strong>
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
              <label className="field fields-search">
                <span className="sr-only">{t("fields.fieldNumber")}</span>
                <input
                  inputMode="numeric"
                  value={query}
                  placeholder={t("fields.fieldNumber")}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") jumpToNumber()
                  }}
                />
              </label>
              <button type="button" className="btn btn-secondary" onClick={jumpToNumber}>
                <LocateFixed className="icon" />
                {t("fields.pick")}
              </button>
            </div>
            <div className="fields-filters">
              <button
                type="button"
                className={onlyMine ? "chip-check on" : "chip-check"}
                aria-pressed={onlyMine}
                disabled={!farm}
                onClick={() => setOnlyMine((value) => !value)}
              >
                {t("fields.thisFarm")}
              </button>
              <button
                type="button"
                className={showUnowned ? "chip-check on" : "chip-check"}
                aria-pressed={showUnowned}
                onClick={() => setShowUnowned((value) => !value)}
              >
                {t("fields.showUnowned")}
              </button>
              <button
                type="button"
                className={fieldQuery.crop === "harvestReady" ? "chip-check on" : "chip-check"}
                aria-pressed={fieldQuery.crop === "harvestReady"}
                onClick={() => patchQuery({ crop: fieldQuery.crop === "harvestReady" ? "" : "harvestReady" })}
              >
                {t("fields.crop.harvestReady")}
              </button>
              <button
                type="button"
                className={fieldQuery.joined ? "chip-check on" : "chip-check"}
                aria-pressed={fieldQuery.joined}
                onClick={() => patchQuery({ joined: !fieldQuery.joined })}
              >
                {t("fields.filterJoined")}
              </button>
              <button
                type="button"
                className={fieldQuery.weeds ? "chip-check on" : "chip-check"}
                aria-pressed={fieldQuery.weeds}
                onClick={() => patchQuery({ weeds: !fieldQuery.weeds })}
              >
                {t("fields.filterWeeds")}
              </button>
              <button
                type="button"
                className={fieldQuery.stones ? "chip-check on" : "chip-check"}
                aria-pressed={fieldQuery.stones}
                onClick={() => patchQuery({ stones: !fieldQuery.stones })}
              >
                {t("fields.filterStones")}
              </button>
              {precisionFarming === true ? (
                <>
                  <button
                    type="button"
                    className={fieldQuery.nitrogen === "low" ? "chip-check on" : "chip-check"}
                    aria-pressed={fieldQuery.nitrogen === "low"}
                    onClick={() => patchQuery({ nitrogen: fieldQuery.nitrogen === "low" ? "" : "low" })}
                  >
                    {t("fields.filterNitrogenLow")}
                  </button>
                  <button
                    type="button"
                    className={fieldQuery.ph === "off" ? "chip-check on" : "chip-check"}
                    aria-pressed={fieldQuery.ph === "off"}
                    onClick={() => patchQuery({ ph: fieldQuery.ph === "off" ? "" : "off" })}
                  >
                    {t("fields.filterPhOff")}
                  </button>
                  <button
                    type="button"
                    className={fieldQuery.scan === "no" ? "chip-check on" : "chip-check"}
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
                    className={fieldQuery.spray === "open" ? "chip-check on" : "chip-check"}
                    aria-pressed={fieldQuery.spray === "open"}
                    onClick={() => patchQuery({ spray: fieldQuery.spray === "open" ? "" : "open" })}
                  >
                    {t("fields.filterSprayOpen")}
                  </button>
                  <button
                    type="button"
                    className={fieldQuery.lime === "open" ? "chip-check on" : "chip-check"}
                    aria-pressed={fieldQuery.lime === "open"}
                    onClick={() => patchQuery({ lime: fieldQuery.lime === "open" ? "" : "open" })}
                  >
                    {t("fields.filterLimeOpen")}
                  </button>
                </>
              )}
              <select
                className="fields-filter-select"
                aria-label={t("fields.filterFruit")}
                value={fieldQuery.fruit}
                onChange={(event) => patchQuery({ fruit: event.target.value })}
              >
                <option value="">{t("fields.filterFruit")}</option>
                {fruitOptions.map(([name, title]) => (
                  <option key={name} value={name}>
                    {title}
                  </option>
                ))}
              </select>
              <select
                className="fields-filter-select"
                aria-label={t("fields.filterCrop")}
                value={fieldQuery.crop}
                onChange={(event) => patchQuery({ crop: event.target.value })}
              >
                <option value="">{t("fields.filterCrop")}</option>
                {cropFilters.map((crop) => (
                  <option key={crop} value={crop}>
                    {t(`fields.crop.${crop}`)}
                  </option>
                ))}
              </select>
              {precisionFarming === true ? (
                <select
                  className="fields-filter-select"
                  aria-label={t("fields.filterSoil")}
                  value={fieldQuery.soil}
                  onChange={(event) => patchQuery({ soil: event.target.value })}
                >
                  <option value="">{t("fields.filterSoil")}</option>
                  {[1, 2, 3, 4].map((soil) => (
                    <option key={soil} value={String(soil)}>
                      {t(`fields.soilType.${soil}`)}
                    </option>
                  ))}
                </select>
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
        {label}
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

/** Quiet at the default view. Numbers and crop marks appear once the map is enlarged. */
function labelScreenPx(zoom: number) {
  return Math.min(18, 11 + 2.5 * Math.max(zoom - 1, 0))
}

function visibleLabels(
  fields: DrawnField[],
  zoom: number,
  sidePx: number,
  pinnedId: number | null,
  hoverId: number | null,
) {
  if (sidePx <= 0) return { scale: 0, ids: new Set<number>() }
  const scale = (labelScreenPx(zoom) / (sidePx * Math.max(zoom, 1))) * 100 / LABEL_HEIGHT
  const ranked = [...fields].sort((a, b) => {
    if (a.id === pinnedId) return -1
    if (b.id === pinnedId) return 1
    const area = (field: DrawnField) => (field.box ? field.box.w * field.box.h : 0)
    return area(b) - area(a)
  })
  const placed: { x: number; y: number; w: number; h: number }[] = []
  const ids = new Set<number>()
  for (const field of ranked) {
    if (!field.label) continue
    const forced = labelHot(field, hoverId, pinnedId)
    if (!forced && zoom < LABELS_FROM_ZOOM) continue
    const width = labelWidth(field.label.length, true) * scale
    const height = LABEL_HEIGHT * scale
    const labelBox = { x: field.x - width / 2, y: field.y - height / 2, w: width, h: height }
    const fits =
      field.box != null &&
      field.box.w * field.box.h >= width * height * 0.42 &&
      field.box.w >= width * 0.55 &&
      field.box.h >= height * 0.45
    if (!forced && !fits) continue
    const gap = 0.15 * scale
    const blocked = placed.some(
      (other) =>
        labelBox.x < other.x + other.w + gap &&
        labelBox.x + labelBox.w + gap > other.x &&
        labelBox.y < other.y + other.h + gap &&
        labelBox.y + labelBox.h + gap > other.y,
    )
    if (blocked && !forced) continue
    placed.push(labelBox)
    ids.add(field.id)
  }
  return { scale, ids }
}

function FieldMap({
  fields,
  outlines,
  painted,
  raster,
  mapUrl,
  live,
  selectedId,
  focusToken,
  label,
  onSelect,
  onContentBox,
  children,
}: {
  fields: DrawnField[]
  outlines: { key: string; ids: number[]; polygon: string }[]
  painted: boolean
  raster: { href: string; x: number; y: number; w: number; h: number } | null
  mapUrl: string | null
  live: boolean
  selectedId: number | null
  focusToken: number
  label: string
  onSelect: (id: number) => void
  onContentBox: (box: { x: number; y: number; w: number; h: number } | null) => void
  children?: ReactNode
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const cam = useRef({ x: 0, y: 0, k: 1 })
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null)
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const [mapFailed, setMapFailed] = useState(false)
  const [loadedRasters, setLoadedRasters] = useState<ReadonlySet<string>>(() => new Set())
  const [failedRaster, setFailedRaster] = useState<string | null>(null)
  const [brokenIcons, setBrokenIcons] = useState<ReadonlySet<string>>(() => new Set())
  const rasterReady = raster != null && failedRaster !== raster.href && loadedRasters.has(raster.href)
  const [zoom, setZoom] = useState(1)
  const [sidePx, setSidePx] = useState(0)
  const [hoverId, setHoverId] = useState<number | null>(null)
  const fieldsRef = useRef(fields)
  const selectedRef = useRef(selectedId)
  const labels = useMemo(
    () => visibleLabels(fields, zoom, sidePx, selectedId, hoverId),
    [fields, hoverId, selectedId, sidePx, zoom],
  )

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

  function focusField(field: DrawnField | undefined) {
    const viewport = viewportRef.current
    if (!viewport || !field) return
    const width = viewport.clientWidth
    const height = viewport.clientHeight
    const k = 2.6
    const px = (field.x / 100) * width
    const py = (field.y / 100) * height
    cam.current.k = k
    cam.current.x = width / 2 - px * k
    cam.current.y = height / 2 - py * k
    apply()
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
      const next = Math.min(viewport.clientWidth, viewport.clientHeight)
      setSidePx((prev) => (prev === next ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

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
            if (cam.current.k <= 1) return
            cam.current.x = current.cx + dx
            cam.current.y = current.cy + dy
            apply()
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
              src={mapUrl}
              alt=""
              draggable={false}
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
            viewBox="0 0 100 100"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={label}
            style={{ "--map-zoom": zoom } as CSSProperties}
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
            {fields.map((field) => {
              const hot = labelHot(field, hoverId, selectedId)
              if (!field.label || labels.scale <= 0 || (!labels.ids.has(field.id) && !hot)) return null
              const withIcon = true
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
                  {withIcon && field.iconUrl && !brokenIcons.has(field.iconUrl) ? (
                    <image
                      href={field.iconUrl}
                      x={iconX}
                      y={-1.05}
                      width="2.1"
                      height="2.1"
                      onError={() => {
                        const href = field.iconUrl
                        if (!href) return
                        setBrokenIcons((current) => {
                          if (current.has(href)) return current
                          const next = new Set(current)
                          next.add(href)
                          return next
                        })
                      }}
                    />
                  ) : null}
                  {withIcon && (!field.iconUrl || brokenIcons.has(field.iconUrl)) ? (
                    <g transform={`translate(${iconX} -1.05)`}>
                      <rect width="2.1" height="2.1" rx="0.35" fill={field.color} />
                      <g transform="scale(0.131)" style={{ color: "#172016" }}>
                        <CropMark kind={field.mark} />
                      </g>
                    </g>
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
        <span className="fields-detail-mark" style={{ color: cropColor(field) }} aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <CropMark kind={cropKey(field.fruitName)} />
          </svg>
          {field.iconUrl ? (
            <img
              src={field.iconUrl}
              alt=""
              onError={(event) => {
                event.currentTarget.style.display = "none"
              }}
            />
          ) : null}
        </span>
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
