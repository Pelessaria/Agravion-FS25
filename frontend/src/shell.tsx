import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import {
  ArrowLeft,
  Bell,
  CalendarDays,
  Clock3,
  CloudSun,
  House,
  Landmark,
  LayoutDashboard,
  LogOut,
  Map,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  PawPrint,
  Play,
  RefreshCw,
  Server,
  Settings,
  Sprout,
  Tag,
  Tractor,
  Users,
  Wallet,
  X,
} from "lucide-react"
import { apiWorkspaceFarms, apiWorkspaceLiveMap, type LiveMapResponse } from "./api"
import { FarmSwitcher } from "./components/farm-switcher"
import { BrandLockup, BrandMark, Toasts, useTimeLabel } from "./components/ui"
import { seedNotifications, type AppNotification } from "./demo-notifications"
import { i18n } from "./i18n"
import { APP_MODULES, MODULE_SECTIONS, moduleIsReady, type ModuleId } from "./modules"
import { useStore } from "./store"
import { MANAGEMENT_VERSION } from "./version"

const MODULE_ICONS: Record<ModuleId, ComponentType<{ className?: string }>> = {
  map: Map,
  weather: CloudSun,
  fields: Sprout,
  equipment: Tractor,
  animals: PawPrint,
  storage: Package,
  finance: Wallet,
  trade: Landmark,
  farm: House,
  server: Server,
}

function chooseLocale(lng: "de" | "en") {
  void i18n.changeLanguage(lng)
  localStorage.setItem("fs25.locale", lng)
  document.documentElement.lang = lng
}

const PERIOD_TO_MONTH = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2]

