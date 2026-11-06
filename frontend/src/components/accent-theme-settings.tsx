import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ACCENT_PRESETS,
  applyAccentPreference,
  normalizeAccentHex,
  readAccentPreference,
  writeAccentPreference,
  type AccentPresetId,
  type AccentThemePreference,
} from "../accent-theme"
import { useStore } from "../store"

const NAMED: Exclude<AccentPresetId, "custom">[] = ["red", "green", "blue", "yellow", "orange", "violet"]

const PRESET_LABEL: Record<Exclude<AccentPresetId, "custom">, string> = {
  red: "accentPresetRed",
  green: "accentPresetGreen",
  blue: "accentPresetBlue",
  yellow: "accentPresetYellow",
  orange: "accentPresetOrange",
  violet: "accentPresetViolet",
}

export function AccentThemeSettings() {
  const { t } = useTranslation()
  const { pushToast } = useStore()
  const [pref, setPref] = useState<AccentThemePreference>(() => readAccentPreference())
  const [customDraft, setCustomDraft] = useState(() => pref.custom ?? ACCENT_PRESETS.red.accent)

  const colorValue = useMemo(() => {
    if (pref.id === "custom") return normalizeAccentHex(customDraft) ?? ACCENT_PRESETS.red.accent
    return ACCENT_PRESETS[pref.id].accent
  }, [pref, customDraft])

  function commit(next: AccentThemePreference, toast = true) {
    writeAccentPreference(next)
    applyAccentPreference(next)
    setPref(next)
    if (toast) pushToast("ok", t("settings.accentApplied"))
  }

  function choosePreset(id: Exclude<AccentPresetId, "custom">) {
    commit({ id })
  }

  function chooseCustom() {
    const hex = normalizeAccentHex(customDraft) ?? ACCENT_PRESETS.red.accent
    setCustomDraft(hex)
    commit({ id: "custom", custom: hex })
  }

  function onCustomColor(value: string) {
    const hex = normalizeAccentHex(value)
    if (!hex) return
    setCustomDraft(hex)
    commit({ id: "custom", custom: hex }, false)
  }

  function onCustomText(value: string) {
    setCustomDraft(value)
    const hex = normalizeAccentHex(value)
    if (!hex) return
    commit({ id: "custom", custom: hex }, false)
  }

  return (
    <div className="accent-theme">
      <div className="accent-preset-grid" role="group" aria-label={t("settings.accentTitle")}>
        {NAMED.map((id) => (
          <button
            key={id}
            type="button"
            className="accent-swatch"
            aria-pressed={pref.id === id}
            onClick={() => choosePreset(id)}
          >
            <span className="accent-swatch-chip" style={{ background: ACCENT_PRESETS[id].accent }} aria-hidden="true" />
            {t(`settings.${PRESET_LABEL[id]}`)}
          </button>
        ))}
        <button
          type="button"
          className="accent-swatch"
          aria-pressed={pref.id === "custom"}
          onClick={() => chooseCustom()}
        >
          <span className="accent-swatch-chip is-custom" aria-hidden="true" />
          {t("settings.accentPresetCustom")}
        </button>
      </div>

      {pref.id === "custom" ? (
        <div className="accent-custom-row">
          <label className="field" style={{ margin: 0 }}>
            <span>{t("settings.accentCustomLabel")}</span>
            <span className="accent-custom-row" style={{ marginTop: 6 }}>
              <input
                type="color"
                value={colorValue}
                aria-label={t("settings.accentCustomLabel")}
                onChange={(event) => onCustomColor(event.target.value)}
              />
              <input
                type="text"
                spellCheck={false}
                inputMode="text"
                value={customDraft}
                aria-label={t("settings.accentCustomLabel")}
                onChange={(event) => onCustomText(event.target.value)}
                onBlur={() => {
                  const hex = normalizeAccentHex(customDraft)
                  if (hex) setCustomDraft(hex)
                  else setCustomDraft(pref.custom ?? ACCENT_PRESETS.red.accent)
                }}
              />
            </span>
            <span className="field-hint">{t("settings.accentCustomHint")}</span>
          </label>
        </div>
      ) : null}
    </div>
  )
}
