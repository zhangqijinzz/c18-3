import { clampTokenValues, cloneTokens, contrastRatio, normalizeColor, themeTokens, validateTokens } from '../domain/brandRules'
import type { BrandRepository } from '../repositories/brandRepository'
import type { BrandGuidelinesExporter } from '../services/exportService'
import { createBrowserClock, type Clock } from '../services/clock'
import { WorkspaceCoordinator } from '../services/workspaceCoordinator'
import { SESSION_STALE_MS } from '../services/workspaceCoordinator'
import type { StorageService } from '../services/storageService'
import { SESSIONS_STORAGE_KEY } from '../services/storageService'
import { INITIAL_TOKENS, type BrandDocument, type BrandMirrorSnapshot, type BrandTheme, type ConflictNotice, type DraftEnvelope, type DraftRecovery, type SavedVersion, type SessionRecord } from '../models/brandMirrorModels'

type Listener = () => void

const AUTOSAVE_DEBOUNCE_MS = 800
/** Drafts older than this are treated as stale remnants and discarded. */
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

export class BrandMirrorViewModel {
  private document: BrandDocument = { version: 1, tokens: INITIAL_TOKENS, theme: 'studio', versions: [] }
  private snapshot: BrandMirrorSnapshot = this.makeSnapshot('', 'ready')
  private readonly listeners = new Set<Listener>()
  private readonly repository: BrandRepository
  private readonly exporter?: BrandGuidelinesExporter
  private readonly clock: Clock
  private readonly coordinator: WorkspaceCoordinator
  private readonly storageRef: StorageService | null

  private initialized = false
  /** True whenever in-memory content is newer than anything written to disk. */
  private hasUnsavedEdits = false
  private saveState: BrandMirrorSnapshot['saveState'] = 'idle'
  private lastSavedAt: number | null = null
  private autosaveHandle: number | null = null
  private conflict: ConflictNotice | null = null
  private draftRecovery: DraftRecovery | null = null
  private unregisterUnload?: () => void
  /** Identity (sessionId@updatedAt) of the last remote draft we handled. */
  private lastRemoteIdentity: string | null = null
  /** Reader sessions we have already announced, so heartbeats don't re-toast. */
  private knownReaderIds = new Set<string>()
  private readerNoticeHandle: number | null = null

  constructor(
    repository: BrandRepository,
    exporter?: BrandGuidelinesExporter,
    deps: { coordinator?: WorkspaceCoordinator; storage?: StorageService; clock?: Clock } = {},
  ) {
    this.repository = repository
    this.exporter = exporter
    this.clock = deps.clock ?? createBrowserClock()
    this.storageRef = deps.storage ?? null
    this.coordinator = deps.coordinator ?? new WorkspaceCoordinator(this.storageRef ?? missingStorage(), this.clock)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Simulate the renderer process being killed: timers stop and nothing is
   * flushed, but the last checkpoint draft stays on disk. Test-only.
   */
  kill(): void {
    this.cancelAutosave()
    this.clearReaderNotice()
    this.coordinator.kill()
    this.listeners.clear()
  }

  private clearReaderNotice(): void {
    if (this.readerNoticeHandle !== null) this.clock.clearTimeout(this.readerNoticeHandle)
    this.readerNoticeHandle = null
  }

  /** Unregister timers/listeners without simulating a page close. */
  dispose(): void {
    this.unregisterUnload?.()
    this.unregisterUnload = undefined
    this.cancelAutosave()
    this.clearReaderNotice()
    this.listeners.clear()
  }

  getSnapshot(): BrandMirrorSnapshot {
    return this.snapshot
  }

  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    const committed = this.repository.load()
    if (committed) this.document = committed

    this.coordinator.setCallbacks({
      onRemoteDraft: (envelope) => this.handleRemoteDraft(envelope),
      onDemotion: (newOwner) => this.handleDemotion(newOwner),
      onPromotion: () => this.handlePromotion(),
      onReaderJoined: (reader) => this.handleReaderJoined(reader),
    })
    const { role } = this.coordinator.start()

    // Evaluated after the coordinator pruned stale sessions, so a checkpoint
    // whose tab crashed is distinguishable from a live owner's autosave.
    const storedDraft = this.repository.loadDraft()
    const recovery = this.evaluateDraft(storedDraft)
    if (recovery?.use && storedDraft) {
      this.document = storedDraft.document
    }
    this.draftRecovery = role === 'owner' ? (recovery?.banner ?? null) : null

    // Single unload path: re-anchor the draft as a healthy close first, then
    // drop the session so a waiting reader promotes onto the final content.
    this.unregisterUnload = this.clock.onUnload(() => {
      if (this.coordinator.canWrite()) this.anchorClosedDraft()
      this.coordinator.prepareUnload()
    })

    const message = this.draftRecovery
      ? '已恢复异常关闭前未保存的草稿'
      : committed
        ? '已恢复最近一次工作状态'
        : '从 Studio warm 开始探索'

    this.lastSavedAt = storedDraft?.updatedAt ?? null
    this.refresh(message, role === 'owner' ? (this.draftRecovery ? 'editing' : 'ready') : 'readonly')
  }

