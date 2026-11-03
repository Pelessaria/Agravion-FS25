import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { ChevronDown, ChevronRight, Copy, Download, Link2, Pause, Play, RotateCcw, Search, Square, Trash2 } from "lucide-react"
import {
  apiDeleteServerMods,
  apiDownloadServerMod,
  apiDownloadServerMods,
  apiSaveServerSettings,
  apiServerAction,
  apiServerSnapshot,
  apiSetServerModActive,
  apiUpdateServerMod,
  apiUpdateServerMods,
  apiUploadServerMod,
  ApiError,
  type ServerSettingField,
  type ServerSnapshot,
} from "../api"
import modhubIcon from "../assets/modhub-favicon.png"
import { MissingWorkspace, Modal, PermissionBlock } from "../components/ui"
import { serverCapabilities } from "../modules"
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
  const caps = serverCapabilities(access)
  const canWrite = caps.control
  const canMods = caps.mods
  const canLog = caps.log
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
  const [selected, setSelected] = useState<string[]>([])
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState<string[] | null>(null)
  const [downloading, setDownloading] = useState("")
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!workspace || !allowed || !access || !liveMode) return
    let cancelled = false
    const load = async (silent: boolean) => {
      if (!silent) setLoading(true)
      try {
        const next = await apiServerSnapshot(workspace.id)
        if (cancelled) return
        setSnapshot(next)
        if (!silent) {
          setSettings(next.settings)
          setError(next.error ?? "")
        } else if (next.error) {
          setError(next.error)
        }
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

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const selectedMods = snapshot.mods.filter((mod) => selectedSet.has(mod.name))
  const selectedUpdatable = selectedMods.filter((mod) => mod.updateAvailable)
  const selectedDownloadable = selectedMods.filter((mod) => mod.download)
  const visibleSelected = visibleMods.filter((mod) => selectedSet.has(mod.name)).length
  const allVisibleSelected = visibleMods.length > 0 && visibleSelected === visibleMods.length

  function toggleSelected(name: string) {
    setSelected((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]))
  }

  function toggleVisible(on: boolean) {
    const visible = new Set(visibleMods.map((mod) => mod.name))
    setSelected((current) => (on ? [...new Set([...current, ...visible])] : current.filter((name) => !visible.has(name))))
  }

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
    setError("")
    const wantRunning = action !== "stop"
    try {
      await apiServerAction(workspace.id, action)
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const next = await apiServerSnapshot(workspace.id)
        if (!alive.current) return
        setSnapshot(next)
        setSettings(next.settings)
        setError(next.error ?? "")
        if (next.running === wantRunning) break
        await new Promise((resolve) => window.setTimeout(resolve, 3000))
      }
    } catch (caught) {
      if (alive.current) setError(caught instanceof ApiError ? caught.message : t("server.actionMissing"))
    } finally {
      if (alive.current) setBusy("")
    }
  }

  async function downloadMod(name: string) {
    await downloadMods([name])
  }

  async function downloadMods(names: string[]) {
    if (!workspace || names.length === 0) return
    setDownloading(names.length === 1 ? names[0] : "many")
    setError("")
    try {
      if (names.length === 1) await apiDownloadServerMod(workspace.id, names[0])
      else await apiDownloadServerMods(workspace.id, names)
    } catch (caught) {
      if (alive.current) setError(caught instanceof ApiError ? caught.message : t("server.missingFiles"))
    } finally {
      if (alive.current) setDownloading("")
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

  async function removeMods(names: string[]) {
    if (!workspace || names.length === 0) return
    setBusy("delete")
    try {
      const result = await apiDeleteServerMods(workspace.id, names)
      pushToast("ok", t("server.deleteDone", { count: result.deleted }))
      setSelected((current) => current.filter((name) => !names.includes(name)))
      setPendingDelete(null)
      await reload()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("server.deleteNeedsStop"))
      setPendingDelete(null)
    } finally {
      setBusy("")
    }
  }

  async function updateMods(names: string[]) {
    if (!workspace || names.length === 0) return
    setBusy("update-many")
    setError("")
    try {
      const result = await apiUpdateServerMods(workspace.id, names)
      if (!alive.current) return
      pushToast("ok", result.updated === 1 ? t("server.updateOneDone") : t("server.updateManyDone", { count: result.updated }))
      if (result.failed.length > 0) setError(result.failed.map((item) => `${item.name}: ${item.error}`).join(" "))
      setSelected((current) => current.filter((name) => !names.includes(name) || result.failed.some((item) => item.name === name)))
      setPendingUpdate(null)
      await reload()
    } catch (caught) {
      if (alive.current) setError(caught instanceof ApiError ? caught.message : t("server.updateManyFailed"))
      setPendingUpdate(null)
    } finally {
      if (alive.current) setBusy("")
    }
  }

  async function toggleMod(name: string, active: boolean) {
    if (!workspace) return
    setBusy(name)
    try {
      await apiSetServerModActive(workspace.id, name, active)
      await reload()
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : t("server.actionMissing")
      setError(message)
      pushToast("warn", message)
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
        {canWrite ? <div className="server-actions">
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
        </div> : null}
        {canWrite && !snapshot.webConfigured ? (
          <p className="hint server-hero-note">
            {t("server.missingLogin")}{" "}
            {canManageUsers() ? <Link to={`/w/${workspace.id}/settings`}>{t("server.openSettings")}</Link> : null}
          </p>
        ) : null}
      </div>

      {canMods ? <div className="panel">
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
          <label className="mod-search">
            <Search className="icon" aria-hidden="true" />
            <input
              value={modQuery}
              placeholder={t("server.modSearch")}
              onChange={(event) => setModQuery(event.target.value)}
            />
          </label>
          <div className="server-toolbar-actions">
          <Tip
            text={
              selectedDownloadable.length === 0
                ? selected.length > 0
                  ? t("server.missingFiles")
                  : undefined
                : downloading !== ""
                  ? t("server.downloadBusy")
                  : undefined
            }
          >
            <button
              type="button"
              className="btn btn-secondary"
              disabled={selectedDownloadable.length === 0 || downloading !== ""}
              onClick={() => void downloadMods(selectedDownloadable.map((mod) => mod.name))}
            >
              <Download className="icon" aria-hidden="true" />
              {downloading === "many" ? t("server.loading") : t("server.download")}
              {selectedDownloadable.length > 0 ? ` (${selectedDownloadable.length})` : ""}
            </button>
          </Tip>
          {canWrite ? (
            <Tip
              text={
                selectedUpdatable.length === 0
                  ? selected.length > 0
                    ? t("server.updateManyNone")
                    : undefined
                  : snapshot.running !== false
                    ? t("server.updateNeedsStop")
                    : busy !== ""
                      ? t("server.busy")
                      : undefined
              }
            >
              <button
                type="button"
                className="btn btn-primary"
                disabled={selectedUpdatable.length === 0 || snapshot.running !== false || busy !== ""}
                onClick={() => setPendingUpdate(selectedUpdatable.map((mod) => mod.name))}
              >
                {busy === "update-many" ? t("server.loading") : t("server.update")}
                {selectedUpdatable.length > 0 ? ` (${selectedUpdatable.length})` : ""}
              </button>
            </Tip>
          ) : null}
          {canWrite ? (
            <Tip
              text={
                selected.length === 0
                  ? undefined
                  : !snapshot.ftpConfigured
                    ? t("server.deleteNeedsFiles")
                    : snapshot.running !== false
                      ? t("server.deleteNeedsStop")
                      : busy !== ""
                        ? t("server.busy")
                        : undefined
              }
            >
              <button
                type="button"
                className="btn btn-danger"
                disabled={selected.length === 0 || !snapshot.ftpConfigured || snapshot.running !== false || busy !== ""}
                onClick={() => setPendingDelete(selected)}
              >
                <Trash2 className="icon" aria-hidden="true" />
                {t("server.delete")}
                {selected.length > 0 ? ` (${selected.length})` : ""}
              </button>
            </Tip>
          ) : null}
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
        </div>
        {visibleMods.length === 0 ? (
          <p className="muted">{t("server.noMods")}</p>
        ) : (
          <div className={modsOpen ? "server-mods is-open" : "server-mods"}>
            <table>
              <thead>
                <tr>
                  {canWrite ? (
                    <th className="mod-select">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        ref={(input) => {
                          if (input) input.indeterminate = visibleSelected > 0 && !allVisibleSelected
                        }}
                        aria-label={t("server.selectAll")}
                        onChange={(event) => toggleVisible(event.target.checked)}
                      />
                    </th>
                  ) : null}
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
                  const toggleDisabled = busy !== "" || snapshot.running === true
                  const toggleLabel = mod.active ? t("server.deactivate") : t("server.activate")
                  const toggleReason = snapshot.running === true ? t("server.toggleNeedsStop") : busy !== "" ? t("server.busy") : undefined
                  const unused = mod.used === false && mod.mapDependency !== true
                  const deleteDisabled = !snapshot.ftpConfigured || snapshot.running !== false || busy !== ""
                  const deleteReason = !deleteDisabled
                    ? t("server.delete")
                    : !snapshot.ftpConfigured
                      ? t("server.deleteNeedsFiles")
                      : snapshot.running !== false
                        ? t("server.deleteNeedsStop")
                        : t("server.busy")
                  return (
                    <tr key={mod.name}>
                      {canWrite ? (
                        <td className="mod-select">
                          <input
                            type="checkbox"
                            checked={selectedSet.has(mod.name)}
                            aria-label={t("server.selectMod", { name: mod.title || mod.name })}
                            onChange={() => toggleSelected(mod.name)}
                          />
                        </td>
                      ) : null}
                      <td className="mod-name">
                        <div className="mod-title-line">
                          <strong>{mod.title || mod.name}</strong>
                          {unused ? (
                            <span className="mod-unused" title={t("server.unusedTip")} aria-label={t("server.unused")} />
                          ) : null}
                          {mod.mapDependency ? (
                            <span className="mod-dependency" title={t("server.mapDependencyTip")} aria-label={t("server.mapDependency")}>
                              <Link2 className="icon" aria-hidden="true" />
                            </span>
                          ) : null}
                        </div>
                        {mod.title ? <span className="mod-file">{mod.name}</span> : null}
                      </td>
                      <td>{mod.author || "—"}</td>
                      <td>{formatBytes(mod.bytes)}</td>
                      <td>
                        <div className="server-mod-meta">
                          <span className={mod.active == null ? "badge is-unknown" : mod.active ? "badge" : "badge is-inactive"}>
                            {mod.active == null ? t("server.unknownActive") : mod.active ? t("server.active") : t("server.inactive")}
                          </span>
                        </div>
                      </td>
                      <td className="mod-version">
                        <div className="mod-version-row">
                          <span className="mod-version-current">{mod.version || "—"}</span>
                          <span className="mod-version-next">{mod.updateAvailable && mod.hubVersion ? mod.hubVersion : ""}</span>
                          <span className="mod-version-spacer" />
                          <span className="mod-version-rule" aria-hidden="true" />
                          <span className="mod-version-actions">
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
                          <span className="mod-icon-slot">
                            {mod.hubUrl ? (
                              <a className="btn btn-secondary mod-icon-btn" href={mod.hubUrl} target="_blank" rel="noreferrer" title={t("server.modHub")} aria-label={t("server.modHub")}>
                                <img src={modhubIcon} alt="" width={18} height={18} />
                              </a>
                            ) : null}
                          </span>
                          <span className="mod-icon-slot">
                            {mod.active != null && canWrite ? (
                              <Tip text={toggleReason}>
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
                                title={downloading === mod.name ? t("server.downloadBusy") : t("server.download")}
                                disabled={downloading === mod.name}
                                onClick={() => void downloadMod(mod.name)}
                              >
                                <Download className="icon" aria-hidden="true" />
                              </button>
                            ) : null}
                          </span>
                          <span className="mod-icon-slot">
                            {canWrite ? (
                              <Tip text={deleteReason}>
                                <button
                                  type="button"
                                  className="btn btn-secondary mod-icon-btn"
                                  disabled={deleteDisabled}
                                  aria-label={t("server.delete")}
                                  onClick={() => setPendingDelete([mod.name])}
                                >
                                  <Trash2 className="icon" aria-hidden="true" />
                                </button>
                              </Tip>
                            ) : null}
                          </span>
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
      </div> : null}

      {canWrite && settings.length > 0 ? (
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
                <span>{t(`server.fields.${field.name}`, { defaultValue: field.label })}</span>
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

      {canLog ? <div className="panel">
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
      </div> : null}
      {pendingUpdate && pendingUpdate.length > 0 ? (
        <Modal title={t("server.update")} onClose={() => busy !== "update-many" && setPendingUpdate(null)}>
          <p>{pendingUpdate.length === 1 ? t("server.updateOne") : t("server.updateMany", { count: pendingUpdate.length })}</p>
          <div className="card-actions">
            <button type="button" className="btn btn-secondary" disabled={busy === "update-many"} onClick={() => setPendingUpdate(null)}>
              {t("server.cancel")}
            </button>
            <button type="button" className="btn btn-primary" disabled={busy === "update-many"} onClick={() => void updateMods(pendingUpdate)}>
              {busy === "update-many" ? t("server.loading") : t("server.update")}
            </button>
          </div>
        </Modal>
      ) : null}
      {pendingDelete && pendingDelete.length > 0 ? (
        <Modal title={t("server.delete")} onClose={() => busy !== "delete" && setPendingDelete(null)}>
          <p>
            {pendingDelete.length === 1
              ? t("server.deleteOne", { name: snapshot.mods.find((mod) => mod.name === pendingDelete[0])?.title || pendingDelete[0] })
              : t("server.deleteMany", { count: pendingDelete.length })}
          </p>
          {pendingDelete.some((name) => snapshot.mods.find((mod) => mod.name === name)?.mapDependency) ? (
            <p className="hint">{t("server.deleteDependency")}</p>
          ) : null}
          <div className="card-actions">
            <button type="button" className="btn btn-secondary" disabled={busy === "delete"} onClick={() => setPendingDelete(null)}>
              {t("server.cancel")}
            </button>
            <button type="button" className="btn btn-danger" disabled={busy === "delete"} onClick={() => void removeMods(pendingDelete)}>
              {busy === "delete" ? t("server.loading") : t("server.delete")}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  )
}
