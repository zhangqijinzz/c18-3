import { clampTokenValues, cloneTokens, contrastRatio, normalizeColor, themeTokens, validateTokens } from '../domain/brandRules'
import type { BrandGuidelinesExporter } from '../services/exportService'
import { type WorkspacePersistence } from '../services/workspacePersistence'
import { INITIAL_TOKENS, type BrandDocument, type BrandMirrorSnapshot, type BrandTheme, type SavedVersion } from '../models/brandMirrorModels'

type Listener = () => void

export class BrandMirrorViewModel {
  private snapshot: BrandMirrorSnapshot
  private readonly listeners = new Set<Listener>()
  private readonly persistence: WorkspacePersistence
  private readonly exporter?: BrandGuidelinesExporter
  private lastMessage = ''

  constructor(persistence: WorkspacePersistence, exporter?: BrandGuidelinesExporter) {
    this.persistence = persistence
    this.exporter = exporter
    persistence.events.onChange = () => this.handlePersistenceChange()
    persistence.events.onRemoteDocument = (document, sessionId) => this.handleRemoteDocument(document, sessionId)
    const initial = persistence.loadInitial()
    this.snapshot = this.buildSnapshot(initial, '正在连接本地工作区…', 'loading')
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): BrandMirrorSnapshot {
    return this.snapshot
  }

  initialize(): void {
    this.persistence.start()
    this.syncFromPersistence()
  }

  dispose(): void {
    this.persistence.dispose()
    this.listeners.clear()
  }

  selectTheme(theme: BrandTheme): void {
    if (!this.guardEditable()) return
    this.update({ tokens: themeTokens(theme), theme }, '已切换基础主题')
  }

  updateColor(field: 'primary' | 'secondary', value: string): void {
    if (!this.guardEditable()) return
    const color = normalizeColor(value)
    this.update({ tokens: { ...this.persistence.getDocument().tokens, [field]: color } }, '令牌已更新')
  }

  updateScale(field: 'radiusScale' | 'spacingScale' | 'typeScale', index: number, value: number): void {
    if (!this.guardEditable()) return
    const current = this.persistence.getDocument()
    const values = [...current.tokens[field]]
    values[index] = Number.isFinite(value) ? value : values[index]
    this.update({ tokens: clampTokenValues({ ...current.tokens, [field]: values }) }, '令牌已更新')
  }

  reset(): void {
    if (!this.guardEditable()) return
    this.update({ tokens: cloneTokens(INITIAL_TOKENS), theme: 'studio' }, '已恢复默认令牌')
  }

  saveVersion(): void {
    if (this.persistence.getState().role === 'viewer' || this.persistence.getState().conflict) {
      this.lastMessage = '当前页面为只读，接管编辑后才能保存版本'
      this.syncFromPersistence()
      return
    }
    const document = this.persistence.getDocument()
    const validationError = validateTokens(document.tokens)
    if (validationError) {
      this.lastMessage = validationError
      this.syncFromPersistence('error')
      return
    }
    const nextVersion: SavedVersion = {
      id: `version-${Date.now()}`,
      label: document.versions.length === 0 ? 'Version A' : `Version ${String.fromCharCode(65 + document.versions.length)}`,
      tokens: cloneTokens(document.tokens),
      createdAt: new Date().toISOString(),
    }
    const nextDocument: BrandDocument = { ...document, versions: [...document.versions, nextVersion] }
    // 版本是文档的一部分：先登记为编辑再立即落盘
    this.persistence.setEdited(nextDocument)
    if (!this.persistence.flushNow()) {
      this.lastMessage = '版本保存失败：另一个页面正在写入，请先处理冲突'
      this.syncFromPersistence('error')
      return
    }
    this.lastMessage = '版本已保存'
    this.syncFromPersistence('ready')
  }

  toggleCompare(): void {
    this.snapshot = { ...this.snapshot, compareMode: !this.snapshot.compareMode }
    this.lastMessage = this.snapshot.compareMode ? '正在对比最近两个版本' : '已退出对比模式'
    this.snapshot = { ...this.snapshot, message: this.lastMessage }
    this.emit()
  }

  exportBrandGuidelines(): void {
    if (!this.exporter) return
    try {
      this.exporter.export(this.snapshot)
      this.lastMessage = '品牌规范已导出'
    } catch {
      this.lastMessage = '导出失败，请稍后重试'
    }
    this.syncFromPersistence(this.lastMessage.includes('失败') ? 'error' : undefined)
  }

  requestTakeover(): void {
    this.persistence.requestTakeover()
  }

  resolveConflict(choice: 'local' | 'remote'): void {
    this.persistence.resolveConflict(choice)
  }

  recoverDraft(choice: 'recover' | 'discard'): void {
    this.persistence.recoverDraft(choice)
  }

  // ---- 内部 ----

  private handlePersistenceChange(): void {
    this.syncFromPersistence()
  }

  private handleRemoteDocument(_document: BrandDocument, sessionId: string): void {
    const state = this.persistence.getState()
    if (sessionId !== state.sessionId && !state.conflict && !state.recovery) {
      this.lastMessage = '已同步另一个页面的最新内容'
    }
    this.syncFromPersistence()
  }

  private guardEditable(readOnlyMessage?: string): boolean {
    if (this.persistence.canEdit()) return true
    if (readOnlyMessage) {
      this.lastMessage = readOnlyMessage
      this.syncFromPersistence('error')
    }
    return false
  }

  private update(partial: Partial<Pick<BrandDocument, 'tokens' | 'theme'>>, message: string): void {
    const current = this.persistence.getDocument()
    const next: BrandDocument = {
      ...current,
      tokens: partial.tokens ?? current.tokens,
      theme: partial.theme ?? current.theme,
    }
    this.persistence.setEdited(next)
    this.lastMessage = message
    this.syncFromPersistence('editing')
  }

  /** persistence -> snapshot 单向同步，compareMode 等纯视图状态保留 */
  private syncFromPersistence(statusOverride?: BrandMirrorSnapshot['status']): void {
    const state = this.persistence.getState()
    const notice = this.persistence.consumeNotice()
    if (notice) this.lastMessage = notice
    const document = this.persistence.getDocument()
    const previous = this.snapshot
    const status = statusOverride ?? (state.savePhase === 'error' ? 'error' : state.savePhase === 'pending' || state.savePhase === 'saving' ? 'editing' : state.role === 'starting' ? 'loading' : 'ready')
    this.snapshot = {
      ...this.buildSnapshot(document, this.lastMessage, status),
      compareMode: previous?.compareMode ?? false,
      savePhase: state.savePhase,
      savedAt: state.savedAt,
      role: state.role,
      peerCount: state.peerCount,
      ownerSessionId: state.ownerSessionId,
      recovery: state.recovery,
      conflict: state.conflict,
    }
    this.emit()
  }

  private buildSnapshot(document: Omit<BrandDocument, 'version'>, message: string, status: BrandMirrorSnapshot['status']): BrandMirrorSnapshot {
    const ratio = contrastRatio(document.tokens.primary, document.tokens.secondary)
    const latestVersion = document.versions[document.versions.length - 1]
    return {
      status,
      tokens: cloneTokens(document.tokens),
      theme: document.theme,
      versions: document.versions,
      compareMode: false,
      activeVersionId: latestVersion?.id ?? null,
      contrastRatio: ratio,
      contrastWarning: ratio < 3,
      message,
      savePhase: 'idle',
      savedAt: null,
      role: 'starting',
      peerCount: 1,
      ownerSessionId: null,
      recovery: null,
      conflict: null,
      notice: null,
    }
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }
}
