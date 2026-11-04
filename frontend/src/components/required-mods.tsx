import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { LoaderCircle, RefreshCw } from "lucide-react"
import { apiRequiredMods, type RequiredModStatus, type RequiredModsResponse } from "../api"

export function RequiredModsPanel({
  workspaceId,
  settingsPath,
  compact,
}: {
  workspaceId: string
  settingsPath: string
  compact?: boolean
}) {
  const { t } = useTranslation()
  const [data, setData] = useState<RequiredModsResponse | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async (fresh = false) => {
    setBusy(true)
    setError(false)
    try {
      const result = await apiRequiredMods(workspaceId, fresh)
      setData(result)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await apiRequiredMods(workspaceId)
        if (!cancelled) setData(result)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  function statusLabel(mod: RequiredModStatus) {
    if (mod.updateAvailable) {
      return t("wsettings.requiredModsUpdateAvailable", {
        package: mod.packageVersion ?? "—",
        running: mod.runningVersion ?? "—",
      })
    }
    if (mod.status === "active") {
      return mod.packageVersion
        ? t("wsettings.requiredModsUpToDate")
        : t("wsettings.requiredModsActive")
    }
    if (mod.status === "installed") return t("wsettings.requiredModsOnlyInstalled")
    return t("wsettings.requiredModsMissing")
  }

  return (
    <section className={compact ? "req-mods compact" : "req-mods"}>
      <header className="req-mods-head">
        <div>
          <h2>{t("wsettings.requiredModsTitle")}</h2>
          {!compact ? <p className="hint">{t("wsettings.requiredModsLead")}</p> : null}
        </div>
        <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => void load(true)}>
          {busy ? <LoaderCircle className="icon spin" /> : <RefreshCw className="icon" />}
          {t("wsettings.requiredModsRefresh")}
        </button>
      </header>

      {busy && !data ? <p className="muted">{t("wsettings.requiredModsChecking")}</p> : null}
      {error ? <p className="field-error">{t("wsettings.connectorDeployFail")}</p> : null}
      {data && !data.hostAccess ? <p className="hint">{t("wsettings.requiredModsNoHost")}</p> : null}

      {data ? (
        <div className="req-mods-table" role="table">
          <div className="req-mods-row head" role="row">
            <span role="columnheader">{t("wsettings.requiredModsColMod")}</span>
            <span role="columnheader">{t("wsettings.requiredModsInstalled")}</span>
            <span role="columnheader">{t("wsettings.requiredModsActivated")}</span>
            <span role="columnheader">{t("wsettings.requiredModsColStatus")}</span>
          </div>
          {data.mods.map((mod) => (
            <div key={mod.id} className={`req-mods-row status-${mod.status}`} role="row">
              <div className="req-mods-name" role="cell">
                <strong>{mod.title}</strong>
                <span className="faint">
                  {[
                    mod.runningVersion
                      ? t("wsettings.requiredModsVersion", { version: mod.runningVersion })
                      : null,
                    mod.packageVersion
                      ? t("wsettings.requiredModsPackage", { version: mod.packageVersion })
                      : null,
                    mod.installedPath,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <span className={mod.installed ? "flag ok" : "flag"} role="cell">
                {mod.installed ? t("yes") : t("no")}
              </span>
              <span className={mod.activated ? "flag ok" : "flag"} role="cell">
                {mod.activated ? t("yes") : t("no")}
              </span>
              <span
                className={`flag status-${mod.status}${mod.updateAvailable ? " status-update" : ""}`}
                role="cell"
              >
                {statusLabel(mod)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <p className="req-mods-foot muted">
        <Link to={settingsPath}>{t("wsettings.requiredModsOpenPackage")}</Link>
      </p>
    </section>
  )
}
