import type { MailSettings } from "./types"

export const defaultMailSettings: MailSettings = {
  host: "",
  port: 587,
  encryption: "starttls",
  username: "",
  password: "",
  fromEmail: "",
  fromName: "Agravion",
}

export function normalizeMailSettings(raw: unknown): MailSettings {
  if (!raw || typeof raw !== "object") return { ...defaultMailSettings }
  const value = raw as Partial<MailSettings>
  const encryption =
    value.encryption === "none" || value.encryption === "tls" || value.encryption === "starttls"
      ? value.encryption
      : "starttls"
  const port = Number(value.port)
  return {
    host: typeof value.host === "string" ? value.host : "",
    port: Number.isFinite(port) && port > 0 ? Math.round(port) : 587,
    encryption,
    username: typeof value.username === "string" ? value.username : "",
    password: typeof value.password === "string" ? value.password : "",
    fromEmail: typeof value.fromEmail === "string" ? value.fromEmail : "",
    fromName: typeof value.fromName === "string" ? value.fromName : "Agravion",
  }
}
