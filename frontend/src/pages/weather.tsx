import type { ComponentType, ReactNode } from "react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Cloud,
  CloudFog,
  CloudHail,
  CloudRain,
  CloudSun,
  Droplets,
  Gauge,
  Snowflake,
  Sun,
  Tornado,
  Wind,
} from "lucide-react"
import { apiWorkspaceLiveMap, type LiveForecastDay, type LiveForecastHour, type LiveMapResponse } from "../api"
import { EmptyState, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { useStore } from "../store"
import { useWorkspaceRoute } from "../use-workspace"

const PERIOD_TO_MONTH = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2]
const KNOWN = new Set(["SUN", "CLEAR", "CLOUDY", "CLOUDS", "PARTLY_CLOUDY", "RAIN", "SNOW", "HAIL", "TWISTER", "FOG"])

const SKY: Record<string, { icon: ComponentType<{ className?: string }>; tone: string }> = {
  SUN: { icon: Sun, tone: "sun" },
  CLEAR: { icon: Sun, tone: "sun" },
  CLOUDY: { icon: Cloud, tone: "cloud" },
  CLOUDS: { icon: Cloud, tone: "cloud" },
  PARTLY_CLOUDY: { icon: CloudSun, tone: "sun" },
  RAIN: { icon: CloudRain, tone: "rain" },
  SNOW: { icon: Snowflake, tone: "snow" },
  HAIL: { icon: CloudHail, tone: "hail" },
  TWISTER: { icon: Tornado, tone: "cloud" },
  FOG: { icon: CloudFog, tone: "fog" },
}

