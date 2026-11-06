import type { Vehicle } from "../types"

type GaugeTone = "fuel" | "wear" | "def"

const SEGMENT_COUNT = 10

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

function segmentFill(pct: number, index: number) {
  const start = (index / SEGMENT_COUNT) * 100
  const end = ((index + 1) / SEGMENT_COUNT) * 100
  if (pct <= start) return 0
  if (pct >= end) return 100
  return ((pct - start) / (end - start)) * 100
}

function StatusMeter({
  tone,
  label,
  pct,
  amount,
  showAmount,
}: {
  tone: GaugeTone
  label: string
  pct: number
  amount: string
  showAmount: boolean
}) {
  const rounded = Math.round(pct)
  const display = showAmount ? amount : `${rounded}%`
  const statusClass = tone === "def" ? "status-adblue" : `status-${tone}`

  return (
    <div className={`status-item ${statusClass}`} data-status={tone === "def" ? "adblue" : tone} data-value={rounded} title={amount}>
      <div className="status-labels">
        <span>{label}</span>
        <output>{display}</output>
      </div>
      <div
        className="statusbar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
      >
        {Array.from({ length: SEGMENT_COUNT }, (_, index) => {
          const fill = segmentFill(pct, index)
          return (
            <span key={index} className="status-segment" aria-hidden="true">
              <i className="status-segment-fill" style={{ width: `${fill}%` }} />
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** Telemetry meters for fleet-style equipment cards. */
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
    <div className="status-list">
      {rows.map((row) => {
        const pct = row.max > 0 ? Math.max(0, Math.min(100, (row.value / row.max) * 100)) : 0
        return (
          <StatusMeter
            key={row.key}
            tone={row.tone}
            label={row.label}
            pct={pct}
            amount={row.amount}
            showAmount={showAmount}
          />
        )
      })}
    </div>
  )
}

/** Status block for vehicle detail. */
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