function clockLabel(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null
  const ms = value > 0 && value <= 1 ? value * 24 * 60 * 60 * 1000 : value
  if (ms < 0 || ms > 48 * 60 * 60 * 1000) return null
  const minutes = Math.floor(ms / 60000) % (24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

function worldPlayerCount(live: LiveMapResponse | null, fallback: number | null) {
  if (!live?.ok) return fallback
  const names = new Set<string>()
  for (const player of live.players) {
    const name = player.name?.trim()
    names.add(name ? name : player.id)
  }
  for (const vehicle of live.vehicles) {
    if (!vehicle.controlled) continue
    const name = vehicle.driver?.trim()
    names.add(name ? name : `vehicle:${vehicle.id}`)
  }
  if (fallback != null && fallback > names.size) return fallback
  return names.size
}

function ContextStat({
  symbol,
  value,
  label,
  className,
}: {
  symbol: ReactNode
  value: string
  label: string
  className?: string
}) {
  return (
    <span className={["context-stat", className].filter(Boolean).join(" ")} title={`${label}: ${value}`}>
      {symbol}
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  )
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? "")
    .join("")
}

export function Shell() {
  const { t, i18n: current } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const stamp = useTimeLabel()
  const {
    actor,
    accessibleFarms,
    canManageUsers,
    canManageWorkspace,
    moduleAccess,
    selectedFarm,
    sessionUserId,
    setSelectedFarm,
    setViewUser,
    signOut,
    users,
    viewUserId,
    workspaces,
    liveMode,
    replaceWorkspaceFarms,
    upsertWorkspace,
  } = useStore()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("fs25.sidebar") === "collapsed")
  const [drawer, setDrawer] = useState(false)
  const [menu, setMenu] = useState<"user" | "notify" | null>(null)
  const [notifications, setNotifications] = useState<AppNotification[]>(seedNotifications)
  const [farmsBusy, setFarmsBusy] = useState(false)
  const headerMenusRef = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<LiveMapResponse | null>(null)

  const workspaceId = location.pathname.match(/^\/w\/([^/]+)/)?.[1]
  const workspace = workspaceId ? workspaces.find((item) => item.id === workspaceId) : undefined
  const [seenPath, setSeenPath] = useState(location.pathname)
  if (seenPath !== location.pathname) {
    setSeenPath(location.pathname)
    setDrawer(false)
    setMenu(null)
  }

  useEffect(() => {
    setMenu(null)
  }, [workspaceId])

  // Discover farm stubs from the savegame when opening a live workspace.
  useEffect(() => {
    if (!liveMode || !workspace || !workspace.feedConfigured) return
    let cancelled = false
    setFarmsBusy(true)
    void (async () => {
      try {
        const result = await apiWorkspaceFarms(workspace.id, { sync: true })
        if (cancelled) return
        replaceWorkspaceFarms(workspace.id, result.farms)
        if (result.workspace) upsertWorkspace(result.workspace)
      } catch {
        /* keep previous stubs */
      } finally {
        if (!cancelled) setFarmsBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [liveMode, workspace?.id, workspace?.feedConfigured])

  useEffect(() => {
    if (!liveMode || !workspace || workspace.disabled) {
      setLive(null)
      return
    }
    const workspaceId = workspace.id
    let cancelled = false
    const load = async () => {
      if (document.hidden) return
      try {
        const next = await apiWorkspaceLiveMap(workspaceId)
        if (!cancelled) setLive(next)
      } catch {
        // Keep the last reading. The bar shows a dash until the first one arrives.
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [liveMode, workspace?.id, workspace?.disabled])

  useEffect(() => {
    localStorage.setItem("fs25.sidebar", collapsed ? "collapsed" : "open")
  }, [collapsed])

  useEffect(() => {
    if (!menu) return
    function onPointer(event: PointerEvent) {
      if (headerMenusRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    window.addEventListener("pointerdown", onPointer)
    return () => window.removeEventListener("pointerdown", onPointer)
  }, [menu])

  const moduleId = location.pathname.match(/\/m\/([^/]+)/)?.[1]
  const moduleLabel = APP_MODULES.find((item) => item.id === moduleId)
  const title = workspace
    ? location.pathname.includes("/equipment/") || location.pathname.includes("/vehicles/")
      ? t("vehicles.detail")
      : location.pathname.includes("/equipment") || location.pathname.includes("/vehicles")
        ? t("modules.equipment")
        : location.pathname.endsWith("/settings")
          ? t("wsettings.title")
          : moduleLabel
            ? t(moduleLabel.labelKey)
            : t("nav.overview")
      : location.pathname.startsWith("/instances/new")
        ? t("create.title")
        : location.pathname.startsWith("/instances")
          ? t("control.title")
          : location.pathname.startsWith("/access")
            ? t("access.title")
            : location.pathname.startsWith("/settings")
              ? t("settings.title")
              : t("dashboard.title")

  useEffect(() => {
    document.title = `${title} · ${t("appName")}`
  }, [t, title])

  const unread = notifications.filter((item) => !item.read).length
  const avatarLabel = actor?.name ?? t("profile.open")
  const farms = workspace ? accessibleFarms(workspace.id) : []
  const farm = workspace ? selectedFarm(workspace.id) : null
  const monthIndex = live?.period != null && live.period >= 1 && live.period <= 12 ? PERIOD_TO_MONTH[live.period - 1] : null
  const dayValue =
    live?.day != null ? (monthIndex != null ? `${live.day} · ${t(`fields.month.${monthIndex}`)}` : String(live.day)) : "—"
  const playerTotal = worldPlayerCount(live, workspace?.playersOnline ?? null)
  const playerCapacity = workspace?.playerCapacity ?? null
  const playerValue =
    playerTotal == null && playerCapacity == null ? "—" : `${playerTotal ?? "—"} / ${playerCapacity ?? "—"}`
  const balanceValue =
    farm?.money == null
      ? "—"
      : new Intl.NumberFormat(current.language, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(farm.money)
  const linkLabel = workspace ? (workspace.disabled ? t("card.disabled") : t(`link.${workspace.linkState}`)) : ""

  return (
    <div className={collapsed ? "shell collapsed" : "shell"}>
      <a className="skip" href="#content">
        {t("skip")}
      </a>
      <aside className={drawer ? "sidebar open" : "sidebar"}>
        <div className="side-brand">
          <BrandMark />
          <BrandLockup size="sidebar" />
          <button
            type="button"
            className="btn btn-ghost btn-icon mobile-only"
            aria-label={t("close")}
            onClick={() => setDrawer(false)}
          >
            <X className="icon" />
          </button>
        </div>
        {workspace ? (
          <div className="side-workspace">
            <Link className="nav-exit" to="/instances">
              <ArrowLeft className="icon" />
              <span className="nav-label">{t("workspace.back")}</span>
            </Link>
            <FarmSwitcher
              farms={farms}
              farm={farm}
              collapsed={collapsed}
              discovering={farmsBusy && farms.length === 0}
              onSelect={(farmId) => setSelectedFarm(workspace.id, farmId)}
            />
          </div>
        ) : null}
        <nav className="nav" aria-label={t("menu")}>
          {workspace ? (
            <>
              <NavLink to={`/w/${workspace.id}`} end>
                <LayoutDashboard className="icon" />
                <span className="nav-label">{t("nav.overview")}</span>
              </NavLink>
              {MODULE_SECTIONS.map((section) => {
                const items = APP_MODULES.filter(
                  (module) => module.section === section.id && moduleAccess(workspace.id, module.id),
                ).sort((a, b) =>
                  t(a.labelKey).localeCompare(t(b.labelKey), current.language, { sensitivity: "base" }),
                )
                if (items.length === 0) return null
                return (
                  <div key={section.id} className="nav-section">
                    <p className="nav-section-label nav-label">{t(section.labelKey)}</p>
                    {items.map((module) => {
                      const Icon = MODULE_ICONS[module.id]
                      if (!moduleIsReady(module.id)) {
                        return (
                          <span key={module.id} className="is-unavailable" aria-disabled="true">
                            <Icon className="icon" />
                            <span className="nav-label">{t(module.labelKey)}</span>
                          </span>
                        )
                      }
                      return (
                        <NavLink key={module.id} to={`/w/${workspace.id}/${module.path}`}>
                          <Icon className="icon" />
                          <span className="nav-label">{t(module.labelKey)}</span>
                        </NavLink>
                      )
                    })}
                  </div>
                )
              })}
              {canManageWorkspace(workspace.id) ? (
                <>
                  <div className="nav-spacer" role="presentation" />
                  <NavLink to={`/w/${workspace.id}/settings`}>
                    <Settings className="icon" />
                    <span className="nav-label">{t("nav.workspaceSettings")}</span>
                  </NavLink>
                </>
              ) : null}
            </>
          ) : (
            <>
              <NavLink to="/" end>
                <LayoutDashboard className="icon" />
                <span className="nav-label">{t("nav.dashboard")}</span>
              </NavLink>
              <NavLink to="/instances">
                <Server className="icon" />
                <span className="nav-label">{t("nav.control")}</span>
              </NavLink>
              {canManageUsers() ? (
                <NavLink to="/access">
                  <Users className="icon" />
                  <span className="nav-label">{t("nav.access")}</span>
                </NavLink>
              ) : null}
              <NavLink to="/settings">
                <Settings className="icon" />
                <span className="nav-label">{t("nav.settings")}</span>
              </NavLink>
            </>
          )}
        </nav>
        <footer className="side-foot">
          {!liveMode ? (
            <label className="side-viewas">
              <span className="nav-label">{t("settings.viewAs")}</span>
              <select
                value={viewUserId ?? sessionUserId ?? ""}
                onChange={(event) => setViewUser(event.target.value)}
                title={t("settings.viewAsHint")}
                aria-label={t("settings.viewAs")}
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.active ? user.name : `${user.name} (${t("users.inactive")})`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {workspace ? (
            <div className="side-instance" title={`${t("context.instance")}: ${workspace.name} · ${linkLabel}`}>
              <span className="side-instance-label nav-label">{t("context.instance")}</span>
              <div className="side-instance-row">
                <span className="ws-no">{workspace.number}</span>
                <span className={`dot ${workspace.disabled ? "unknown" : workspace.linkState}`} />
                <span className="side-instance-copy nav-label">
                  <strong>{workspace.name}</strong>
                  <span>{linkLabel}</span>
                </span>
              </div>
            </div>
          ) : null}
          <p className="side-version">
            <span className="nav-label">{t("shell.product")}</span>
            <strong>{MANAGEMENT_VERSION}</strong>
          </p>
        </footer>
      </aside>
      {drawer ? (
        <button type="button" className="backdrop" aria-label={t("close")} onClick={() => setDrawer(false)} />
      ) : null}
      <div className="main">
        <header className="header">
          <div className="header-bar">
            <div className="header-title">
              {workspace ? (
                <>
                  <img className="header-logo" src="/logo.svg" alt="" width="36" height="36" />
                  <div>
                    <strong>{title}</strong>
                    <span>{workspace.name}</span>
                  </div>
                </>
              ) : (
                <div className="mobile-only header-mobile-title">
                  <img className="header-logo" src="/logo.svg" alt="" width="36" height="36" />
                  <strong>{title}</strong>
                </div>
              )}
            </div>
            <div className="header-actions">
              {!liveMode ? (
                <span className="demo-chip" title={t("demoBanner")}>
                  {t("demo")}
                </span>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost btn-icon mobile-only"
                aria-label={t("menu")}
                onClick={() => setDrawer(true)}
              >
                <Menu className="icon" />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon desktop-only"
                aria-label={collapsed ? t("expand") : t("collapse")}
                onClick={() => setCollapsed((value) => !value)}
              >
                {collapsed ? <PanelLeftOpen className="icon" /> : <PanelLeftClose className="icon" />}
              </button>
              <div className="header-menus" ref={headerMenusRef}>
                <div className="menu-wrap">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon notify-btn"
                    aria-label={t("notify.open")}
                    aria-expanded={menu === "notify"}
                    onClick={() => setMenu((value) => (value === "notify" ? null : "notify"))}
                  >
                    <Bell className="icon" />
                    {unread > 0 ? <span className="notify-dot" aria-hidden="true" /> : null}
                  </button>
                  {menu === "notify" ? (
                    <div className="dropdown notify-tray">
                      <div className="notify-head">
                        <strong>{t("notify.title")}</strong>
                        {unread > 0 ? (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() =>
                              setNotifications((current) => current.map((item) => ({ ...item, read: true })))
                            }
                          >
                            {t("notify.markAll")}
                          </button>
                        ) : null}
                      </div>
                      {notifications.length === 0 ? <p className="muted">{t("notify.empty")}</p> : null}
                      <ul className="notify-list">
                        {notifications.map((item) => {
                          const target = item.workspaceId ? `/w/${item.workspaceId}` : "/instances"
                          return (
                            <li key={item.id}>
                              <button
                                type="button"
                                className={item.read ? "notify-item" : "notify-item unread"}
                                onClick={() => {
                                  setNotifications((current) =>
                                    current.map((entry) =>
                                      entry.id === item.id ? { ...entry, read: true } : entry,
                                    ),
                                  )
                                  setMenu(null)
                                  navigate(target)
                                }}
                              >
                                <span className={`notify-tone ${item.tone}`} />
                                <span>
                                  <strong>{t(item.titleKey)}</strong>
                                  <span className="faint">{t(item.bodyKey)}</span>
                                  <span className="faint">{stamp(item.at, "")}</span>
                                </span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
                <div className="menu-wrap">
                  <button
                    type="button"
                    className="profile-trigger"
                    aria-label={t("profile.open")}
                    aria-expanded={menu === "user"}
                    onClick={() => setMenu((value) => (value === "user" ? null : "user"))}
                  >
                    {actor?.avatarDataUrl ? (
                      <img src={actor.avatarDataUrl} alt="" />
                    ) : (
                      <span>{initials(avatarLabel)}</span>
                    )}
                  </button>
                  {menu === "user" ? (
                    <div className="dropdown profile-menu">
                      <div className="profile-menu-head">
                        <strong>{actor?.name ?? t("logout")}</strong>
                        <span className="faint">{actor?.email}</span>
                      </div>
                      <div className="menu-lang">
                        <span>{t("language")}</span>
                        <div className="lang" role="group" aria-label={t("language")}>
                          <button
                            type="button"
                            aria-pressed={current.language !== "en"}
                            aria-label={t("german")}
                            onClick={() => chooseLocale("de")}
                          >
                            DE
                          </button>
                          <button
                            type="button"
                            aria-pressed={current.language === "en"}
                            aria-label={t("english")}
                            onClick={() => chooseLocale("en")}
                          >
                            EN
                          </button>
                        </div>
                      </div>
                      <Link to="/settings" onClick={() => setMenu(null)}>
                        <Settings className="icon" />
                        {t("profile.settings")}
                      </Link>
                      <button
                        type="button"
                        onClick={() => {
                          void signOut().then(() => navigate("/login"))
                        }}
                      >
                        <LogOut className="icon" />
                        {t("logout")}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </header>
        {workspace ? (
          <div className="context">
            <div className="context-bar" aria-label={t("context.bar")}>
              <ContextStat
                symbol={live?.paused ? <Pause className="icon" /> : <Play className="icon" />}
                value={live ? (live.paused ? t("context.paused") : t("context.active")) : "—"}
                label={t("context.play")}
                className={live?.paused ? "is-paused" : undefined}
              />
              <span className="context-pipe" aria-hidden="true">|</span>
              <ContextStat
                symbol={<CalendarDays className="icon" />}
                value={dayValue}
                label={t("context.day")}
              />
              <span className="context-pipe" aria-hidden="true">|</span>
              <ContextStat
                symbol={<Clock3 className="icon" />}
                value={clockLabel(live?.dayTime ?? null) ?? "—"}
                label={t("context.time")}
              />
              <span className="context-pipe" aria-hidden="true">|</span>
              <ContextStat
                symbol={<Users className="icon" />}
                value={playerValue}
                label={t("context.players")}
              />
              {farm ? (
                <>
                  <span className="context-pipe" aria-hidden="true">|</span>
                  <ContextStat
                    symbol={<House className="icon" />}
                    value={farm.name?.trim() || t("farm.stubName", { id: farm.gameFarmId })}
                    label={t("context.farm")}
                  />
                  <span className="context-pipe" aria-hidden="true">|</span>
                  <ContextStat
                    symbol={<Wallet className="icon" />}
                    value={balanceValue}
                    label={t("context.balance")}
                  />
                </>
              ) : null}
              <span className="context-pipe" aria-hidden="true">|</span>
              <ContextStat
                symbol={<RefreshCw className="icon" />}
                value={workspace.lastSyncAt ? stamp(workspace.lastSyncAt, "—") : "—"}
                label={t("context.sync")}
              />
              <span className="context-pipe" aria-hidden="true">|</span>
              <ContextStat
                symbol={<Map className="icon" />}
                value={workspace.mapName?.trim() || "—"}
                label={t("context.map")}
              />
              <span className="context-pipe" aria-hidden="true">|</span>
              <ContextStat
                symbol={<Tag className="icon" />}
                value={workspace.gameVersion?.trim() || "—"}
                label={t("workspace.gameVersion")}
              />
            </div>
          </div>
        ) : null}
        <main id="content" className="content">
          <Outlet />
        </main>
      </div>
      <Toasts />
    </div>
  )
}