  selectTheme(theme: BrandTheme): void {
    if (!this.canMutate()) return
    this.mutate({ tokens: themeTokens(theme), theme }, '已切换基础主题')
  }

  updateColor(field: 'primary' | 'secondary', value: string): void {
    if (!this.canMutate()) return
    const color = normalizeColor(value)
    this.mutate({ tokens: { ...this.document.tokens, [field]: color } }, '令牌已更新')
  }

  updateScale(field: 'radiusScale' | 'spacingScale' | 'typeScale', index: number, value: number): void {
    if (!this.canMutate()) return
    const values = [...this.document.tokens[field]]
    values[index] = Number.isFinite(value) ? value : values[index]
    this.mutate({ tokens: clampTokenValues({ ...this.document.tokens, [field]: values }) }, '令牌已更新')
  }

  reset(): void {
    if (!this.canMutate()) return
    this.mutate({ tokens: cloneTokens(INITIAL_TOKENS), theme: 'studio' }, '已恢复默认令牌')
  }

  saveVersion(): void {
    if (!this.canMutate()) {
      this.showBlockedMessage()
      return
    }
    this.flushAutosave()
    const validationError = validateTokens(this.document.tokens)
    if (validationError) {
      this.refresh(validationError, 'error')
      return
    }
    const nextVersion: SavedVersion = {
      id: `version-${this.clock.now()}`,
      label: this.document.versions.length === 0 ? 'Version A' : `Version ${String.fromCharCode(65 + this.document.versions.length)}`,
      tokens: cloneTokens(this.document.tokens),
      createdAt: new Date(this.clock.now()).toISOString(),
    }
    const versions = [...this.document.versions, nextVersion]
    try {
      this.repository.save({ ...this.document, versions })
      this.document = { ...this.document, versions }
      this.hasUnsavedEdits = false
      this.cancelAutosave()
      this.repository.clearDraft()
      this.lastSavedAt = this.clock.now()
      this.saveState = 'saved'
      this.draftRecovery = null
      this.refresh('版本已保存', 'ready')
    } catch {
      this.saveState = 'offline'
      this.refresh('版本保存失败，请稍后重试', 'error')
    }
  }

  toggleCompare(): void {
    this.snapshot = { ...this.snapshot, compareMode: !this.snapshot.compareMode, message: this.snapshot.compareMode ? '已退出对比模式' : '正在对比最近两个版本' }
    this.emit()
  }

  exportBrandGuidelines(): void {
    if (!this.exporter) return
    try {
      this.exporter.export(this.snapshot)
      this.refresh('品牌规范已导出', this.snapshot.status)
    } catch {
      this.refresh('导出失败，请稍后重试', 'error')
    }
  }

  // ----- Multi-tab resolution actions --------------------------------------

