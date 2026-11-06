import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { CircleHelp, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { formatWhen } from "../demo"
import { useStore } from "../store"

// oxlint-disable-next-line react/only-export-components -- shared hook for the prototype screens
export function useTimeLabel() {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === "en" ? "en-GB" : "de-DE"
  return (iso: string | null, fallback: string) => formatWhen(iso, locale, fallback)
}

export function MissingValue({ text }: { text: string | null }) {
  const { t } = useTranslation()
  if (!text) return <span className="faint">{t("unavailable")}</span>
  return <>{text}</>
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <section className="state-panel">
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <div className="state-panel-actions">{action}</div> : null}
    </section>
  )
}

export function PermissionBlock() {
  const { t } = useTranslation()
  return (
    <EmptyState
      title={t("permission.title")}
      body={t("permission.body")}
      action={
        <Link className="btn btn-secondary" to="/instances">
          {t("permission.back")}
        </Link>
      }
    />
  )
}

export function MissingWorkspace() {
  const { t } = useTranslation()
  return (
    <EmptyState
      title={t("workspace.missingTitle")}
      body={t("workspace.missingBody")}
      action={
        <Link className="btn btn-secondary" to="/instances">
          {t("workspace.back")}
        </Link>
      }
    />
  )
}

export function Modal({
  title,
  onClose,
  children,
  alert = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  alert?: boolean
}) {
  const titleId = useId()
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (alert) event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener("keydown", onKey, alert)
    return () => window.removeEventListener("keydown", onKey, alert)
  }, [alert, onClose])

  return (
    <div
      className={alert ? "modal-back is-alert" : "modal-back"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Toasts() {
  const { t } = useTranslation()
  const { toasts, dismissToast } = useStore()
  const notices = toasts.filter((toast) => toast.tone === "ok")
  const error = toasts.find((toast) => toast.tone !== "ok") ?? null
  const [copiedFor, setCopiedFor] = useState<string | null>(null)
  const copied = error != null && copiedFor === error.id

  return (
    <>
      {notices.length > 0 ? (
        <div className="toasts" aria-live="polite">
          {notices.map((toast) => (
            <div className={`toast ${toast.tone}`} key={toast.id}>
              <span>{toast.text}</span>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={t("toast.dismiss")}
                onClick={() => dismissToast(toast.id)}
              >
                <X className="icon" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <Modal alert title={t("toast.errorTitle")} onClose={() => dismissToast(error.id)}>
          <p className="toast-error-body">{error.text}</p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(error.text).then(
                  () => setCopiedFor(error.id),
                  () => setCopiedFor(null),
                )
              }}
            >
              {copied ? t("toast.copied") : t("toast.copy")}
            </button>
            <button type="button" className="btn btn-primary" autoFocus onClick={() => dismissToast(error.id)}>
              {t("close")}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  )
}

/** Square mark — sidebar collapsed / compact chrome. */
export function BrandMark({ large = false }: { large?: boolean }) {
  const { t } = useTranslation()
  const size = large ? 72 : 40
  return (
    <img
      className={large ? "brand-mark brand-mark-lg" : "brand-mark"}
      src="/logo.svg"
      alt={t("appName")}
      width={size}
      height={size}
    />
  )
}

/** Logo Lang 3 (hell) — wordmark + slogan for dark surfaces. */
export function BrandLockup({
  size = "sidebar",
}: {
  size?: "sidebar" | "hero" | "login"
}) {
  const { t } = useTranslation()
  return (
    <img
      className={`brand-lockup brand-lockup-${size}`}
      src="/brand/logo-lang-3-light.svg"
      alt={t("appName")}
    />
  )
}

/** Quiet “?” help control for labels — click/tap to open, Esc / outside to close. */
export function FieldTip({ label, children }: { label: string; children: ReactNode }) {
  const tipId = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    function onPointer(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointer)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("pointerdown", onPointer)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <span className="field-tip" ref={rootRef}>
      <button
        type="button"
        className="field-tip-btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={tipId}
        onClick={() => setOpen((value) => !value)}
      >
        <CircleHelp className="icon" aria-hidden="true" />
      </button>
      {open ? (
        <span className="field-tip-panel" id={tipId} role="note">
          {children}
        </span>
      ) : null}
    </span>
  )
}
