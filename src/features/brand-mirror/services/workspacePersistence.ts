import type { BrandDocument, BrandTheme, BrandTokens, SavedVersion, PendingRecovery, WorkspaceConflict } from '../models/brandMirrorModels'
import { INITIAL_TOKENS } from '../models/brandMirrorModels'
import type { BrandRepository, StoredDraft } from '../repositories/brandRepository'
import type { WorkspaceChannel, WorkspaceSignal } from '../services/workspaceChannel'

export interface PersistenceTiming {
  /** 编辑后自动落盘防抖 */
  autosaveDelay: number
  /** 持续编辑时两次落盘的最大间隔 */
  autosaveMaxWait: number
  /** 草稿写入防抖（尽量贴近最后一次编辑） */
  draftDelay: number
  /** owner 心跳间隔 */
  heartbeatInterval: number
  /** 超过该时间没有心跳则认为另一个页面已不在 */
  peerTtl: number
  /** 启动选举窗口，让同时打开的页面互相发现 */
  electionDelay: number
}

export interface PersistenceClock {
  now(): number
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>
  clearInterval(handle: ReturnType<typeof setInterval>): void
}

export interface PersistenceLifecycle {
  onPageHide(callback: () => void): () => void
  onPageHidden(callback: () => void): () => void
}

export interface PersistenceCallbacks {
  /** 存储中的文档被另一个页面更新（落盘成功 / 心跳携带了新修订号） */
  onRemoteDocument(document: BrandDocument, sessionId: string): void
  onChange(): void
}

export class PersistenceEvents implements PersistenceCallbacks {
  onRemoteDocument: (document: BrandDocument, sessionId: string) => void = () => {}
  onChange: () => void = () => {}
}

export type PersistenceSavePhase = 'idle' | 'pending' | 'saving' | 'saved' | 'error'
export type PersistenceRole = 'starting' | 'owner' | 'viewer'

export interface PersistenceState {
  role: PersistenceRole
  savePhase: PersistenceSavePhase
  savedAt: number | null
  peerCount: number
  ownerSessionId: string | null
  recovery: PendingRecovery | null
  conflict: WorkspaceConflict | null
  /** 发现冲突后等待对方决定，本页也停止自动保存 */
  frozen: boolean
  baseRevision: number
  updatedAt: number
  sessionId: string
  /** 角色变化等一次性提示，VM 读取后清掉 */
  notice: string | null
}

const DEFAULT_TIMING: PersistenceTiming = {
  autosaveDelay: 900,
  autosaveMaxWait: 3000,
  draftDelay: 300,
  heartbeatInterval: 1500,
  peerTtl: 5000,
  electionDelay: 200,
}

export interface PersistenceOptions {
  repository: BrandRepository
  channel: WorkspaceChannel
  /** 预先创建的事件桥，便于 VM 在构造后绑定回调、打破循环依赖 */
  events?: PersistenceEvents
  sessionId?: string
  timing?: Partial<PersistenceTiming>
  clock?: PersistenceClock
  lifecycle?: PersistenceLifecycle
}

interface PeerInfo {
  revision: number
  updatedAt: number
  lastSeen: number
  role: PersistenceRole
}

export class WorkspacePersistence {
  readonly events: PersistenceEvents
  private readonly repository: BrandRepository
  private readonly channel: WorkspaceChannel
  private readonly sessionId: string
  private readonly timing: PersistenceTiming
  private readonly clock: PersistenceClock
  private readonly lifecycle: PersistenceLifecycle

  private role: PersistenceRole = 'starting'
  private savePhase: PersistenceSavePhase = 'idle'
  private savedAt: number | null = null
  private baseRevision = -1
  private updatedAt = 0
  private recovery: PendingRecovery | null = null
  private conflict: WorkspaceConflict | null = null
  private frozen = false
  private ownerSessionId: string | null = null
  private notice: string | null = null
  /** 已经回应过 hello 的页面，避免双方无限互发 */
  private readonly greetedPeers = new Set<string>()

