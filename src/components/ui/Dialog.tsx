import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

const focusableSelector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
const openDialogs: HTMLElement[] = []

/** 弹层共享键盘焦点处理；只有最上层弹层响应 Escape。 */
export function useDialogFocus(onClose: () => void, modal = true, dismissible = true) {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef({ onClose, dismissible })
  latest.current = { onClose, dismissible }

  useEffect(() => {
    const panel = ref.current
    if (!panel) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openDialogs.push(panel)
    const isTopmost = (): boolean => openDialogs[openDialogs.length - 1] === panel
    const focusable = (): HTMLElement[] => Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
    const focusFirst = (): void => (focusable()[0] ?? panel).focus({ preventScroll: true })
    focusFirst()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTopmost() || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (latest.current.dismissible) latest.current.onClose()
      } else if (modal && event.key === 'Tab') {
        const elements = focusable()
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (!first) {
          event.preventDefault()
          panel.focus()
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (modal && isTopmost() && !panel.contains(event.target as Node)) focusFirst()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
      const index = openDialogs.indexOf(panel)
      if (index >= 0) openDialogs.splice(index, 1)
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [modal])

  return ref
}

interface DialogProps {
  title: string
  className: string
  panelClassName: string
  onClose: () => void
  dismissible?: boolean
  children: ReactNode
}

export default function Dialog({ title, className, panelClassName, onClose, dismissible = true, children }: DialogProps) {
  const ref = useDialogFocus(onClose, true, dismissible)
  return (
    <div className={`dialog-mask ${className}`} onClick={(event) => {
      if (event.target === event.currentTarget && dismissible) onClose()
    }}>
      <div ref={ref} className={`dialog-panel ${panelClassName}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}
