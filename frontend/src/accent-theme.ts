/** Accent / brand theming for Agravion UI chrome (not semantic status greens). */

export type AccentPresetId = "red" | "green" | "blue" | "yellow" | "orange" | "violet" | "custom"

export type AccentPalette = {
  accent: string
  accent2: string
  accentInk: string
  bright: string
}

export type AccentThemePreference = {
  id: AccentPresetId
  /** Used when id === "custom"; ignored for named presets. */
  custom?: string
}

export const ACCENT_STORAGE_KEY = "agravion.accentTheme"

export const ACCENT_PRESETS: Record<Exclude<AccentPresetId, "custom">, AccentPalette> = {
  red: {
    accent: "#a52e35",
    accent2: "#d4787e",
    accentInk: "#fff6f6",
    bright: "#c45c63",
  },
  green: {
    accent: "#4caf50",
    accent2: "#c6e88a",
    accentInk: "#062110",
    bright: "#c6e88a",
  },
  blue: {
    accent: "#3b6fd4",
    accent2: "#8fb4f0",
    accentInk: "#f3f7ff",
    bright: "#6b93e8",
  },
  yellow: {
    accent: "#c9a227",
    accent2: "#e8d07a",
    accentInk: "#1a1405",
    bright: "#dbb94a",
  },
  orange: {
    accent: "#d96a2b",
    accent2: "#f0a66e",
    accentInk: "#fff7f0",
    bright: "#e8874a",
  },
  violet: {
    accent: "#7b4fc4",
    accent2: "#b794e8",
    accentInk: "#f7f3ff",
    bright: "#9770d6",
  },
}

const PRESET_IDS = new Set<string>(Object.keys(ACCENT_PRESETS))

function clampByte(n: number) {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function parseHex(input: string): [number, number, number] | null {
  const raw = input.trim().replace(/^#/, "")
  if (!/^[0-9a-fA-F]{6}$/.test(raw) && !/^[0-9a-fA-F]{3}$/.test(raw)) return null
  const hex =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

function toHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((n) => clampByte(n).toString(16).padStart(2, "0")).join("")}`
}

function mixHex(a: string, b: string, t: number): string {
  const A = parseHex(a)
  const B = parseHex(b)
  if (!A || !B) return a
  return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t)
}

function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Build a readable palette from one accent hex (custom theme). */
export function deriveAccentPalette(accentHex: string): AccentPalette | null {
  const rgb = parseHex(accentHex)
  if (!rgb) return null
  const accent = toHex(rgb[0], rgb[1], rgb[2])
  const bright = mixHex(accent, "#ffffff", 0.28)
  const accent2 = mixHex(accent, "#ffffff", 0.42)
  const accentInk = relativeLuminance(accent) > 0.55 ? "#1a1408" : "#fff6f6"
  return { accent, accent2, accentInk, bright }
}

export function normalizeAccentHex(input: string): string | null {
  const rgb = parseHex(input)
  if (!rgb) return null
  return toHex(rgb[0], rgb[1], rgb[2])
}

export function resolveAccentPalette(pref: AccentThemePreference): AccentPalette {
  if (pref.id === "custom") {
    const custom = pref.custom ? deriveAccentPalette(pref.custom) : null
    return custom ?? ACCENT_PRESETS.red
  }
  return ACCENT_PRESETS[pref.id] ?? ACCENT_PRESETS.red
}

export function readAccentPreference(): AccentThemePreference {
  try {
    const raw = localStorage.getItem(ACCENT_STORAGE_KEY)
    if (!raw) return { id: "red" }
    const parsed = JSON.parse(raw) as AccentThemePreference
    if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") return { id: "red" }
    if (parsed.id === "custom") {
      const custom = parsed.custom ? normalizeAccentHex(parsed.custom) : null
      return custom ? { id: "custom", custom } : { id: "red" }
    }
    if (PRESET_IDS.has(parsed.id)) return { id: parsed.id as Exclude<AccentPresetId, "custom"> }
  } catch {
    // ignore corrupt storage
  }
  return { id: "red" }
}

export function writeAccentPreference(pref: AccentThemePreference) {
  localStorage.setItem(ACCENT_STORAGE_KEY, JSON.stringify(pref))
}

/** Apply palette to :root so all `var(--accent*)` / `var(--brand)` chrome follows. */
export function applyAccentPalette(palette: AccentPalette, root: HTMLElement = document.documentElement) {
  root.style.setProperty("--accent", palette.accent)
  root.style.setProperty("--accent-2", palette.accent2)
  root.style.setProperty("--accent-ink", palette.accentInk)
  root.style.setProperty("--accent-bright", palette.bright)
  root.style.setProperty("--brand", `linear-gradient(135deg, ${palette.bright} 0%, ${palette.accent} 100%)`)
  root.dataset.accentTheme = palette.accent
}

export function applyAccentPreference(pref: AccentThemePreference = readAccentPreference()) {
  applyAccentPalette(resolveAccentPalette(pref))
}