  private document: BrandDocument = { version: 1, tokens: INITIAL_TOKENS, theme: 'studio', versions: [] }
  private readonly peers = new Map<string, PeerInfo>()
  private pendingRemoteDocuments: Array<{ document: BrandDocument; sessionId: string }> = []

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null
  private autosaveWaitStart: number | null = null
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reapTimer: ReturnType<typeof setInterval> | null = null
  private electionTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private disposed = false
  private detachChannel: (() => void) | null = null
  private detachHide: (() => void) | null = null
  private detachHidden: (() => void) | null = null

  constructor(options: PersistenceOptions) {
    this.events = options.events ?? new PersistenceEvents()
    this.repository = options.repository
    this.channel = options.channel
    this.sessionId = options.sessionId ?? `session-${Math.random().toString(36).slice(2, 10)}`
    this.timing = { ...DEFAULT_TIMING, ...options.timing }
    this.clock = options.clock ?? browserClock()
    this.lifecycle = options.lifecycle ?? browserLifecycle()
  }

  /** 先读存储，VM 据此建立初始快照；随后再注册信令开始选举 */
  loadInitial(): BrandDocument {
    const stored = this.repository.load()
    if (stored) {
      this.document = stored.document
      this.baseRevision = stored.revision
      this.updatedAt = stored.updatedAt
      this.savedAt = stored.updatedAt || null
    }
    return this.getDocument()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.detachChannel = this.channel.onMessage((signal) => this.handleSignal(signal))
    this.detachHide = this.lifecycle.onPageHide(() => this.handlePageHide())
    this.detachHidden = this.lifecycle.onPageHidden(() => this.flushNow())

    // 广播存在，给同时打开的页面一个互相发现的窗口后再确定角色
    this.post({ type: 'hello', from: this.sessionId, revision: this.baseRevision, updatedAt: this.updatedAt })
    this.electionTimer = this.clock.setTimeout(() => this.finishElection(), this.timing.electionDelay)
    this.emit()
  }

  getState(): PersistenceState {
    return {
      role: this.role,
      savePhase: this.savePhase,
      savedAt: this.savedAt,
      peerCount: this.peers.size + 1,
      ownerSessionId: this.ownerSessionId,
      recovery: this.recovery,
      conflict: this.conflict,
      frozen: this.frozen,
      baseRevision: this.baseRevision,
      updatedAt: this.updatedAt,
      sessionId: this.sessionId,
      notice: this.notice,
    }
  }

  consumeNotice(): string | null {
    const notice = this.notice
    this.notice = null
    return notice
  }

  getDocument(): BrandDocument {
    return cloneDocument(this.document)
  }

  canEdit(): boolean {
    return this.role === 'owner' && !this.conflict && !this.frozen
  }

  /** 用户在界面上产生了一次编辑 */
  setEdited(document: BrandDocument): void {
    if (!this.canEdit()) return
    this.document = cloneDocument(document)
    this.updatedAt = this.clock.now()
    this.savePhase = 'pending'
    this.scheduleDraft()
    this.scheduleAutosave()
    this.emit()
  }

  /** 立即落盘（页面隐藏 / 手动保存版本时调用） */
  flushNow(): boolean {
    this.cancelAutosave()
    return this.flush()
  }

  requestTakeover(): void {
    if (this.role !== 'viewer') return
    const owner = this.liveOwner()
    if (owner) {
      this.post({ type: 'takeover-request', from: this.sessionId, to: owner, revision: this.baseRevision, updatedAt: this.updatedAt })
    } else {
      this.becomeOwner('未检测到其他在线页面，已接管编辑')
    }
    this.emit()
  }

