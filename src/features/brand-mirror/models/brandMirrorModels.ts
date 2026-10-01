export type BrandTheme = 'studio' | 'editorial' | 'night'
export type MirrorStatus = 'loading' | 'ready' | 'editing' | 'error'
export type SavePhase = 'idle' | 'pending' | 'saving' | 'saved' | 'error'
export type WorkspaceRole = 'starting' | 'owner' | 'viewer'

export interface BrandTokens {
  primary: string
  secondary: string
  radiusScale: number[]
  spacingScale: number[]
  typeScale: number[]
}

export interface SavedVersion {
  id: string
  label: string
  tokens: BrandTokens
  createdAt: string
}

export interface BrandDocument {
  version: 1
  tokens: BrandTokens
  theme: BrandTheme
  versions: SavedVersion[]
}

export interface BrandMirrorSnapshot {
  status: MirrorStatus
  tokens: BrandTokens
  theme: BrandTheme
  versions: SavedVersion[]
  compareMode: boolean
  activeVersionId: string | null
  contrastRatio: number
  contrastWarning: boolean
  message: string
  savePhase: SavePhase
  savedAt: number | null
  role: WorkspaceRole
  peerCount: number
  ownerSessionId: string | null
  /** 异常关闭后找回的未保存草稿，等待用户决定恢复还是丢弃 */
  recovery: PendingRecovery | null
  /** 与另一个页面的写入冲突，用户决定前冻结本页自动保存 */
  conflict: WorkspaceConflict | null
  /** 只读/降级等非阻断性提示，例如被另一个页面接管 */
  notice: string | null
}

export interface PendingRecovery {
  draftAt: number
  committedAt: number | null
  tokens: BrandTokens
  theme: BrandTheme
  versions: SavedVersion[]
}

export interface WorkspaceConflict {
  localTokens: BrandTokens
  localTheme: BrandTheme
  localUpdatedAt: number
  remoteTokens: BrandTokens
  remoteTheme: BrandTheme
  remoteUpdatedAt: number
  remoteRevision: number
  remoteSessionId: string
  fromStartup: boolean
}

export const INITIAL_TOKENS: BrandTokens = {
  primary: '#F15A47',
  secondary: '#24324A',
  radiusScale: [8, 12, 18, 28],
  spacingScale: [4, 8, 12, 20, 32],
  typeScale: [12, 14, 16, 20, 28, 40],
}

export const THEME_PRESETS: Record<BrandTheme, { label: string; tokens: BrandTokens }> = {
  studio: {
    label: 'Studio warm',
    tokens: INITIAL_TOKENS,
  },
  editorial: {
    label: 'Editorial green',
    tokens: {
      primary: '#238B73', secondary: '#173C35', radiusScale: [4, 8, 12, 18], spacingScale: [4, 8, 16, 24, 40], typeScale: [12, 14, 16, 22, 30, 44],
    },
  },
  night: {
    label: 'Night signal',
    tokens: {
      primary: '#A98BFF', secondary: '#191829', radiusScale: [6, 10, 14, 22], spacingScale: [4, 8, 12, 18, 28], typeScale: [12, 14, 16, 20, 28, 38],
    },
  },
}
