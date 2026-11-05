import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Cloud, CloudFog, CloudRain, Droplets, Gauge, Snowflake, Wind } from "lucide-react"
import { apiWorkspaceLiveMap, type LiveForecastDay, type LiveForecastHour, type LiveMapResponse } from "../api"
import { EmptyState, MissingWorkspace, PermissionBlock, useTimeLabel } from "../components/ui"
import { useStore } from "../store"
import { useWorkspaceRoute } from "../use-workspace"

const PERIOD_TO_MONTH = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2]
const KNOWN = new Set(["SUN", "CLEAR", "CLOUDY", "CLOUDS", "PARTLY_CLOUDY", "RAIN", "SNOW", "HAIL", "TWISTER", "FOG"])

const TONE: Record<string, string> = {
  SUN: "sun",
  CLEAR: "sun",
  CLOUDY: "cloud",
  CLOUDS: "cloud",
  PARTLY_CLOUDY: "partly",
  RAIN: "rain",
  SNOW: "snow",
  HAIL: "hail",
  TWISTER: "storm",
  FOG: "fog",
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

function compass(degrees: number, language: string) {
  const names = language.startsWith("de")
    ? ["N", "NO", "O", "SO", "S", "SW", "W", "NW"]
    : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
  return names[((Math.round(degrees / 45) % 8) + 8) % 8]
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
  const { t, i18n } = useTranslation()
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
          <section className="weather-top">
            <article className="panel weather-current">
              <h2>{t("weather.now")}</h2>
              <div className="weather-now-row">
                <SkyMark raw={payload.weather} large />
                <div className="weather-hero-copy">
                  {payload.temperature != null ? <strong>{payload.temperature.toFixed(1)} °C</strong> : null}
                  <span>{conditionLabel(t, payload.weather)}</span>
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
              <div className="weather-metrics">
                <Metric icon={<Wind />} label={t("weather.wind")} value={payload.windSpeed != null ? `${payload.windSpeed}${wind != null ? ` (${compass(wind, i18n.language)})` : ""}` : null} />
                <Metric icon={<Droplets />} label={t("weather.humidity")} value={share(payload.humidity)} />
                <Metric icon={<CloudRain />} label={t("weather.rain")} value={share(payload.rain)} />
                <Metric icon={<Cloud />} label={t("weather.clouds")} value={share(payload.clouds)} />
              </div>
            </article>
            <article className="panel weather-extra">
              <Extra icon={<WindArrow degrees={wind ?? 0} />} label={t("weather.direction")} value={wind != null ? `${wind}° ${compass(wind, i18n.language)}` : null} />
              <Extra icon={<CloudFog />} label={t("weather.fog")} value={share(payload.fog)} />
              <Extra icon={<Snowflake />} label={t("weather.snow")} value={payload.snow != null ? `${payload.snow}` : null} />
              <Extra icon={<Gauge />} label={t("weather.timeScale")} value={payload.timeScale != null ? `${payload.timeScale}×` : null} />
            </article>
          </section>
          {(payload.days ?? []).length > 0 || (payload.hours ?? []).length > 0 ? (
            <section className="weather-mid">
              {(payload.days ?? []).length > 0 ? (
                <article className="panel">
                  <h2>{t("weather.forecast")}</h2>
                  <div className="weather-days">
                    {(payload.days ?? []).slice(0, 7).map((day, index) => (
                      <DayCard
                        key={`${day.day ?? "d"}-${index}`}
                        day={day}
                        label={conditionLabel(t, day.type)}
                        dayLabel={day.day != null ? t("live.day", { day: day.day }) : t("weather.dayAhead", { day: index + 1 })}
                        today={index === 0}
                      />
                    ))}
                  </div>
                </article>
              ) : null}
              {(payload.days ?? []).some((day) => day.high != null || day.low != null) ? (
                <article className="panel">
                  <h2>{t("weather.trend")}</h2>
                  <Trend days={payload.days ?? []} highLabel={t("weather.high")} lowLabel={t("weather.low")} />
                </article>
              ) : null}
            </section>
          ) : null}
          <section className="weather-low">
            {(payload.hours ?? []).length > 0 ? (
              <article className="panel">
                <h2>{t("weather.hourly")}</h2>
                <div className="weather-hours">
                  {(payload.hours ?? []).slice(0, 12).map((hour, index) => (
                    <HourCard key={`${hour.time ?? "h"}-${index}`} hour={hour} label={conditionLabel(t, hour.type)} now={index === 0} />
                  ))}
                </div>
              </article>
            ) : null}
            <article className="panel weather-sync">
              <h2>{t("weather.conditions")}</h2>
              <p><i />{t("weather.synced")}</p>
              <p><i />{t("weather.syncGame")}</p>
              {payload.writtenAt ? <footer>{t("live.updated", { time: stamp(payload.writtenAt, "") })}</footer> : null}
              <small>{t("weather.precision")}</small>
            </article>
          </section>
        </>
      ) : null}
    </div>
  )
}

