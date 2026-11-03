import { useEffect, useMemo, useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { Copy, Download, Play, RotateCcw, Square } from "lucide-react"
import {
  apiDownloadServerMod,
  apiSaveServerLogin,
  apiSaveServerSettings,
  apiServerAction,
  apiServerSnapshot,
  apiSetServerModActive,
  apiUploadServerMod,
  ApiError,
  type ServerSettingField,
  type ServerSnapshot,
} from "../api"
import { MissingWorkspace, PermissionBlock } from "../components/ui"
import { useStore } from "../store"
import { useWorkspaceRoute } from "../use-workspace"

const EMPTY_SNAPSHOT: ServerSnapshot = {
  webConfigured: false,
  ftpConfigured: false,
  loggedIn: false,
  actions: [],
  mods: [],
  settings: [],
  log: null,
  error: null,
}

function feedOrigin(value: string): string {
  const raw = value.trim()
  if (!raw) return ""
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`)
    if (url.protocol !== "http:" && url.protocol !== "https:") return ""
    return url.origin
  } catch {
    return ""
  }
}

export function ServerPage() {
  const { t } = useTranslation()
  const { liveMode, moduleAccess, canManageUsers, upsertWorkspace, pushToast } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "server") : null
  const canWrite = access === "write"
  const admin = canManageUsers()
  const [snapshot, setSnapshot] = useState<ServerSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [loginDraft, setLoginDraft] = useState<{ id: string; username: string; password: string } | null>(null)
  const [settings, setSettings] = useState<ServerSettingField[]>([])
  const [modQuery, setModQuery] = useState("")
  const [copied, setCopied] = useState(false)

  const login =
    workspace && loginDraft?.id === workspace.id
      ? loginDraft
      : {
          id: workspace?.id ?? "",
          username: workspace?.console?.username ?? "",
          password: "",
        }
  const origin = feedOrigin(workspace?.feedUrl ?? workspace?.console?.baseUrl ?? "")

  useEffect(() => {
    if (!workspace || !allowed || !access || !liveMode) return
    let cancelled = false
    const load = async (silent: boolean) => {
      if (!silent) setLoading(true)
      try {
        const next = await apiServerSnapshot(workspace.id)
        if (cancelled) return
        setSnapshot(next)
        if (!silent) setSettings(next.settings)
        setError(next.error ?? "")
      } catch (caught) {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : t("server.missingLogin"))
      } finally {
        if (!silent && !cancelled) setLoading(false)
      }
    }
    void load(false)
    const timer = window.setInterval(() => void load(true), 20000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [access, allowed, liveMode, t, workspace])

  const visibleMods = useMemo(() => {
    const needle = modQuery.trim().toLocaleLowerCase()
    if (!needle) return snapshot.mods
    return snapshot.mods.filter((mod) => mod.name.toLocaleLowerCase().includes(needle))
  }, [modQuery, snapshot.mods])

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !access) return <PermissionBlock />
  if (!liveMode) {
    return (
      <section className="page">
        <div className="page-head">
          <div>
            <h1>{t("modules.server")}</h1>
            <p>{t("server.demo")}</p>
          </div>
        </div>
      </section>
    )
  }

  async function reload() {
    if (!workspace) return
    setLoading(true)
    try {
      const next = await apiServerSnapshot(workspace.id)
      setSnapshot(next)
      setSettings(next.settings)
      setError(next.error ?? "")
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("server.missingLogin"))
    } finally {
      setLoading(false)
    }
  }

  async function saveLogin(event: FormEvent) {
    event.preventDefault()
    if (!workspace) return
    const keepPassword = login.password === "" && Boolean(workspace.console?.hasPassword)
    if (!login.username.trim() || (!keepPassword && login.password === "")) {
      setError(t("server.loginRequired"))
      return
    }
    setBusy("login")
    try {
      const result = await apiSaveServerLogin(workspace.id, {
        username: login.username.trim(),
        password: login.password || undefined,
        keepPassword,
      })
      upsertWorkspace({ ...workspace, console: result.console })
      setLoginDraft(null)
      setError("")
      await reload()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("server.loginRequired"))
    } finally {
      setBusy("")
    }
  }

  async function run(action: "start" | "stop" | "restart") {
    if (!workspace) return
    setBusy(action)
    try {
      await apiServerAction(workspace.id, action)
      await reload()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("server.actionMissing"))
    } finally {
      setBusy("")
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault()
    if (!workspace) return
    setBusy("settings")
    const values: Record<string, string | boolean> = {}
    for (const field of settings) {
      values[field.name] = field.type === "checkbox" ? field.value === "1" : field.value
    }
    try {
      await apiSaveServerSettings(workspace.id, values)
      await reload()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("server.actionMissing"))
    } finally {
      setBusy("")
    }
  }

  async function upload(file: File | undefined) {
    if (!workspace || !file) return
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError(t("server.zipOnly"))
      return
    }
    if (file.size > 80 * 1024 * 1024) {
      setError(t("server.tooLarge"))
      return
    }
    setBusy("upload")
    try {
      await apiUploadServerMod(workspace.id, file)
      await reload()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("server.missingFiles"))
    } finally {
      setBusy("")
    }
  }

  async function toggleMod(name: string, active: boolean) {
    if (!workspace) return
    setBusy(name)
    try {
      await apiSetServerModActive(workspace.id, name, active)
      await reload()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("server.actionMissing"))
    } finally {
      setBusy("")
    }
  }

  async function copyLog() {
    if (!snapshot.log?.text) return
    try {
      await navigator.clipboard.writeText(snapshot.log.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      pushToast("warn", t("create.copyFailed"))
    }
  }

  function downloadLog() {
    if (!snapshot.log?.text) return
    const blob = new Blob([snapshot.log.text], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    const rawName = snapshot.log.name && snapshot.log.name !== "log" ? snapshot.log.name : "server-log.txt"
    anchor.href = url
    anchor.download = /\.(txt|log)$/i.test(rawName) ? rawName : `${rawName}.txt`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const actionIds = new Set(snapshot.actions.map((action) => action.id))
  const stamp = snapshot.at ? new Date(snapshot.at) : null
  const stampText = stamp && !Number.isNaN(stamp.getTime()) ? stamp.toLocaleString() : snapshot.at
  const stateLabel = snapshot.running === true ? t("server.running") : snapshot.running === false ? t("server.stopped") : t("server.pending")
  const actions = [
    { id: "start" as const, icon: Play, className: "btn btn-primary" },
    { id: "stop" as const, icon: Square, className: "btn btn-danger" },
    { id: "restart" as const, icon: RotateCcw, className: "btn btn-secondary" },
  ]

  return (
    <section className="page server-page">
      <div className="page-head">
        <div>
          <h1>{t("modules.server")}</h1>
          <p>{t("server.lead")}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => void reload()} disabled={loading}>
          {loading ? t("server.loading") : t("server.refresh")}
        </button>
      </div>
      {error ? <p className="field-error">{error}</p> : null}

      <div className="panel server-hero">
        <div className="server-state">
          <span className={`dot ${snapshot.running === true ? "online" : snapshot.running === false ? "offline" : "unknown"}`} />
          <div>
            <strong>{stateLabel}</strong>
            {stampText && !snapshot.pending ? <span className="faint">{t("server.cachedAt", { time: stampText })}</span> : null}
          </div>
        </div>
        <div className="server-actions">
          {actions.map((action) => {
            const Icon = action.icon
            const ready = actionIds.has(action.id)
            return (
              <button
                key={action.id}
                type="button"
                className={action.className}
                disabled={!canWrite || !ready || busy !== ""}
                title={ready ? undefined : t("server.actionMissing")}
                onClick={() => void run(action.id)}
              >
                <Icon className="icon" aria-hidden="true" />
                {t(`server.${action.id}`)}
              </button>
            )
          })}
        </div>
        {!snapshot.webConfigured ? <p className="hint server-hero-note">{t("server.missingLogin")}</p> : null}
      </div>

      {admin ? (
        <form className="panel" onSubmit={(event) => void saveLogin(event)}>
          <div className="server-panel-head">
            <h2>{t("server.loginTitle")}</h2>
          </div>
          <p className="hint">{t("server.loginHint")}</p>
          <p className="server-origin">
            <span>{t("server.detectedUrl")}</span>
            <strong>{origin || t("server.detectedMissing")}</strong>
          </p>
          <div className="server-login-grid">
            <label className="field">
              <span>{t("server.username")}</span>
              <input value={login.username} autoComplete="off" onChange={(event) => setLoginDraft({ ...login, username: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("server.password")}</span>
              <input
                type="password"
                value={login.password}
                autoComplete="new-password"
                placeholder={workspace.console?.hasPassword ? t("server.keepPassword") : ""}
                onChange={(event) => setLoginDraft({ ...login, password: event.target.value })}
              />
            </label>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy === "login"}>
            {t("server.saveLogin")}
          </button>
        </form>
      ) : null}

      <div className="panel">
        <div className="server-panel-head">
          <h2>{t("server.mods")}</h2>
          <span className="faint">{t("server.modCount", { count: visibleMods.length })}</span>
        </div>
        {!snapshot.ftpConfigured ? <p className="hint">{t("server.missingFiles")}</p> : null}
        <div className="server-toolbar">
          <input
            value={modQuery}
            placeholder={t("server.modSearch")}
            onChange={(event) => setModQuery(event.target.value)}
          />
          {canWrite ? (
            <label className="btn btn-secondary">
              {busy === "upload" ? t("server.loading") : t("server.upload")}
              <input
                className="sr-only"
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ""
                  void upload(file)
                }}
              />
            </label>
          ) : null}
        </div>
        {visibleMods.length === 0 ? (
          <p className="muted">{t("server.noMods")}</p>
        ) : (
          <div className="server-mods">
            <table>
              <thead>
                <tr>
                  <th>{t("server.mods")}</th>
                  <th>{t("server.active")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleMods.map((mod) => (
                  <tr key={mod.name}>
                    <td>{mod.name}</td>
                    <td>
                      <span className={mod.active == null ? "badge is-unknown" : mod.active ? "badge" : "badge is-off"}>
                        {mod.active == null ? t("server.unknownActive") : mod.active ? t("server.active") : t("server.inactive")}
                      </span>
                    </td>
                    <td>
                      <div className="server-mod-actions">
                        {mod.active != null && canWrite ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy === mod.name}
                            onClick={() => void toggleMod(mod.name, !mod.active)}
                          >
                            {mod.active ? t("server.inactive") : t("server.active")}
                          </button>
                        ) : null}
                        {mod.download ? (
                          <button type="button" className="btn btn-secondary" onClick={() => void apiDownloadServerMod(workspace.id, mod.name).catch((caught) => setError(caught instanceof ApiError ? caught.message : t("server.missingFiles")))}>
                            {t("server.download")}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {settings.length > 0 ? (
        <form className="panel" onSubmit={(event) => void saveSettings(event)}>
          <div className="server-panel-head">
            <h2>{t("server.settings")}</h2>
          </div>
          <div className="server-settings">
            {settings.map((field) => (
              <label key={field.name} className={field.type === "checkbox" ? "check-row" : "field"}>
                {field.type === "checkbox" ? (
                  <input
                    type="checkbox"
                    checked={field.value === "1"}
                    disabled={!canWrite}
                    onChange={(event) =>
                      setSettings((current) =>
                        current.map((item) => (item.name === field.name ? { ...item, value: event.target.checked ? "1" : "0" } : item)),
                      )
                    }
                  />
                ) : null}
                <span>{field.label}</span>
                {field.type === "select" ? (
                  <select
                    value={field.value}
                    disabled={!canWrite}
                    onChange={(event) =>
                      setSettings((current) => current.map((item) => (item.name === field.name ? { ...item, value: event.target.value } : item)))
                    }
                  >
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : field.type !== "checkbox" ? (
                  <input
                    value={field.value}
                    disabled={!canWrite}
                    onChange={(event) =>
                      setSettings((current) => current.map((item) => (item.name === field.name ? { ...item, value: event.target.value } : item)))
                    }
                  />
                ) : null}
              </label>
            ))}
          </div>
          {canWrite ? (
            <button className="btn btn-primary" type="submit" disabled={busy === "settings"}>
              {t("server.saveSettings")}
            </button>
          ) : null}
        </form>
      ) : null}

      <div className="panel">
        <div className="server-panel-head">
          <h2>{t("server.log")}</h2>
          <div className="server-actions">
            <button type="button" className="btn btn-secondary" disabled={!snapshot.log} onClick={() => void copyLog()}>
              <Copy className="icon" aria-hidden="true" />
              {copied ? t("server.copied") : t("server.copyLog")}
            </button>
            <button type="button" className="btn btn-secondary" disabled={!snapshot.log} onClick={downloadLog}>
              <Download className="icon" aria-hidden="true" />
              {t("server.downloadLog")}
            </button>
          </div>
        </div>
        {snapshot.log ? (
          <pre className="update-log-pre server-log">{snapshot.log.text}</pre>
        ) : (
          <p className="muted">{t("server.noLog")}</p>
        )}
      </div>
    </section>
  )
}
