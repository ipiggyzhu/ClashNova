import type { CSSProperties, ReactNode } from 'react'

export type BadgeTone =
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'gray'
  | 'blue'
  | 'purple'
  | 'cyan'

export interface BadgeProps {
  tone?: BadgeTone
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

export default function Badge({ tone = 'gray', className, style, children }: BadgeProps) {
  const cls = ['badge', `b-${tone}`, className ?? ''].filter(Boolean).join(' ')
  return (
    <span className={cls} style={style}>
      {children}
    </span>
  )
}