function toneOf(raw: string | null) {
  const key = weatherKey(raw)
  return (key && TONE[key]) || "cloud"
}

function SkyMark({ raw, large }: { raw: string | null; large?: boolean }) {
  const tone = toneOf(raw)
  return (
    <span className={large ? `weather-sky is-${tone}` : `weather-art is-${tone}`}>
      <WeatherSvg kind={weatherKey(raw)} />
    </span>
  )
}

function WeatherSvg({ kind }: { kind: string | null }) {
  const cloud = "M20 42h26c6.2 0 11-4.4 11-10.2 0-5.2-4-9.4-9.2-10-1.2-6.4-7-11-13.6-11-5.6 0-10.4 3.4-12.2 8.2C15.2 19.6 10 24 10 29.6 10 36.2 14.6 42 20 42z"
  if (kind === "SUN" || kind === "CLEAR") {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g stroke="#f0a202" strokeWidth="3.4" strokeLinecap="round">
          <path d="M32 6v8M32 50v8M6 32h8M50 32h8M13 13l6 6M45 45l6 6M51 13l-6 6M19 45l-6 6" />
        </g>
        <circle cx="32" cy="32" r="13" fill="#ffc83d" />
        <circle cx="27" cy="28" r="5" fill="#ffe7a3" />
      </svg>
    )
  }
  if (kind === "RAIN") {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d={cloud} fill="#d5e2ea" />
        <path d={cloud} fill="#f7fbfd" transform="translate(0 -1)" />
        <g fill="#3d9be0">
          <path d="M22 46c2 4 2 6 0 9-2-3-2-5 0-9z" />
          <path d="M32 47c2 4 2 6 0 9-2-3-2-5 0-9z" />
          <path d="M42 46c2 4 2 6 0 9-2-3-2-5 0-9z" />
        </g>
      </svg>
    )
  }
  if (kind === "SNOW") {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d={cloud} fill="#e7eef3" />
        <g fill="#7eb6e6" stroke="#f7fbff" strokeWidth="1.2">
          <circle cx="22" cy="50" r="2.4" />
          <circle cx="32" cy="54" r="2.4" />
          <circle cx="43" cy="49" r="2.4" />
        </g>
      </svg>
    )
  }
  if (kind === "HAIL") {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d={cloud} fill="#d7e0e8" />
        <g fill="#f4f8fb" stroke="#6aa4d8" strokeWidth="1.4">
          <circle cx="22" cy="50" r="2.6" />
          <circle cx="32" cy="54" r="2.6" />
          <circle cx="42" cy="49" r="2.6" />
        </g>
      </svg>
    )
  }
  if (kind === "FOG") {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g fill="#c5d0d6">
          <rect x="10" y="18" width="36" height="6" rx="3" />
          <rect x="18" y="29" width="36" height="6" rx="3" fill="#e8eef1" />
          <rect x="12" y="40" width="32" height="6" rx="3" />
        </g>
      </svg>
    )
  }
  if (kind === "TWISTER") {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <ellipse cx="32" cy="16" rx="18" ry="6" fill="#c5ced4" />
        <ellipse cx="30" cy="28" rx="13" ry="5" fill="#dfe6ea" />
        <ellipse cx="34" cy="39" rx="8" ry="4" fill="#b7c3ca" />
        <ellipse cx="31" cy="49" rx="4" ry="3" fill="#8ea0aa" />
      </svg>
    )
  }
  if (kind === "PARTLY_CLOUDY") {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g stroke="#f0a202" strokeWidth="3" strokeLinecap="round">
          <path d="M22 8v6M10 22h6M12 12l4 4" />
        </g>
        <circle cx="22" cy="22" r="8" fill="#ffc83d" />
        <path d={cloud} fill="#f7fbfd" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d={cloud} fill="#d5dee6" />
      <path d={cloud} fill="#f4f7fa" transform="translate(-1 -1)" />
    </svg>
  )
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

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string | null }) {
  return (
    <div className="weather-metric">
      {icon}
      <span>{label}</span>
      <strong>{value ?? "–"}</strong>
    </div>
  )
}

