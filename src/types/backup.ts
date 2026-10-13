export interface BackupEntry {
  id: string
  label: string
  createdAt: number
  appVersion: string
  sizeBytes: number
  source: 'local' | 'webdav'
  /** Damaged entries remain visible/deletable, but cannot be restored or uploaded. */
  error?: string
}

export interface BackupPreview {
  entry: BackupEntry
  profileCount: number
  enhancerCount: number
  fileCount: number
  preservedSettings: string[]
  warnings: string[]
}

export interface BackupExport {
  filename: string
  content: string
}

export interface WebDavConfig {
  url: string
  username: string
  passwordSaved: boolean
}

export interface WebDavConfigInput {
  url: string
  username: string
  /** Omitted retains the stored password only when the account and origin match. */
  password?: string
}
