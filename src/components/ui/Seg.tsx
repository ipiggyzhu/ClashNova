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
}

export default function Seg<T extends string = string>({
  items,
  value,
  onChange,
  className,
}: SegProps<T>) {
  return (
    <div className={className ? `seg ${className}` : 'seg'}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          className={it.value === value ? 'seg-item on' : 'seg-item'}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
