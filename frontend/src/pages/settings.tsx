import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { Camera, CheckCircle2, CircleAlert, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react"
import {
  applyUpdate,
  checkForUpdates,
  fetchUpdateLog,
  formatSha,
  GITHUB_REPO_URL,
  type UpdateStatus,
} from "../github-update"
import { i18n } from "../i18n"
import { apiScheduleStatus, type ScheduleStatus } from "../api"
import { useStore } from "../store"
import type { MailEncryption, MailSettings } from "../types"
import { isEmail } from "../validate"
import { MANAGEMENT_VERSION } from "../version"

type SettingsTab = "profile" | "general" | "update" | "mail"

function UpdateLogPanel({
  initialLines,
  onToast,
}: {
  initialLines: string[]
  onToast: (tone: "ok" | "warn" | "danger", text: string) => void
}) {
  const { t } = useTranslation()
  const [lines, setLines] = useState(initialLines)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setLines(initialLines)
  }, [initialLines])

  async function refresh() {
    setBusy(true)
    try {
      const result = await fetchUpdateLog()
      setLines(result.lines)
    } catch {
      onToast("warn", t("settings.updateLogFailed"))
    } finally {
      setBusy(false)
    }
  }

  const text = lines.join("\n")

  return (
    <div className="update-log-panel">
      <div className="field-label-row">
        <h3>{t("settings.updateLogTitle")}</h3>
        <div className="setting-actions">
          <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => void refresh()}>
            {busy ? <LoaderCircle className="icon spin" /> : null}
            {t("settings.updateLogRefresh")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={text === ""}
            onClick={() => {
              void navigator.clipboard.writeText(text).then(
                () => onToast("ok", t("settings.updateLogCopied")),
                () => onToast("warn", t("create.copyFailed")),
              )
            }}
          >
            {t("settings.updateLogCopy")}
          </button>
        </div>
      </div>
      <p className="hint">{t("settings.updateLogHint")}</p>
      {lines.length === 0 ? (
        <p className="muted">{t("settings.updateLogEmpty")}</p>
      ) : (
        <pre className="update-log-pre" tabIndex={0}>
          {text}
        </pre>
      )}
    </div>
  )
}

function chooseLocale(lng: "de" | "en") {
  void i18n.changeLanguage(lng)
  localStorage.setItem("fs25.locale", lng)
  document.documentElement.lang = lng
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? "")
    .join("")
}

