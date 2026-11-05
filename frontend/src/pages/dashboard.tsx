import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { ArrowDown, ArrowUp, Eye, EyeOff, LayoutTemplate, RotateCcw } from "lucide-react"
import { EmptyState, MissingValue } from "../components/ui"
import {
  DASHBOARD_WIDGETS,
  defaultDashboardLayout,
  layoutStorageKey,
  normalizeDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetId,
} from "../dashboard-widgets"
import { useStore } from "../store"
import type { LinkState, Workspace } from "../types"

const STATUS_COLOR: Record<LinkState | "disabled", string> = {
  online: "#4caf50",
  offline: "#7aa2ff",
  unpaired: "#ff8f5a",
  error: "#ff6d88",
  unknown: "#8d9792",
  disabled: "#8d9792",
}

function needsAttention(workspace: Workspace) {
  return (
    workspace.disabled ||
    workspace.linkState === "offline" ||
    workspace.linkState === "unpaired" ||
    workspace.linkState === "error" ||
    workspace.notice !== null
  )
}

function statusOf(workspace: Workspace) {
  if (workspace.disabled) return "disabled" as const
  return workspace.linkState
}

function reasonOf(workspace: Workspace) {
  if (workspace.disabled) return "disabled" as const
  if (workspace.notice) return workspace.notice
  return workspace.linkState
}

function Donut({
  parts,
  label,
}: {
  parts: { key: string; label: string; value: number; color: string }[]
  label: string
}) {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  const radius = 46
  const circumference = 2 * Math.PI * radius
  const active = parts.filter((part) => part.value > 0)
  const gap = active.length > 1 ? 3 : 0
  let cursor = 0

  return (
    <svg className="donut" viewBox="0 0 140 140" role="img" aria-label={label}>
      <circle cx="70" cy="70" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
      {active.map((part) => {
        const length = Math.max(0, (part.value / Math.max(total, 1)) * circumference - gap)
        const dash = `${length} ${circumference - length}`
        const offset = -cursor
        cursor += length + gap
        return (
          <circle
            key={part.key}
            cx="70"
            cy="70"
            r={radius}
            fill="none"
            stroke={part.color}
            strokeWidth="12"
            strokeDasharray={dash}
            strokeDashoffset={offset}
            transform="rotate(-90 70 70)"
          />
        )
      })}
      <text x="70" y="78" textAnchor="middle" fill="currentColor" fontSize="32" fontWeight="600">
        {total}
      </text>
    </svg>
  )
}

function widgetMeta(id: DashboardWidgetId) {
  return DASHBOARD_WIDGETS.find((widget) => widget.id === id)!
}

