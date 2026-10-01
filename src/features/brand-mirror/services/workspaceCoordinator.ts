import type { DraftEnvelope, SessionRecord } from '../models/brandMirrorModels'
import { DRAFT_STORAGE_KEY, SESSIONS_STORAGE_KEY, type StorageService } from '../services/storageService'
import type { Clock } from './clock'
import { parseDraft } from '../repositories/brandRepository'

export type CoordinatorRole = 'owner' | 'reader'

export interface StartupResult {
  role: CoordinatorRole
  /** Live session currently holding the workspace when this tab starts as a reader. */
  owner: SessionRecord | null
}

export interface CoordinatorCallbacks {
  /** Another tab (owner or new taker) wrote a draft. */
  onRemoteDraft?(envelope: DraftEnvelope): void
  /** Our ownership was taken away by another tab. */
  onDemotion?(newOwner: SessionRecord): void
  /** The owner we were reading vanished; this tab has been promoted. */
  onPromotion?(): void
  /** A second tab joined while we own the workspace. */
  onReaderJoined?(reader: SessionRecord): void
}

export const HEARTBEAT_INTERVAL_MS = 1_500
/** Heartbeat older than this means the tab crashed or was suspended. */
export const SESSION_STALE_MS = 6_000

interface SessionsLedger {
  sessions: SessionRecord[]
}

/**
 * Coordinates which tab may write the workspace using a session ledger in
 * localStorage. Writes are opt-in: a tab never overwrites another tab's draft
 * while it is only a reader, and ownership transfers require an explicit claim.
 */
export class WorkspaceCoordinator {
  readonly sessionId: string
  private role: CoordinatorRole = 'reader'
  private claim = 0
  private sessions: SessionRecord[] = []
  private heartbeatHandle: number | null = null
  private started = false
  private detachStorage?: () => void
  /** True while applying our own ledger write; suppresses echo events. */
  private writingSessions = false
  private callbacks: CoordinatorCallbacks

