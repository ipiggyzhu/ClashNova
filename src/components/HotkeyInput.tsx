import { useState } from 'react'
import { useT } from '../i18n'
import Icon from './ui/Icon'

interface HotkeyInputProps {
  label: string
  value: string
  onCommit: (accelerator: string) => void
}

/** 录制一次组合键；Escape 取消录制，失焦不提交。 */
export default function HotkeyInput({ label, value, onCommit }: HotkeyInputProps) {
  const t = useT()
  const [recording, setRecording] = useState(false)

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!recording) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      return
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return
    const parts: string[] = []
    if (event.ctrlKey) parts.push('Ctrl')
    if (event.shiftKey) parts.push('Shift')
    if (event.altKey) parts.push('Alt')
    if (event.metaKey) parts.push('Super')
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key)
    onCommit(parts.join('+'))
    setRecording(false)
  }

  return (
    <div className="hotkey-set">
      <button type="button" className={recording ? 'hotkey-btn rec' : 'hotkey-btn'}
        aria-label={`${label}：${recording ? t('按下组合键') : value || t('点击录制')}`} aria-pressed={recording}
        onClick={() => setRecording(true)} onKeyDown={onKeyDown} onBlur={() => setRecording(false)}>
        {recording ? t('按下组合键') : value ? (
          <span className="kbd-group">
            {value.split('+').map((key, index) => <span className="kbd" key={`${index}-${key}`}>{key}</span>)}
          </span>
        ) : t('点击录制')}
      </button>
      {value && (
        <button type="button" className="hotkey-clear" title={t('清除')} aria-label={`${t('清除')}：${label}`} onClick={() => onCommit('')}>
          <Icon name="x" size={11} />
        </button>
      )}
    </div>
  )
}
