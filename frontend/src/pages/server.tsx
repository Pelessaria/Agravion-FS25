import { useEffect, useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import {
  apiDownloadServerMod,
  apiSaveServerAccess,
  apiSaveServerLogin,
  apiSaveServerSettings,
  apiServerAccess,
  apiServerAction,
  apiServerSnapshot,
  apiSetServerModActive,
  apiUploadServerMod,
  ApiError,
  type ServerAccessUser,
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

export function ServerPage() {
  const { t } = useTranslation()
  const { liveMode, moduleAccess, canManageUsers, upsertWorkspace } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "server") : null
  const canWrite = access === "write"
  const admin = canManageUsers()
  const [snapshot, setSnapshot] = useState<ServerSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [loginDraft, setLoginDraft] = useState<{ id: string; baseUrl: string; username: string; password: string } | null>(null)
  const [settings, setSettings] = useState<ServerSettingField[]>([])
  const [people, setPeople] = useState<ServerAccessUser[]>([])

  const login =
    workspace && loginDraft?.id === workspace.id
      ? loginDraft
      : {
          id: workspace?.id ?? "",
          baseUrl: workspace?.console?.baseUrl ?? "",
          username: workspace?.console?.username ?? "",
          password: "",
        }

  useEffect(() => {
    if (!workspace || !allowed || !access || !liveMode) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const next = await apiServerSnapshot(workspace.id)
        if (cancelled) return
        setSnapshot(next)
        setSettings(next.settings)
        setError(next.error ?? "")
      } catch (caught) {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : t("server.missingLogin"))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [access, allowed, liveMode, t, workspace])

  useEffect(() => {
    if (!workspace || !liveMode || !admin) return
    let cancelled = false
    void apiServerAccess(workspace.id)
      .then((result) => {
        if (!cancelled) setPeople(result.users)
      })
      .catch(() => {
        if (!cancelled) setPeople([])
      })
    return () => {
      cancelled = true
    }
  }, [admin, liveMode, workspace])

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
        baseUrl: login.baseUrl.trim(),
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

  async function changeAccess(userId: string, value: string) {
    if (!workspace) return
    const next = value === "read" || value === "write" ? value : "none"
    setBusy(`access-${userId}`)
    try {
      await apiSaveServerAccess(workspace.id, userId, next)
      setPeople((current) =>
        current.map((person) => (person.id === userId ? { ...person, access: next === "none" ? null : next } : person)),
      )
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("server.accessSaved"))
    } finally {
      setBusy("")
    }
  }

  const actionIds = new Set(snapshot.actions.map((action) => action.id))

  return (
    <section className="page">
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

      {admin ? (
        <form className="panel" onSubmit={(event) => void saveLogin(event)}>
          <h2>{t("server.loginTitle")}</h2>
          <p className="hint">{t("server.loginHint")}</p>
          <div className="grid-2">
            <label className="field">
              <span>{t("server.baseUrl")}</span>
              <input value={login.baseUrl} autoComplete="off" spellCheck={false} onChange={(event) => setLoginDraft({ ...login, baseUrl: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("server.username")}</span>
              <input value={login.username} autoComplete="off" onChange={(event) => setLoginDraft({ ...login, username: event.target.value })} />
            </label>
          </div>
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
          <button className="btn btn-primary" type="submit" disabled={busy === "login"}>
            {t("server.saveLogin")}
          </button>
        </form>
      ) : null}

      <div className="panel">
        <h2>{t("modules.server")}</h2>
        {!snapshot.webConfigured ? <p className="hint">{t("server.missingLogin")}</p> : null}
        <div className="setting-actions">
          {(["start", "stop", "restart"] as const).map((id) => (
            <button
              key={id}
              type="button"
              className="btn"
              disabled={!canWrite || !actionIds.has(id) || busy !== ""}
              title={actionIds.has(id) ? undefined : t("server.actionMissing")}
              onClick={() => void run(id)}
            >
              {t(`server.${id}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2>{t("server.mods")}</h2>
        {!snapshot.ftpConfigured ? <p className="hint">{t("server.missingFiles")}</p> : null}
        {canWrite ? (
          <label className="btn btn-secondary">
            {t("server.upload")}
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
        {snapshot.mods.length === 0 ? (
          <p className="muted">{t("server.noMods")}</p>
        ) : (
          <table>
            <tbody>
              {snapshot.mods.map((mod) => (
                <tr key={mod.name}>
                  <td>{mod.name}</td>
                  <td>
                    {mod.active == null
                      ? t("server.unknownActive")
                      : mod.active
                        ? t("server.active")
                        : t("server.inactive")}
                  </td>
                  <td>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {settings.length > 0 ? (
        <form className="panel" onSubmit={(event) => void saveSettings(event)}>
          <h2>{t("server.settings")}</h2>
          {settings.map((field) => (
            <label key={field.name} className="field">
              <span>{field.label}</span>
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
              ) : field.type === "select" ? (
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
              ) : (
                <input
                  value={field.value}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setSettings((current) => current.map((item) => (item.name === field.name ? { ...item, value: event.target.value } : item)))
                  }
                />
              )}
            </label>
          ))}
          {canWrite ? (
            <button className="btn btn-primary" type="submit" disabled={busy === "settings"}>
              {t("server.saveSettings")}
            </button>
          ) : null}
        </form>
      ) : null}

      <div className="panel">
        <h2>{t("server.log")}</h2>
        {snapshot.log ? (
          <pre className="update-log-pre">{snapshot.log.text}</pre>
        ) : (
          <p className="muted">{t("server.noLog")}</p>
        )}
      </div>

      {admin ? (
        <div className="panel">
          <h2>{t("server.access")}</h2>
          <p className="hint">{t("server.accessHint")}</p>
          <table>
            <tbody>
              {people.map((person) => (
                <tr key={person.id}>
                  <td>
                    {person.name}
                    <span className="hint"> {person.email}</span>
                  </td>
                  <td>
                    {person.admin ? (
                      t("server.accessWrite")
                    ) : (
                      <select
                        value={person.access ?? "none"}
                        disabled={busy === `access-${person.id}`}
                        onChange={(event) => void changeAccess(person.id, event.target.value)}
                      >
                        <option value="none">{t("server.accessNone")}</option>
                        <option value="read">{t("server.accessRead")}</option>
                        <option value="write">{t("server.accessWrite")}</option>
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
