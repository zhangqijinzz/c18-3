import type { BrandDocument, DraftEnvelope } from '../models/brandMirrorModels'
import { clampTokenValues, validateTokens } from '../domain/brandRules'
import { DOCUMENT_STORAGE_KEY, DRAFT_STORAGE_KEY, type StorageService } from '../services/storageService'

export interface BrandRepository {
  load(): BrandDocument | null
  save(document: BrandDocument): void
  loadDraft(): DraftEnvelope | null
  saveDraft(envelope: DraftEnvelope): void
  clearDraft(): void
}

export class LocalBrandRepository implements BrandRepository {
  constructor(private readonly storage: StorageService) {}

  load(): BrandDocument | null {
    return parseDocument(this.storage.read(DOCUMENT_STORAGE_KEY))
  }

  save(document: BrandDocument): void {
    const validationError = validateTokens(document.tokens)
    if (validationError) throw new Error(validationError)
    this.storage.write(DOCUMENT_STORAGE_KEY, JSON.stringify(document))
  }

  loadDraft(): DraftEnvelope | null {
    return parseDraft(this.storage.read(DRAFT_STORAGE_KEY))
  }

  saveDraft(envelope: DraftEnvelope): void {
    const validationError = validateTokens(envelope.document.tokens)
    if (validationError) throw new Error(validationError)
    this.storage.write(DRAFT_STORAGE_KEY, JSON.stringify(envelope))
  }

  clearDraft(): void {
    this.storage.remove(DRAFT_STORAGE_KEY)
  }
}

export function parseDocument(raw: string | null): BrandDocument | null {
  if (!raw) return null
  try {
    const candidate: unknown = JSON.parse(raw)
    if (!isDocument(candidate)) return null
    return { ...candidate, tokens: clampTokenValues(candidate.tokens) }
  } catch {
    return null
  }
}

export function parseDraft(raw: string | null): DraftEnvelope | null {
  if (!raw) return null
  try {
    const candidate: unknown = JSON.parse(raw)
    if (!candidate || typeof candidate !== 'object') return null
    const envelope = candidate as Partial<DraftEnvelope>
    if (envelope.version !== 1 || typeof envelope.updatedAt !== 'number') return null
    if (typeof envelope.sessionId !== 'string' || !isDocument(envelope.document)) return null
    return {
      version: 1,
      updatedAt: envelope.updatedAt,
      closed: envelope.closed === true,
      sessionId: envelope.sessionId,
      document: { ...envelope.document, tokens: clampTokenValues(envelope.document.tokens) },
    }
  } catch {
    return null
  }
}

function isDocument(value: unknown): value is BrandDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BrandDocument>
  return candidate.version === 1 && !!candidate.tokens && Array.isArray(candidate.versions) && typeof candidate.theme === 'string'
}
