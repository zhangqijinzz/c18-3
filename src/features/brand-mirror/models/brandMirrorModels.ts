export type BrandTheme = 'studio' | 'editorial' | 'night'
export type MirrorStatus = 'loading' | 'ready' | 'editing' | 'readonly' | 'conflict' | 'error'

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

/** Draft envelope persisted alongside the committed document; survives tab crashes. */
export interface DraftEnvelope {
  version: 1
  document: BrandDocument
  updatedAt: number
  /**
   * True when written by the unload flush of a healthy shutdown.
   * Absent/false means the last write was a periodic checkpoint, so the tab
   * may have been killed with edits still buffered.
   */
  closed?: boolean
  /** Tab/session that last wrote the draft, for cross-tab attribution. */
  sessionId: string
}

export interface SessionRecord {
  id: string
  startedAt: number
  heartbeatAt: number
  role: 'owner' | 'reader'
  /** Increments every time this tab forcefully takes ownership over. */
  claim: number
}

export type ConflictReason =
  /** A tab that took ownership away from us while we had unsaved edits. */
  | 'demoted-dirty'
  /** A draft written by another tab differs from what we are displaying. */
  | 'remote-diverged'

export interface ConflictNotice {
  reason: ConflictReason
  remoteDocument: BrandDocument
  remoteUpdatedAt: number
  remoteSessionId: string
}

export interface DraftRecovery {
  updatedAt: number
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
  /** Autosave state of this tab. */
  saveState: 'idle' | 'saving' | 'saved' | 'offline'
  lastSavedAt: number | null
  /** False until this tab wins ownership or the user takes over. */
  canEdit: boolean
  conflict: ConflictNotice | null
  draftRecovery: DraftRecovery | null
  /** Owner currently holding the workspace; null when this tab owns it. */
  ownerLabel: string | null
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
