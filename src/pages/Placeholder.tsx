import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'

export interface PlaceholderProps {
  title: string
}

/** M3 功能占位页(traffic/topology/routemap/providers) */
export default function Placeholder({ title }: PlaceholderProps) {
  return (
    <section className="page">
      <Card icon={<Icon name="clock" />} iconColor="var(--accent)" title={title}>
        <div className="placeholder-body">
          <div className="placeholder-big">M3 开发中</div>
          <p>「{title}」将在 M3 里程碑提供，敬请期待。</p>
        </div>
      </Card>
    </section>
  )
}