export function SettingsPage() {
  const { t, i18n: current } = useTranslation()
  const store = useStore()
  const actor = store.actor
  const liveMode = store.liveMode
  const isAdmin = actor?.globalRole === "admin" && actor.active
  const fileRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<SettingsTab>("profile")

  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [alias, setAlias] = useState("")
  const [notificationEmail, setNotificationEmail] = useState("")
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null)
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false)
  const [profileError, setProfileError] = useState("")

  const [currentPassword, setCurrentPassword] = useState("")
  const [nextPassword, setNextPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordError, setPasswordError] = useState("")

  const [mail, setMail] = useState<MailSettings>(store.mailSettings)
  const [mailError, setMailError] = useState("")
  const [mailTesting, setMailTesting] = useState(false)

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateApplying, setUpdateApplying] = useState(false)
  const [updateApplyError, setUpdateApplyError] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<ScheduleStatus | null>(null)
  const [demoInstalledSha] = useState<string | null>(() => {
    try {
      return localStorage.getItem("agravion.installedSha")
    } catch {
      return null
    }
  })

  useEffect(() => {
    if (!actor) return
    setFirstName(actor.firstName)
    setLastName(actor.lastName)
    setAlias(actor.alias)
    setNotificationEmail(actor.notificationEmail || actor.email)
    setAvatarDataUrl(actor.avatarDataUrl)
    setTwoFactorEnabled(actor.twoFactorEnabled)
  }, [actor])

  useEffect(() => {
    setMail(store.mailSettings)
  }, [store.mailSettings])

  useEffect(() => {
    if ((tab === "mail" || tab === "update") && !isAdmin) setTab("profile")
  }, [isAdmin, tab])

  async function runUpdateCheck() {
    setUpdateChecking(true)
    const status = await checkForUpdates(MANAGEMENT_VERSION, demoInstalledSha)
    setUpdateStatus(status)
    setUpdateChecking(false)
    if (status.error) {
      store.pushToast("warn", t("settings.updateCheckFailed", { error: status.error }))
    }
  }

  useEffect(() => {
    if (tab !== "update" || !isAdmin || !liveMode) return
    let cancelled = false
    void apiScheduleStatus()
      .then((row) => {
        if (!cancelled) setSchedule(row)
      })
      .catch(() => {
        if (!cancelled) setSchedule(null)
      })
    return () => {
      cancelled = true
    }
  }, [tab, isAdmin, liveMode])

  useEffect(() => {
    if (tab !== "update" || !isAdmin) return
    let cancelled = false
    setUpdateChecking(true)
    void checkForUpdates(MANAGEMENT_VERSION, demoInstalledSha).then((status) => {
      if (cancelled) return
      setUpdateStatus(status)
      setUpdateChecking(false)
    })
    return () => {
      cancelled = true
    }
  }, [tab, isAdmin, demoInstalledSha])

  async function runUpdateApply(kind: "update" | "repair" = "update") {
    const canRetryMigrations = Boolean(updateStatus?.lastError || updateStatus?.migrationError)
    if (kind === "update" && !updateStatus?.updateAvailable && !canRetryMigrations) return
    if (
      !window.confirm(
        kind === "repair" || canRetryMigrations
          ? t("settings.updateRepairConfirm")
          : t("settings.updateConfirm"),
      )
    ) {
      return
    }
    setUpdateApplying(true)
    setUpdateApplyError(null)
    // repair: same SHA, backend still re-deploys frontend/dist → public/
    const result = await applyUpdate(updateStatus?.remoteSha ?? null, { force: false })
    setUpdateApplying(false)
    if (!result.ok) {
      const err = result.error ?? "—"
      setUpdateApplyError(err)
      if (result.error === "backend_unavailable") {
        store.pushToast("warn", t("settings.updateBackendMissing"))
        return
      }
      store.pushToast("warn", t("settings.updateFailed", { error: err }))
      await runUpdateCheck()
      return
    }
    if (updateStatus?.remoteSha) {
      try {
        localStorage.setItem("agravion.installedSha", updateStatus.remoteSha)
      } catch {
        /* ignore */
      }
    }
    store.pushToast("ok", result.message ?? t("settings.updateApplied"))
    await runUpdateCheck()
    window.setTimeout(() => {
      window.location.reload()
    }, 600)
  }

  function onAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith("image/")) {
      store.pushToast("warn", t("settings.avatarType"))
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      store.pushToast("warn", t("settings.avatarSize"))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") setAvatarDataUrl(reader.result)
    }
    reader.readAsDataURL(file)
  }

  function saveProfile(event: FormEvent) {
    event.preventDefault()
    if (!actor) return
    if (notificationEmail.trim() && !isEmail(notificationEmail)) {
      setProfileError(t("settings.notificationInvalid"))
      return
    }
    setProfileError("")
    store.updateProfile(actor.id, {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      alias: alias.trim(),
      notificationEmail: notificationEmail.trim() || actor.email,
      avatarDataUrl,
      twoFactorEnabled,
    })
    store.pushToast("ok", t("settings.profileSaved"))
  }

  function savePassword(event: FormEvent) {
    event.preventDefault()
    if (!currentPassword || currentPassword.length < 12) {
      setPasswordError(t("settings.passwordCurrentShort"))
      return
    }
    if (nextPassword.length < 12) {
      setPasswordError(t("login.passwordShort"))
      return
    }
    if (nextPassword !== confirmPassword) {
      setPasswordError(t("settings.passwordMismatch"))
      return
    }
    if (currentPassword === "wrong-password") {
      setPasswordError(t("settings.passwordWrong"))
      return
    }
    setPasswordError("")
    setCurrentPassword("")
    setNextPassword("")
    setConfirmPassword("")
    store.pushToast("ok", t("settings.passwordSaved"))
  }

  function saveMail(event: FormEvent) {
    event.preventDefault()
    if (!isAdmin) return
    if (!mail.host.trim()) {
      setMailError(t("settings.mailHostRequired"))
      return
    }
    if (!mail.fromEmail.trim() || !isEmail(mail.fromEmail)) {
      setMailError(t("settings.mailFromInvalid"))
      return
    }
    setMailError("")
    store.setMailSettings(mail)
    store.pushToast("ok", t("settings.mailSaved"))
  }

  function testMail() {
    if (!isAdmin) return
    setMailTesting(true)
    window.setTimeout(() => {
      setMailTesting(false)
      if (!mail.host.trim()) {
        store.pushToast("warn", t("settings.mailHostRequired"))
        return
      }
      store.pushToast("ok", t("settings.mailTestOk"))
    }, 700)
  }

  const display = actor
    ? `${firstName} ${lastName}`.trim() || actor.name
    : ""

  return (
    <section className="settings-page-wrap">
      <header className="access-head">
        <div className="access-head-copy">
          <h1>{t("settings.title")}</h1>
          <p>{t("settings.lead")}</p>
        </div>
        <nav className="access-tabs" role="tablist" aria-label={t("settings.title")}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "profile"}
            className={tab === "profile" ? "access-tab active" : "access-tab"}
            onClick={() => setTab("profile")}
          >
            {t("settings.tabProfile")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "general"}
            className={tab === "general" ? "access-tab active" : "access-tab"}
            onClick={() => setTab("general")}
          >
            {t("settings.tabGeneral")}
          </button>
          {isAdmin ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "update"}
              className={tab === "update" ? "access-tab active" : "access-tab"}
              onClick={() => setTab("update")}
            >
              {t("settings.tabUpdate")}
            </button>
          ) : null}
          {isAdmin ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "mail"}
              className={tab === "mail" ? "access-tab active" : "access-tab"}
              onClick={() => setTab("mail")}
            >
              {t("settings.tabMail")}
            </button>
          ) : null}
        </nav>
      </header>

      {tab === "profile" && actor ? (
        <div className="settings-stack">
          <form className="panel settings-card" onSubmit={saveProfile}>
            <div className="settings-card-head">
              <h2>{t("settings.profile")}</h2>
              <p className="hint">{t("settings.profileLead")}</p>
            </div>

            <div className="profile-avatar-row">
              <button
                type="button"
                className="profile-avatar"
                onClick={() => fileRef.current?.click()}
                aria-label={t("settings.avatarChange")}
              >
                {avatarDataUrl ? (
                  <img src={avatarDataUrl} alt="" />
                ) : (
                  <span aria-hidden="true">{initials(display)}</span>
                )}
                <span className="profile-avatar-overlay" aria-hidden="true">
                  <Camera className="icon" />
                </span>
              </button>
              <div className="profile-avatar-copy">
                <div>
                  <strong>{display}</strong>
                  <p className="faint">{actor.email}</p>
                </div>
                <div className="profile-avatar-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
                    {t("settings.avatarChange")}
                  </button>
                  {avatarDataUrl ? (
                    <button type="button" className="btn btn-ghost" onClick={() => setAvatarDataUrl(null)}>
                      {t("settings.avatarRemove")}
                    </button>
                  ) : null}
                </div>
                <p className="hint">{t("settings.avatarHint")}</p>
              </div>
              <input
                ref={fileRef}
                className="sr"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onAvatar}
              />
            </div>

            <div className="settings-form-grid">
              <label className="field">
                <span>{t("settings.firstName")}</span>
                <input value={firstName} onChange={(event) => setFirstName(event.target.value)} autoComplete="given-name" />
                <span className="field-hint">{t("settings.optional")}</span>
              </label>
              <label className="field">
                <span>{t("settings.lastName")}</span>
                <input value={lastName} onChange={(event) => setLastName(event.target.value)} autoComplete="family-name" />
                <span className="field-hint">{t("settings.optional")}</span>
              </label>
              <label className="field">
                <span>{t("settings.alias")}</span>
                <input value={alias} onChange={(event) => setAlias(event.target.value)} autoComplete="nickname" />
                <span className="field-hint">{t("settings.aliasHint")}</span>
              </label>
              <label className="field">
                <span>{t("settings.notificationEmail")}</span>
                <input
                  type="email"
                  value={notificationEmail}
                  onChange={(event) => setNotificationEmail(event.target.value)}
                  autoComplete="email"
                />
                <span className="field-hint">{t("settings.notificationHint")}</span>
              </label>
            </div>
            {profileError ? <p className="field-error">{profileError}</p> : null}

            <div className="settings-toggle-row">
              <div>
                <strong>{t("settings.twoFactor")}</strong>
                <p className="faint">{t("settings.twoFactorHint")}</p>
              </div>
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={twoFactorEnabled}
                aria-label={t("settings.twoFactor")}
                onClick={() => setTwoFactorEnabled((value) => !value)}
              >
                <span />
              </button>
            </div>
            {twoFactorEnabled ? (
              <p className="access-note">
                <ShieldCheck className="icon inline-icon" aria-hidden="true" />
                {t("settings.twoFactorDemo")}
              </p>
            ) : null}

            <div className="setting-actions">
              <button type="submit" className="btn btn-primary">
                {t("settings.saveProfile")}
              </button>
            </div>
          </form>

          <form className="panel settings-card" onSubmit={savePassword}>
            <div className="settings-card-head">
              <h2>{t("settings.passwordTitle")}</h2>
              <p className="hint">{t("settings.passwordLead")}</p>
            </div>
            <div className="settings-form-grid single">
              <label className="field">
                <span>{t("settings.passwordCurrent")}</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <label className="field">
                <span>{t("settings.passwordNew")}</span>
                <input
                  type="password"
                  value={nextPassword}
                  onChange={(event) => setNextPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="field">
                <span>{t("settings.passwordConfirm")}</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
            </div>
            {passwordError ? <p className="field-error">{passwordError}</p> : null}
            <div className="setting-actions">
              <button type="submit" className="btn btn-secondary">
                {t("settings.passwordSave")}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {tab === "general" ? (
        <div className="settings-stack">
          <section className="panel settings-card">
            <div className="settings-card-head">
              <h2>{t("language")}</h2>
              <p className="hint">{t("settings.languageLead")}</p>
            </div>
            <div className="lang" role="group" aria-label={t("language")}>
              <button type="button" aria-pressed={current.language !== "en"} onClick={() => chooseLocale("de")}>
                {t("german")}
              </button>
              <button type="button" aria-pressed={current.language === "en"} onClick={() => chooseLocale("en")}>
                {t("english")}
              </button>
            </div>
          </section>
          {!store.liveMode ? (
            <p className="hint">{t("settings.viewAsMoved")}</p>
          ) : null}
        </div>
      ) : null}

      {tab === "update" && isAdmin ? (
        <section className="panel settings-card">
          <div className="settings-card-head">
            <h2>{t("settings.updateTitle")}</h2>
            <p className="hint">{t("settings.updateLead")}</p>
          </div>

          {updateChecking && !updateStatus ? (
            <div className="update-status update-status-pending" role="status">
              <LoaderCircle className="icon spin" aria-hidden="true" />
              <div>
                <strong>{t("settings.updateChecking")}</strong>
                <span>{t("settings.updateStatusPendingLead")}</span>
              </div>
            </div>
          ) : null}

          {updateStatus ? (
            <div
              className={
                updateStatus.updateAvailable ? "update-status update-status-available" : "update-status update-status-current"
              }
              role="status"
              aria-live="polite"
            >
              {updateStatus.updateAvailable ? (
                <CircleAlert className="icon" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="icon" aria-hidden="true" />
              )}
              <div>
                <strong>
                  {updateStatus.updateAvailable ? t("settings.updateAvailable") : t("settings.updateCurrentOk")}
                </strong>
                <span>
                  {updateStatus.updateAvailable
                    ? t("settings.updateAvailableLead", {
                        sha: formatSha(updateStatus.remoteSha),
                      })
                    : t("settings.updateCurrentLead", {
                        sha: formatSha(updateStatus.installedSha ?? demoInstalledSha),
                      })}
                  {" · "}
                  {updateStatus.source === "api"
                    ? t("settings.updateSourceApi")
                    : updateStatus.source === "github"
                      ? t("settings.updateSourceGithub")
                      : t("settings.updateSourceDemo")}
                </span>
              </div>
            </div>
          ) : null}

          <div className="update-meta">
            {liveMode && schedule ? (
              <div className="update-meta-row">
                <span className="faint">{t("settings.cronLabel")}</span>
                <strong>
                  {schedule.state === "active"
                    ? t("settings.cronActive")
                    : schedule.state === "installed"
                      ? t("settings.cronInstalled")
                      : schedule.state === "stale"
                        ? t("settings.cronStale", {
                            time: schedule.lastRunAt
                              ? new Date(schedule.lastRunAt).toLocaleString(i18n.language)
                              : "–",
                          })
                        : t("settings.cronMissing")}
                </strong>
              </div>
            ) : null}
            <div className="update-meta-row">
              <span className="faint">{t("settings.updateCurrent")}</span>
              <strong>{MANAGEMENT_VERSION}</strong>
            </div>
            <div className="update-meta-row">
              <span className="faint">{t("settings.updateRepo")}</span>
              <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
                {updateStatus?.repo ?? "Pelessaria/Agravion-FS25"}
              </a>
            </div>
            <div className="update-meta-row">
              <span className="faint">{t("settings.updateBranch")}</span>
              <strong>{updateStatus?.branch ?? "main"}</strong>
            </div>
            <div className="update-meta-row">
              <span className="faint">{t("settings.updateInstalledSha")}</span>
              <code>{formatSha(updateStatus?.installedSha ?? demoInstalledSha)}</code>
            </div>
            <div className="update-meta-row">
              <span className="faint">{t("settings.updateRemoteSha")}</span>
              <code>{formatSha(updateStatus?.remoteSha)}</code>
            </div>
            {updateStatus?.remoteMessage ? (
              <div className="update-meta-row">
                <span className="faint">{t("settings.updateRemoteMessage")}</span>
                <span>{updateStatus.remoteMessage}</span>
              </div>
            ) : null}
          </div>

          {liveMode && schedule && (schedule.daemon === "stopped" || schedule.state === "missing") ? (
            <p className="hint">
              {schedule.daemon === "stopped"
                ? t("settings.cronDaemonStopped")
                : schedule.state === "missing"
                  ? t("settings.cronMissingHint")
                  : null}
            </p>
          ) : null}

          {updateStatus?.source !== "api" && !liveMode ? (
            <p className="hint">{t("settings.updateApplyDemo")}</p>
          ) : null}
          {updateStatus && updateStatus.source !== "api" && liveMode ? (
            <p className="hint">
              {t("settings.updateApiFallback")}
              {updateStatus.error ? ` (${updateStatus.error})` : null}
            </p>
          ) : null}

          <div className="setting-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={updateChecking || updateApplying}
              onClick={() => void runUpdateCheck()}
            >
              {updateChecking ? <LoaderCircle className="icon spin" /> : <RefreshCw className="icon" />}
              {updateChecking ? t("settings.updateChecking") : t("settings.updateCheck")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                updateChecking ||
                updateApplying ||
                !updateStatus?.updateAvailable ||
                !updateStatus.remoteSha ||
                (updateStatus.source !== "api" && !liveMode)
              }
              title={
                updateStatus?.source !== "api" && !liveMode
                  ? t("settings.updateApplyDemo")
                  : updateStatus && !updateStatus.updateAvailable
                    ? t("settings.updateApplyDisabledCurrent")
                    : undefined
              }
              onClick={() => void runUpdateApply("update")}
            >
              {updateApplying ? t("settings.updateApplying") : t("settings.updateApply")}
            </button>
            {liveMode && updateStatus && (!updateStatus.updateAvailable || updateStatus.lastError || updateStatus.migrationError) ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={updateChecking || updateApplying}
                title={t("settings.updateRepairHint")}
                onClick={() => void runUpdateApply("repair")}
              >
                {t("settings.updateRepair")}
              </button>
            ) : null}
            <a className="btn btn-ghost" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
              {t("settings.updateOpenRepo")}
            </a>
          </div>
          {liveMode && updateStatus && !updateStatus.updateAvailable ? (
            <p className="hint">{t("settings.updateRepairHint")}</p>
          ) : null}

          {(() => {
            const persistent =
              updateApplyError ||
              updateStatus?.lastError ||
              updateStatus?.migrationError ||
              null
            if (!persistent) return null
            return (
              <div className="host-error-box update-error-box" role="alert">
                <p className="hint">{t("settings.updateLastErrorTitle")}</p>
                <p className="field-error">{persistent}</p>
                <div className="setting-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => {
                      void navigator.clipboard.writeText(persistent).then(
                        () => store.pushToast("ok", t("settings.updateErrorCopied")),
                        () => store.pushToast("warn", t("create.copyFailed")),
                      )
                    }}
                  >
                    {t("settings.updateErrorCopy")}
                  </button>
                </div>
                <p className="hint">{t("settings.updateLastErrorHint")}</p>
              </div>
            )
          })()}

          <UpdateLogPanel
            initialLines={updateStatus?.updateLog ?? []}
            onToast={(tone, text) => store.pushToast(tone, text)}
          />
        </section>
      ) : null}

      {tab === "mail" && isAdmin ? (
        <form className="panel settings-card" onSubmit={saveMail}>
          <div className="settings-card-head">
            <h2>{t("settings.mailTitle")}</h2>
            <p className="hint">{t("settings.mailLead")}</p>
          </div>
          <div className="settings-form-grid">
            <label className="field">
              <span>{t("settings.mailHost")}</span>
              <input
                value={mail.host}
                onChange={(event) => setMail((currentMail) => ({ ...currentMail, host: event.target.value }))}
                placeholder="smtp.example.com"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>{t("settings.mailPort")}</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={mail.port}
                onChange={(event) =>
                  setMail((currentMail) => ({ ...currentMail, port: Number(event.target.value) || 587 }))
                }
              />
            </label>
            <label className="field">
              <span>{t("settings.mailEncryption")}</span>
              <select
                value={mail.encryption}
                onChange={(event) =>
                  setMail((currentMail) => ({
                    ...currentMail,
                    encryption: event.target.value as MailEncryption,
                  }))
                }
              >
                <option value="none">{t("settings.mailEncNone")}</option>
                <option value="starttls">{t("settings.mailEncStarttls")}</option>
                <option value="tls">{t("settings.mailEncTls")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("settings.mailUsername")}</span>
              <input
                value={mail.username}
                onChange={(event) => setMail((currentMail) => ({ ...currentMail, username: event.target.value }))}
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>{t("settings.mailPassword")}</span>
              <input
                type="password"
                value={mail.password}
                onChange={(event) => setMail((currentMail) => ({ ...currentMail, password: event.target.value }))}
                autoComplete="new-password"
              />
              <span className="field-hint">{t("settings.mailPasswordHint")}</span>
            </label>
            <label className="field">
              <span>{t("settings.mailFromName")}</span>
              <input
                value={mail.fromName}
                onChange={(event) => setMail((currentMail) => ({ ...currentMail, fromName: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>{t("settings.mailFromEmail")}</span>
              <input
                type="email"
                value={mail.fromEmail}
                onChange={(event) => setMail((currentMail) => ({ ...currentMail, fromEmail: event.target.value }))}
                placeholder="noreply@example.com"
              />
            </label>
          </div>
          {mailError ? <p className="field-error">{mailError}</p> : null}
          <div className="setting-actions">
            <button type="button" className="btn btn-secondary" disabled={mailTesting} onClick={testMail}>
              {mailTesting ? t("settings.mailTesting") : t("settings.mailTest")}
            </button>
            <button type="submit" className="btn btn-primary">
              {t("settings.mailSave")}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  )
}
