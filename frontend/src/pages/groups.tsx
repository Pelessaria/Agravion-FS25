import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ServerCapToggles } from "../components/server-caps"
import { APP_MODULES, encodeServerCapabilities, serverCapabilities, type ServerCap } from "../modules"
import { useStore } from "../store"
import type { AccessGroup, ModuleAccess, WorkspaceRole } from "../types"

const ROLES: WorkspaceRole[] = ["workspace_admin", "manager", "operator", "viewer"]

export function GroupsPanel() {
  const { t } = useTranslation()
  const store = useStore()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")

  const ordered = [...store.groups].sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name))
  const selected = ordered.find((group) => group.id === selectedId) ?? ordered[0] ?? null

  function createGroup() {
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      store.pushToast("warn", t("groups.nameShort"))
      return
    }
    const id = store.createGroup({
      name: trimmed,
      description: description.trim(),
      grantsPlatformAdmin: false,
      workspaceRole: "viewer",
      modules: [],
      workspaceIds: [],
    })
    setName("")
    setDescription("")
    setCreating(false)
    setSelectedId(id)
    store.pushToast("ok", t("groups.created"))
  }

  function patch(group: AccessGroup, next: Partial<AccessGroup>) {
    store.updateGroup(group.id, next)
  }

  function toggleServer(group: AccessGroup, cap: ServerCap) {
    const current = group.modules.find((item) => item.moduleId === "server")?.access ?? null
    const caps = serverCapabilities(current)
    caps[cap] = !caps[cap]
    const next = encodeServerCapabilities(caps)
    const modules = group.modules.filter((item) => item.moduleId !== "server")
    patch(group, { modules: next ? [...modules, { moduleId: "server", access: next }] : modules })
  }

  function cycleModule(group: AccessGroup, moduleId: string) {
    const current = group.modules.find((item) => item.moduleId === moduleId)?.access ?? null
    const nextAccess: ModuleAccess | null = current === null ? "read" : current === "read" ? "write" : null
    const modules = group.modules.filter((item) => item.moduleId !== moduleId)
    patch(group, {
      modules: nextAccess ? [...modules, { moduleId, access: nextAccess }] : modules,
    })
  }

  return (
      <div className="people">
        <aside className="people-side">
          <div className="people-tools">
            <button type="button" className="btn btn-primary" onClick={() => setCreating((value) => !value)}>
              {t("groups.add")}
            </button>
          </div>
          {creating ? (
            <div className="stack">
              <label className="field">
                <span>{t("groups.name")}</span>
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="field">
                <span>{t("groups.description")}</span>
                <input value={description} onChange={(event) => setDescription(event.target.value)} />
              </label>
              <button type="button" className="btn btn-secondary" onClick={createGroup}>
                {t("groups.create")}
              </button>
            </div>
          ) : null}
          <div className="person-list">
            {ordered.map((group) => (
              <button
                key={group.id}
                type="button"
                className={["person", selected?.id === group.id ? "selected" : ""].filter(Boolean).join(" ")}
                aria-current={selected?.id === group.id ? "true" : undefined}
                onClick={() => setSelectedId(group.id)}
              >
                <span className="avatar" aria-hidden="true">
                  {group.name.slice(0, 1).toLocaleUpperCase()}
                </span>
                <span>
                  <strong>{group.name}</strong>
                  <span className="faint">
                    {group.grantsPlatformAdmin
                      ? t("groups.kindAdmin")
                      : t("groups.memberCount", { count: group.memberIds.length })}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        {selected ? (
          <article className="people-detail">
            <header className="person-head">
              <span className="avatar" aria-hidden="true">
                {selected.name.slice(0, 1).toLocaleUpperCase()}
              </span>
              <div>
                <h2>{selected.name}</h2>
                <p className="faint">{selected.description || t("groups.noDescription")}</p>
                <div className="person-meta">
                  <span className="badge">{selected.system ? t("groups.preset") : t("groups.custom")}</span>
                  {selected.grantsPlatformAdmin ? <span className="badge">{t("groups.kindAdmin")}</span> : null}
                </div>
              </div>
            </header>

            {!selected.system ? (
              <div className="stack">
                <label className="field">
                  <span>{t("groups.name")}</span>
                  <input
                    value={selected.name}
                    onChange={(event) => patch(selected, { name: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t("groups.description")}</span>
                  <input
                    value={selected.description}
                    onChange={(event) => patch(selected, { description: event.target.value })}
                  />
                </label>
              </div>
            ) : (
              <p className="access-note">{t("groups.presetHint")}</p>
            )}

            {!selected.grantsPlatformAdmin ? (
              <>
                <div className="access-intro">
                  <h3>{t("groups.rightsTitle")}</h3>
                  <p className="faint">{t("groups.rightsHint")}</p>
                </div>
                <label className="field">
                  <span>{t("groups.workspaceRole")}</span>
                  <select
                    value={selected.workspaceRole ?? "viewer"}
                    disabled={selected.system && selected.id === "grp-ws-admin"}
                    onChange={(event) =>
                      patch(selected, { workspaceRole: event.target.value as WorkspaceRole })
                    }
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(`users.roles.${role}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="group-workspaces">
                  <h3>{t("groups.workspaces")}</h3>
                  <ul className="chip-check-list">
                    {[...store.workspaces]
                      .sort((a, b) => a.number - b.number)
                      .map((workspace) => {
                        const on = selected.workspaceIds.includes(workspace.id)
                        return (
                          <li key={workspace.id}>
                            <button
                              type="button"
                              className={on ? "chip-check on" : "chip-check"}
                              onClick={() =>
                                patch(selected, {
                                  workspaceIds: on
                                    ? selected.workspaceIds.filter((id) => id !== workspace.id)
                                    : [...selected.workspaceIds, workspace.id],
                                })
                              }
                            >
                              <span className="ws-no">{workspace.number}</span>
                              {workspace.name}
                            </button>
                          </li>
                        )
                      })}
                  </ul>
                </div>
                {selected.workspaceRole !== "workspace_admin" ? (
                  <div className="module-panel static">
                    <h3>{t("groups.modules")}</h3>
                    <ul className="module-list">
                      {APP_MODULES.map((module) => {
                        const access =
                          selected.modules.find((item) => item.moduleId === module.id)?.access ?? null
                        const right =
                          access === "write"
                            ? t("modules.write")
                            : access === "read"
                              ? t("modules.read")
                              : t("modules.hidden")
                        return (
                          <li className="module-row" key={module.id}>
                            <span className="module-name">{t(module.labelKey)}</span>
                            {module.id === "server" ? (
                              <ServerCapToggles access={access} onToggle={(cap) => toggleServer(selected, cap)} />
                            ) : (
                              <button
                                type="button"
                                className={access ? `perm ${access}` : "perm"}
                                onClick={() => cycleModule(selected, module.id)}
                              >
                                {right}
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ) : (
                  <p className="muted">{t("groups.adminModules")}</p>
                )}
              </>
            ) : (
              <p className="muted">{t("groups.adminBody")}</p>
            )}

            <div className="access-intro">
              <h3>{t("groups.members")}</h3>
              <p className="faint">{t("groups.membersHint")}</p>
            </div>
            <ul className="group-members">
              {store.users.map((user) => {
                const on = selected.memberIds.includes(user.id)
                return (
                  <li key={user.id}>
                    <span>
                      <strong>{user.name}</strong>
                      <span className="faint">{user.email}</span>
                    </span>
                    <button
                      type="button"
                      className="switch"
                      role="switch"
                      aria-checked={on}
                      aria-label={t("groups.toggleMember", { name: user.name })}
                      disabled={selected.grantsPlatformAdmin && on && user.id === store.sessionUserId}
                      onClick={() => store.setGroupMember(selected.id, user.id, !on)}
                    >
                      <span />
                    </button>
                  </li>
                )
              })}
            </ul>

            {!selected.system ? (
              <div className="setting-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    if (store.deleteGroup(selected.id)) {
                      setSelectedId(null)
                      store.pushToast("ok", t("groups.deleted"))
                    }
                  }}
                >
                  {t("groups.delete")}
                </button>
              </div>
            ) : null}
          </article>
        ) : null}
      </div>
  )
}