function clockLabel(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null
  const ms = value > 0 && value <= 1 ? value * 24 * 60 * 60 * 1000 : value
  if (ms < 0 || ms > 48 * 60 * 60 * 1000) return null
  const minutes = Math.floor(ms / 60000) % (24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

function share(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null
  if (value >= 0 && value <= 1) return `${Math.round(value * 100)} %`
  return `${Math.round(value)}`
}

function ratioOf(value: number | null) {
  if (value == null || !Number.isFinite(value) || value < 0) return null
  if (value <= 1) return value
  if (value <= 100) return value / 100
  return null
}

function windDegrees(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null
  const degrees = Math.round((value * 180) / Math.PI)
  return ((degrees % 360) + 360) % 360
}

function weatherKey(raw: string | null) {
  if (!raw) return null
  const key = raw.trim().toUpperCase()
  return KNOWN.has(key) ? key : null
}

function hasReport(payload: LiveMapResponse | null) {
  if (!payload) return false
  return (
    payload.weather != null ||
    payload.temperature != null ||
    payload.windSpeed != null ||
    payload.rain != null ||
    payload.clouds != null ||
    payload.humidity != null ||
    (payload.hours?.length ?? 0) > 0 ||
    (payload.days?.length ?? 0) > 0
  )
}

export function WeatherPage() {
  const { t } = useTranslation()
  const stamp = useTimeLabel()
  const { liveMode, moduleAccess } = useStore()
  const { workspace, allowed } = useWorkspaceRoute()
  const access = workspace ? moduleAccess(workspace.id, "weather") : null
  const [payload, setPayload] = useState<LiveMapResponse | null>(null)
  const [loading, setLoading] = useState(liveMode)

  useEffect(() => {
    if (!workspace || !allowed || !access || !liveMode) return
    let cancelled = false
    const load = async (first: boolean) => {
      if (!first && document.hidden) return
      if (first) setLoading(true)
      try {
        const next = await apiWorkspaceLiveMap(workspace.id)
        if (!cancelled) setPayload(next)
      } catch {
        if (!cancelled && first) setPayload(null)
      } finally {
        if (!cancelled && first) setLoading(false)
      }
    }
    void load(true)
    const timer = window.setInterval(() => void load(false), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [access, allowed, liveMode, workspace])

  if (!workspace) return <MissingWorkspace />
  if (!allowed || !access) return <PermissionBlock />

  const month = payload?.period != null && payload.period >= 1 && payload.period <= 12 ? PERIOD_TO_MONTH[payload.period - 1] : null
  const clock = clockLabel(payload?.dayTime ?? null)
  const wind = windDegrees(payload?.windDirection ?? null)
  const ready = hasReport(payload)

  return (
    <div className="page weather-page">
      <header className="page-head">
        <div>
          <h1>{t("modules.weather")}</h1>
          <p>{t("modules.weatherLead")}</p>
        </div>
        {payload?.writtenAt ? <p className="faint">{t("live.updated", { time: stamp(payload.writtenAt, "") })}</p> : null}
      </header>
      {loading && !payload ? <p className="muted">{t("weather.loading")}</p> : null}
      {!loading && !ready ? <EmptyState title={t("weather.missingTitle")} body={t("weather.missingBody")} /> : null}
      {ready && payload ? (
        <>
          <section className="weather-now">
            <div className="weather-hero">
              <SkyMark raw={payload.weather} large />
              <div className="weather-hero-copy">
                <span>{conditionLabel(t, payload.weather)}</span>
                {payload.temperature != null ? <strong>{payload.temperature.toFixed(1)}°</strong> : null}
                <p>
                  {[
                    clock,
                    payload.day != null ? t("live.day", { day: payload.day }) : null,
                    month != null ? t(`fields.month.${month}`) : null,
                    payload.paused ? t("live.paused") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </div>
            <dl className="weather-facts">
              <Fact icon={<Wind />} label={t("weather.wind")} value={payload.windSpeed != null ? String(payload.windSpeed) : null} />
              <Fact
                icon={wind != null ? <WindArrow degrees={wind} /> : <Wind />}
                label={t("weather.direction")}
                value={wind != null ? `${wind}°` : null}
              />
              <Fact icon={<CloudRain />} label={t("weather.rain")} value={share(payload.rain)} ratio={ratioOf(payload.rain)} />
              <Fact icon={<Cloud />} label={t("weather.clouds")} value={share(payload.clouds)} ratio={ratioOf(payload.clouds)} />
              <Fact icon={<Droplets />} label={t("weather.humidity")} value={share(payload.humidity)} ratio={ratioOf(payload.humidity)} />
              <Fact icon={<CloudFog />} label={t("weather.fog")} value={share(payload.fog)} ratio={ratioOf(payload.fog)} />
              <Fact icon={<Snowflake />} label={t("weather.snow")} value={payload.snow != null ? `${payload.snow}` : null} ratio={ratioOf(payload.snow)} />
              <Fact icon={<Gauge />} label={t("weather.timeScale")} value={payload.timeScale != null ? `${payload.timeScale}` : null} />
            </dl>
          </section>
          {(payload.hours ?? []).length > 0 ? (
            <section>
              <h2>{t("weather.hourly")}</h2>
              <div className="weather-strip">
                {(payload.hours ?? []).map((hour, index) => (
                  <HourCard key={`${hour.time ?? "h"}-${index}`} hour={hour} label={conditionLabel(t, hour.type)} />
                ))}
              </div>
            </section>
          ) : null}
          {(payload.days ?? []).length > 0 ? (
            <section>
              <h2>{t("weather.daily")}</h2>
              <div className="weather-days">
                {(payload.days ?? []).map((day, index) => (
                  <DayCard key={`${day.day ?? "d"}-${index}`} day={day} label={conditionLabel(t, day.type)} dayLabel={day.day != null ? t("live.day", { day: day.day }) : t("weather.dayAhead", { day: index + 1 })} />
                ))}
              </div>
            </section>
          ) : null}
          <p className="weather-note">{t("weather.precision")}</p>
        </>
      ) : null}
    </div>
  )
}

function SkyMark({ raw, large }: { raw: string | null; large?: boolean }) {
  const key = weatherKey(raw)
  const spec = (key && SKY[key]) || { icon: CloudSun, tone: "sun" }
  const Icon = spec.icon
  if (large) {
    return (
      <div className={`weather-sky is-${spec.tone}`}>
        <Icon />
      </div>
    )
  }
  return <Icon className="weather-mini" />
}

function WindArrow({ degrees }: { degrees: number }) {
  return (
    <span className="weather-arrow" style={{ transform: `rotate(${degrees}deg)` }}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 2.5 17.2 12H13.4v9.2h-2.8V12H6.8L12 2.5Z" />
      </svg>
    </span>
  )
}

function conditionLabel(t: (key: string) => string, raw: string | null) {
  if (!raw) return t("weather.unknown")
  const key = raw.trim().toUpperCase()
  if (KNOWN.has(key)) return t(`weather.kind.${key}`)
  const words = raw.replace(/[_-]+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

function Fact({ icon, label, value, ratio }: { icon: ReactNode; label: string; value: string | null; ratio?: number | null }) {
  if (!value) return null
  return (
    <div>
      {icon}
      <dt>{label}</dt>
      <dd>{value}</dd>
      {ratio != null ? (
        <span className="weather-meter" aria-hidden="true">
          <i style={{ width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` }} />
        </span>
      ) : null}
    </div>
  )
}

function HourCard({ hour, label }: { hour: LiveForecastHour; label: string }) {
  const when = clockLabel(hour.time)
  return (
    <article className="weather-card">
      <SkyMark raw={hour.type} />
      <span>{when ?? label}</span>
      <strong>{hour.temperature != null ? `${hour.temperature.toFixed(0)}°` : "–"}</strong>
      <em>{when ? label : null}</em>
      {hour.windSpeed != null ? <small>{hour.windSpeed}</small> : null}
    </article>
  )
}

function DayCard({ day, label, dayLabel }: { day: LiveForecastDay; label: string; dayLabel: string }) {
  return (
    <article className="weather-card">
      <SkyMark raw={day.type} />
      <span>{dayLabel}</span>
      <strong>
        {day.high != null ? `${day.high.toFixed(0)}°` : "–"}
        {day.low != null ? <small> {day.low.toFixed(0)}°</small> : null}
      </strong>
      <em>{label}</em>
      {day.windSpeed != null ? <small>{day.windSpeed}</small> : null}
    </article>
  )
}
