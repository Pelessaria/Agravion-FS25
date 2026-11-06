import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { Clock3, Map as MapIcon, Tag, Users, Wallet } from "lucide-react"
import { RequiredModsPanel } from "../components/required-mods"
import { EmptyState, MissingValue, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { APP_MODULES, moduleIsReady } from "../modules"
import { useStore } from "../store"
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
  const { activity, liveMode, moduleAccess, selectedFarm } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()

  if (!workspace) return <MissingWorkspace />
  if (!allowed) return <PermissionBlock />

  const farm = selectedFarm(workspace.id)
  const notice = workspace.disabled ? "disabled" : workspace.notice
  const shortcuts = APP_MODULES.filter((module) => moduleAccess(workspace.id, module.id))
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
            <Users className="fields-stat-icon" aria-hidden="true" />
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
            <Tag className="fields-stat-icon" aria-hidden="true" />
            <strong>
              <MissingValue text={workspace.gameVersion ?? null} />
            </strong>
            <span>{t("workspace.gameVersion")}</span>
          </p>
          <p>
            <MapIcon className="fields-stat-icon" aria-hidden="true" />
            <strong>
              <MissingValue text={workspace.mapName} />
            </strong>
            <span>{t("workspace.map")}</span>
          </p>
          <p>
            <Clock3 className="fields-stat-icon" aria-hidden="true" />
            <strong>
              <MissingValue text={workspace.gameTime} />
            </strong>
            <span>{t("workspace.gameTime")}</span>
          </p>
          {farm ? (
            <p>
              <Wallet className="fields-stat-icon" aria-hidden="true" />
              <strong>
                <MissingValue text={money(farm.money, i18n.language)} />
              </strong>
              <span>{t("workspace.balance")}</span>
            </p>
          ) : null}
          <p>
            <Clock3 className="fields-stat-icon" aria-hidden="true" />
            <strong>
              <MissingValue
                text={workspace.lastSyncAt ? stamp(workspace.lastSyncAt, t("unavailable")) : null}
              />
            </strong>
            <span>{t("workspace.asOf")}</span>
          </p>
        </div>
      </div>

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