  /**
   * Reader action: ask to edit. We take ownership immediately (the previous
   * owner is demoted and keeps its edits), then load the current draft. If it
   * differs from what this tab shows, the user still chooses which wins
   * before any content is overwritten.
   */
  requestTakeOver(): void {
    if (this.coordinator.getRole() === 'owner') return
    const previous = this.repository.loadDraft()
    this.coordinator.takeOver()

    if (previous && !sameDocument(previous.document, this.document)) {
      // Newer content exists that this tab has not seen: surface it and write
      // nothing until the user picks a side.
      this.conflict = {
        reason: 'remote-diverged',
        remoteDocument: cloneDocument(previous.document),
        remoteUpdatedAt: previous.updatedAt,
        remoteSessionId: previous.sessionId,
      }
      this.refresh('你已请求接管，请选择以哪一份内容继续编辑', 'conflict')
      return
    }

    this.conflict = null
    // Anchor this tab's view as the new owner's baseline. The demoted tab
    // receives this draft and can still keep its own buffered edits.
    this.writeDraft(false)
    this.refresh('已接管工作区，可以开始编辑', 'ready')
  }

  /** Keep this tab's edits: take ownership and persist them as the workspace draft. */
  resolveKeepMine(): void {
    this.coordinator.takeOver()
    this.conflict = null
    this.draftRecovery = null
    this.writeDraft(false)
    this.refresh('已接管工作区，本页内容已保留', 'ready')
  }

  /** Discard this tab's view and adopt the other tab's draft. */
  resolveKeepTheirs(remoteDocument: BrandDocument): void {
    this.coordinator.takeOver()
    this.document = cloneDocument(remoteDocument)
    this.conflict = null
    this.draftRecovery = null
    this.hasUnsavedEdits = false
    this.writeDraft(false)
    this.refresh('已采用另一个页面的内容并接管工作区', 'ready')
  }

  /** Stay read-only and follow the other tab's content without taking over. */
  resolveKeepBrowsing(remoteDocument?: BrandDocument): void {
    const target = remoteDocument ?? this.conflict?.remoteDocument
    if (target) this.document = cloneDocument(target)
    this.coordinator.rejoinAsReader()
    this.conflict = null
    this.refresh('正在只读浏览另一个页面的工作区', 'readonly')
  }

  /** Confirm the recovered crash draft: clear the banner and anchor it on disk. */
  keepRecoveredDraft(): void {
    this.draftRecovery = null
    this.hasUnsavedEdits = false
    if (this.coordinator.canWrite()) this.writeDraft(false)
    this.refresh('已保留恢复的草稿，之后的更改会自动保存', this.coordinator.canWrite() ? 'ready' : 'readonly')
  }

  /** Discard a recovered crash draft and return to the last committed version. */
  discardRecoveredDraft(): void {
    const committed = this.repository.load()
    this.document = committed ? cloneDocument(committed) : { version: 1, tokens: cloneTokens(INITIAL_TOKENS), theme: 'studio', versions: [] }
    this.draftRecovery = null
    this.hasUnsavedEdits = false
    if (this.coordinator.canWrite()) {
      this.repository.clearDraft()
      this.refresh('已丢弃未保存草稿，回到最近保存的版本', 'ready')
    } else {
      this.refresh('已丢弃草稿，正在只读浏览', 'readonly')
    }
  }

  // ----- Internals ----------------------------------------------------------

  private handleRemoteDraft(envelope: DraftEnvelope): void {
    const identity = `${envelope.sessionId}@${envelope.updatedAt}`
    if (identity === this.lastRemoteIdentity) return
    this.lastRemoteIdentity = identity

    const same = sameDocument(this.document, envelope.document)

    // Demoted while a conflict dialog is open: live-refresh the "theirs" side.
    if (this.coordinator.getRole() === 'reader' && this.conflict && !same) {
      this.conflict = { ...this.conflict, remoteDocument: cloneDocument(envelope.document), remoteUpdatedAt: envelope.updatedAt, remoteSessionId: envelope.sessionId }
      this.emit()
      return
    }

    if (this.coordinator.getRole() === 'reader') {
      if (!same) {
        this.document = cloneDocument(envelope.document)
        this.lastSavedAt = envelope.updatedAt
        this.refresh('已同步另一个页面的最新编辑', 'readonly')
      }
      return
    }

    // We currently own the workspace, yet another tab wrote a draft: it must
    // have taken ownership over. Preserve both sides until the user decides.
    if (same) return
    this.presentConflict(envelope, this.hasUnsavedEdits ? 'demoted-dirty' : 'remote-diverged')
  }

