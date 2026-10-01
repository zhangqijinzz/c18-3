import type { BrandDocument, BrandTheme, BrandTokens, SavedVersion } from '../models/brandMirrorModels'
import { clampTokenValues, validateTokens } from '../domain/brandRules'
import { DOCUMENT_STORAGE_KEY, DRAFT_STORAGE_KEY, LEGACY_DOCUMENT_STORAGE_KEY } from '../services/storageService'
import type { StorageService } from '../services/storageService'

export interface StoredDocument {
  document: BrandDocument
  revision: number
  updatedAt: number
  /** 最近一次写入该文档的标签页会话，用于冲突说明 */
  sessionId: string
}

export interface StoredDraft {
  tokens: BrandTokens
  theme: BrandTheme
  versions: SavedVersion[]
  draftAt: number
  /** 草稿基于的已提交修订号 */
  baseRevision: number
  sessionId: string
}

export interface CommitResult {
  ok: boolean
  /** 当前存储中的实际记录；ok 为 false 时用于冲突展示 */
  current: StoredDocument
}

export interface BrandRepository {
  load(): StoredDocument | null
  /** 乐观并发提交：仅当存储修订号等于 expectedRevision 时才写入 */
  commit(document: BrandDocument, expectedRevision: number, sessionId: string, now: number): CommitResult
  /** 冲突仲裁后用户选择保留某一份：以存储最新修订号为基底强制写入 */
  forceCommit(document: BrandDocument, sessionId: string, now: number): StoredDocument
  saveDraft(draft: StoredDraft): void
  loadDraft(): StoredDraft | null
  clearDraft(): void
}

export class LocalBrandRepository implements BrandRepository {
  constructor(private readonly storage: StorageService) {}

  load(): StoredDocument | null {
    const record = readRecord(this.storage, DOCUMENT_STORAGE_KEY)
    if (record) return record
    // 首次升级：旧版本只有一份裸文档，视作 revision 0
    const legacy = this.storage.read(LEGACY_DOCUMENT_STORAGE_KEY)
    if (legacy) {
      try {
        const candidate: unknown = JSON.parse(legacy)
        if (isLegacyDocument(candidate)) {
          const document: BrandDocument = { ...candidate, tokens: clampTokenValues(candidate.tokens) }
          return { document, revision: 0, updatedAt: 0, sessionId: 'legacy' }
        }
      } catch {
        // 损坏的旧数据忽略
      }
    }
    return null
  }

  commit(document: BrandDocument, expectedRevision: number, sessionId: string, now: number): CommitResult {
    const validationError = validateTokens(document.tokens)
    if (validationError) throw new Error(validationError)
    const current = this.load() ?? { revision: -1, updatedAt: 0, sessionId: '', document: emptyDocument() }
    if (current.revision !== expectedRevision) {
      return { ok: false, current }
    }
    const next: StoredDocument = { document, revision: expectedRevision + 1, updatedAt: now, sessionId }
    this.storage.write(DOCUMENT_STORAGE_KEY, JSON.stringify(next))
    return { ok: true, current: next }
  }

  forceCommit(document: BrandDocument, sessionId: string, now: number): StoredDocument {
    const validationError = validateTokens(document.tokens)
    if (validationError) throw new Error(validationError)
    const current = this.load()
    const nextRevision = current ? current.revision + 1 : 0
    const next: StoredDocument = { document, revision: nextRevision, updatedAt: now, sessionId }
    this.storage.write(DOCUMENT_STORAGE_KEY, JSON.stringify(next))
    return next
  }

  saveDraft(draft: StoredDraft): void {
    this.storage.write(DRAFT_STORAGE_KEY, JSON.stringify(draft))
  }

  loadDraft(): StoredDraft | null {
    const raw = this.storage.read(DRAFT_STORAGE_KEY)
    if (!raw) return null
    try {
      const candidate: unknown = JSON.parse(raw)
      if (!isDraft(candidate)) return null
      return { ...candidate, tokens: clampTokenValues(candidate.tokens) }
    } catch {
      return null
    }
  }

  clearDraft(): void {
    this.storage.remove(DRAFT_STORAGE_KEY)
  }
}

function readRecord(storage: StorageService, key: string): StoredDocument | null {
  const raw = storage.read(key)
  if (!raw) return null
  try {
    const candidate: unknown = JSON.parse(raw)
    if (!isRecord(candidate)) return null
    return { ...candidate, document: { ...candidate.document, tokens: clampTokenValues(candidate.document.tokens) } }
  } catch {
    return null
  }
}

function isTokens(value: unknown): value is BrandTokens {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BrandTokens>
  return (
    typeof candidate.primary === 'string'
    && typeof candidate.secondary === 'string'
    && Array.isArray(candidate.radiusScale)
    && Array.isArray(candidate.spacingScale)
    && Array.isArray(candidate.typeScale)
  )
}

function isLegacyDocument(value: unknown): value is BrandDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BrandDocument>
  return candidate.version === 1 && isTokens(candidate.tokens) && Array.isArray(candidate.versions) && typeof candidate.theme === 'string'
}

function isRecord(value: unknown): value is StoredDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StoredDocument>
  return (
    typeof candidate.revision === 'number'
    && typeof candidate.updatedAt === 'number'
    && typeof candidate.sessionId === 'string'
    && !!candidate.document
    && isLegacyDocument(candidate.document)
  )
}

function isDraft(value: unknown): value is StoredDraft {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StoredDraft>
  return (
    isTokens(candidate.tokens)
    && typeof candidate.theme === 'string'
    && Array.isArray(candidate.versions)
    && typeof candidate.draftAt === 'number'
    && typeof candidate.baseRevision === 'number'
    && typeof candidate.sessionId === 'string'
  )
}

function emptyDocument(): BrandDocument {
  return { version: 1, tokens: { primary: '#000000', secondary: '#FFFFFF', radiusScale: [0, 0, 0, 0], spacingScale: [2, 2, 2, 2, 2], typeScale: [10, 10, 10, 10, 10, 10] }, theme: 'studio', versions: [] }
}
