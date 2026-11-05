import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { apiWorkspaceVehicles } from "../api"
import { RequiredModsPanel } from "../components/required-mods"
import { EmptyState, MissingValue, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { APP_MODULES, moduleIsReady } from "../modules"
import { useStore } from "../store"
import type { Vehicle } from "../types"
import { useWorkspaceRoute } from "../use-workspace"

function money(value: number | null, locale: string) {
  if (value === null) return null
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value)
}

export function WorkspaceHomePage() {
  const { t, i18n } = useTranslation()
  const stamp = useTimeLabel()
  const {
    activity,
    liveMode,
    moduleAccess,
    replaceWorkspaceFarms,
    replaceWorkspaceVehicles,
    selectedFarm,
    upsertWorkspace,
    vehicles,
  } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const [feedVehicles, setFeedVehicles] = useState<Vehicle[] | null>(null)
  const [feedBusy, setFeedBusy] = useState(false)

  useEffect(() => {
    if (!workspace || !liveMode || !allowed) return
    let cancelled = false
    setFeedBusy(true)
    void (async () => {
      try {
        const result = await apiWorkspaceVehicles(workspace.id)
        if (cancelled) return
        setFeedVehicles(result.vehicles)
        replaceWorkspaceVehicles(workspace.id, result.vehicles)
        if (result.farms) replaceWorkspaceFarms(workspace.id, result.farms)
        if (result.workspace) upsertWorkspace(result.workspace)
      } catch {
        if (!cancelled) setFeedVehicles([])
      } finally {
        if (!cancelled) setFeedBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace?.id, liveMode, allowed])

  if (!workspace) return <MissingWorkspace />
  if (!allowed) return <PermissionBlock />

  const farm = selectedFarm(workspace.id)
  const notice = workspace.disabled ? "disabled" : workspace.notice
  const shortcuts = APP_MODULES.filter((module) => moduleAccess(workspace.id, module.id))
  const farmVehicles = (() => {
    const source = liveMode ? (feedVehicles ?? vehicles) : vehicles
    return source.filter((item) => {
      if (item.workspaceId !== workspace.id) return false
      if (!farm) return true
      return item.farmId !== null && Number(item.farmId) === Number(farm.gameFarmId)
    })
  })()
  const equipmentCount = liveMode
    ? feedVehicles === null && feedBusy
      ? null
      : farmVehicles.length
    : farmVehicles.length
  const entries = activity
    .filter((item) => item.workspaceId === workspace.id)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 5)

  // Live instances: show server-level dash even without savegame farms yet.
  if (!farm && !liveMode) {
    return (
      <section>
        <div className="page-head">
          <div>
            <h1>{workspace.name}</h1>
            <p>{t("workspace.lead")}</p>
          </div>
        </div>
        <EmptyState title={t("farm.noneTitle")} body={t("farm.noneBody")} />
      </section>
    )
  }

  return (
    <section className="ws-dash">
      {notice ? <p className="notice">{t(`notice.${notice}`)}</p> : null}
      <div className="fields-mast">
      <div className="fields-stats">
        <p>
          <strong>
            <MissingValue
              text={
                workspace.playersOnline == null && workspace.playerCapacity == null
                  ? null
                  : `${workspace.playersOnline ?? "—"} / ${workspace.playerCapacity ?? "—"}`
              }
            />
          </strong>
          <span>{t("workspace.players")}</span>
        </p>
        <p>
          <strong>
            <MissingValue text={workspace.mapName} />
          </strong>
          <span>{t("workspace.map")}</span>
        </p>
        <p>
          <strong>
            <MissingValue text={workspace.gameTime} />
          </strong>
          <span>{t("workspace.gameTime")}</span>
          <em>
            <MissingValue text={workspace.gameVersion ?? null} />
          </em>
        </p>
        <p>
          <strong>
            <MissingValue text={equipmentCount === null ? null : String(equipmentCount)} />
          </strong>
          <span>{t("modules.equipment")}</span>
          <em>{t("farm.equipmentHint")}</em>
        </p>
        {farm ? (
          <>
            <p>
              <strong>
                <MissingValue text={money(farm.money, i18n.language)} />
              </strong>
              <span>{t("workspace.balance")}</span>
            </p>
          </>
        ) : null}
      </div>
      </div>

      {liveMode && feedVehicles && feedVehicles.length > 0 ? (
        <section className="panel ws-feed-vehicles">
          <h2>{t("modules.equipment")}</h2>
          <p className="hint">{t("vehicles.lead")}</p>
          <ul className="activity">
            {feedVehicles.slice(0, 12).map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                <span className="faint">{t(`vehicles.${item.category}`)}</span>
              </li>
            ))}
          </ul>
          {feedVehicles.length > 12 ? (
            <p className="muted">
              <Link to={`/w/${workspace.id}/equipment`}>{t("workspace.openVehicles")}</Link>
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="ws-dash-grid">
        <section className="panel">
          <h2>{t("workspace.shortcuts")}</h2>
          <p className="hint">{t("workspace.shortcutsLead")}</p>
          {shortcuts.length === 0 ? <p className="muted">{t("workspace.shortcutsEmpty")}</p> : null}
          <div className="ws-module-grid">
            {shortcuts.map((module) =>
              moduleIsReady(module.id) ? (
                <Link key={module.id} className="ws-module-link" to={`/w/${workspace.id}/${module.path}`}>
                  <strong>{t(module.labelKey)}</strong>
                  <span className="faint">{t("workspace.openModule")}</span>
                </Link>
              ) : (
                <span key={module.id} className="ws-module-link is-unavailable" aria-disabled="true">
                  <strong>{t(module.labelKey)}</strong>
                  <span className="faint">{t("modules.unavailable")}</span>
                </span>
              ),
            )}
          </div>
        </section>

        <section className="panel">
          <h2>{t("workspace.activity")}</h2>
          <p className="hint">{t("workspace.activityLead")}</p>
          {entries.length === 0 ? <p className="muted">{t("workspace.activityEmpty")}</p> : null}
          <ul className="activity">
            {entries.map((item) => (
              <li key={item.id}>
                <span>{t(`activity.${item.key}`)}</span>
                <span className="faint">{stamp(item.at, t("unavailable"))}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {liveMode ? (
        <RequiredModsPanel workspaceId={workspace.id} settingsPath={`/w/${workspace.id}/settings`} />
      ) : null}
    </section>
  )
}
