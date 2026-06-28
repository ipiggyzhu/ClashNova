export interface ToggleProps {
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  className?: string
  /** 无障碍标签 */
  label?: string
}

export default function Toggle({ on, onChange, disabled = false, className, label }: ToggleProps) {
  const cls = ['toggle', on ? 'on' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <div
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={cls}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      onClick={() => {
        if (!disabled) onChange(!on)
      }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onChange(!on)
        }
      }}
    >
      <div className="knob" />
    </div>
  )
}
