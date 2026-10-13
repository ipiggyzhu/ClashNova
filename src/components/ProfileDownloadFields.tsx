import type { ProfileDownloadOptions } from '../types/profileFeatures'
import Input from './ui/Input'

interface Props {
  value: ProfileDownloadOptions
  onChange: (value: ProfileDownloadOptions) => void
  disabled?: boolean
}

export default function ProfileDownloadFields({ value, onChange, disabled = false }: Props) {
  return (
    <fieldset className="profile-download-fields" disabled={disabled}>
      <legend>下载选项</legend>
      <label>
        <span>User-Agent</span>
        <Input value={value.userAgent ?? ''} placeholder="留空使用 ClashNova 默认值" maxLength={512}
          onChange={(event) => onChange({ ...value, userAgent: event.target.value })} />
      </label>
      <label>
        <span>下载超时（秒）</span>
        <Input type="number" min={1} max={300} step={1} value={value.timeoutSec}
          onChange={(event) => onChange({ ...value, timeoutSec: Number(event.target.value) })} />
      </label>
      <label>
        <span>下载代理</span>
        <select aria-label="下载代理" value={value.proxy} onChange={(event) => onChange({ ...value, proxy: event.target.value as ProfileDownloadOptions['proxy'] })}>
          <option value="system">系统手动代理 / 环境代理</option>
          <option value="direct">直接连接（不使用代理）</option>
          <option value="core">通过 ClashNova 内核</option>
        </select>
      </label>
      <label className="profile-download-check">
        <input type="checkbox" checked={value.updateIntervalFromHeader}
          onChange={(event) => onChange({ ...value, updateIntervalFromHeader: event.target.checked })} />
        <span>采用订阅响应头的更新间隔（关闭自动更新时不生效）</span>
      </label>
    </fieldset>
  )
}
