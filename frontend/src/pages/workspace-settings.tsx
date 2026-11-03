import { useEffect, useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { LoaderCircle } from "lucide-react"
import {
  apiConnectorPackageMeta,
  apiDeployConnector,
  apiRequiredMods,
  apiSaveServerLogin,
  downloadConnectorPackage,
  ApiError,
  type ConnectorPackageMeta,
  type RequiredModStatus,
} from "../api"
import { RequiredModsPanel } from "../components/required-mods"
import { FieldTip, MissingWorkspace, Modal, PermissionBlock } from "../components/ui"
import { useStore } from "../store"
import type { HostProtocol } from "../types"
import { useWorkspaceRoute } from "../use-workspace"
import { isFeedUrl, isFeedUrlWithCode } from "../validate"

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

export function WorkspaceSettingsPage() {
  const { t } = useTranslation()
  const store = useStore()
  const { workspace, allowed, manage } = useWorkspaceRoute()
  const [name, setName] = useState(workspace?.name ?? "")
  const [nameError, setNameError] = useState("")
  const [feed, setFeed] = useState(workspace?.feedUrl ?? "")
  const [feedError, setFeedError] = useState("")
  const host = workspace?.hostAccess
  const [protocol, setProtocol] = useState<HostProtocol>(host?.protocol ?? "sftp")
  const [hostName, setHostName] = useState(host?.host ?? "")
  const [port, setPort] = useState(host?.port ? String(host.port) : "22")
  const [username, setUsername] = useState(host?.username ?? "")
  const [password, setPassword] = useState("")
  const [remoteRoot, setRemoteRoot] = useState(host?.remoteRoot ?? "")
  const [savegamePath, setSavegamePath] = useState(host?.remoteSavegamePath ?? "")
  const [modSettingsPath, setModSettingsPath] = useState(host?.remoteModSettingsPath ?? "")
  const [insecureAck, setInsecureAck] = useState(false)
  const [hostError, setHostError] = useState("")
  const [hostBusy, setHostBusy] = useState(false)
  const [savegameBusy, setSavegameBusy] = useState<number | null>(null)
  const [syncedId, setSyncedId] = useState(workspace?.id)
  const [consoleUser, setConsoleUser] = useState(workspace?.console?.username ?? "")
  const [consolePassword, setConsolePassword] = useState("")
  const [consoleError, setConsoleError] = useState("")
  const [consoleBusy, setConsoleBusy] = useState(false)
  if (workspace && syncedId !== workspace.id) {
    setSyncedId(workspace.id)
    setName(workspace.name)
    setFeed(workspace.feedUrl)
    setNameError("")
    setFeedError("")
    const next = workspace.hostAccess
    setProtocol(next?.protocol ?? "sftp")
    setHostName(next?.host ?? "")
    setPort(next?.port ? String(next.port) : next?.protocol === "sftp" ? "22" : "21")
    setUsername(next?.username ?? "")
    setPassword("")
    setRemoteRoot(next?.remoteRoot ?? "")
    setSavegamePath(next?.remoteSavegamePath ?? "")
    setModSettingsPath(next?.remoteModSettingsPath ?? "")
    setInsecureAck(false)
    setHostError("")
    setConsoleUser(workspace.console?.username ?? "")
    setConsolePassword("")
    setConsoleError("")
  }
  const [testing, setTesting] = useState(false)
  const [dialog, setDialog] = useState<"download" | "disable" | "confirm" | "code" | null>(null)
  const [code, setCode] = useState("")
  const [packageMeta, setPackageMeta] = useState<ConnectorPackageMeta | null>(null)
  const [connectorMod, setConnectorMod] = useState<RequiredModStatus | null>(null)
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false)
  const [deployBusy, setDeployBusy] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)

  const workspaceId = workspace?.id
  useEffect(() => {
    if (dialog !== "download" || !workspaceId) return
    let cancelled = false
    void apiConnectorPackageMeta()
      .then((meta) => {
        if (!cancelled) setPackageMeta(meta)
      })
      .catch(() => {
        if (!cancelled) {
          setPackageMeta({
            available: false,
            error: "meta",
            version: null,
            fileName: "FS25_AgriVisionConnector.zip",
          })
        }
      })
    void apiRequiredMods(workspaceId)
      .then((mods) => {
        if (cancelled || !mods) return
        setConnectorMod(mods.mods.find((item) => item.id === "FS25_AgriVisionConnector") ?? null)
      })
      .catch(() => {
        if (!cancelled) setConnectorMod(null)
      })
      .finally(() => {
        if (!cancelled) setUpdateCheckBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [dialog, workspaceId])

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !manage) return <PermissionBlock />

  const ws = workspace

  async function saveName(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError(t("create.nameRequired"))
      return
    }
    if (trimmed.length < 2) {
      setNameError(t("create.nameShort"))
      return
    }
    if (trimmed.length > 40) {
      setNameError(t("create.nameLong"))
      return
    }
    setNameError("")
    try {
      await store.renameWorkspace(ws.id, trimmed)
      store.pushToast("ok", t("settings.saved"))
    } catch {
      store.pushToast("warn", t("settings.saved"))
    }
  }

  async function saveFeed(event: FormEvent) {
    event.preventDefault()
    const trimmed = feed.trim()
    const configured = Boolean(ws.feedConfigured)
    const ok =
      trimmed === "" ||
      isFeedUrlWithCode(trimmed) ||
      (configured && isFeedUrl(trimmed) && !trimmed.includes("?"))
    if (!ok) {
      setFeedError(t("wsettings.feedInvalid"))
      return
    }
    setFeedError("")
    const result = await store.setFeedUrl(ws.id, trimmed)
    if (!result.ok) {
      setFeedError(result.error ?? t("wsettings.feedInvalid"))
      store.pushToast("warn", result.error ?? t("wsettings.testOffline"))
      return
    }
    store.pushToast("ok", t("wsettings.feedSaved"))
  }

  async function saveHost(event: FormEvent) {
    event.preventDefault()
    if (!hostName.trim() || !username.trim()) {
      setHostError(t("wsettings.hostRequired"))
      return
    }
    if (protocol === "ftp" && !insecureAck && !ws.hostAccess?.insecure) {
      setHostError(t("wsettings.hostFtpAckRequired"))
      return
    }
    const keepPassword = Boolean(ws.hostAccess?.hasPassword) && password === ""
    if (!keepPassword && password === "") {
      setHostError(t("wsettings.hostPasswordRequired"))
      return
    }
    setHostError("")
    setHostBusy(true)
    const result = await store.setHostAccess(ws.id, {
      protocol,
      host: hostName.trim(),
      port: port.trim() ? Number(port) : null,
      username: username.trim(),
      password: password || undefined,
      keepPassword,
      remoteRoot: remoteRoot.trim() || undefined,
      remoteSavegamePath: savegamePath.trim() || undefined,
      remoteModSettingsPath: modSettingsPath.trim() || undefined,
      insecureAck: protocol === "ftp" ? insecureAck || Boolean(ws.hostAccess?.insecure) : false,
      probe: true,
    })
    setHostBusy(false)
    setPassword("")
    const refreshed = result.workspace?.hostAccess
    if (refreshed?.remoteSavegamePath) setSavegamePath(refreshed.remoteSavegamePath)
    if (refreshed?.remoteModSettingsPath) setModSettingsPath(refreshed.remoteModSettingsPath)
    if (!result.ok) {
      setHostError(result.error ?? t("wsettings.hostProbeFail"))
      store.pushToast("warn", result.error ?? t("wsettings.hostProbeFail"))
      return
    }
    store.pushToast("ok", t("wsettings.hostSaved"))
  }

  async function probeHost() {
    setHostBusy(true)
    const result = await store.probeHostAccess(ws.id)
    setHostBusy(false)
    const refreshed = result.workspace?.hostAccess
    if (refreshed?.remoteSavegamePath) setSavegamePath(refreshed.remoteSavegamePath)
    if (refreshed?.remoteModSettingsPath) setModSettingsPath(refreshed.remoteModSettingsPath)
    if (!result.ok) {
      store.pushToast("warn", result.error ?? t("wsettings.hostProbeFail"))
      return
    }
    store.pushToast("ok", t("wsettings.hostProbeOk"))
  }

  async function test() {
    setTesting(true)
    const result = await store.testConnection(ws.id)
    setTesting(false)
    const key =
      result === "ok"
        ? "wsettings.testOk"
        : result === "unpaired"
          ? "wsettings.testUnpaired"
          : result === "disabled"
            ? "wsettings.testDisabled"
            : "wsettings.testOffline"
    store.pushToast(result === "ok" ? "ok" : "warn", t(key))
  }

  async function saveConsole(event: FormEvent) {
    event.preventDefault()
    if (!workspace) return
    const keepPassword = consolePassword === "" && Boolean(workspace.console?.hasPassword)
    if (!consoleUser.trim() || (!keepPassword && consolePassword === "")) {
      setConsoleError(t("server.loginRequired"))
      return
    }
    setConsoleBusy(true)
    setConsoleError("")
    try {
      const result = await apiSaveServerLogin(workspace.id, {
        username: consoleUser.trim(),
        password: consolePassword || undefined,
        keepPassword,
      })
      store.upsertWorkspace({ ...workspace, console: result.console })
      setConsolePassword("")
      store.pushToast("ok", t("server.loginSaved"))
    } catch (caught) {
      setConsoleError(caught instanceof ApiError ? caught.message : t("server.loginRequired"))
    } finally {
      setConsoleBusy(false)
    }
  }

  function onProtocolChange(next: HostProtocol) {
    setProtocol(next)
    if (!ws.hostAccess) {
      setPort(next === "sftp" ? "22" : "21")
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{t("wsettings.title")}</h1>
          <p>{t("wsettings.lead")}</p>
        </div>
      </div>
      <div className="settings-page">
        <header className="panel settings-hero">
          <span className="ws-no">{workspace.number}</span>
          <div>
            <h2>{workspace.name}</h2>
            {workspace.mapName ? <p className="faint">{workspace.mapName}</p> : null}
            <div className="status-line">
              <span className={`dot ${workspace.disabled ? "unknown" : workspace.linkState}`} />
              <span>{workspace.disabled ? t("card.disabled") : t(`link.${workspace.linkState}`)}</span>
            </div>
          </div>
        </header>
        <div className="settings-grid">
          <div className="settings-col">
            <form className="panel settings-card" onSubmit={(event) => void saveName(event)}>
              <h2>{t("wsettings.name")}</h2>
              <label className="field">
                <span className="sr">{t("wsettings.name")}</span>
                <input value={name} aria-invalid={nameError ? true : undefined} onChange={(event) => setName(event.target.value)} />
                {nameError ? <span className="field-error">{nameError}</span> : <span className="hint">{t("create.nameHint")}</span>}
              </label>
              <div className="setting-actions">
                <button className="btn btn-primary" type="submit">{t("save")}</button>
              </div>
            </form>
            <form className="panel settings-card" onSubmit={(event) => void saveFeed(event)}>
              <div className="field-label-row">
                <h2>{t("wsettings.feed")}</h2>
                <FieldTip label={t("wsettings.feedTipLabel")}>
                  <p>{t("wsettings.feedTip")}</p>
                </FieldTip>
              </div>
              <ol className="setup-steps">
                <li>{t("wsettings.feedStep1")}</li>
                <li>{t("wsettings.feedStep2")}</li>
                <li>{t("wsettings.feedStep3")}</li>
                <li>{t("wsettings.feedStep4")}</li>
              </ol>
              <label className="field">
                <span className="field-label-row">
                  <span>{t("wsettings.feedField")}</span>
                  <FieldTip label={t("wsettings.feedUrlTipLabel")}>
                    <p>{t("wsettings.feedUrlTip")}</p>
                    <p className="field-tip-example">{t("wsettings.feedUrlExample")}</p>
                  </FieldTip>
                </span>
                <input
                  value={feed}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("wsettings.feedPlaceholder")}
                  aria-invalid={feedError ? true : undefined}
                  onChange={(event) => setFeed(event.target.value)}
                />
                {feedError ? (
                  <span className="field-error">{feedError}</span>
                ) : (
                  <span className="hint">
                    {workspace.feedConfigured ? t("wsettings.feedHintConfigured") : t("wsettings.feedHint")}
                  </span>
                )}
              </label>
              {workspace.gameVersion || workspace.linkState === "online" ? (
                <p className="instance-version" aria-label={`${t("card.gameVersion")} ${workspace.gameVersion ?? "—"}`}>
                  <span className="instance-version-item">
                    <span>{t("card.gameVersion")}</span>
                    <strong>{workspace.gameVersion ?? "—"}</strong>
                  </span>
                  {workspace.playersOnline !== null ? (
                    <span className="instance-version-item">
                      <span>{t("card.players")}</span>
                      <strong>
                        {workspace.playerCapacity === null
                          ? workspace.playersOnline
                          : `${workspace.playersOnline}/${workspace.playerCapacity}`}
                      </strong>
                    </span>
                  ) : null}
                </p>
              ) : null}
              <div className="setting-actions">
                <button className="btn btn-secondary" type="submit">{t("save")}</button>
              </div>
            </form>

            {store.canManageUsers() ? (
              <form className="panel settings-card" onSubmit={(event) => void saveConsole(event)}>
                <div className="field-label-row">
                  <h2>{t("wsettings.consoleTitle")}</h2>
                  <FieldTip label={t("wsettings.consoleTipLabel")}>
                    <p>{t("wsettings.consoleTipWeb")}</p>
                    <p>{t("wsettings.consoleTipFiles")}</p>
                    <p>{t("wsettings.consoleTipNeither")}</p>
                  </FieldTip>
                </div>
                <p className="hint">{t("wsettings.consoleLead")}</p>
                <p className="server-origin">
                  <span>{t("server.detectedUrl")}</span>
                  <strong>{feedOrigin(workspace.feedUrl || workspace.console?.baseUrl || "") || t("server.detectedMissing")}</strong>
                </p>
                <label className="field">
                  <span>{t("server.username")}</span>
                  <input value={consoleUser} autoComplete="off" onChange={(event) => setConsoleUser(event.target.value)} />
                </label>
                <label className="field">
                  <span>{t("server.password")}</span>
                  <input
                    type="password"
                    value={consolePassword}
                    autoComplete="new-password"
                    placeholder={workspace.console?.hasPassword ? t("server.keepPassword") : ""}
                    onChange={(event) => setConsolePassword(event.target.value)}
                  />
                </label>
                {consoleError ? <p className="field-error">{consoleError}</p> : null}
                <div className="setting-actions">
                  <button className="btn btn-primary" type="submit" disabled={consoleBusy}>
                    {consoleBusy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
                    {t("server.saveLogin")}
                  </button>
                </div>
              </form>
            ) : null}

            <form className="panel settings-card" onSubmit={(event) => void saveHost(event)}>
              <div className="field-label-row">
                <h2>{t("wsettings.hostTitle")}</h2>
                <FieldTip label={t("wsettings.hostTipLabel")}>
                  <p>{t("wsettings.hostTip")}</p>
                </FieldTip>
              </div>
              <p className="hint">{t("wsettings.hostLead")}</p>

              <label className="field">
                <span>{t("wsettings.hostProtocol")}</span>
                <select
                  value={protocol}
                  onChange={(event) => onProtocolChange(event.target.value as HostProtocol)}
                >
                  <option value="sftp">SFTP</option>
                  <option value="ftps">FTPS</option>
                  <option value="ftp">FTP</option>
                </select>
              </label>

              <div className="field-row">
                <label className="field">
                  <span>{t("wsettings.hostHost")}</span>
                  <input
                    value={hostName}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setHostName(event.target.value)}
                  />
                </label>
                <label className="field field-narrow">
                  <span>{t("wsettings.hostPort")}</span>
                  <input
                    value={port}
                    inputMode="numeric"
                    onChange={(event) => setPort(event.target.value)}
                  />
                </label>
              </div>

              <label className="field">
                <span>{t("wsettings.hostUser")}</span>
                <input
                  value={username}
                  autoComplete="username"
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>

              <label className="field">
                <span>{t("wsettings.hostPassword")}</span>
                <input
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  placeholder={
                    workspace.hostAccess?.hasPassword
                      ? t("wsettings.hostPasswordKeep")
                      : undefined
                  }
                  onChange={(event) => setPassword(event.target.value)}
                />
                <span className="hint">{t("wsettings.hostPasswordHint")}</span>
              </label>

              <label className="field">
                <span>{t("wsettings.hostRoot")}</span>
                <input
                  value={remoteRoot}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("wsettings.hostRootPlaceholder")}
                  onChange={(event) => setRemoteRoot(event.target.value)}
                />
              </label>

              <label className="field">
                <span>{t("wsettings.hostSavegame")}</span>
                <input
                  value={savegamePath}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("wsettings.hostSavegamePlaceholder")}
                  onChange={(event) => setSavegamePath(event.target.value)}
                />
              </label>

              <label className="field">
                <span>{t("wsettings.hostModSettings")}</span>
                <input
                  value={modSettingsPath}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("wsettings.hostModSettingsPlaceholder")}
                  onChange={(event) => setModSettingsPath(event.target.value)}
                />
              </label>

              {protocol === "ftps" ? <p className="hint">{t("wsettings.hostFtpsHint")}</p> : null}
              {protocol === "ftp" ? (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={insecureAck || Boolean(workspace.hostAccess?.insecure)}
                    onChange={(event) => setInsecureAck(event.target.checked)}
                  />
                  <span>{t("wsettings.hostFtpAck")}</span>
                </label>
              ) : null}

              {hostError || (workspace.hostAccess?.status === "error" && workspace.hostAccess.lastError) ? (
                <div className="host-error-box" role="alert">
                  <p className="field-error">
                    {hostError || workspace.hostAccess?.lastError}
                  </p>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => {
                      const text = hostError || workspace.hostAccess?.lastError || ""
                      void navigator.clipboard.writeText(text).then(
                        () => store.pushToast("ok", t("wsettings.hostErrorCopied")),
                        () => store.pushToast("warn", t("create.copyFailed")),
                      )
                    }}
                  >
                    {t("wsettings.hostErrorCopy")}
                  </button>
                </div>
              ) : null}
              {workspace.hostAccess?.status === "ok" ? (
                <p className="hint">{t("wsettings.hostStatusOk")}</p>
              ) : null}
              {workspace.hostAccess?.remoteSavegamePath ? (
                <p className="instance-version host-savegame-echo">
                  <span>{t("wsettings.hostSavegame")}</span>
                  <strong>{workspace.hostAccess.remoteSavegamePath}</strong>
                </p>
              ) : null}

              <div className="setting-actions">
                <button className="btn btn-primary" type="submit" disabled={hostBusy}>
                  {hostBusy ? <LoaderCircle className="icon spin" /> : null}
                  {t("wsettings.hostSave")}
                </button>
                {workspace.hostAccess?.configured ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={hostBusy}
                      onClick={() => void probeHost()}
                    >
                      {t("wsettings.hostProbe")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={hostBusy}
                      onClick={() => {
                        void store.clearHostAccess(workspace.id).then(() => {
                          setPassword("")
                          setHostError("")
                          store.pushToast("ok", t("wsettings.hostCleared"))
                        })
                      }}
                    >
                      {t("wsettings.hostClear")}
                    </button>
                  </>
                ) : null}
              </div>

              {(workspace.savegames?.length ?? 0) > 0 ? (
                <div className="savegame-list">
                  <h3>{t("wsettings.savegamesTitle")}</h3>
                  <p className="hint">{t("wsettings.savegamesLead")}</p>
                  <ul className="savegame-rows">
                    {workspace.savegames!.map((sg) => (
                      <li key={sg.id} className={sg.active ? "savegame-row active" : "savegame-row"}>
                        <div className="savegame-row-main">
                          <strong>{sg.name || sg.slotKey}</strong>
                          <span className="faint">{sg.path || sg.slotKey}</span>
                          <span className={`savegame-status status-${sg.status}`}>
                            {t(`wsettings.savegameStatus.${sg.status}`, {
                              defaultValue: sg.statusNote || sg.status,
                            })}
                          </span>
                          {sg.statusNote ? <span className="savegame-note">{sg.statusNote}</span> : null}
                        </div>
                        {sg.active ? (
                          <span className="savegame-active-label">{t("wsettings.savegameActive")}</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary btn-small"
                            disabled={savegameBusy !== null}
                            onClick={() => {
                              setSavegameBusy(sg.id)
                              void store.selectSavegame(ws.id, sg.id).then((result) => {
                                setSavegameBusy(null)
                                if (!result.ok) {
                                  store.pushToast("warn", result.error ?? t("wsettings.savegameSwitchFail"))
                                  return
                                }
                                store.pushToast("ok", t("wsettings.savegameSwitched"))
                              })
                            }}
                          >
                            {savegameBusy === sg.id ? <LoaderCircle className="icon spin" /> : null}
                            {t("wsettings.savegameSelect")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </form>
          </div>
          <div className="settings-col">
            <section className="panel settings-card">
              <h2>{t("workspace.connector")}</h2>
              <p className="instance-version">
                <span className="instance-version-item">
                  <span>{t("workspace.version")}</span>
                  <strong>{workspace.connectorVersion ?? t("workspace.noVersion")}</strong>
                </span>
              </p>
              <RequiredModsPanel
                workspaceId={workspace.id}
                settingsPath={`/w/${workspace.id}/settings`}
                compact
              />
              <div className="setting-actions">
                <button type="button" className="btn btn-secondary" disabled={testing} onClick={() => void test()}>
                  {testing ? <LoaderCircle className="icon spin" /> : null}
                  {t("card.test")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setDialog("confirm")}>
                  {t("card.recouple")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setUpdateCheckBusy(true)
                    setDialog("download")
                  }}
                >
                  {t("card.download")}
                </button>
              </div>
              <p className="hint">{t("wsettings.compatBody")}</p>
            </section>
            <section className="panel settings-card danger-card">
              <h2>{workspace.disabled ? t("wsettings.enable") : t("wsettings.disable")}</h2>
              <p className="hint">{t("wsettings.disableBody")}</p>
              {workspace.disabled ? (
                <div className="setting-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      void store.setDisabled(workspace.id, false).then(() => {
                        store.pushToast("ok", t("wsettings.enabled"))
                      })
                    }}
                  >
                    {t("wsettings.enable")}
                  </button>
                </div>
              ) : (
                <div className="setting-actions">
                  <button type="button" className="btn btn-danger" onClick={() => setDialog("disable")}>
                    {t("wsettings.disable")}
                  </button>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
      {dialog === "download" ? (
        <Modal title={t("wsettings.downloadTitle")} onClose={() => setDialog(null)}>
          <p className="muted">{t("wsettings.downloadBody")}</p>
          {packageMeta?.available && packageMeta.version ? (
            <p className="hint">
              {t("wsettings.connectorPackageVersion", { version: packageMeta.version })}
            </p>
          ) : null}
          {packageMeta && !packageMeta.available ? (
            <p className="field-error">{packageMeta.error || t("wsettings.connectorPackageMissing")}</p>
          ) : null}
          {updateCheckBusy ? (
            <p className="hint">{t("wsettings.requiredModsChecking")}</p>
          ) : connectorMod?.updateAvailable && packageMeta?.version ? (
            <p className="field-error">
              {t("wsettings.connectorUpdateAvailable", {
                package: packageMeta.version,
                running: connectorMod.runningVersion ?? "—",
              })}
            </p>
          ) : packageMeta?.version && connectorMod?.runningVersion ? (
            <p className="hint">
              {t("wsettings.connectorUpToDate", { package: packageMeta.version })}
            </p>
          ) : packageMeta?.version ? (
            <p className="hint">
              {t("wsettings.connectorNoRunningVersion", { package: packageMeta.version })}
            </p>
          ) : null}
          {connectorMod && !connectorMod.activated ? (
            <p className="hint">{t("wsettings.connectorModSettingsMissing")}</p>
          ) : null}
          <p className="hint">{t("wsettings.connectorDeployHint")}</p>
          <div className="modal-actions modal-actions-stack">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>
              {t("close")}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!packageMeta?.available || downloadBusy}
              onClick={() => {
                setDownloadBusy(true)
                void downloadConnectorPackage()
                  .then(() => store.pushToast("ok", t("wsettings.connectorDownload")))
                  .catch(() => store.pushToast("warn", t("wsettings.connectorPackageMissing")))
                  .finally(() => setDownloadBusy(false))
              }}
            >
              {downloadBusy ? <LoaderCircle className="icon spin" /> : null}
              {t("wsettings.connectorDownload")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!packageMeta?.available || deployBusy || !workspace.hostAccess?.configured}
              title={
                workspace.hostAccess?.configured ? undefined : t("wsettings.connectorDeployNeedHost")
              }
              onClick={() => {
                if (!workspace.hostAccess?.configured) {
                  store.pushToast("warn", t("wsettings.connectorDeployNeedHost"))
                  return
                }
                setDeployBusy(true)
                void apiDeployConnector(workspace.id)
                  .then((result) => {
                    if (!result.ok) {
                      store.pushToast("warn", result.error ?? t("wsettings.connectorDeployFail"))
                      return
                    }
                    store.pushToast(
                      "ok",
                      t("wsettings.connectorDeployOk", { path: result.remotePath ?? "mods/" }),
                    )
                    setDialog(null)
                  })
                  .catch((error: unknown) => {
                    const text = error instanceof ApiError && error.message ? error.message : t("wsettings.connectorDeployFail")
                    store.pushToast("warn", text)
                  })
                  .finally(() => setDeployBusy(false))
              }}
            >
              {deployBusy ? <LoaderCircle className="icon spin" /> : null}
              {deployBusy ? t("wsettings.connectorDeploying") : t("wsettings.connectorDeploy")}
            </button>
          </div>
        </Modal>
      ) : null}
      {dialog === "disable" ? (
        <Modal title={t("wsettings.disableTitle")} onClose={() => setDialog(null)}>
          <p className="muted">{t("wsettings.disableBody")}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>{t("cancel")}</button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                void store.setDisabled(workspace.id, true).then(() => {
                  store.pushToast("warn", t("wsettings.disabled"))
                  setDialog(null)
                })
              }}
            >
              {t("wsettings.disable")}
            </button>
          </div>
        </Modal>
      ) : null}
      {dialog === "confirm" ? (
        <Modal title={t("wsettings.recoupleTitle")} onClose={() => setDialog(null)}>
          <p className="muted">{t("wsettings.recoupleBody")}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>{t("cancel")}</button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setCode(store.revealCode(workspace.id))
                setDialog("code")
              }}
            >
              {t("wsettings.recouple")}
            </button>
          </div>
        </Modal>
      ) : null}
      {dialog === "code" ? (
        <Modal
          title={t("wsettings.codeOnce")}
          onClose={() => {
            store.hideCode(workspace.id)
            setDialog(null)
          }}
        >
          <p className="code">{code}</p>
          <p className="hint">{t("create.doneLead")}</p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(code).then(
                  () => store.pushToast("ok", t("create.copied")),
                  () => store.pushToast("warn", t("create.copyFailed")),
                )
              }}
            >
              {t("create.copy")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                store.hideCode(workspace.id)
                setDialog(null)
              }}
            >
              {t("wsettings.hideCode")}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  )
}
