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
  drygrass: "hay",
}

/** Poster symbol for a crop when the game did not write a HUD file. */
export function sheetIcon(kind: string | null | undefined): string | null {
  const key = (kind ?? "").toLowerCase()
  return icons[alias[key] ?? key] ?? null
}
