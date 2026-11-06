import { useEffect, useMemo, useState, type SyntheticEvent } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Boxes, Clock3, LayoutGrid, Puzzle, Tractor, Truck, Wheat, Wrench } from "lucide-react"
import { apiWorkspaceVehicles } from "../api"
import { EmptyState, MissingWorkspace, PermissionBlock } from "../components/ui"
import { useWorkspaceRoute } from "../use-workspace"
import { useStore } from "../store"
import { VehicleMeterBars } from "../components/equip-gauge"
import type { Vehicle, VehicleCategory } from "../types"
import { isPallet, vehicleBrand, vehicleDisplayName } from "../vehicle-label"

type EquipmentFilter = "all" | "tractor" | "trailer" | "tool" | "selfpropelled" | "pallet"

function matchesFilter(vehicle: Vehicle, filter: EquipmentFilter) {
  if (isPallet(vehicle)) return filter === "pallet"
  if (filter === "all" || filter === "pallet") return filter === "all"
  if (filter === "selfpropelled") return vehicle.category === "harvester"
  return vehicle.category === filter
}

function categoryLabelKey(category: VehicleCategory) {
  if (category === "harvester") return "vehicles.selfpropelled"
  return `vehicles.${category}`
}

function CategoryIcon({ category }: { category: EquipmentFilter }) {
  const Icon =
    category === "tractor"
      ? Tractor
      : category === "trailer"
        ? Truck
        : category === "tool"
          ? Wrench
          :     category === "selfpropelled"
            ? Wheat
            : category === "pallet"
              ? Boxes
              : LayoutGrid
  return <Icon className="icon" aria-hidden="true" />
}

function onIconError(event: SyntheticEvent<HTMLImageElement>) {
  const wrap = event.currentTarget.parentElement
  event.currentTarget.remove()
  wrap?.querySelector(".icon-fallback")?.classList.remove("is-hidden")
}