  private handleDemotion(newOwner: SessionRecord): void {
    this.cancelAutosave()
    this.saveState = 'idle'
    if (!this.hasUnsavedEdits) {
      const remote = this.repository.loadDraft()
      if (remote && !sameDocument(remote.document, this.document)) {
        this.presentConflict(remote, 'remote-diverged')
      } else {
        this.refresh('工作区已被另一个页面接管，本页切换为只读', 'readonly')
      }
      return
    }
    // We hold buffered edits. The draft on disk is the new owner's baseline;
    // show it as "theirs" immediately and live-update if a newer draft lands.
    const baseline = this.repository.loadDraft()
    const envelope: DraftEnvelope = baseline
      ? baseline
      : {
          version: 1,
          document: cloneDocument(this.document),
          updatedAt: this.clock.now(),
          closed: true,
          sessionId: newOwner.id,
        }
    this.presentConflict(envelope, 'demoted-dirty')
  }

  private presentConflict(envelope: DraftEnvelope, reason: ConflictNotice['reason']): void {
    this.conflict = {
      reason,
      remoteDocument: cloneDocument(envelope.document),
      remoteUpdatedAt: envelope.updatedAt,
      remoteSessionId: envelope.sessionId,
    }
    this.cancelAutosave()
    this.saveState = 'idle'
    this.refresh(
      reason === 'demoted-dirty' ? '另一个页面接管了工作区，你的编辑尚未写入' : '检测到另一个页面的内容与本页不同',
      'conflict',
    )
  }

  private handlePromotion(): void {
    if (this.conflict) return
    const remote = this.repository.loadDraft()
    if (remote && !sameDocument(remote.document, this.document)) {
      this.document = cloneDocument(remote.document)
      this.lastSavedAt = remote.updatedAt
    }
    this.refresh('原编辑页面已关闭，本页已接管工作区', 'ready')
  }

  private handleReaderJoined(reader: SessionRecord): void {
    if (this.knownReaderIds.has(reader.id)) return
    this.knownReaderIds.add(reader.id)
    // Informational only; ownership does not change. Debounced so rapid
    // open/close cycles don't queue competing toasts.
    if (this.readerNoticeHandle !== null) this.clock.clearTimeout(this.readerNoticeHandle)
    this.readerNoticeHandle = this.clock.setTimeout(() => {
      this.readerNoticeHandle = null
      if (this.coordinator.getRole() === 'owner' && !this.conflict && this.snapshot.status !== 'error') {
        this.snapshot = { ...this.snapshot, message: '另一个页面正在只读查看这份工作区' }
        this.emit()
      }
    }, 400)
  }

  private evaluateDraft(draft: DraftEnvelope | null): { use: boolean; banner: DraftRecovery | null } | null {
    if (!draft) return null
    const age = this.clock.now() - draft.updatedAt
    if (age > DRAFT_MAX_AGE_MS || draft.updatedAt > this.clock.now() + 60_000) {
      this.repository.clearDraft()
      return null
    }
    const committed = this.repository.load()
    if (committed && sameDocument(committed, draft.document)) return null
    if (draft.closed) {
      // Healthy shutdown: resumed silently.
      return { use: true, banner: null }
    }
    // A periodic checkpoint. If its session is still live we are a second tab
    // looking at an active owner's work — not a crash. If the session is gone
    // (or never registered) the page was killed mid-editing.
    const authoredByLiveSession = this.isLiveSession(draft.sessionId)
    return { use: true, banner: authoredByLiveSession ? null : { updatedAt: draft.updatedAt } }
  }

  private isLiveSession(sessionId: string): boolean {
    if (!this.storageRef) return false
    const raw = this.storageRef.read(SESSIONS_STORAGE_KEY)
    if (!raw) return false
    try {
      const sessions = (JSON.parse(raw) as { sessions?: SessionRecord[] }).sessions ?? []
      return sessions.some((session) => session.id === sessionId && this.clock.now() - session.heartbeatAt < SESSION_STALE_MS)
    } catch {
      return false
    }
  }