  resolveConflict(choice: 'local' | 'remote'): void {
    const conflict = this.conflict
    if (!conflict) return
    const winnerSessionId = choice === 'local' ? this.sessionId : conflict.remoteSessionId
    if (choice === 'local') {
      // 用户明确选择保留本页：以存储最新修订号为基底强制写入，覆盖另一份未保存内容
      let forced: ReturnType<BrandRepository['forceCommit']>
      try {
        forced = this.repository.forceCommit(this.getDocument(), this.sessionId, this.clock.now())
      } catch {
        this.savePhase = 'error'
        this.emit()
        return
      }
      this.baseRevision = forced.revision
      this.updatedAt = forced.updatedAt
      this.savedAt = forced.updatedAt
      this.savePhase = 'saved'
      this.repository.clearDraft()
    } else {
      // 以存储中胜出的那份为准，顺带拿到准确的修订号与时间戳
      const stored = this.repository.load()
      if (stored && documentsEqual(stored.document, { ...this.getDocument(), tokens: conflict.remoteTokens, theme: conflict.remoteTheme })) {
        this.document = cloneDocument(stored.document)
        this.baseRevision = stored.revision
        this.updatedAt = stored.updatedAt
        this.savedAt = stored.updatedAt
      } else {
        this.document = { ...this.document, tokens: conflict.remoteTokens, theme: conflict.remoteTheme }
        this.updatedAt = conflict.remoteUpdatedAt
        this.savedAt = conflict.remoteUpdatedAt
        this.baseRevision = Math.max(this.baseRevision, conflict.remoteRevision)
      }
      this.savePhase = 'saved'
      this.repository.clearDraft()
    }

    const winningDocument = this.getDocument()
    this.conflict = null
    this.frozen = false
    this.post({ type: 'conflict-resolved', from: this.sessionId, winnerSessionId, revision: this.baseRevision, updatedAt: this.updatedAt, document: winningDocument })
    // 本页 document 已经是胜出内容，走一次普通刷新即可，避免回调重复套用
    this.becomeOwnerIfWon(winnerSessionId)
    this.emit()
  }

