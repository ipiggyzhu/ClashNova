import { useEffect, useLayoutEffect, useState } from 'react'
import type { ProfileMeta } from '../types/clash'
import Icon from './ui/Icon'
import type { IconName } from './ui/Icon'
import { useDialogFocus } from './ui/Dialog'

export interface ProfileMenuState {
  x: number
  y: number
  profile: ProfileMeta
}

export type ProfileMenuAction = 'select' | 'update' | 'meta' | 'edit' | 'rule' | 'merge' | 'script' | 'delete'

interface ProfileMenuProps {
  state: ProfileMenuState
  onClose: () => void
  onAction: (action: ProfileMenuAction, profile: ProfileMeta) => void
}

const ITEMS: { action: ProfileMenuAction; icon: IconName; label: string }[] = [
  { action: 'select', icon: 'check', label: '设为当前订阅' },
  { action: 'update', icon: 'refresh', label: '更新订阅' },
  { action: 'meta', icon: 'settings', label: '编辑订阅信息' },
  { action: 'edit', icon: 'edit', label: '编辑文件' },
  { action: 'rule', icon: 'rules', label: '添加分流规则' },
  { action: 'merge', icon: 'profiles', label: '新建 Merge 覆写' },
  { action: 'script', icon: 'zap', label: '新建 Script 脚本' },
  { action: 'delete', icon: 'trash', label: '删除' },
]

export default function ProfileMenu({ state, onClose, onAction }: ProfileMenuProps) {
  const ref = useDialogFocus(onClose, false)
  const [position, setPosition] = useState({ left: state.x, top: state.y })
  useLayoutEffect(() => {
    const bounds = ref.current?.getBoundingClientRect()
    if (bounds) setPosition({
      left: Math.max(8, Math.min(state.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(state.y, window.innerHeight - bounds.height - 8)),
    })
  }, [ref, state.x, state.y])

  useEffect(() => {
    const outside = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('contextmenu', outside)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('contextmenu', outside)
    }
  }, [onClose, ref])

  return (
    <div ref={ref} className="profile-menu" role="menu" aria-label={`${state.profile.name} 的订阅操作`}
      tabIndex={-1} style={position} onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          onClose()
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}>
      {ITEMS.filter((item) => item.action !== 'update' || state.profile.kind === 'remote').map((item) => (
        <button key={item.action} type="button" role="menuitem" className={item.action === 'delete' ? 'danger' : undefined}
          disabled={item.action === 'select' && state.profile.current} onClick={() => onAction(item.action, state.profile)}>
          <Icon name={item.icon} size={13} />{item.label}
        </button>
      ))}
    </div>
  )
}