  constructor(
    private readonly storage: StorageService,
    private readonly clock: Clock,
    callbacks: CoordinatorCallbacks = {},
    sessionId?: string,
  ) {
    this.callbacks = callbacks
    this.sessionId = sessionId ?? `session-${clock.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  }

  /** Register (or replace) the event sinks. Safe to call before `start`. */
  setCallbacks(callbacks: CoordinatorCallbacks): void {
    this.callbacks = callbacks
  }

  start(): StartupResult {
    if (this.started) return { role: this.role, owner: this.currentOwner() }
    this.started = true
    this.sessions = this.readSessions()
    this.pruneStale()

    const owner = this.currentOwner()
    if (owner) {
      this.role = 'reader'
      this.upsertSession('reader')
    } else {
      this.role = 'owner'
      this.upsertSession('owner')
    }

    this.detachStorage = this.storage.subscribe((key, value) => {
      if (this.writingSessions) return // echo of our own write
      if (key === SESSIONS_STORAGE_KEY) {
        this.handleSessionsChanged(value)
      } else if (key === DRAFT_STORAGE_KEY) {
        const envelope = parseDraft(value)
        if (envelope && envelope.sessionId !== this.sessionId) this.callbacks.onRemoteDraft?.(envelope)
      }
    })
    this.heartbeatHandle = this.clock.setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS)
    // No automatic unload hook here: the owning view model flushes its draft
    // first and then calls `prepareUnload`, so a waiting reader can never
    // promote itself onto a stale draft.

    return { role: this.role, owner: this.role === 'reader' ? owner : null }
  }

  getRole(): CoordinatorRole {
    return this.role
  }

  getOwner(): SessionRecord | null {
    return this.role === 'owner' ? null : this.currentOwner()
  }

  /** Reader drafts stay in memory until the user explicitly takes over. */
  canWrite(): boolean {
    return this.role === 'owner'
  }

  /**
   * Promotes this tab to owner. The previous owner is left as a reader in the
   * ledger so it observes the claim bump through the storage event and stops
   * writing before any further overwrite can happen.
   */
  takeOver(): void {
    this.claim += 1
    this.role = 'owner'
    this.sessions = this.readSessions()
    this.sessions = this.sessions.map((session) => (session.role === 'owner' && session.id !== this.sessionId
      ? { ...session, role: 'reader' }
      : session))
    this.upsertSession('owner')
  }

  /** Explicit user choice to keep browsing the other tab's workspace read-only. */
  rejoinAsReader(): void {
    if (this.role === 'owner') {
      this.role = 'reader'
      this.upsertSession('reader')
    }
  }

  /**
   * Simulate this tab's process being killed: timers and listeners stop, but
   * the session stays in the shared ledger going stale and the draft remains
   * on disk. Test-only.
   */
  kill(): void {
    if (this.heartbeatHandle !== null) this.clock.clearInterval(this.heartbeatHandle)
    this.heartbeatHandle = null
    this.detachStorage?.()
  }

  /**
   * Called while the page is going away. We drop out of the ledger so that
   * waiting readers can take over promptly; the draft itself is kept on disk
   * (clean or dirty) for recovery.
   */
  prepareUnload(): void {
    this.sessions = this.readSessions().filter((session) => session.id !== this.sessionId)
    this.writeSessions()
    if (this.heartbeatHandle !== null) this.clock.clearInterval(this.heartbeatHandle)
    this.heartbeatHandle = null
    this.detachStorage?.()
  }

  private tick(): void {
    this.sessions = this.readSessions()
    this.pruneStale()

    if (this.role === 'reader') {
      const owner = this.currentOwner()
      if (!owner) {
        this.role = 'owner'
        this.upsertSession('owner')
        this.callbacks.onPromotion?.()
        return
      }
    }

    const self = this.sessions.find((session) => session.id === this.sessionId)
    if (!self || self.role !== this.role || self.claim !== this.claim || this.clock.now() - self.heartbeatAt > HEARTBEAT_INTERVAL_MS) {
      this.upsertSession(this.role)
    }
  }

  private handleSessionsChanged(raw: string | null): void {
    const next = parseLedger(raw)
    const previousReaderIds = new Set(
      this.sessions.filter((session) => session.id !== this.sessionId && session.role === 'reader').map((session) => session.id),
    )
    this.sessions = next
    this.pruneStale()

    const nextOwner = this.currentOwner()

    if (this.role === 'owner' && nextOwner && nextOwner.id !== this.sessionId) {
      // A higher claim always wins. Equal claims break by session id so the
      // two racing tabs converge on the same outcome.
      const self = next.find((session) => session.id === this.sessionId)
      const selfClaim = self?.claim ?? 0
      const lost = nextOwner.claim > selfClaim || (nextOwner.claim === selfClaim && nextOwner.id < this.sessionId)
      if (lost) {
        this.role = 'reader'
        this.claim = selfClaim
        this.upsertSession('reader')
        this.callbacks.onDemotion?.(nextOwner)
      } else {
        // Re-assert ownership; the racing tab yields on its next event.
        this.upsertSession('owner')
      }
      return
    }

    if (this.role === 'reader' && !nextOwner) {
      this.role = 'owner'
      this.upsertSession('owner')
      this.callbacks.onPromotion?.()
      return
    }

    if (this.role === 'owner') {
      const joiner = next.find((session) => session.id !== this.sessionId && session.role === 'reader' && !previousReaderIds.has(session.id))
      if (joiner) this.callbacks.onReaderJoined?.(joiner)
    }
  }

  private currentOwner(): SessionRecord | null {
    return this.currentOwnerFrom(this.sessions)
  }

  private currentOwnerFrom(list: SessionRecord[]): SessionRecord | null {
    const owners = list.filter((session) => session.role === 'owner')
    if (owners.length === 0) return null
    return owners.reduce((winner, candidate) => (candidate.claim > winner.claim || (candidate.claim === winner.claim && candidate.id < winner.id) ? candidate : winner))
  }

  private pruneStale(): void {
    const cutoff = this.clock.now() - SESSION_STALE_MS
    this.sessions = this.sessions.filter((session) => session.id === this.sessionId || session.heartbeatAt >= cutoff)
  }

  private upsertSession(role: CoordinatorRole): void {
    const now = this.clock.now()
    const previous = this.readSessions().find((session) => session.id === this.sessionId)
    this.sessions = this.readSessions().filter((session) => session.id !== this.sessionId)
    this.pruneStale()
    const record: SessionRecord = {
      id: this.sessionId,
      startedAt: previous?.startedAt ?? now,
      heartbeatAt: now,
      role,
      claim: role === 'owner' ? this.claim : 0,
    }
    this.sessions.push(record)
    this.writeSessions()
  }

  private readSessions(): SessionRecord[] {
    return parseLedger(this.storage.read(SESSIONS_STORAGE_KEY))
  }

  private writeSessions(): void {
    const ledger: SessionsLedger = { sessions: this.sessions }
    this.writingSessions = true
    try {
      this.storage.write(SESSIONS_STORAGE_KEY, JSON.stringify(ledger))
    } finally {
      this.writingSessions = false
    }
  }
}

function parseLedger(raw: string | null): SessionRecord[] {
  if (!raw) return []
  try {
    const candidate: unknown = JSON.parse(raw)
    if (!candidate || typeof candidate !== 'object') return []
    const sessions = (candidate as SessionsLedger).sessions
    if (!Array.isArray(sessions)) return []
    return sessions.filter(isSession)
  } catch {
    return []
  }
}

function isSession(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SessionRecord>
  return typeof candidate.id === 'string'
    && typeof candidate.startedAt === 'number'
    && typeof candidate.heartbeatAt === 'number'
    && (candidate.role === 'owner' || candidate.role === 'reader')
    && typeof candidate.claim === 'number'
}
