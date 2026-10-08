export interface ToggleProps {
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  className?: string
  /** 无障碍标签 */
  label: string
}

export default function Toggle({ on, onChange, disabled = false, className, label }: ToggleProps) {
  const cls = ['toggle', on ? 'on' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={cls}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      onClick={() => {
        if (!disabled) onChange(!on)
      }}
    >
      <span className="knob" aria-hidden="true" />
    </button>
  )
}
