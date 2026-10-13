export interface AppUpdate {
  version: string
  buildId: string
  assetName: string
  size: number
  sha256: string
  sameVersion: boolean
}

export interface CoreUpdate {
  version: string
  size: number
  sha256: string
}

export interface InstalledCore {
  id: string
  version: string
  bundled: boolean
  active: boolean
}

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'switching' | 'failed' | 'cancelled'

export interface UpdateState {
  supported: boolean
  currentBuildId: string
  appChecked: boolean
  appDownloaded: boolean
  app: AppUpdate | null
  core: CoreUpdate | null
  installedCores: InstalledCore[]
  phase: UpdatePhase
  kind: 'app' | 'core' | null
  downloaded: number
  total: number
  error: string | null
}
