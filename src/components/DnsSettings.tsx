import { useState } from 'react'
import './DnsSettings.css'
import Button from './ui/Button'
import Icon from './ui/Icon'
import Input from './ui/Input'
import Seg from './ui/Seg'
import Toggle from './ui/Toggle'
import { useT } from '../i18n'
import { useAppStore } from '../stores/app'
import type { AppSettings, DnsEnhancedMode, FakeIpFilterMode } from '../types/clash'

interface RowProps {
  title: string
  desc?: string
  children: React.ReactNode
}

function Row({ title, desc, children }: RowProps) {
  return (
    <div className="dns-row">
      <div className="dns-info">
        <h4>{title}</h4>
        {desc && <p>{desc}</p>}
      </div>
      <div className="dns-ctrl">{children}</div>
    </div>
  )
}

interface DnsSettingsProps {
  onClose: () => void
}

export default function DnsSettings({ onClose }: DnsSettingsProps) {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const patchSettings = useAppStore((s) => s.patchSettings)

  const [draft, setDraft] = useState<Partial<Record<keyof AppSettings, string>>>({})
  const [validationError, setValidationError] = useState<string | null>(null)

  const patch = (p: Partial<AppSettings>): void => {
    void patchSettings(p).catch(() => {})
  }

  const draftValue = (key: keyof AppSettings, fallback: string): string =>
    (draft[key] as string | undefined) ?? fallback

  const commitText = (key: 'dnsListen' | 'fakeIpRange'): void => {
    const raw = draft[key]
    if (raw === undefined) return
    const trimmed = raw.trim()

    if (!trimmed) {
      setDraft((d) => ({ ...d, [key]: undefined }))
      return
    }

    // 验证 DNS 监听地址格式: host:port
    if (key === 'dnsListen') {
      const match = trimmed.match(/^(.+):(\d+)$/)
      if (!match) {
        setValidationError(t('DNS 监听地址格式错误，应为 host:port'))
        return
      }
      const port = parseInt(match[2], 10)
      if (port < 1 || port > 65535) {
        setValidationError(t('端口范围应为 1-65535'))
        return
      }
    }

    // 验证 Fake IP 范围格式: CIDR
    if (key === 'fakeIpRange') {
      const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/
      if (!cidrRegex.test(trimmed)) {
        setValidationError(t('Fake IP 范围格式错误，应为 CIDR 格式（如 198.18.0.1/16）'))
        return
      }
      // 验证每个八位组范围
      const parts = trimmed.split('/')
      const octets = parts[0].split('.').map(Number)
      if (octets.some((n) => n > 255)) {
        setValidationError(t('IP 地址段应为 0-255'))
        return
      }
      const prefix = parseInt(parts[1], 10)
      if (prefix < 1 || prefix > 32) {
        setValidationError(t('CIDR 前缀应为 1-32'))
        return
      }
    }

    setValidationError(null)
    patch({ [key]: trimmed })
    setDraft((d) => ({ ...d, [key]: undefined }))
  }

  const resetDefaults = (): void => {
    patch({
      enableDns: true,
      dnsListen: '127.0.0.1:5335',
      dnsEnhancedMode: 'fake-ip',
      fakeIpRange: '198.18.0.1/16',
      fakeIpFilterMode: 'blacklist',
      ipv6Dns: false,
      preferH3: false,
      respectRules: false,
      useHosts: false,
      useSystemHosts: false,
    })
  }

  return (
    <div className="dns-mask" onClick={onClose}>
      <div className="dns-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="dns-head">
          <Icon name="zap" size={16} />
          <span>{t('DNS 覆写')}</span>
          <span className="spacer" />
          <Button size="sm" onClick={resetDefaults}>
            <Icon name="refresh" size={13} />
            {t('重置为默认值')}
          </Button>
          <button className="icon-btn" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <div className="dns-body">
          {validationError && (
            <div className="dns-error">
              <Icon name="x" size={14} />
              <span>{validationError}</span>
            </div>
          )}

          <Row title={t('启用 DNS')}>
            <Toggle on={settings.enableDns} onChange={(on) => patch({ enableDns: on })} />
          </Row>

          <Row title={t('DNS 监听地址')}>
            <Input
              style={{ width: 180 }}
              value={draftValue('dnsListen', settings.dnsListen)}
              onChange={(e) => setDraft((d) => ({ ...d, dnsListen: e.target.value }))}
              onBlur={() => commitText('dnsListen')}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('增强模式')}>
            <Seg<DnsEnhancedMode | ''>
              items={[
                { value: '', label: t('关闭') },
                { value: 'fake-ip', label: 'Fake IP' },
                { value: 'redir-host', label: 'Redir Host' },
              ]}
              value={settings.dnsEnhancedMode}
              onChange={(v) => patch({ dnsEnhancedMode: v })}
            />
          </Row>

          {settings.dnsEnhancedMode === 'fake-ip' && (
            <>
              <Row title={t('Fake IP 范围')}>
                <Input
                  style={{ width: 180 }}
                  value={draftValue('fakeIpRange', settings.fakeIpRange)}
                  onChange={(e) => setDraft((d) => ({ ...d, fakeIpRange: e.target.value }))}
                  onBlur={() => commitText('fakeIpRange')}
                  disabled={!settings.enableDns}
                />
              </Row>

              <Row title={t('Fake IP 过滤模式')}>
                <Seg<FakeIpFilterMode>
                  items={[
                    { value: 'blacklist', label: t('黑名单') },
                    { value: 'whitelist', label: t('白名单') },
                  ]}
                  value={settings.fakeIpFilterMode}
                  onChange={(v) => patch({ fakeIpFilterMode: v })}
                />
              </Row>
            </>
          )}

          <Row title="IPv6" desc={t('启用 IPv6 DNS 解析')}>
            <Toggle
              on={settings.ipv6Dns}
              onChange={(on) => patch({ ipv6Dns: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('优先使用 HTTP/3')} desc={t('DNS DOH 使用 HTTP/3 协议')}>
            <Toggle
              on={settings.preferH3}
              onChange={(on) => patch({ preferH3: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('遵循路由规则')} desc={t('DNS 连接遵循路由规则')}>
            <Toggle
              on={settings.respectRules}
              onChange={(on) => patch({ respectRules: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('使用 Hosts')} desc={t('启用通过 hosts 文件解析域名')}>
            <Toggle
              on={settings.useHosts}
              onChange={(on) => patch({ useHosts: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('使用系统 Hosts')} desc={t('启用通过操作系统 hosts 文件解析')}>
            <Toggle
              on={settings.useSystemHosts}
              onChange={(on) => patch({ useSystemHosts: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <div className="dns-note">
            <Icon name="bell" size={14} />
            <span>
              {t('高级配置会与 DNS 覆写编辑器互相同步；编辑器中的 nameserver、fallback 等额外字段会保留。')}
            </span>
          </div>
        </div>

        <div className="dns-foot">
          <Button variant="primary" onClick={onClose}>
            <Icon name="check" size={13} />
            {t('保存')}
          </Button>
        </div>
      </div>
    </div>
  )
}
