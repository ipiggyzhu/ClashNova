import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'

function errorMessage(error: unknown): string {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown application error'
}

export default function RouteError() {
  const error = useRouteError()
  const message = errorMessage(error)

  return (
    <div className="route-error">
      <Card
        icon={<Icon name="x" />}
        iconColor="var(--red)"
        title="页面加载失败"
        actions={
          <>
            <Button onClick={() => window.location.reload()}>刷新</Button>
            <Button variant="primary" onClick={() => window.location.assign('/dashboard')}>
              回到首页
            </Button>
          </>
        }
      >
        <p>应用收到了一段异常数据，当前页面没有成功渲染。</p>
        <pre>{message}</pre>
      </Card>
    </div>
  )
}
