import type { Vehicle } from "../types"

type GaugeTone = "fuel" | "wear" | "def"

function amountLabel(value: number, max: number, language: string, unit: string) {
  const format = (n: number) => n.toLocaleString(language, { maximumFractionDigits: 0 })
  return `${format(value)} / ${format(max)} ${unit}`
}

type GaugeSource = Pick<Vehicle, "fuel" | "fuelCapacity" | "wear" | "defLevel" | "defCapacity">

type StatusRow = {
  key: string
  tone: GaugeTone
  label: string
  value: number
  max: number
  amount: string
}

function collectRows(vehicle: GaugeSource, language: string, label: (key: string) => string): StatusRow[] {
  const rows: StatusRow[] = []
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

/** Compact telemetry rows for fleet-style equipment cards. */
export function VehicleStatusRows({
  vehicle,
  language,
  label,
  showAmount = false,
}: {
  vehicle: GaugeSource
  language: string
  label: (key: string) => string
  showAmount?: boolean
}) {
  const rows = collectRows(vehicle, language, label)
  if (rows.length === 0) return null
  return (
    <span className="equip-status">
      {rows.map((row) => {
        const pct = row.max > 0 ? Math.max(0, Math.min(100, (row.value / row.max) * 100)) : 0
        return (
          <span key={row.key} className={`equip-status-row is-${row.tone}`} title={row.amount}>
            <span className="equip-status-label">{row.label}</span>
            <span className="equip-status-track" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </span>
            <strong className="equip-status-value">
              {showAmount ? row.amount : `${Math.round(pct)}%`}
            </strong>
          </span>
        )
      })}
    </span>
  )
}

/** Larger status block for vehicle detail. */
export function VehicleGauges({
  vehicle,
  language,
  label,
}: {
  vehicle: GaugeSource
  language: string
  label: (key: string) => string
}) {
  return <VehicleStatusRows vehicle={vehicle} language={language} label={label} showAmount />
}
