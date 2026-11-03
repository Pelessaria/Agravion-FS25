import { useTranslation } from "react-i18next"
import { SERVER_CAPS, serverCapabilities, type ServerCap } from "../modules"

export function ServerCapToggles({
  access,
  disabled,
  onToggle,
}: {
  access: string | null
  disabled?: boolean
  onToggle: (cap: ServerCap) => void
}) {
  const { t } = useTranslation()
  const caps = serverCapabilities(access)

  return (
    <span className="perm-flags">
      {SERVER_CAPS.map((cap) => (
        <button
          key={cap}
          type="button"
          className={caps[cap] ? "perm-flag on" : "perm-flag"}
          disabled={disabled}
          aria-pressed={caps[cap]}
          title={t(`modules.serverCaps.${cap}Tip`)}
          onClick={() => onToggle(cap)}
        >
          {t(`modules.serverCaps.${cap}`)}
        </button>
      ))}
    </span>
  )
}