function Extra({ icon, label, value }: { icon: ReactNode; label: string; value: string | null }) {
  return (
    <div className="weather-extra-item">
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value ?? "–"}</strong>
    </div>
  )
}

function HourCard({ hour, label, now }: { hour: LiveForecastHour; label: string; now?: boolean }) {
  const when = clockLabel(hour.time)
  return (
    <article className={now ? `weather-hour is-now is-${toneOf(hour.type)}` : `weather-hour is-${toneOf(hour.type)}`}>
      <time>{when ?? label}</time>
      <SkyMark raw={hour.type} />
      <strong>{hour.temperature != null ? `${hour.temperature.toFixed(0)}°` : "–"}</strong>
      <small>{hour.windSpeed != null ? hour.windSpeed : label}</small>
    </article>
  )
}

function DayCard({ day, label, dayLabel, today }: { day: LiveForecastDay; label: string; dayLabel: string; today?: boolean }) {
  return (
    <article className={today ? `weather-day is-today is-${toneOf(day.type)}` : `weather-day is-${toneOf(day.type)}`}>
      <span>{dayLabel}</span>
      <SkyMark raw={day.type} />
      <strong>{day.high != null ? `${day.high.toFixed(0)}°` : "–"}</strong>
      <em>{day.low != null ? `${day.low.toFixed(0)}°` : "–"}</em>
      <small>{label}</small>
      {day.windSpeed != null ? <small>{day.windSpeed}</small> : null}
    </article>
  )
}

function Trend({ days, highLabel, lowLabel }: { days: LiveForecastDay[]; highLabel: string; lowLabel: string }) {
  const rows = days.slice(0, 7)
  const highs = rows.map((day) => day.high)
  const lows = rows.map((day) => day.low)
  const values = [...highs, ...lows].filter((value): value is number => value != null && Number.isFinite(value))
  if (values.length === 0) return null
  const max = Math.max(...values) + 2
  const min = Math.min(...values) - 2
  const span = max - min || 1
  const x = (index: number) => 42 + (index * 430) / Math.max(rows.length - 1, 1)
  const y = (value: number) => 168 - ((value - min) / span) * 132
  const path = (series: Array<number | null>) => {
    let drawing = ""
    series.forEach((value, index) => {
      if (value == null) return
      drawing += `${drawing === "" ? "M" : "L"} ${x(index).toFixed(1)} ${y(value).toFixed(1)} `
    })
    return drawing.trim()
  }
  return (
    <div className="weather-chart">
      <svg viewBox="0 0 500 200" role="img" aria-label={highLabel}>
        {[0, 1, 2, 3].map((step) => {
          const value = max - (step * span) / 3
          const yy = y(value)
          return (
            <g key={step}>
              <line x1="36" y1={yy} x2="486" y2={yy} />
              <text x="30" y={yy + 3} textAnchor="end">
                {Math.round(value)}°
              </text>
            </g>
          )
        })}
        {rows.map((day, index) => (
          <text key={`${day.day ?? "t"}-${index}`} x={x(index)} y="190" textAnchor="middle">
            {day.day ?? index + 1}
          </text>
        ))}
        <path d={path(highs)} className="is-high" />
        <path d={path(lows)} className="is-low" />
        {highs.map((value, index) => (value == null ? null : <circle key={`h-${index}`} cx={x(index)} cy={y(value)} r="3.2" className="is-high" />))}
        {lows.map((value, index) => (value == null ? null : <circle key={`l-${index}`} cx={x(index)} cy={y(value)} r="3.2" className="is-low" />))}
      </svg>
      <p>
        <i className="is-high" />
        {highLabel}
        <i className="is-low" />
        {lowLabel}
      </p>
    </div>
  )
}
