import type { CSSProperties, ReactNode } from 'react'

export interface CardProps {
  /** 卡片头图标(置于 .card-ic 容器内, 一般传 <Icon name=.../>) */
  icon?: ReactNode
  /** .card-ic 的着色(currentColor 同时驱动底色), 如 "var(--green)" */
  iconColor?: string
  title?: ReactNode
  /** 头部右侧操作区(.card-actions) */
  actions?: ReactNode
  /** true 时 children 不包 .card-body(用于表格等通栏内容) */
  flush?: boolean
  className?: string
  style?: CSSProperties
  bodyClassName?: string
  bodyStyle?: CSSProperties
  children?: ReactNode
}

export default function Card({
  icon,
  iconColor,
  title,
  actions,
  flush = false,
  className,
  style,
  bodyClassName,
  bodyStyle,
  children,
}: CardProps) {
  const hasHead = icon != null || title != null || actions != null
  return (
    <div className={className ? `card ${className}` : 'card'} style={style}>
      {hasHead && (
        <div className="card-head">
          {icon != null && (
            <span className="card-ic" style={iconColor ? { color: iconColor } : undefined}>
              {icon}
            </span>
          )}
          {title != null && <h3>{title}</h3>}
          {actions != null && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {flush ? (
        children
      ) : (
        <div className={bodyClassName ? `card-body ${bodyClassName}` : 'card-body'} style={bodyStyle}>
          {children}
        </div>
      )}
    </div>
  )
}
