const modules = import.meta.glob("./assets/crop-icons/*.png", {
  eager: true,
  import: "default",
}) as Record<string, string>

const icons: Record<string, string> = {}
for (const [path, url] of Object.entries(modules)) {
  const name = path.split("/").pop()?.replace(/\.png$/i, "")
  if (name) icons[name] = url
}

const alias: Record<string, string> = {
  summerbarley: "barley",
  silagemaize: "maize",
  corn: "maize",
  meadow: "grass",
  fieldgrass: "grass",
  greenrye: "grass",
  vetchrye: "grass",
  drygrass: "drygrasswindrow",
  oilseedradish: "oilradish",
  sugarbeetroot: "sugarbeet",
}

function iconKey(kind: string | null | undefined) {
  const key = (kind ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
  if (!key) return null
  return alias[key] ?? key
}

/** HUD symbol from the icon pack. Mod files still win when the connector copied one. */
export function cropIcon(kind: string | null | undefined): string | null {
  const key = iconKey(kind)
  if (!key) return null
  return icons[key] ?? icons.unknown ?? null
}

/** Same pack, without the unknown stand-in. Storage uses this for goods that have no picture. */
export function cropIconExact(kind: string | null | undefined): string | null {
  const key = iconKey(kind)
  if (!key) return null
  return icons[key] ?? null
}