export function DashboardPage() {
  const { t } = useTranslation()
  const store = useStore()
  const { accessibleWorkspaces, actor } = store
  const userId = actor?.id ?? "guest"
  const [editing, setEditing] = useState(false)
  const [layout, setLayout] = useState<DashboardLayout>(() => defaultDashboardLayout())

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(layoutStorageKey(userId))
      setLayout(normalizeDashboardLayout(raw ? JSON.parse(raw) : null))
    } catch {
      setLayout(defaultDashboardLayout())
    }
  }, [userId])

  useEffect(() => {
    sessionStorage.setItem(layoutStorageKey(userId), JSON.stringify(layout))
  }, [layout, userId])

  const ordered = [...accessibleWorkspaces].sort((a, b) => a.number - b.number)
  const online = ordered.filter((workspace) => !workspace.disabled && workspace.linkState === "online")
  const flagged = ordered.filter(needsAttention)
  const reported = ordered.filter((workspace) => workspace.playersOnline !== null)
  const players = reported.reduce((sum, workspace) => sum + (workspace.playersOnline ?? 0), 0)
  const missingPlayers = ordered.length - reported.length

  const statusOrder = ["online", "offline", "unpaired", "error", "disabled"] as const
  const statusParts = statusOrder.map((key) => ({
    key,
    label: key === "disabled" ? t("card.disabled") : t(`link.${key}`),
    value: ordered.filter((workspace) => statusOf(workspace) === key).length,
    color: STATUS_COLOR[key],
  }))
  const statusLabel = statusParts
    .filter((part) => part.value > 0)
    .map((part) => `${part.label} ${part.value}`)
    .join(", ")

  function move(id: DashboardWidgetId, direction: -1 | 1) {
    setLayout((current) => {
      const index = current.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  function toggle(id: DashboardWidgetId) {
    setLayout((current) =>
      current.map((item) => (item.id === id ? { ...item, visible: !item.visible } : item)),
    )
  }

  function renderWidget(id: DashboardWidgetId) {
    if (id === "stats") {
      return (
        <div className="fields-mast" key={id}>
          <div className="fields-stats">
            <p className="has-note">
              <strong>{online.length}</strong>
              <span>
                {t("dashboard.activeInstances")}
                <em>{t("dashboard.onlineCount", { count: ordered.length })}</em>
              </span>
            </p>
            <p className="has-note">
              <strong className={flagged.length > 0 ? "warn" : undefined}>{flagged.length}</strong>
              <span>
                {t("dashboard.attention")}
                <em>{flagged.length === 0 ? t("dashboard.attentionQuiet") : t("dashboard.attentionSome")}</em>
              </span>
            </p>
            <p className={missingPlayers > 0 ? "has-note" : undefined}>
              <strong>{reported.length === 0 ? <MissingValue text={null} /> : players}</strong>
              <span>
                {t("dashboard.players")}
                {missingPlayers > 0 ? <em>{t("dashboard.playersMissing", { count: missingPlayers })}</em> : null}
              </span>
            </p>
          </div>
        </div>
      )
    }

    if (id === "status") {
      return (
        <section className="panel settings-card" key={id}>
          <h2>{t("dashboard.statusTitle")}</h2>
          <p className="hint">{t("dashboard.statusLead")}</p>
          <div className="chart-layout">
            <Donut parts={statusParts} label={statusLabel} />
            <ul className="legend">
              {statusParts
                .filter((part) => part.value > 0)
                .map((part) => (
                  <li key={part.key}>
                    <span className="swatch" style={{ background: part.color }} />
                    <span>{part.label}</span>
                    <strong>{part.value}</strong>
                  </li>
                ))}
            </ul>
          </div>
        </section>
      )
    }

    if (id === "players") {
      return (
        <section className="panel settings-card" key={id}>
          <h2>{t("dashboard.playersChart")}</h2>
          <p className="hint">{t("dashboard.playersLead")}</p>
          <div className="hbar-list">
            {ordered.map((workspace) => {
              const known =
                workspace.playersOnline !== null &&
                workspace.playerCapacity !== null &&
                workspace.playerCapacity > 0
              const width = known
                ? Math.min(100, (workspace.playersOnline! / workspace.playerCapacity!) * 100)
                : 0
              const value =
                workspace.playersOnline === null
                  ? null
                  : workspace.playerCapacity
                    ? t("dashboard.playersOf", {
                        online: workspace.playersOnline,
                        capacity: workspace.playerCapacity,
                      })
                    : String(workspace.playersOnline)
              return (
                <div key={workspace.id}>
                  <div className="hbar-top">
                    <span className="hbar-name">
                      <span className="ws-no">{workspace.number}</span>
                      <strong>{workspace.name}</strong>
                    </span>
                    <span className="faint">{value ?? t("unavailable")}</span>
                  </div>
                  <div className={known ? "hbar-track" : "hbar-track empty"} aria-hidden="true">
                    {known ? <span style={{ width: `${width}%` }} /> : null}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )
    }

    return (
      <section className="panel settings-card dash-panel" key={id}>
        <div className="dash-panel-head">
          <h2>{t("dashboard.attentionTitle")}</h2>
          {flagged.length > 0 ? <span className="faint">{t("dashboard.attentionCount", { count: flagged.length })}</span> : null}
        </div>
        {flagged.length === 0 ? <p className="muted">{t("dashboard.attentionEmpty")}</p> : null}
        <ul className="dash-list">
          {flagged.map((workspace) => {
            const reason = reasonOf(workspace)
            const detail =
              reason === "disabled" ||
              reason === "unpaired" ||
              reason === "stale" ||
              reason === "feed" ||
              reason === "offline"
                ? t(`notice.${reason}`)
                : t(`link.${workspace.linkState}`)
            return (
              <li key={workspace.id}>
                <Link className="dash-row" to={`/w/${workspace.id}`}>
                  <span className="ws-no">{workspace.number}</span>
                  <span>
                    <strong>{workspace.name}</strong>
                    <span className="faint">{detail}</span>
                  </span>
                  <span className={`dot ${statusOf(workspace) === "disabled" ? "unknown" : workspace.linkState}`} />
                </Link>
              </li>
            )
          })}
        </ul>
      </section>
    )
  }

  const visible = layout.filter((item) => item.visible)
  const rows: DashboardWidgetId[][] = []
  for (let index = 0; index < visible.length; index += 1) {
    const id = visible[index].id
    const meta = widgetMeta(id)
    const next = visible[index + 1]
    if (meta.span === "half" && next && widgetMeta(next.id).span === "half") {
      rows.push([id, next.id])
      index += 1
    } else if (meta.span === "half") {
      rows.push([id])
    } else {
      rows.push([id])
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{t("dashboard.welcome")}</h1>
          <p>{t("dashboard.lead")}</p>
        </div>
        <div className="toolbar">
          <button
            type="button"
            className={editing ? "btn btn-primary" : "btn btn-secondary"}
            onClick={() => setEditing((value) => !value)}
          >
            <LayoutTemplate className="icon" />
            {editing ? t("dashboard.doneEdit") : t("dashboard.edit")}
          </button>
          <Link className="btn btn-secondary" to="/instances">
            {t("dashboard.openInstances")}
          </Link>
        </div>
      </div>

      {ordered.length === 0 ? (
        <EmptyState title={t("dashboard.noAccessTitle")} body={t("dashboard.noAccessBody")} />
      ) : (
        <>
          {editing ? (
            <section className="panel dash-editor">
              <div className="dash-panel-head">
                <h2>{t("dashboard.editorTitle")}</h2>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setLayout(defaultDashboardLayout())}
                >
                  <RotateCcw className="icon" />
                  {t("dashboard.resetLayout")}
                </button>
              </div>
              <p className="hint">{t("dashboard.editorLead")}</p>
              <ul className="dash-editor-list">
                {layout.map((item, index) => {
                  const meta = widgetMeta(item.id)
                  return (
                    <li key={item.id}>
                      <span>
                        <strong>{t(meta.labelKey)}</strong>
                        <span className="faint">{item.visible ? t("dashboard.visible") : t("dashboard.hidden")}</span>
                      </span>
                      <span className="dash-editor-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          aria-label={t("dashboard.moveUp")}
                          disabled={index === 0}
                          onClick={() => move(item.id, -1)}
                        >
                          <ArrowUp className="icon" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          aria-label={t("dashboard.moveDown")}
                          disabled={index === layout.length - 1}
                          onClick={() => move(item.id, 1)}
                        >
                          <ArrowDown className="icon" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          aria-label={item.visible ? t("dashboard.hide") : t("dashboard.show")}
                          onClick={() => toggle(item.id)}
                        >
                          {item.visible ? <EyeOff className="icon" /> : <Eye className="icon" />}
                        </button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}

          <div className="dash-board">
            {rows.map((ids) => {
              if (ids.length === 2 || widgetMeta(ids[0]).span === "half") {
                return (
                  <div className="chart-grid" key={ids.join("-")}>
                    {ids.map((id) => renderWidget(id))}
                  </div>
                )
              }
              return renderWidget(ids[0])
            })}
          </div>
        </>
      )}
    </section>
  )
}
