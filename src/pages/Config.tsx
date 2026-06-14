import { useEffect, useState } from 'react'
import './Config.css'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import CodeEditor from '../components/ui/CodeEditor'
import Icon from '../components/ui/Icon'
import { useT } from '../i18n'
import { call } from '../services/ipc'

export default function Config() {
  const t = useT()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      console.log('[Config] 开始加载运行时配置...')
      const yaml = await call('get_runtime_config')
      console.log('[Config] 加载成功，内容长度:', yaml.length)
      setContent(yaml)
    } catch (err) {
      console.error('[Config] 加载失败:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const copyToClipboard = () => {
    void navigator.clipboard.writeText(content).catch(() => {})
  }

  return (
    <div className="pg-config">
      <Card
        icon={<Icon name="settings" />}
        iconColor="var(--accent)"
        title={t('当前运行配置')}
        actions={
          <>
            {!loading && !error && (
              <>
                <Button size="sm" onClick={copyToClipboard}>
                  <Icon name="download" size={13} />
                  {t('复制')}
                </Button>
                <Button size="sm" onClick={() => void load()}>
                  <Icon name="refresh" size={13} />
                  {t('刷新')}
                </Button>
              </>
            )}
          </>
        }
      >
        {loading && (
          <div className="config-status">
            <Icon name="refresh" size={24} />
            <span>{t('加载中…')}</span>
          </div>
        )}
        {error && (
          <div className="config-status error">
            <Icon name="x" size={24} />
            <span>{error}</span>
            <Button size="sm" onClick={() => void load()}>
              {t('重试')}
            </Button>
          </div>
        )}
        {!loading && !error && (
          <div className="config-editor">
            <CodeEditor value={content} onChange={() => {}} lang="yaml" readOnly />
          </div>
        )}
      </Card>
    </div>
  )
}
