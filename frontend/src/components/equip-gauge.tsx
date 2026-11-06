import type { Vehicle } from "../types"

type GaugeTone = "fuel" | "wear" | "def"

function amountLabel(value: number, max: number, language: string, unit: string) {
  const format = (n: number) => n.toLocaleString(language, { maximumFractionDigits: 0 })
  return `${format(value)} / ${format(max)} ${unit}`
}

type GaugeSource = Pick<Vehicle, "fuel" | "fuelCapacity" | "wear" | "defLevel" | "defCapacity">

export function VehicleGauges({
  vehicle,
  language,
  label,
}: {
  vehicle: GaugeSource
  language: string
  label: (key: string) => string
}) {
  const gauges: ReturnType<typeof EquipGauge>[] = []
  if (vehicle.fuel != null && vehicle.fuelCapacity != null && vehicle.fuelCapacity > 0) {
    gauges.push(
      <EquipGauge
        key="fuel"
        tone="fuel"
        label={label("vehicles.fuel")}
        value={vehicle.fuel}
        max={vehicle.fuelCapacity}
        amount={amountLabel(vehicle.fuel, vehicle.fuelCapacity, language, "l")}
      />,
    )
  }
  if (vehicle.wear != null) {
    gauges.push(
      <EquipGauge
        key="wear"
        tone="wear"
        label={label("vehicles.wear")}
        value={vehicle.wear}
        max={100}
        amount={amountLabel(vehicle.wear, 100, language, "%")}
      />,
    )
  }
  if (vehicle.defLevel != null && vehicle.defCapacity != null && vehicle.defCapacity > 0) {
    gauges.push(
      <EquipGauge
        key="def"
        tone="def"
        label={label("vehicles.def")}
        value={vehicle.defLevel}
        max={vehicle.defCapacity}
        amount={amountLabel(vehicle.defLevel, vehicle.defCapacity, language, "l")}
      />,
    )
  }
  if (gauges.length === 0) return null
  return <span className="equip-gauges">{gauges}</span>
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
    <span className={`equip-gauge is-${tone}`} title={amount}>
      <span className="equip-gauge-ring">
        <svg viewBox="-4 -4 48 48" aria-hidden="true">
          <circle className="equip-gauge-track" cx="20" cy="20" r={radius} />
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
