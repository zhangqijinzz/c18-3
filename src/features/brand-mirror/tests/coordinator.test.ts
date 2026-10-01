import { describe, expect, it, vi } from 'vitest'
import { WorkspaceCoordinator, HEARTBEAT_INTERVAL_MS, SESSION_STALE_MS } from '../services/workspaceCoordinator'
import { MemoryStorageService } from '../services/storageService'
import { ManualClock } from '../services/clock'
import { DRAFT_STORAGE_KEY, SESSIONS_STORAGE_KEY } from '../services/storageService'
import { INITIAL_TOKENS } from '../models/brandMirrorModels'
import type { DraftEnvelope } from '../models/brandMirrorModels'

function draft(sessionId: string, updatedAt: number, extra: Partial<DraftEnvelope> = {}): string {
  const envelope: DraftEnvelope = {
    version: 1,
    document: { version: 1, tokens: INITIAL_TOKENS, theme: 'studio', versions: [] },
    updatedAt,
    closed: false,
    sessionId,
    ...extra,
  }
  return JSON.stringify(envelope)
}

describe('WorkspaceCoordinator', () => {
  it('first tab owns the workspace, later tabs join as readers', () => {
    const storage = new MemoryStorageService()
    const clock = new ManualClock()
    const first = new WorkspaceCoordinator(storage, clock, {}, 'session-aaa')
    const second = new WorkspaceCoordinator(storage, clock, {}, 'session-bbb')

    expect(first.start().role).toBe('owner')
    const secondStart = second.start()
    expect(secondStart.role).toBe('reader')
    expect(secondStart.owner?.id).toBe('session-aaa')
    expect(first.canWrite()).toBe(true)
    expect(second.canWrite()).toBe(false)
  })

  it('promotes a waiting reader once the owner goes away', () => {
    const storage = new MemoryStorageService()
    const clock = new ManualClock()
    const first = new WorkspaceCoordinator(storage, clock, {}, 'session-aaa')
    const promoted = vi.fn()
    const second = new WorkspaceCoordinator(storage, clock, { onPromotion: promoted }, 'session-bbb')

    first.start()
    second.start()
    first.prepareUnload()
    storage.emitRemote(SESSIONS_STORAGE_KEY, storage.read(SESSIONS_STORAGE_KEY))
    expect(promoted).toHaveBeenCalledTimes(1)
    expect(second.getRole()).toBe('owner')
  })

  it('promotes a reader when the owner crashes and its heartbeat goes stale', () => {
    const storage = new MemoryStorageService()
    const clock = new ManualClock()
    const first = new WorkspaceCoordinator(storage, clock, {}, 'session-aaa')
    const promoted = vi.fn()
    const second = new WorkspaceCoordinator(storage, clock, { onPromotion: promoted }, 'session-bbb')

    first.start()
    second.start()
    // Simulate the owner being killed: no further unload or heartbeat.
    first.kill()
    clock.advance(SESSION_STALE_MS + HEARTBEAT_INTERVAL_MS + 10)
    expect(promoted).toHaveBeenCalled()
    expect(second.getRole()).toBe('owner')
  })

  it('takeOver demotes the live owner, which observes the loss', () => {
    const storage = new MemoryStorageService()
    const clock = new ManualClock()
    const demoted = vi.fn()
    const first = new WorkspaceCoordinator(storage, clock, { onDemotion: demoted }, 'session-aaa')
    const second = new WorkspaceCoordinator(storage, clock, {}, 'session-bbb')

    first.start()
    second.start()
    second.takeOver()
    storage.emitRemote(SESSIONS_STORAGE_KEY, storage.read(SESSIONS_STORAGE_KEY))
    expect(demoted).toHaveBeenCalledTimes(1)
    expect(first.getRole()).toBe('reader')
    expect(second.getRole()).toBe('owner')
  })

  it('never emits onRemoteDraft for the session that wrote the draft', () => {
    const storage = new MemoryStorageService()
    const clock = new ManualClock()
    const remoteDraft = vi.fn()
    const first = new WorkspaceCoordinator(storage, clock, { onRemoteDraft: remoteDraft }, 'session-aaa')
    first.start()
    storage.write(DRAFT_STORAGE_KEY, draft('session-aaa', 100))
    storage.emitRemote(DRAFT_STORAGE_KEY, storage.read(DRAFT_STORAGE_KEY))
    expect(remoteDraft).not.toHaveBeenCalled()

    storage.write(DRAFT_STORAGE_KEY, draft('session-bbb', 200))
    storage.emitRemote(DRAFT_STORAGE_KEY, storage.read(DRAFT_STORAGE_KEY))
    expect(remoteDraft).toHaveBeenCalledTimes(1)
  })

  it('two racing takeOver calls converge on a single owner', () => {
    const storage = new MemoryStorageService()
    const clock = new ManualClock()
    const a = new WorkspaceCoordinator(storage, clock, {}, 'session-aaa')
    const b = new WorkspaceCoordinator(storage, clock, {}, 'session-bbb')
    a.start()
    b.start()
    a.takeOver()
    b.takeOver()
    // Let both observe the ledger writes in order.
    storage.emitRemote(SESSIONS_STORAGE_KEY, storage.read(SESSIONS_STORAGE_KEY))
    storage.emitRemote(SESSIONS_STORAGE_KEY, storage.read(SESSIONS_STORAGE_KEY))
    const roles = [a.getRole(), b.getRole()]
    expect(roles.filter((role) => role === 'owner')).toHaveLength(1)
  })

  it('keeps heartbeating without changing ownership', () => {
    const storage = new MemoryStorageService()
    const clock = new ManualClock()
    const promoted = vi.fn()
    const first = new WorkspaceCoordinator(storage, clock, {}, 'session-aaa')
    const second = new WorkspaceCoordinator(storage, clock, { onPromotion: promoted }, 'session-bbb')
    first.start()
    second.start()
    clock.advance(HEARTBEAT_INTERVAL_MS * 2)
    expect(promoted).not.toHaveBeenCalled()
    expect(first.getRole()).toBe('owner')
    expect(second.getRole()).toBe('reader')
  })
})