  private mutate(partial: Partial<Pick<BrandDocument, 'tokens' | 'theme'>>, message: string): void {
    this.document = {
      ...this.document,
      tokens: partial.tokens ?? this.document.tokens,
      theme: partial.theme ?? this.document.theme,
    }
    this.hasUnsavedEdits = true
    this.saveState = 'saving'
    this.armAutosave()
    this.refresh(message, 'editing')
  }

  private armAutosave(): void {
    this.cancelAutosave()
    this.autosaveHandle = this.clock.setTimeout(() => {
      this.autosaveHandle = null
      this.writeDraft(false)
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  private cancelAutosave(): void {
    if (this.autosaveHandle !== null) {
      this.clock.clearTimeout(this.autosaveHandle)
      this.autosaveHandle = null
    }
  }

  /**
   * Healthy page close: flush any buffered edits and tag the draft as closed
   * so the next launch resumes silently instead of showing a crash banner.
   */
  private anchorClosedDraft(): void {
    this.cancelAutosave()
    if (this.hasUnsavedEdits) {
      this.writeDraft(true)
    } else {
      const stored = this.repository.loadDraft()
      if (stored && !stored.closed) this.writeDraft(true)
    }
  }

  private flushAutosave(): void {
    if (this.autosaveHandle !== null) {
      this.cancelAutosave()
      this.writeDraft(false)
    }
  }

  private writeDraft(closed: boolean): void {
    if (!this.coordinator.canWrite()) return
    try {
      const envelope: DraftEnvelope = {
        version: 1,
        document: cloneDocument(this.document),
        updatedAt: this.clock.now(),
        closed,
        sessionId: this.coordinator.sessionId,
      }
      this.repository.saveDraft(envelope)
      this.hasUnsavedEdits = false
      this.lastSavedAt = envelope.updatedAt
      this.saveState = 'saved'
    } catch {
      this.saveState = 'offline'
    }
    if (this.snapshot.status !== 'conflict') {
      // Rebuild so the 'saved'/'offline' save state reaches listeners while
      // preserving the current screen status (editing/ready/readonly).
      this.snapshot = this.makeSnapshot(this.snapshot.message, this.snapshot.status)
      this.emit()
    }
  }

  private canMutate(): boolean {
    if (this.conflict) {
      this.showBlockedMessage()
      return false
    }
    if (!this.coordinator.canWrite()) {
      this.showBlockedMessage()
      return false
    }
    return true
  }

  private showBlockedMessage(): void {
    const message = this.conflict
      ? '请先在冲突提示中选择要保留的内容'
      : '另一个页面正在编辑这份工作区，本页为只读'
    this.refresh(message, this.conflict ? 'conflict' : 'readonly')
  }

  private refresh(message: string, status: BrandMirrorSnapshot['status']): void {
    this.snapshot = this.makeSnapshot(message, status)
    this.emit()
  }

  private makeSnapshot(message: string, status: BrandMirrorSnapshot['status']): BrandMirrorSnapshot {
    const ratio = contrastRatio(this.document.tokens.primary, this.document.tokens.secondary)
    const latestVersion = this.document.versions[this.document.versions.length - 1]
    const ownerRecord = this.coordinator?.getOwner() ?? null
    return {
      status,
      tokens: cloneTokens(this.document.tokens),
      theme: this.document.theme,
      versions: this.document.versions,
      compareMode: false,
      activeVersionId: latestVersion?.id ?? null,
      contrastRatio: ratio,
      contrastWarning: ratio < 3,
      message,
      saveState: this.saveState,
      lastSavedAt: this.lastSavedAt,
      canEdit: this.coordinator ? this.coordinator.canWrite() && !this.conflict : true,
      conflict: this.conflict,
      draftRecovery: this.draftRecovery,
      ownerLabel: ownerRecord ? shortSessionLabel(ownerRecord.id) : null,
    }
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }
}

function cloneDocument(document: BrandDocument): BrandDocument {
  return {
    ...document,
    tokens: cloneTokens(document.tokens),
    versions: document.versions.map((version) => ({ ...version, tokens: cloneTokens(version.tokens) })),
  }
}

function sameDocument(a: BrandDocument, b: BrandDocument): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function shortSessionLabel(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(-4).toUpperCase()
}

function missingStorage(): StorageService {
  throw new Error('BrandMirrorViewModel 需要通过 deps.storage 提供 StorageService')
}
