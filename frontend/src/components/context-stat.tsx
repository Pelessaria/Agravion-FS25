import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

export function ContextStat({
  symbol,
  value,
  label,
  note,
  className,
}: {
  symbol: ReactNode
  value: ReactNode
  label: ReactNode
  note?: ReactNode
  className?: string
}) {
  const title = [label, value].every((part) => typeof part === "string") ? `${label}: ${value}` : undefined
  return (
    <span className={["context-stat", className].filter(Boolean).join(" ")} title={title}>
      {symbol}
      <strong>{value}</strong>
      <small>
        {label}
        {note ? <em>{note}</em> : null}
      </small>
    </span>
  )
}

export function ContextPipe() {
  return <span className="context-pipe" aria-hidden="true">|</span>
}

type PageStatsApi = {
  slot: HTMLDivElement | null
  setSlot: (node: HTMLDivElement | null) => void
  active: boolean
  setActive: (active: boolean) => void
}

const PageStatsContext = createContext<PageStatsApi | null>(null)

export function PageStatsProvider({ children }: { children: ReactNode }) {
  const [slot, setSlotState] = useState<HTMLDivElement | null>(null)
  const [active, setActiveState] = useState(false)
  const setSlot = useCallback((node: HTMLDivElement | null) => {
    setSlotState((current) => (current === node ? current : node))
  }, [])
  const setActive = useCallback((next: boolean) => {
    setActiveState((current) => (current === next ? current : next))
  }, [])
  const value = useMemo(() => ({ slot, setSlot, active, setActive }), [slot, setSlot, active, setActive])
  return <PageStatsContext.Provider value={value}>{children}</PageStatsContext.Provider>
}

export function PageStats({ label, children }: { label: string; children: ReactNode }) {
  const api = useContext(PageStatsContext)
  const setActive = api?.setActive
  useEffect(() => {
    if (!setActive) return
    setActive(true)
    return () => setActive(false)
  }, [setActive])
  if (!api?.slot) return null
  return createPortal(
    <div className="context-extra-block">
      <p className="context-extra-label">{label}</p>
      <div className="context-extra-row">{children}</div>
    </div>,
    api.slot,
  )
}

export function ContextExtra({ open }: { open: boolean }) {
  const api = useContext(PageStatsContext)
  if (!api) return null
  return <div id="context-extra" ref={api.setSlot} className={open ? "context-extra" : "context-extra is-collapsed"} />
}

export function ContextStatsToggle({
  open,
  label,
  onToggle,
}: {
  open: boolean
  label: string
  onToggle: () => void
}) {
  const api = useContext(PageStatsContext)
  if (!api?.active) return null
  return (
    <button
      type="button"
      className={open ? "context-toggle is-open" : "context-toggle"}
      aria-expanded={open}
      aria-controls="context-extra"
      title={label}
      aria-label={label}
      onClick={onToggle}
    >
      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 14l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
