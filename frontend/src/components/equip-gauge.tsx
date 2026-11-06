import type { Vehicle } from "../types"

type GaugeTone = "fuel" | "wear" | "def"

function amountLabel(value: number, max: number, language: string, unit: string) {
  const format = (n: number) => n.toLocaleString(language, { maximumFractionDigits: 0 })
  return `${format(value)} / ${format(max)} ${unit}`
}

type GaugeSource = Pick<Vehicle, "fuel" | "fuelCapacity" | "wear" | "defLevel" | "defCapacity">

function collectGauges(vehicle: GaugeSource, language: string, label: (key: string) => string) {
  const rows: { key: string; tone: GaugeTone; label: string; value: number; max: number; amount: string }[] = []
  if (vehicle.fuel != null && vehicle.fuelCapacity != null && vehicle.fuelCapacity > 0) {
    rows.push({
      key: "fuel",
      tone: "fuel",
      label: label("vehicles.fuel"),
      value: vehicle.fuel,
      max: vehicle.fuelCapacity,
      amount: amountLabel(vehicle.fuel, vehicle.fuelCapacity, language, "l"),
    })
  }
  if (vehicle.wear != null) {
    rows.push({
      key: "wear",
      tone: "wear",
      label: label("vehicles.wear"),
      value: vehicle.wear,
      max: 100,
      amount: amountLabel(vehicle.wear, 100, language, "%"),
    })
  }
  if (vehicle.defLevel != null && vehicle.defCapacity != null && vehicle.defCapacity > 0) {
    rows.push({
      key: "def",
      tone: "def",
      label: label("vehicles.def"),
      value: vehicle.defLevel,
      max: vehicle.defCapacity,
      amount: amountLabel(vehicle.defLevel, vehicle.defCapacity, language, "l"),
    })
  }
  return rows
}

export function VehicleGauges({
  vehicle,
  language,
  label,
}: {
  vehicle: GaugeSource
  language: string
  label: (key: string) => string
}) {
  const rows = collectGauges(vehicle, language, label)
  if (rows.length === 0) return null
  return (
    <span className="equip-gauges">
      {rows.map((row) => (
        <EquipGauge
          key={row.key}
          tone={row.tone}
          label={row.label}
          value={row.value}
          max={row.max}
          amount={row.amount}
        />
      ))}
    </span>
  )
}

/** Compact horizontal meters for poster-style equipment tiles. */
export function VehicleMeterBars({
  vehicle,
  language,
  label,
}: {
  vehicle: GaugeSource
  language: string
  label: (key: string) => string
}) {
  const rows = collectGauges(vehicle, language, label)
  if (rows.length === 0) return null
  return (
    <span className="equip-meters">
      {rows.map((row) => {
        const pct = row.max > 0 ? Math.max(0, Math.min(100, (row.value / row.max) * 100)) : 0
        return (
          <span key={row.key} className={`equip-meter is-${row.tone}`} title={row.amount}>
            <span className="equip-meter-label">
              <em>{row.label}</em>
              <strong>{Math.round(pct)}%</strong>
            </span>
            <span className="equip-meter-track" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </span>
          </span>
        )
      })}
    </span>
  )
}

export function EquipGauge({
  label,
  value,
  max,
  tone,
  amount,
}: {
  label: string
  value: number
  max: number
  tone: GaugeTone
  amount: string
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  const radius = 14

  return (
    <span className={`equip-gauge is-${tone}`}>
      <span className="equip-gauge-ring">
        <svg viewBox="-4 -4 48 48" aria-hidden="true">
          <circle className="equip-gauge-track" cx="20" cy="20" r={radius} />
          <circle
            className="equip-gauge-glow"
            cx="20"
            cy="20"
            r={radius}
            pathLength={100}
            strokeDasharray={`${pct} 100`}
            strokeLinecap="round"
          />
          <circle
            className="equip-gauge-value"
            cx="20"
            cy="20"
            r={radius}
            pathLength={100}
            strokeDasharray={`${pct} 100`}
            strokeLinecap="round"
          />
        </svg>
        <span className="equip-gauge-pct">{Math.round(pct)}%</span>
      </span>
      <span className="equip-gauge-label">{label}</span>
      <span className="equip-gauge-amt">{amount}</span>
    </span>
  )
}
