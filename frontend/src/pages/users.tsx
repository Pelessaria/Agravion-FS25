import { useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import {
  Check,
  ChevronRight,
  CloudSun,
  House,
  Landmark,
  Server,
  LoaderCircle,
  Map,
  Package,
  PawPrint,
  Sprout,
  Tractor,
  Wallet,
} from "lucide-react"
import { apiSaveModuleAccess, ApiError } from "../api"
import { ServerCapToggles } from "../components/server-caps"
import { APP_MODULES, encodeServerCapabilities, serverCapabilities, type ModuleId, type ServerCap } from "../modules"
import { useStore } from "../store"
import type { AppUser, GlobalRole, ModuleAccess, Workspace, WorkspaceRole } from "../types"
import { isEmail } from "../validate"

const MODULE_ICONS: Record<ModuleId, typeof Map> = {
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

const WORKSPACE_ROLES: WorkspaceRole[] = ["workspace_admin", "manager", "operator", "viewer"]

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? "")
    .join("")
}

export function UsersPanel() {
  const { t } = useTranslation()
  const store = useStore()
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [openSpaces, setOpenSpaces] = useState<Record<string, boolean>>({})
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [nameError, setNameError] = useState("")
  const [emailError, setEmailError] = useState("")
  const [pending, setPending] = useState(false)

  const needle = query.trim().toLocaleLowerCase()
  const visible = store.users.filter((user) => {
    if (!needle) return true
    return user.name.toLocaleLowerCase().includes(needle) || user.email.toLocaleLowerCase().includes(needle)
  })
  const selected = visible.find((user) => user.id === selectedId) ?? visible[0] ?? null

  function submit(event: FormEvent) {
    event.preventDefault()
    const nextName = name.trim() ? "" : t("users.nameRequired")
    const nextEmail = isEmail(email) ? "" : t("users.emailInvalid")
    setNameError(nextName)
    setEmailError(nextEmail)
    if (nextName || nextEmail) return
    setPending(true)
    window.setTimeout(() => {
      const result = store.createUser(name, email)
      setPending(false)
      if (result === "taken") {
        setEmailError(t("users.emailTaken"))
        return
      }
      setName("")
      setEmail("")
      setCreating(false)
      setSelectedId(result)
      store.pushToast("ok", t("users.created"))
    }, 500)
  }

  function setAccess(user: AppUser, workspace: Workspace, enabled: boolean) {
    if (enabled) {
      const current = user.memberships.find((item) => item.workspaceId === workspace.id)
      store.assign(user.id, workspace.id, current?.role ?? "viewer")
      return
    }
    store.unassign(user.id, workspace.id)
  }

  async function setModule(user: AppUser, workspaceId: string, moduleId: string, current: ModuleAccess | null) {
    const next = current === null ? "read" : current === "read" ? "write" : null
    if (store.liveMode && user.globalRole !== "admin") {
      try {
        await apiSaveModuleAccess(workspaceId, user.id, moduleId, next ?? "none")
      } catch (caught) {
        store.pushToast("warn", caught instanceof ApiError ? caught.message : t("users.accessFailed"))
        return
      }
    }
    store.setModuleAccess(user.id, workspaceId, moduleId, next)
  }

  async function setServerCap(user: AppUser, workspaceId: string, current: string | null, cap: ServerCap) {
    const nextCaps = serverCapabilities(current)
    nextCaps[cap] = !nextCaps[cap]
    const next = encodeServerCapabilities(nextCaps)
    if (store.liveMode && user.globalRole !== "admin") {
      try {
        await apiSaveModuleAccess(workspaceId, user.id, "server", next ?? "none")
      } catch (caught) {
        store.pushToast("warn", caught instanceof ApiError ? caught.message : t("users.accessFailed"))
        return
      }
    }
    store.setModuleAccess(user.id, workspaceId, "server", next)
  }

  return (
      <div className="people">
        <aside className="people-side">
          <div className="people-tools">
            <label className="field">
              <span>{t("users.search")}</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <button type="button" className="btn btn-primary" onClick={() => setCreating((value) => !value)}>
              {t("users.add")}
            </button>
          </div>
          {creating ? (
            <form className="stack" onSubmit={submit} noValidate>
              <label className="field">
                <span>{t("users.name")}</span>
                <input value={name} aria-invalid={nameError ? true : undefined} onChange={(event) => setName(event.target.value)} />
                {nameError ? <span className="field-error">{nameError}</span> : null}
              </label>
              <label className="field">
                <span>{t("users.email")}</span>
                <input
                  type="email"
                  value={email}
                  aria-invalid={emailError ? true : undefined}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {emailError ? <span className="field-error">{emailError}</span> : null}
              </label>
              <button className="btn btn-secondary" type="submit" disabled={pending}>
                {pending ? <LoaderCircle className="icon spin" /> : null}
                {pending ? t("users.creating") : t("users.create")}
              </button>
            </form>
          ) : null}
          {visible.length === 0 ? <p className="faint">{t("users.noMatch")}</p> : null}
          <div className="person-list">
            {visible.map((user) => {
              const count = user.globalRole === "admin" ? store.workspaces.length : user.memberships.length
              return (
                <button
                  key={user.id}
                  type="button"
                  className={[
                    "person",
                    selected?.id === user.id ? "selected" : "",
                    user.active ? "" : "inactive",
                  ].filter(Boolean).join(" ")}
                  aria-current={selected?.id === user.id ? "true" : undefined}
                  onClick={() => setSelectedId(user.id)}
                >
                  <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
                  <span>
                    <strong>{user.name}</strong>
                    <span className="faint">
                      {user.globalRole === "admin" ? t("users.allWorkspaces") : t("users.accessCount", { count })}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>
        {selected ? (
          <article className="people-detail">
            <header className="person-head">
              <span className={selected.active ? "avatar" : "avatar muted"} aria-hidden="true">{initials(selected.name)}</span>
              <div>
                <h2>{selected.name}</h2>
                <p className="faint">{selected.email}</p>
                <div className="person-meta">
                  <span className="badge">{selected.globalRole === "admin" ? t("users.globalAdmin") : t("users.member")}</span>
                  {selected.id === store.sessionUserId ? (
                    <span className="faint">{t("users.selfAccount")}</span>
                  ) : (
                    <>
                      <span className="faint">{t("users.activeAccount")}</span>
                      <button
                        type="button"
                        className="switch"
                        role="switch"
                        aria-checked={selected.active}
                        aria-label={t("users.activeAccount")}
                        onClick={() => store.setUserActive(selected.id, !selected.active)}
                      >
                        <span />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </header>
            {!selected.active ? <p className="access-note">{t("users.inactiveHint")}</p> : null}

            <div className="access-intro">
              <h3>{t("users.platformRole")}</h3>
              <p className="faint">{t("users.platformRoleHint")}</p>
            </div>
            <label className="field">
              <span>{t("users.role")}</span>
              <select
                value={selected.globalRole}
                disabled={selected.id === store.sessionUserId}
                onChange={(event) => store.setGlobalRole(selected.id, event.target.value as GlobalRole)}
              >
                <option value="admin">{t("users.globalAdmin")}</option>
                <option value="member">{t("users.member")}</option>
              </select>
            </label>

            <div className="access-intro">
              <h3>{t("users.groupsTitle")}</h3>
              <p className="faint">{t("users.groupsHint")}</p>
            </div>
            <ul className="chip-check-list">
              {store.groups.map((group) => {
                const on = selected.groupIds.includes(group.id) || group.memberIds.includes(selected.id)
                return (
                  <li key={group.id}>
                    <button
                      type="button"
                      className={on ? "chip-check on" : "chip-check"}
                      disabled={group.grantsPlatformAdmin && on && selected.id === store.sessionUserId}
                      onClick={() => store.setGroupMember(group.id, selected.id, !on)}
                    >
                      {group.name}
                    </button>
                  </li>
                )
              })}
            </ul>

            <div className="access-intro">
              <h3>{t("users.accessTitle")}</h3>
              <p className="faint">{selected.globalRole === "admin" ? t("users.adminAll") : t("users.accessHint")}</p>
            </div>
            <ul className="access-list">
              {[...store.workspaces].sort((a, b) => a.number - b.number).map((workspace) => {
                const membership = selected.memberships.find((item) => item.workspaceId === workspace.id)
                const enabled = Boolean(membership)
                const admin = selected.globalRole === "admin"
                const open = Boolean(openSpaces[workspace.id])
                const fullModules = membership?.role === "workspace_admin"
                return (
                  <li className={open ? "access-block open" : "access-block"} key={workspace.id}>
                    <div className="access-row">
                      <button
                        type="button"
                        className="access-toggle"
                        aria-expanded={open}
                        onClick={() => setOpenSpaces((current) => ({ ...current, [workspace.id]: !open }))}
                      >
                        <ChevronRight className="icon" />
                        <span className={`dot ${workspace.disabled ? "unknown" : workspace.linkState}`} />
                        <span className="title-with-no">
                          <span className="ws-no">{workspace.number}</span>
                          <span>
                            <strong>{workspace.name}</strong>
                            {workspace.mapName ? <span className="faint">{workspace.mapName}</span> : null}
                          </span>
                        </span>
                      </button>
                      {admin ? (
                        <span className="faint">{t("users.open")}</span>
                      ) : (
                        <button
                          type="button"
                          className="switch"
                          role="switch"
                          aria-checked={enabled}
                          aria-label={t("users.grant", { name: workspace.name })}
                          onClick={() => setAccess(selected, workspace, !enabled)}
                        >
                          <span />
                        </button>
                      )}
                    </div>
                    {open ? (
                      <div className="module-panel">
                        {!admin && !enabled ? <p className="module-lock">{t("users.needWorkspace")}</p> : null}
                        {!admin && enabled ? (
                          <label className="field">
                            <span>{t("users.workspaceRole")}</span>
                            <select
                              value={membership?.role ?? "viewer"}
                              onChange={(event) =>
                                store.assign(selected.id, workspace.id, event.target.value as WorkspaceRole)
                              }
                            >
                              {WORKSPACE_ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {t(`users.roles.${role}`)}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        {fullModules ? <p className="module-lock">{t("users.workspaceAdminModules")}</p> : null}
                        <ul className="module-list">
                          {APP_MODULES.map((module) => {
                            const access = admin || fullModules
                              ? "write"
                              : (membership?.modules.find((item) => item.moduleId === module.id)?.access ?? null)
                            const right = access === "write" ? t("modules.write") : access === "read" ? t("modules.read") : t("modules.hidden")
                            const Icon = MODULE_ICONS[module.id]
                            return (
                              <li className={admin || enabled ? "module-row" : "module-row off"} key={module.id}>
                                <span className="module-name">
                                  <Icon className="icon" aria-hidden="true" />
                                  {t(module.labelKey)}
                                </span>
                                {module.id === "server" ? (
                                  <ServerCapToggles
                                    access={admin || fullModules ? "write" : access}
                                    disabled={admin || fullModules || !enabled}
                                    onToggle={(cap) => void setServerCap(selected, workspace.id, access, cap)}
                                  />
                                ) : (
                                <button
                                  type="button"
                                  className={access ? `perm ${access}` : "perm"}
                                  disabled={admin || fullModules || !enabled}
                                  aria-label={t("modules.cycle", { module: t(module.labelKey), right })}
                                  onClick={() => void setModule(selected, workspace.id, module.id, access === "read" || access === "write" ? access : null)}
                                >
                                  <span className="perm-checks" aria-hidden="true">
                                    <Check className={access ? "icon perm-mark on" : "icon perm-mark"} />
                                    <Check className={access === "write" ? "icon perm-mark on" : "icon perm-mark"} />
                                  </span>
                                  <span>{right}</span>
                                </button>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </article>
        ) : null}
      </div>
  )
}