export function VehiclesPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const {
    vehicles,
    liveMode,
    moduleAccess,
    selectedFarm,
    replaceWorkspaceFarms,
    replaceWorkspaceVehicles,
    upsertWorkspace,
  } = useStore()
  const { id, workspace, allowed } = useWorkspaceRoute()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<EquipmentFilter>("all")
  const [loading, setLoading] = useState(false)
  const equipmentAccess = workspace ? moduleAccess(workspace.id, "equipment") : null
  const farm = workspace ? selectedFarm(workspace.id) : null

  useEffect(() => {
    if (!workspace || !liveMode || !allowed || !equipmentAccess) return
    let cancelled = false

    const refreshVehicles = async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true)
      try {
        const result = await apiWorkspaceVehicles(workspace.id)
        if (cancelled) return
        replaceWorkspaceVehicles(workspace.id, result.vehicles)
        if (result.farms) replaceWorkspaceFarms(workspace.id, result.farms)
        if (result.workspace) upsertWorkspace(result.workspace)
      } catch {
        // keep last list
      } finally {
        if (!cancelled && showSpinner) setLoading(false)
      }
    }

    void refreshVehicles(true)

    return () => {
      cancelled = true
    }
  }, [workspace?.id, liveMode, allowed, equipmentAccess])

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const inWorkspace = vehicles.filter((vehicle) => vehicle.workspaceId === id)
    const anyFarmBound = inWorkspace.some((vehicle) => vehicle.farmId !== null)
    return inWorkspace
      .filter((vehicle) => {
        if (!farm) return true
        if (vehicle.farmId !== null) {
          return Number(vehicle.farmId) === Number(farm.gameFarmId)
        }
        return !anyFarmBound
      })
      .filter((vehicle) => matchesFilter(vehicle, filter))
      .filter((vehicle) => {
        if (!needle) return true
        const title = vehicleDisplayName(vehicle.name).toLocaleLowerCase()
        const mod = (vehicle.modKey ?? "").toLocaleLowerCase()
        const brand = (vehicleBrand(vehicle) ?? "").toLocaleLowerCase()
        return (
          title.includes(needle) ||
          mod.includes(needle) ||
          brand.includes(needle) ||
          vehicle.name.toLocaleLowerCase().includes(needle)
        )
      })
      .sort((a, b) =>
        vehicleDisplayName(a.name).localeCompare(vehicleDisplayName(b.name), i18n.language),
      )
  }, [farm, filter, i18n.language, id, query, vehicles])

  const fleetHours = rows.reduce((sum, vehicle) => sum + (vehicle.hours ?? 0), 0)
  const fleetMods = rows.filter((vehicle) => vehicle.modKey).length

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !equipmentAccess) return <PermissionBlock />

  const filters: { id: EquipmentFilter; label: string }[] = [
    { id: "all", label: t("vehicles.all") },
    { id: "tractor", label: t("vehicles.tractor") },
    { id: "trailer", label: t("vehicles.trailer") },
    { id: "tool", label: t("vehicles.tool") },
    { id: "selfpropelled", label: t("vehicles.selfpropelled") },
    { id: "pallet", label: t("vehicles.pallet") },
  ]

  return (
    <section className="equipment-page">
      <div className="fields-mast">
        <h1>{t("modules.equipment")}</h1>
        <div className="fields-stats">
          <p>
            <Tractor className="fields-stat-icon" aria-hidden="true" />
            <strong>{rows.length.toLocaleString(i18n.language)}</strong>
            <span>{t("vehicles.fleet")}</span>
          </p>
          <p>
            <Clock3 className="fields-stat-icon" aria-hidden="true" />
            <strong>{fleetHours.toLocaleString(i18n.language, { maximumFractionDigits: 0 })} h</strong>
            <span>{t("vehicles.fleetHours")}</span>
          </p>
          <p>
            <Puzzle className="fields-stat-icon" aria-hidden="true" />
            <strong>{fleetMods.toLocaleString(i18n.language)}</strong>
            <span>{t("vehicles.fleetMods")}</span>
          </p>
        </div>
      </div>

      <div className="equip-toolbar">
        <nav className="access-tabs equipment-tabs" role="tablist" aria-label={t("vehicles.category")}>
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              aria-label={item.label}
              title={item.label}
              className={filter === item.id ? "access-tab active" : "access-tab"}
              onClick={() => setFilter(item.id)}
            >
              <CategoryIcon category={item.id} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <label className="field equip-search">
          <span className="sr-only">{t("vehicles.search")}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("vehicles.searchHint")}
          />
        </label>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={t("vehicles.emptyTitle")}
          body={loading ? t("farm.discovering") : t("vehicles.emptyBody")}
        />
      ) : (
        <div className="equip-grid">
          {rows.map((vehicle) => {
            const category =
              isPallet(vehicle)
                ? "pallet"
                : vehicle.category === "harvester"
                  ? "selfpropelled"
                  : vehicle.category
            const hours =
              vehicle.hours === null
                ? null
                : `${vehicle.hours.toLocaleString(i18n.language, { maximumFractionDigits: 0 })} h`
            const title = vehicleDisplayName(vehicle.name)
            const brand = vehicleBrand(vehicle)
            const position =
              vehicle.x === null || vehicle.z === null
                ? null
                : `${vehicle.x.toFixed(0)} / ${vehicle.z.toFixed(0)} m`

            const meta = [
              position ? `${t("vehicles.position")} ${position}` : null,
              hours,
              vehicle.plate ? `${t("vehicles.plate")} ${vehicle.plate}` : null,
            ].filter(Boolean)

            return (
              <button
                key={vehicle.id}
                type="button"
                className="equip-card is-poster"
                onClick={() => navigate(`/w/${id}/equipment/${vehicle.id}`)}
              >
                <span className="equip-card-media">
                  {vehicle.iconUrl ? (
                    <img src={vehicle.iconUrl} alt="" onError={onIconError} />
                  ) : null}
                  <Tractor className={`icon icon-fallback${vehicle.iconUrl ? " is-hidden" : ""}`} />
                  <span className="equip-card-cat">
                    <CategoryIcon category={category} />
                    <span>{t(categoryLabelKey(category === "selfpropelled" ? "harvester" : category))}</span>
                  </span>
                </span>
                <span className="equip-card-body">
                  {brand ? <span className="equip-card-brand">{brand}</span> : null}
                  <strong className="equip-card-title">{title}</strong>
                  {meta.length > 0 ? <span className="equip-card-meta">{meta.join(" · ")}</span> : null}
                  <VehicleMeterBars vehicle={vehicle} language={i18n.language} label={(key) => t(key)} />
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