  recoverDraft(choice: 'recover' | 'discard'): void {
    if (!this.recovery) return
    if (choice === 'recover') {
      this.document = { version: 1, tokens: this.recovery.tokens, theme: this.recovery.theme, versions: this.recovery.versions }
      this.updatedAt = this.recovery.draftAt
      // 恢复出来的是未提交内容，立即进入一轮自动落盘
      this.savePhase = 'pending'
      this.scheduleDraft()
      this.scheduleAutosave()
    }
    this.recovery = null
    this.repository.clearDraft()
    this.emit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.role === 'owner') {
      this.post({ type: 'bye', from: this.sessionId, revision: this.baseRevision, updatedAt: this.updatedAt })
    }
    this.detachChannel?.()
    this.detachHide?.()
    this.detachHidden?.()
    if (this.autosaveTimer) this.clock.clearTimeout(this.autosaveTimer)
    if (this.draftTimer) this.clock.clearTimeout(this.draftTimer)
    if (this.electionTimer) this.clock.clearTimeout(this.electionTimer)
    if (this.heartbeatTimer) this.clock.clearInterval(this.heartbeatTimer)
    if (this.reapTimer) this.clock.clearInterval(this.reapTimer)
  }

  // ---- 启动选举 ----

  private finishElection(): void {
    if (this.disposed || this.role !== 'starting') return
    const liveOwners = [...this.peers.entries()]
      .filter(([, peer]) => peer.role === 'owner' && this.clock.now() - peer.lastSeen <= this.timing.peerTtl)
      .map(([id]) => id)
    if (liveOwners.length === 0) {
      this.assessRecovery()
      this.role = 'owner'
      this.ownerSessionId = this.sessionId
      this.startHeartbeat()
      this.postHeartbeat()
      this.emit()
      return
    }
    liveOwners.sort()
    const elected = liveOwners[0]
    this.ownerSessionId = elected
    this.role = 'viewer'
    const owner = this.peers.get(elected)
    if (owner) {
      this.syncFromPeer(elected, owner)
    }
    this.emit()
  }

  private becomeOwnerIfWon(winnerSessionId: string): void {
    if (winnerSessionId === this.sessionId && this.role !== 'owner') {
      this.role = 'owner'
      this.ownerSessionId = this.sessionId
      this.startHeartbeat()
    }
  }

  private becomeOwner(notice: string): void {
    this.role = 'owner'
    this.ownerSessionId = this.sessionId
    this.notice = notice
    this.startHeartbeat()
    this.postHeartbeat()
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = this.clock.setInterval(() => this.postHeartbeat(), this.timing.heartbeatInterval)
    if (!this.reapTimer) {
      this.reapTimer = this.clock.setInterval(() => this.reapPeers(), this.timing.heartbeatInterval)
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      this.clock.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private postHeartbeat(): void {
    this.post({ type: 'heartbeat', from: this.sessionId, revision: this.baseRevision, updatedAt: this.updatedAt, document: this.getDocument() })
  }

  // ---- 信号处理 ----

  private handleSignal(signal: WorkspaceSignal): void {
    if (this.disposed || signal.from === this.sessionId) return
    const now = this.clock.now()
    const previous = this.peers.get(signal.from)
    const role: PersistenceRole = signal.type === 'heartbeat' ? 'owner' : previous?.role ?? 'starting'
    this.peers.set(signal.from, { revision: signal.revision, updatedAt: signal.updatedAt, lastSeen: now, role })

    switch (signal.type) {
      case 'hello': {
        if (this.role === 'owner' && !this.greetedPeers.has(signal.from)) {
          this.greetedPeers.add(signal.from)
          this.postHeartbeat()
        } else if (this.role === 'starting' && !this.greetedPeers.has(signal.from)) {
          // 也报个到（只回第一次），对方同样能在选举窗口内看到本页
          this.greetedPeers.add(signal.from)
          this.post({ type: 'hello', from: this.sessionId, revision: this.baseRevision, updatedAt: this.updatedAt })
        }
        break
      }
      case 'heartbeat': {
        if (this.role === 'starting') {
          // 选举前就收到心跳：记录 owner，选举窗口结束时自然成为 viewer
          this.ownerSessionId = signal.from
        } else if (signal.from === this.ownerSessionId || (!this.ownerSessionId && this.role === 'viewer')) {
          this.ownerSessionId = signal.from
          const peer = this.peers.get(signal.from)
          if (peer) this.syncFromPeer(signal.from, peer, signal.document)
        } else if (this.role === 'owner' && signal.from < this.sessionId) {
          // 同时启动造成的脑裂：会话 id 较小者继续持有，较大者降级
          this.demoteToViewer(signal)
        }
        break
      }
      case 'bye': {
        this.peers.delete(signal.from)
        if (signal.from === this.ownerSessionId && this.role === 'viewer') {
          this.ownerSessionId = null
          this.notice = '另一个页面已关闭，可接管编辑'
        }
        break
      }
      case 'takeover-request': {
        if (signal.to !== this.sessionId) break
        if (this.role !== 'owner') break
        // 交接前先把未落盘内容写进去，避免抹掉本页工作
        const flushed = this.flushNow()
        if (!flushed) {
          this.post({ type: 'takeover-deny', from: this.sessionId, to: signal.from, revision: this.baseRevision, updatedAt: this.updatedAt, reason: '本页存在待解决的冲突，无法交接' })
          break
        }
        this.role = 'viewer'
        this.ownerSessionId = signal.from
        const requester = this.peers.get(signal.from)
        if (requester) requester.role = 'owner'
        this.stopHeartbeat()
        this.cancelAutosave()
        this.notice = `另一个页面（${shortSession(signal.from)}）正在编辑同一份工作区，本页已切换为只读`
        this.post({ type: 'takeover-grant', from: this.sessionId, to: signal.from, revision: this.baseRevision, updatedAt: this.updatedAt, document: this.getDocument() })
        this.events.onChange()
        break
      }
      case 'takeover-grant': {
        if (signal.to !== this.sessionId || this.role !== 'viewer') break
        this.role = 'owner'
        this.ownerSessionId = this.sessionId
        this.notice = '另一个页面已把编辑权交给本页'
        if (signal.document) {
          this.adoptRemote(signal.document, signal.from, signal.revision, signal.updatedAt)
        } else {
          this.baseRevision = signal.revision
        }
        this.startHeartbeat()
        this.postHeartbeat()
        this.emit()
        break
      }
      case 'takeover-deny': {
        if (signal.to !== this.sessionId) break
        // 对方暂时无法交接，保持只读，由用户稍后重试
        this.notice = signal.reason ?? '另一个页面暂时无法交出编辑权，请稍后重试'
        this.emit()
        break
      }
      case 'conflict-detected': {
        if (this.role !== 'owner' || this.conflict) break
        // 另一个页面在提交时撞上了本页修订号：双方一起冻结，等待决定
        this.frozen = true
        this.cancelAutosave()
        const peer = this.peers.get(signal.from)
        if (peer) peer.role = 'owner'
        if (signal.document && !documentsEqual(signal.document, this.document)) {
          this.conflict = {
            localTokens: cloneTokens(this.document.tokens),
            localTheme: this.document.theme,
            localUpdatedAt: this.updatedAt,
            remoteTokens: signal.document.tokens,
            remoteTheme: signal.document.theme,
            remoteUpdatedAt: signal.updatedAt,
            remoteRevision: signal.revision,
            remoteSessionId: signal.from,
            fromStartup: false,
          }
        }
        this.emit()
        break
      }
      case 'conflict-resolved': {
        if (!signal.document || !signal.winnerSessionId) break
        const wasInConflict = !!this.conflict
        this.conflict = null
        this.frozen = false
        this.adoptRemote(signal.document, signal.from, signal.revision, signal.updatedAt)
        if (signal.winnerSessionId === this.sessionId) {
          this.role = 'owner'
          this.ownerSessionId = this.sessionId
          this.startHeartbeat()
        } else {
          this.role = 'viewer'
          this.ownerSessionId = signal.winnerSessionId
          this.stopHeartbeat()
          const peer = this.peers.get(signal.winnerSessionId)
          if (peer) peer.role = 'owner'
        }
        if (wasInConflict) {
          this.notice = signal.winnerSessionId === this.sessionId
            ? '已按你的选择保留本页内容'
            : `已按冲突处理结果保留另一个页面（${shortSession(signal.winnerSessionId)}）的内容，本页为只读`
        }
        break
      }
    }
    this.emit()
  }

  private demoteToViewer(signal: WorkspaceSignal): void {
    const hadLocalWork = this.savePhase === 'pending'
    this.role = 'viewer'
    this.ownerSessionId = signal.from
    this.stopHeartbeat()
    this.cancelAutosave()
    if (signal.document) {
      if (hadLocalWork && !documentsEqual(signal.document, this.document)) {
        // 脑裂瞬间本页也在编辑：进入冲突，不静默丢掉本页内容
        this.frozen = true
        this.conflict = {
          localTokens: cloneTokens(this.document.tokens),
          localTheme: this.document.theme,
          localUpdatedAt: this.updatedAt,
          remoteTokens: signal.document.tokens,
          remoteTheme: signal.document.theme,
          remoteUpdatedAt: signal.updatedAt,
          remoteRevision: signal.revision,
          remoteSessionId: signal.from,
          fromStartup: false,
        }
      } else {
        this.adoptRemote(signal.document, signal.from, signal.revision, signal.updatedAt)
      }
    }
    this.emit()
  }

  private syncFromPeer(sessionId: string, peer: PeerInfo, document?: BrandDocument): void {
    const candidate = document
      ? { document, revision: peer.revision, updatedAt: peer.updatedAt, sessionId }
      : this.loadCurrentFromStorage()
    if (!candidate) return
    if (candidate.revision > this.baseRevision || (candidate.revision === this.baseRevision && candidate.updatedAt > this.updatedAt)) {
      this.adoptRemote(candidate.document, sessionId, candidate.revision, candidate.updatedAt)
    }
  }

  private loadCurrentFromStorage(): { document: BrandDocument; revision: number; updatedAt: number; sessionId: string } | null {
    const stored = this.repository.load()
    if (!stored) return null
    return { document: stored.document, revision: stored.revision, updatedAt: stored.updatedAt, sessionId: stored.sessionId }
  }

  private adoptRemote(document: BrandDocument, sessionId: string, revision: number, updatedAt: number): void {
    // 等待用户裁决冲突时，任何自动同步都不能抹掉本地候选内容
    if (this.conflict || this.frozen) return
    this.document = cloneDocument(document)
    this.baseRevision = revision
    this.updatedAt = updatedAt
    this.savedAt = updatedAt
    if (this.savePhase !== 'error') this.savePhase = 'saved'
    this.pendingRemoteDocuments.push({ document: cloneDocument(document), sessionId })
  }

  private reapPeers(): void {
    if (this.disposed) return
    const now = this.clock.now()
    let changed = false
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen <= this.timing.peerTtl) continue
      this.peers.delete(id)
      if (id === this.ownerSessionId && this.role === 'viewer') {
        this.ownerSessionId = null
      }
      changed = true
    }
    if (changed) this.emit()
  }

  // ---- 自动落盘与草稿 ----

  private scheduleAutosave(): void {
    if (this.autosaveTimer) this.clock.clearTimeout(this.autosaveTimer)
    const now = this.clock.now()
    if (this.autosaveWaitStart === null) this.autosaveWaitStart = now
    const elapsed = now - this.autosaveWaitStart
    const wait = Math.max(0, Math.min(this.timing.autosaveDelay, this.timing.autosaveMaxWait - elapsed))
    this.autosaveTimer = this.clock.setTimeout(() => {
      this.autosaveTimer = null
      this.flush()
    }, wait)
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer) {
      this.clock.clearTimeout(this.autosaveTimer)
      this.autosaveTimer = null
    }
    this.autosaveWaitStart = null
  }

  private scheduleDraft(): void {
    if (this.draftTimer) this.clock.clearTimeout(this.draftTimer)
    this.draftTimer = this.clock.setTimeout(() => {
      this.draftTimer = null
      this.writeDraft()
    }, this.timing.draftDelay)
  }

  private writeDraft(): void {
    if (this.role !== 'owner' || this.conflict || this.frozen) return
    const draft: StoredDraft = {
      tokens: cloneTokens(this.document.tokens),
      theme: this.document.theme,
      versions: this.document.versions.map(cloneVersion),
      draftAt: this.clock.now(),
      baseRevision: this.baseRevision,
      sessionId: this.sessionId,
    }
    try {
      this.repository.saveDraft(draft)
    } catch {
      // 草稿写不进不阻塞编辑，稍后的自动落盘仍会尝试提交正式文档
    }
  }

  private flush(): boolean {
    if (this.role !== 'owner' || this.conflict || this.frozen) {
      this.autosaveWaitStart = null
      return false
    }
    this.autosaveWaitStart = null
    this.savePhase = 'saving'
    this.emit()
    let result: ReturnType<BrandRepository['commit']>
    try {
      result = this.repository.commit(this.getDocument(), this.baseRevision, this.sessionId, this.clock.now())
    } catch {
      this.savePhase = 'error'
      this.emit()
      return false
    }
    if (result.ok) {
      this.baseRevision = result.current.revision
      this.updatedAt = result.current.updatedAt
      this.savedAt = result.current.updatedAt
      this.savePhase = 'saved'
      this.repository.clearDraft()
      this.postHeartbeat()
      this.emit()
      return true
    }
    // CAS 失败：存储已被另一个页面推进。内容相同则静默对齐修订号，否则进入冲突并冻结
    if (documentsEqual(result.current.document, this.document)) {
      this.adoptRemote(result.current.document, result.current.sessionId, result.current.revision, result.current.updatedAt)
      this.emit()
      this.drainRemoteDocuments()
      return true
    }    this.savePhase = 'error'
    this.conflict = {
      localTokens: cloneTokens(this.document.tokens),
      localTheme: this.document.theme,
      localUpdatedAt: this.updatedAt,
      remoteTokens: result.current.document.tokens,
      remoteTheme: result.current.document.theme,
      remoteUpdatedAt: result.current.updatedAt,
      remoteRevision: result.current.revision,
      remoteSessionId: result.current.sessionId,
      fromStartup: false,
    }
    this.frozen = true
    this.cancelAutosave()
    this.post({ type: 'conflict-detected', from: this.sessionId, revision: result.current.revision, updatedAt: this.updatedAt, document: this.getDocument() })
    this.emit()
    return false
  }

  private handlePageHide(): void {
    if (this.role === 'owner') {
      // 同步落盘：异常关闭路径上能找回的最后一道保险
      if (this.draftTimer) {
        this.draftTimer = null
        this.writeDraft()
      }
      this.flushNow()
      this.post({ type: 'bye', from: this.sessionId, revision: this.baseRevision, updatedAt: this.updatedAt })
    }
  }

  // ---- 崩溃恢复 ----

  private assessRecovery(): void {
    const draft = this.repository.loadDraft()
    if (!draft) return
    const draftSessionLive = this.peers.has(draft.sessionId) && this.clock.now() - (this.peers.get(draft.sessionId)?.lastSeen ?? 0) <= this.timing.peerTtl
    if (draft.sessionId === this.sessionId || draftSessionLive) return
    const stored = this.repository.load()
    const draftDocument: BrandDocument = { version: 1, tokens: draft.tokens, theme: draft.theme, versions: draft.versions }
    // 草稿内容与已提交内容一致（正常关闭时已落盘），无需打扰用户
    if (stored && documentsEqual(draftDocument, stored.document)) {
      this.repository.clearDraft()
      return
    }
    this.recovery = {
      draftAt: draft.draftAt,
      committedAt: stored?.updatedAt ?? null,
      tokens: cloneTokens(draft.tokens),
      theme: draft.theme,
      versions: draft.versions.map(cloneVersion),
    }
  }

  // ---- 其它 ----

  private liveOwner(): string | null {
    if (!this.ownerSessionId) return null
    const peer = this.peers.get(this.ownerSessionId)
    if (!peer) return null
    return this.clock.now() - peer.lastSeen <= this.timing.peerTtl ? this.ownerSessionId : null
  }

  private post(signal: WorkspaceSignal): void {
    try {
      this.channel.post(signal)
    } catch {
      // 通道不可用时退化为纯存储协调，冲突仍可由 CAS 兜住
    }
  }

  private drainRemoteDocuments(): void {
    const pending = this.pendingRemoteDocuments
    this.pendingRemoteDocuments = []
    pending.forEach(({ document, sessionId }) => this.events.onRemoteDocument(document, sessionId))
  }

  private emit(): void {
    this.drainRemoteDocuments()
    this.events.onChange()
  }
}

