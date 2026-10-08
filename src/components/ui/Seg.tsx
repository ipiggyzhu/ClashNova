import type { ReactNode } from 'react'

export interface SegItem<T extends string = string> {
  value: T
  label: ReactNode
}

export interface SegProps<T extends string = string> {
  items: SegItem<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
  label?: string
  disabled?: boolean
}

export default function Seg<T extends string = string>({
  items,
  value,
  onChange,
  className,
  label,
  disabled,
}: SegProps<T>) {
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="group" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          aria-pressed={it.value === value}
          disabled={disabled}
          className={it.value === value ? 'seg-item on' : 'seg-item'}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
