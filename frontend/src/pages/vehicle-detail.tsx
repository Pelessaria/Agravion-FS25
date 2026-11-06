import { useEffect, useState, type SyntheticEvent } from "react"
import { useTranslation } from "react-i18next"
import { Link, useParams } from "react-router-dom"
import { Package, Tractor } from "lucide-react"
import { apiWorkspaceVehicles } from "../api"
import { VehicleGauges } from "../components/equip-gauge"
import { EmptyState, MissingValue, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { farmDisplayName } from "../farm-label"
import { useStore } from "../store"
import { useWorkspaceRoute } from "../use-workspace"
import type { Vehicle } from "../types"
import { modDisplayName, modZipLabel, vehicleBrand, vehicleDisplayName } from "../vehicle-label"

function positionOf(vehicle: Vehicle) {
  if (vehicle.x === null || vehicle.z === null) return null
  const format = (value: number) => value.toFixed(0)
  return `${format(vehicle.x)} / ${format(vehicle.z)} m`
}

function shortFilename(path: string | null | undefined) {
  if (!path) return null
  const normalized = path.replace(/\\/g, "/")
  const parts = normalized.split("/")
  return parts[parts.length - 1] || normalized
}

function onBrandIconError(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.remove()
}

function onIconError(event: SyntheticEvent<HTMLImageElement>) {
  const wrap = event.currentTarget.parentElement
  event.currentTarget.remove()
  wrap?.querySelector(".icon-fallback")?.classList.remove("is-hidden")
}

export function VehicleDetailPage() {
  const { t, i18n } = useTranslation()
  const stamp = useTimeLabel()
  const { vehicleId = "" } = useParams()
  const decodedId = decodeURIComponent(vehicleId)
  const { vehicles, moduleAccess, farmByGameId, liveMode, replaceWorkspaceVehicles } = useStore()
  const { id, workspace, allowed } = useWorkspaceRoute()
  const [lookup, setLookup] = useState<"pending" | "done">("pending")
  const vehicle = vehicles.find((item) => item.id === decodedId && item.workspaceId === id)

  useEffect(() => {
    if (!workspace || !liveMode) return
    if (vehicles.some((item) => item.id === decodedId && item.workspaceId === workspace.id)) {
      setLookup("done")
      return
    }
    let cancelled = false
    setLookup("pending")
    apiWorkspaceVehicles(workspace.id)
      .then((result) => {
        if (!cancelled) replaceWorkspaceVehicles(workspace.id, result.vehicles)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLookup("done")
      })
    return () => {
      cancelled = true
    }
  }, [decodedId, liveMode, workspace?.id])
  const fill = vehicle?.fill ? (i18n.language === "en" ? vehicle.fill.en : vehicle.fill.de) : null
  const equipmentAccess = workspace ? moduleAccess(workspace.id, "equipment") : null
  const linkedFarm = vehicle ? farmByGameId(id, vehicle.farmId) : null
  const farmName = linkedFarm ? farmDisplayName(linkedFarm, t) : null
  const categoryKey =
    vehicle?.category === "harvester" ? "vehicles.selfpropelled" : vehicle ? `vehicles.${vehicle.category}` : ""

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !equipmentAccess) return <PermissionBlock />
  if (!vehicle && lookup !== "done") {
    return <EmptyState title={t("live.loading")} body={t("farm.discovering")} />
  }
  if (!vehicle) {
    return (
      <EmptyState
        title={t("vehicles.unknownTitle")}
        body={t("vehicles.unknownBody")}
        action={
          <Link className="btn btn-secondary" to={`/w/${id}/equipment`}>
            {t("back")}
          </Link>
        }
      />
    )
  }

  const modKey = vehicle.modKey ?? null
  const modName = modDisplayName(modKey)
  const modZip = modZipLabel(modKey)
  const fileLabel = shortFilename(vehicle.filename)
  const brand = vehicleBrand(vehicle)
  const farmLabel =
    farmName ?? (vehicle.farmId === null ? t("unavailable") : t("vehicles.farmId", { id: vehicle.farmId }))
  const hours =
    vehicle.hours === null
      ? t("unavailable")
      : `${vehicle.hours.toLocaleString(i18n.language, { maximumFractionDigits: 1 })} h`

  return (
    <section className="equip-detail">
      <Link className="equip-back" to={`/w/${id}/equipment`}>
        {t("vehicles.backToList")}
      </Link>

      <article className="equip-sheet">
        <div className="equip-sheet-main">
          <div className="equip-sheet-media" aria-hidden="true">
            {vehicle.iconUrl ? (
              <img className="equip-sheet-vehicle" src={vehicle.iconUrl} alt="" onError={onIconError} />
            ) : null}
            <Tractor className={`icon icon-fallback${vehicle.iconUrl ? " is-hidden" : ""}`} />
            {vehicle.brandIconUrl ? (
              <img
                className="equip-sheet-brand-logo"
                src={vehicle.brandIconUrl}
                alt={brand ?? ""}
                title={brand ?? undefined}
                onError={onBrandIconError}
              />
            ) : null}
          </div>
          <div className="equip-sheet-id">
            {!vehicle.brandIconUrl && brand ? <p className="equip-sheet-brand">{brand}</p> : null}
            <h1>{vehicleDisplayName(vehicle.name)}</h1>
            <p className="equip-kicker">
              {t(categoryKey)}
              <span>·</span>
              {t("vehicles.observed", { time: stamp(vehicle.observedAt, t("unavailable")) })}
            </p>
          </div>
        </div>

        <VehicleGauges vehicle={vehicle} language={i18n.language} label={(key) => t(key)} />

        <dl className="equip-sheet-facts">
          <div>
            <dt>{t("vehicles.brand")}</dt>
            <dd>
              {vehicle.brandIconUrl ? (
                <img
                  className="equip-sheet-brand-logo"
                  src={vehicle.brandIconUrl}
                  alt={brand ?? ""}
                  title={brand ?? undefined}
                  onError={onBrandIconError}
                  style={{ position: "static", height: 22, maxWidth: 140, padding: 0, border: 0, background: "transparent" }}
                />
              ) : (
                <MissingValue text={brand} />
              )}
            </dd>
          </div>
          <div>
            <dt>{t("vehicles.hours")}</dt>
            <dd>{hours}</dd>
          </div>
          <div>
            <dt>{t("vehicles.farm")}</dt>
            <dd>{farmLabel}</dd>
          </div>
          <div>
            <dt>{t("vehicles.position")}</dt>
            <dd>
              <MissingValue text={positionOf(vehicle)} />
            </dd>
          </div>
          {vehicle.plate ? (
            <div>
              <dt>{t("vehicles.plate")}</dt>
              <dd>{vehicle.plate}</dd>
            </div>
          ) : null}
          {fill ? (
            <div>
              <dt>{t("vehicles.fill")}</dt>
              <dd>{fill}</dd>
            </div>
          ) : null}
        </dl>

        <div className="equip-sheet-foot">
          {modKey ? (
            <>
              <span className="equip-mod-icon" aria-hidden="true">
                {vehicle.modIconUrl ? <img src={vehicle.modIconUrl} alt="" onError={onIconError} /> : null}
                <Package className={`icon icon-fallback${vehicle.modIconUrl ? " is-hidden" : ""}`} />
              </span>
              <div className="equip-mod-copy">
                <p className="equip-kicker">{t("vehicles.modTitle")}</p>
                <strong>{modName}</strong>
                <span className="equip-mod-meta">
                  <code>{modZip}</code>
                  {fileLabel ? <span>{fileLabel}</span> : null}
                </span>
                {vehicle.filename ? (
                  <p className="equip-path" title={vehicle.filename}>
                    {vehicle.filename}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="equip-base">{t("vehicles.modBaseHint")}</p>
          )}
        </div>
      </article>
    </section>
  )
}
