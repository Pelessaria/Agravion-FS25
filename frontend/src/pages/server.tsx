import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { ChevronDown, ChevronRight, Copy, Download, Pause, Play, RotateCcw, Square } from "lucide-react"
import {
  apiDownloadServerMod,
  apiSaveServerSettings,
  apiServerAction,
  apiServerSnapshot,
  apiSetServerModActive,
  apiUpdateServerMod,
  apiUploadServerMod,
  ApiError,
  type ServerSettingField,
  type ServerSnapshot,
} from "../api"
import modhubIcon from "../assets/modhub-favicon.png"
import { MissingWorkspace, PermissionBlock } from "../components/ui"
import { useStore } from "../store"
import { useWorkspaceRoute } from "../use-workspace"

type ModSort = "name" | "version" | "author" | "size" | "active"

function Tip({ text, children }: { text?: string; children: ReactNode }) {
  if (!text) return children
  return (
    <span className="btn-tip" title={text}>
      {children}
    </span>
  )
}

function versionParts(value: string): number[] {
  const match = /(\d+(?:\.\d+)*)/.exec(value)
  if (!match) return []
  return match[1].split(".").map((part) => Number(part))
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  const count = Math.max(a.length, b.length)
  for (let index = 0; index < count; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return "—"
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024)
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(2)} MB`
  }
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

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
  const { liveMode, moduleAccess, canManageUsers, pushToast } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "server") : null
  const canWrite = access === "write"
  const [snapshot, setSnapshot] = useState<ServerSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [settings, setSettings] = useState<ServerSettingField[]>([])
  const [modQuery, setModQuery] = useState("")
  const [modsOpen, setModsOpen] = useState(false)
  const [sortKey, setSortKey] = useState<ModSort>("name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [copied, setCopied] = useState(false)

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
    const filtered = needle
      ? snapshot.mods.filter((mod) =>
          [mod.title, mod.name, mod.author, mod.version, mod.hubVersion].some((value) => (value ?? "").toLocaleLowerCase().includes(needle)),
        )
      : snapshot.mods
    const factor = sortDir === "asc" ? 1 : -1
    const label = (mod: (typeof filtered)[number]) => mod.title || mod.name
    return [...filtered].sort((a, b) => {
      const tie = label(a).localeCompare(label(b), "de", { sensitivity: "base" })
      if (sortKey === "name") return label(a).localeCompare(label(b), "de", { sensitivity: "base" }) * factor
      if (sortKey === "author") {
        const left = a.author ?? ""
        const right = b.author ?? ""
        if (left === "" && right !== "") return 1
        if (left !== "" && right === "") return -1
        const diff = left.localeCompare(right, "de", { sensitivity: "base" })
        return (diff === 0 ? tie : diff) * factor
      }
      if (sortKey === "version") {
        if (!a.version && b.version) return 1
        if (a.version && !b.version) return -1
        const diff = compareVersions(a.version ?? "", b.version ?? "")
        return (diff === 0 ? tie : diff) * factor
      }
      if (sortKey === "size") {
        if (a.bytes == null && b.bytes != null) return 1
        if (a.bytes != null && b.bytes == null) return -1
        const diff = (a.bytes ?? 0) - (b.bytes ?? 0)
        return (diff === 0 ? tie : diff) * factor
      }
      const rank = (value: boolean | null | undefined) => (value === true ? 2 : value === false ? 0 : 1)
      const diff = rank(a.active) - rank(b.active)
      return (diff === 0 ? tie : diff) * factor
    })
  }, [modQuery, snapshot.mods, sortDir, sortKey])

  function toggleSort(next: ModSort) {
    if (sortKey === next) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
      return
    }
    setSortKey(next)
    setSortDir("asc")
  }

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

  async function updateMod(name: string) {
    if (!workspace) return
    setBusy(`update:${name}`)
    try {
      const result = await apiUpdateServerMod(workspace.id, name)
      pushToast("ok", result.note || t("server.updateDone"))
      await reload()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("server.updateNeedsStop"))
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
    const text = snapshot.log.text
    let copiedOk = false
    try {
      await navigator.clipboard.writeText(text)
      copiedOk = true
    } catch {
      const area = document.createElement("textarea")
      area.value = text
      area.setAttribute("readonly", "")
      area.style.position = "fixed"
      area.style.left = "-9999px"
      document.body.appendChild(area)
      area.select()
      copiedOk = document.execCommand("copy")
      area.remove()
    }
    if (!copiedOk) {
      pushToast("warn", t("create.copyFailed"))
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
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
        <Tip text={loading ? t("server.refreshBusy") : undefined}>
          <button type="button" className="btn btn-secondary" onClick={() => void reload()} disabled={loading}>
            {loading ? t("server.loading") : t("server.refresh")}
          </button>
        </Tip>
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
            const disabled = !canWrite || !ready || busy !== ""
            const reason = !disabled
              ? undefined
              : !canWrite
                ? t("server.needWrite")
                : busy !== ""
                  ? t("server.busy")
                  : action.id === "start" && snapshot.running === true
                    ? t("server.startWhileRunning")
                    : action.id !== "start" && snapshot.running === false
                      ? t("server.stopWhileStopped")
                      : t("server.actionMissing")
            return (
              <Tip key={action.id} text={reason}>
                <button
                  type="button"
                  className={action.className}
                  disabled={disabled}
                  onClick={() => void run(action.id)}
                >
                  <Icon className="icon" aria-hidden="true" />
                  {t(`server.${action.id}`)}
                </button>
              </Tip>
            )
          })}
        </div>
        {!snapshot.webConfigured ? (
          <p className="hint server-hero-note">
            {t("server.missingLogin")}{" "}
            {canManageUsers() ? <Link to={`/w/${workspace.id}/settings`}>{t("server.openSettings")}</Link> : null}
          </p>
        ) : null}
      </div>

      <div className="panel">
        <div className="server-panel-head">
          <h2>{t("server.mods")}</h2>
          <div className="server-actions">
            <span className="faint">{t("server.modCount", { count: snapshot.mods.length })}</span>
            <button
              type="button"
              className="btn btn-secondary"
              aria-expanded={modsOpen}
              onClick={() => setModsOpen((open) => !open)}
            >
              {modsOpen ? <ChevronDown className="icon" aria-hidden="true" /> : <ChevronRight className="icon" aria-hidden="true" />}
              {modsOpen ? t("server.modsHide") : t("server.modsShow")}
            </button>
          </div>
        </div>
        {!snapshot.ftpConfigured ? <p className="hint">{t("server.missingFiles")}</p> : null}
        <p className="hint">{snapshot.savegameRead ? t("server.savegameKnown") : t("server.savegameUnknown")}</p>
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
          <div className={modsOpen ? "server-mods is-open" : "server-mods"}>
            <table>
              <thead>
                <tr>
                  {(
                    [
                      ["name", t("server.modName")],
                      ["author", t("server.modAuthor")],
                      ["size", t("server.modSize")],
                      ["active", t("server.active")],
                      ["version", t("server.modVersion")],
                    ] as const
                  ).map(([id, label]) => (
                    <th key={id} aria-sort={sortKey === id ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className={id === "version" ? "mod-version" : undefined}>
                      <button type="button" className="sort-btn" onClick={() => toggleSort(id)}>
                        {label}
                        <span className="sort-mark" aria-hidden="true">
                          {sortKey === id ? (sortDir === "asc" ? "↑" : "↓") : ""}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleMods.map((mod) => {
                  const stopped = snapshot.running === false
                  const updateDisabled = !canWrite || !stopped || busy !== ""
                  const updateReason = !mod.updateAvailable
                    ? undefined
                    : !updateDisabled
                      ? undefined
                      : !canWrite
                        ? t("server.needWrite")
                        : busy !== ""
                          ? t("server.busy")
                          : snapshot.running === true
                            ? t("server.updateNeedsStop")
                            : t("server.updateUnknown")
                  const toggleDisabled = busy === mod.name
                  const toggleLabel = mod.active ? t("server.deactivate") : t("server.activate")
                  return (
                    <tr key={mod.name}>
                      <td className="mod-name">
                        <strong>{mod.title || mod.name}</strong>
                        {mod.title ? <span className="mod-file">{mod.name}</span> : null}
                      </td>
                      <td>{mod.author || "—"}</td>
                      <td>{formatBytes(mod.bytes)}</td>
                      <td>
                        <div className="server-mod-meta">
                          <span className={mod.active == null ? "badge is-unknown" : mod.active ? "badge" : "badge is-off"}>
                            {mod.active == null ? t("server.unknownActive") : mod.active ? t("server.active") : t("server.inactive")}
                          </span>
                          {mod.used === false ? <span className="badge is-warn">{t("server.unused")}</span> : null}
                        </div>
                      </td>
                      <td className="mod-version">
                        <div className="mod-version-row">
                          <span className="mod-version-current">{mod.version || "—"}</span>
                          <span className="mod-version-next">{mod.updateAvailable && mod.hubVersion ? mod.hubVersion : ""}</span>
                          <span className="mod-version-rule" aria-hidden="true" />
                          <span className="mod-icon-slot">
                            {mod.hubUrl ? (
                              <a className="btn btn-secondary mod-icon-btn" href={mod.hubUrl} target="_blank" rel="noreferrer" title={t("server.modHub")} aria-label={t("server.modHub")}>
                                <img src={modhubIcon} alt="" width={18} height={18} />
                              </a>
                            ) : null}
                          </span>
                          <span className="mod-icon-slot">
                            {mod.active != null && canWrite ? (
                              <Tip text={toggleDisabled ? t("server.busy") : undefined}>
                                <button
                                  type="button"
                                  className="btn btn-secondary mod-icon-btn"
                                  disabled={toggleDisabled}
                                  aria-label={toggleLabel}
                                  title={toggleDisabled ? undefined : toggleLabel}
                                  onClick={() => void toggleMod(mod.name, mod.active !== true)}
                                >
                                  {mod.active ? <Pause className="icon" aria-hidden="true" /> : <Play className="icon" aria-hidden="true" />}
                                </button>
                              </Tip>
                            ) : null}
                          </span>
                          <span className="mod-icon-slot">
                            {mod.download ? (
                              <button
                                type="button"
                                className="btn btn-secondary mod-icon-btn"
                                aria-label={t("server.download")}
                                title={t("server.download")}
                                onClick={() => void apiDownloadServerMod(workspace.id, mod.name).catch((caught) => setError(caught instanceof ApiError ? caught.message : t("server.missingFiles")))}
                              >
                                <Download className="icon" aria-hidden="true" />
                              </button>
                            ) : null}
                          </span>
                          <span className="mod-update-slot">
                            {mod.updateAvailable ? (
                              <Tip text={updateReason}>
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  disabled={updateDisabled}
                                  onClick={() => void updateMod(mod.name)}
                                >
                                  {busy === `update:${mod.name}` ? t("server.loading") : t("server.update")}
                                </button>
                              </Tip>
                            ) : null}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
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
            <Tip text={busy === "settings" ? t("server.busy") : undefined}>
              <button className="btn btn-primary" type="submit" disabled={busy === "settings"}>
                {t("server.saveSettings")}
              </button>
            </Tip>
          ) : null}
        </form>
      ) : null}

      <div className="panel">
        <div className="server-panel-head">
          <h2>{t("server.log")}</h2>
          <div className="server-actions">
            <Tip text={snapshot.log ? undefined : t("server.noLogTip")}>
              <button type="button" className="btn btn-secondary" disabled={!snapshot.log} onClick={() => void copyLog()}>
                <Copy className="icon" aria-hidden="true" />
                {copied ? t("server.copied") : t("server.copyLog")}
              </button>
            </Tip>
            <Tip text={snapshot.log ? undefined : t("server.noLogTip")}>
              <button type="button" className="btn btn-secondary" disabled={!snapshot.log} onClick={downloadLog}>
                <Download className="icon" aria-hidden="true" />
                {t("server.downloadLog")}
              </button>
            </Tip>
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
