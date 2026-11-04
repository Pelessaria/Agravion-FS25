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

/** HUD symbol from the icon pack. Mod files still win when the connector copied one. */
export function cropIcon(kind: string | null | undefined): string | null {
  const key = (kind ?? "").toLowerCase()
  if (!key) return null
  return icons[alias[key] ?? key] ?? icons.unknown ?? null
}