export function documentsEqual(first: BrandDocument, second: BrandDocument): boolean {
  return serializeDocument(first) === serializeDocument(second)
}

function serializeDocument(document: BrandDocument): string {
  return JSON.stringify({
    primary: document.tokens.primary,
    secondary: document.tokens.secondary,
    radiusScale: document.tokens.radiusScale,
    spacingScale: document.tokens.spacingScale,
    typeScale: document.tokens.typeScale,
    theme: document.theme,
    versions: document.versions.map((version) => [version.id, version.label, version.createdAt, version.tokens.primary, version.tokens.secondary, version.tokens.radiusScale.join(','), version.tokens.spacingScale.join(','), version.tokens.typeScale.join(',')]),
  })
}

function shortSession(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(0, 4)
}

function cloneTokens(tokens: BrandTokens): BrandTokens {
  return { ...tokens, radiusScale: [...tokens.radiusScale], spacingScale: [...tokens.spacingScale], typeScale: [...tokens.typeScale] }
}

function cloneVersion(version: SavedVersion): SavedVersion {
  return { ...version, tokens: cloneTokens(version.tokens) }
}

function cloneDocument(document: BrandDocument): BrandDocument {
  return { version: 1, tokens: cloneTokens(document.tokens), theme: document.theme as BrandTheme, versions: document.versions.map(cloneVersion) }
}

export function browserClock(): PersistenceClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (callback, delay) => setInterval(callback, delay),
    clearInterval: (handle) => clearInterval(handle),
  }
}

export function browserLifecycle(): PersistenceLifecycle {
  return {
    onPageHide(callback) {
      const handler = (): void => callback()
      window.addEventListener('pagehide', handler)
      return () => window.removeEventListener('pagehide', handler)
    },
    onPageHidden(callback) {
      const handler = (): void => {
        if (document.visibilityState === 'hidden') callback()
      }
      document.addEventListener('visibilitychange', handler)
      return () => document.removeEventListener('visibilitychange', handler)
    },
  }
}
