import { apiFetch, ApiError } from "./api"

/** Public GitHub source of truth for Agravion installs and in-app updates. */
export const GITHUB_OWNER = "Pelessaria"
export const GITHUB_REPO = "Agravion-FS25"
export const GITHUB_BRANCH = "main"
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

export type UpdateStatus = {
  enabled: boolean
  installedVersion: string
  installedSha: string | null
  installedAt: string | null
  repo: string
  branch: string
  remoteSha: string | null
  remoteMessage: string | null
  remoteHtmlUrl: string | null
  updateAvailable: boolean
  checkedAt: string
  source: "api" | "github" | "demo"
  error?: string
  /** Last failed update/migration — persisted server-side for support. */
  lastError?: string | null
  lastErrorAt?: string | null
  migrationError?: string | null
  updateLog?: string[]
}

function shortSha(sha: string | null | undefined) {
  if (!sha) return null
  return sha.slice(0, 7)
}

async function fetchGithubHead(): Promise<{
  sha: string
  message: string | null
  htmlUrl: string | null
}> {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Agravion-UI",
      },
    },
  )
  if (!response.ok) {
    throw new Error(`GitHub HTTP ${response.status}`)
  }
  const json = (await response.json()) as {
    sha?: string
    html_url?: string
    commit?: { message?: string }
  }
  const sha = json.sha ?? ""
  if (!sha) throw new Error("GitHub response missing SHA")
  const raw = json.commit?.message?.trim() ?? null
  const message = raw ? raw.split("\n")[0] ?? raw : null
  return { sha, message, htmlUrl: json.html_url ?? null }
}

/**
 * Prefer Laravel `/api/system/update` when the backend is reachable.
 * Fall back to the public GitHub API for display; install still goes through PHP when live.
 */
export async function checkForUpdates(installedVersion: string, installedSha: string | null): Promise<UpdateStatus> {
  const checkedAt = new Date().toISOString()
  let apiError: string | undefined

  try {
    const json = await apiFetch<Omit<UpdateStatus, "source">>("/api/system/update")
    return { ...json, source: "api" }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        return {
          enabled: false,
          installedVersion,
          installedSha,
          installedAt: null,
          repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          branch: GITHUB_BRANCH,
          remoteSha: null,
          remoteMessage: null,
          remoteHtmlUrl: null,
          updateAvailable: false,
          checkedAt,
          source: "api",
          error: error.message,
        }
      }
      apiError = `HTTP ${error.status}: ${error.message}`
    } else if (error instanceof Error) {
      apiError = error.message
    }
  }

  try {
    const head = await fetchGithubHead()
    const updateAvailable = !installedSha || installedSha !== head.sha
    return {
      enabled: true,
      installedVersion,
      installedSha,
      installedAt: null,
      repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      branch: GITHUB_BRANCH,
      remoteSha: head.sha,
      remoteMessage: head.message,
      remoteHtmlUrl: head.htmlUrl,
      updateAvailable,
      checkedAt,
      source: "github",
      error: apiError,
    }
  } catch (error) {
    return {
      enabled: true,
      installedVersion,
      installedSha,
      installedAt: null,
      repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      branch: GITHUB_BRANCH,
      remoteSha: null,
      remoteMessage: null,
      remoteHtmlUrl: null,
      updateAvailable: false,
      checkedAt,
      source: "demo",
      error: apiError ?? (error instanceof Error ? error.message : "Update check failed"),
    }
  }
}

export async function applyUpdate(
  sha: string | null,
  options: { force?: boolean } = {},
): Promise<{ ok: boolean; error?: string; message?: string }> {
  try {
    const json = await apiFetch<{ ok?: boolean; error?: string; message?: string }>("/api/system/update", {
      method: "POST",
      body: JSON.stringify({
        confirm: true,
        sha: sha ?? undefined,
        force: options.force === true,
      }),
    })
    if (json.ok === false) {
      return { ok: false, error: json.error ?? "Update failed" }
    }
    return { ok: true, message: json.message }
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, error: error.message }
    }
    return {
      ok: false,
      error: "backend_unavailable",
    }
  }
}

export function formatSha(sha: string | null | undefined) {
  return shortSha(sha) ?? "—"
}

export async function fetchUpdateLog(): Promise<{ lines: string[]; path: string }> {
  return apiFetch("/api/system/update/log")
}
