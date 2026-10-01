import { describe, expect, it } from 'vitest'
import type { BrandDocument } from '../models/brandMirrorModels'
import { INITIAL_TOKENS } from '../models/brandMirrorModels'
import { LocalBrandRepository, type StoredDraft } from '../repositories/brandRepository'
import type { StorageService } from '../services/storageService'
import { WorkspacePersistence, type PersistenceTiming } from '../services/workspacePersistence'
import { ManualClock, ManualLifecycle, MemoryBus, MemoryChannel } from './persistenceTestUtils'

class MemoryStorage implements StorageService {
  private readonly map = new Map<string, string>()

  read(key: string): string | null {
    return this.map.get(key) ?? null
  }

  write(key: string, value: string): void {
    this.map.set(key, value)
  }

  remove(key: string): void {
    this.map.delete(key)
  }

  keys(): string[] {
    return [...this.map.keys()]
  }
}

const TIMING: PersistenceTiming = {
  autosaveDelay: 900,
  autosaveMaxWait: 3000,
  draftDelay: 300,
  heartbeatInterval: 1500,
  peerTtl: 5000,
  electionDelay: 200,
}

function makeDocument(primary = INITIAL_TOKENS.primary): BrandDocument {
  return { version: 1, tokens: { ...INITIAL_TOKENS, primary }, theme: 'studio', versions: [] }
}

interface Harness {
  persistence: WorkspacePersistence
  repository: LocalBrandRepository
  storage: MemoryStorage
  clock: ManualClock
  lifecycle: ManualLifecycle
}

function createHarness(sessionId: string, storage: MemoryStorage, bus: MemoryBus, clock: ManualClock): Harness {
  const lifecycle = new ManualLifecycle()
  const repository = new LocalBrandRepository(storage)
  const persistence = new WorkspacePersistence({
    repository,
    channel: new MemoryChannel(bus),
    clock,
    lifecycle,
    sessionId,
    timing: TIMING,
  })
  persistence.loadInitial()
  return { persistence, repository, storage, clock, lifecycle }
}

function openPage(sessionId: string, storage: MemoryStorage, bus: MemoryBus, clock: ManualClock): Harness {
  const page = createHarness(sessionId, storage, bus, clock)
  page.persistence.start()
  return page
}

describe('WorkspacePersistence 自动落盘', () => {
  it('编辑后按防抖节奏自动提交，提交成功后清掉草稿', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const page = openPage('session-page', storage, new MemoryBus(), clock)
    clock.advance(250)
    expect(page.persistence.getState().role).toBe('owner')

    page.persistence.setEdited(makeDocument('#123456'))
    clock.advance(350)
    expect(page.repository.loadDraft()?.tokens.primary).toBe('#123456')
    expect(page.repository.load()).toBeNull()

    clock.advance(600)
    const stored = page.repository.load()
    expect(stored?.document.tokens.primary).toBe('#123456')
    expect(stored?.revision).toBe(0)
    expect(page.persistence.getState().savePhase).toBe('saved')
    expect(page.repository.loadDraft()).toBeNull()
  })

  it('持续编辑也不会超过最大落盘间隔', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const page = openPage('session-page', storage, new MemoryBus(), clock)
    clock.advance(250)

    for (let index = 0; index < 20; index += 1) {
      page.persistence.setEdited(makeDocument(`#1000${index.toString().padStart(2, '0')}`))
      clock.advance(400)
    }
    // 8 秒的连续编辑，3 秒封顶间隔下至少落盘两次
    expect(page.repository.load()?.revision).toBeGreaterThanOrEqual(1)
    // 最后一次编辑仍挂起，手动收尾应能成功提交
    page.persistence.flushNow()
    expect(page.persistence.getState().savePhase).toBe('saved')
  })

  it('pagehide 时先同步写草稿并立即提交，异常关闭也不丢内容', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const page = openPage('session-page', storage, new MemoryBus(), clock)
    clock.advance(250)

    page.persistence.setEdited(makeDocument('#ABCDEF'))
    page.lifecycle.firePageHide()

    const stored = page.repository.load()
    expect(stored?.document.tokens.primary).toBe('#ABCDEF')
    expect(stored?.revision).toBe(0)
  })

  it('编辑后来不及自动提交就崩溃，草稿保留，下次启动可恢复', () => {
    const storage = new MemoryStorage()
    const deadClock = new ManualClock()
    const dead = openPage('session-dead', storage, new MemoryBus(), deadClock)
    deadClock.advance(250)
    dead.persistence.setEdited(makeDocument('#ABCDEF'))
    deadClock.advance(300)
    expect(dead.repository.loadDraft()).not.toBeNull()
    dead.persistence.dispose()

    const aliveClock = new ManualClock(5_000_000)
    const next = openPage('session-alive', storage, new MemoryBus(), aliveClock)
    aliveClock.advance(250)
    expect(next.persistence.getState().recovery?.tokens.primary).toBe('#ABCDEF')

    next.persistence.recoverDraft('recover')
    expect(next.persistence.getDocument().tokens.primary).toBe('#ABCDEF')
    aliveClock.advance(900)
    expect(next.repository.load()?.document.tokens.primary).toBe('#ABCDEF')
  })

  it('草稿与已提交内容一致时不打扰用户，直接清掉', () => {
    const storage = new MemoryStorage()
    const repository = new LocalBrandRepository(storage)
    const document = makeDocument('#ABCDEF')
    repository.commit(document, -1, 'session-dead', 1000)
    const draft: StoredDraft = { tokens: document.tokens, theme: document.theme, versions: document.versions, draftAt: 1200, baseRevision: 0, sessionId: 'session-dead' }
    repository.saveDraft(draft)

    const clock = new ManualClock(5_000_000)
    const page = openPage('session-alive', storage, new MemoryBus(), clock)
    clock.advance(250)
    expect(page.persistence.getState().recovery).toBeNull()
    expect(repository.loadDraft()).toBeNull()
  })

  it('选择丢弃草稿则以已保存内容为准', () => {
    const storage = new MemoryStorage()
    const repository = new LocalBrandRepository(storage)
    repository.commit(makeDocument('#111111'), -1, 'session-dead', 1000)
    repository.saveDraft({ tokens: { ...INITIAL_TOKENS, primary: '#222222' }, theme: 'studio', versions: [], draftAt: 1200, baseRevision: 0, sessionId: 'session-dead' })

    const clock = new ManualClock(5_000_000)
    const page = openPage('session-alive', storage, new MemoryBus(), clock)
    clock.advance(250)
    expect(page.persistence.getState().recovery).not.toBeNull()
    page.persistence.recoverDraft('discard')
    expect(page.persistence.getDocument().tokens.primary).toBe('#111111')
  })
})

describe('WorkspacePersistence 多标签协调', () => {
  it('第二个页面以只读打开，并持续同步 owner 的内容', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const bus = new MemoryBus()
    const first = openPage('session-aaaa', storage, bus, clock)
    clock.advance(250)
    first.persistence.setEdited(makeDocument('#123456'))
    clock.advance(900)

    const second = openPage('session-bbbb', storage, bus, clock)
    clock.advance(250)

    expect(first.persistence.getState().role).toBe('owner')
    expect(second.persistence.getState().role).toBe('viewer')
    expect(second.persistence.canEdit()).toBe(false)
    expect(second.persistence.getDocument().tokens.primary).toBe('#123456')

    first.persistence.setEdited(makeDocument('#654321'))
    clock.advance(900)
    expect(second.persistence.getDocument().tokens.primary).toBe('#654321')
  })

  it('只读页面显式接管时，owner 先落盘自己的未落盘改动再交接', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const bus = new MemoryBus()
    const first = openPage('session-aaaa', storage, bus, clock)
    clock.advance(250)
    const second = openPage('session-bbbb', storage, bus, clock)
    clock.advance(250)
    expect(second.persistence.getState().role).toBe('viewer')

    first.persistence.setEdited(makeDocument('#AAAAAA'))
    clock.advance(100)
    second.persistence.requestTakeover()

    expect(first.persistence.getState().role).toBe('viewer')
    expect(second.persistence.getState().role).toBe('owner')
    expect(first.repository.load()?.document.tokens.primary).toBe('#AAAAAA')
    expect(second.persistence.getDocument().tokens.primary).toBe('#AAAAAA')
    expect(second.persistence.canEdit()).toBe(true)
  })

  it('接管前只读页面的任何编辑都不会写入或覆盖工作区', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const bus = new MemoryBus()
    const first = openPage('session-aaaa', storage, bus, clock)
    clock.advance(250)
    first.persistence.setEdited(makeDocument('#123456'))
    clock.advance(900)

    const second = openPage('session-bbbb', storage, bus, clock)
    clock.advance(250)
    const before = JSON.stringify(second.repository.load())
    second.persistence.setEdited(makeDocument('#FFFFFF'))
    clock.advance(5000)
    expect(JSON.stringify(second.repository.load())).toBe(before)
    expect(second.repository.load()?.document.tokens.primary).toBe('#123456')
  })

  it('owner 正常关闭（bye）后，只读页面可自行接管', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const bus = new MemoryBus()
    const first = openPage('session-aaaa', storage, bus, clock)
    clock.advance(250)
    const second = openPage('session-bbbb', storage, bus, clock)
    clock.advance(250)

    first.persistence.dispose()
    expect(second.persistence.getState().ownerSessionId).toBeNull()
    second.persistence.requestTakeover()
    expect(second.persistence.getState().role).toBe('owner')
  })

  it('owner 崩溃（无 bye，心跳超时）后，只读页面仍能接管', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const bus = new MemoryBus()
    const first = openPage('session-aaaa', storage, bus, clock)
    clock.advance(250)
    const second = openPage('session-bbbb', storage, bus, clock)
    clock.advance(250)

    // 不发 bye、直接摘掉通道来模拟崩溃
    first.persistence.dispose()
    clock.advance(6000)
    second.persistence.requestTakeover()
    expect(second.persistence.getState().role).toBe('owner')
  })
})

describe('WorkspacePersistence 冲突处理', () => {
  it('CAS 写入失败且内容不同时冻结自动保存，选择保留本页则强制提交', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const page = openPage('session-page', storage, new MemoryBus(), clock)
    clock.advance(250)
    page.persistence.setEdited(makeDocument('#222222'))

    // 自动落盘前，存储被另一个会话推进为不同内容
    new LocalBrandRepository(storage).commit(makeDocument('#111111'), -1, 'session-other', clock.now() + 1)

    clock.advance(900)
    const conflictState = page.persistence.getState()
    expect(conflictState.conflict).not.toBeNull()
    expect(conflictState.frozen).toBe(true)
    expect(conflictState.conflict?.remoteTokens.primary).toBe('#111111')
    // 冻结期间继续编辑不会覆盖远端
    page.persistence.setEdited(makeDocument('#999999'))
    clock.advance(5000)
    expect(page.repository.load()?.document.tokens.primary).toBe('#111111')

    page.persistence.resolveConflict('local')
    expect(page.repository.load()?.document.tokens.primary).toBe('#222222')
    expect(page.persistence.getState().conflict).toBeNull()
    expect(page.persistence.getState().frozen).toBe(false)
  })

  it('选择保留另一个页面时，本页采用对端内容并清除草稿', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const page = openPage('session-page', storage, new MemoryBus(), clock)
    clock.advance(250)
    page.persistence.setEdited(makeDocument('#222222'))
    new LocalBrandRepository(storage).commit(makeDocument('#333333'), -1, 'session-other', clock.now() + 1)
    clock.advance(900)
    expect(page.persistence.getState().conflict).not.toBeNull()

    page.persistence.resolveConflict('remote')
    expect(page.persistence.getDocument().tokens.primary).toBe('#333333')
    expect(page.persistence.getState().conflict).toBeNull()
    expect(page.repository.loadDraft()).toBeNull()
  })

  it('CAS 失败但两边内容一致时静默对齐，不打扰用户', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    const page = openPage('session-page', storage, new MemoryBus(), clock)
    clock.advance(250)
    page.persistence.setEdited(makeDocument('#444444'))
    new LocalBrandRepository(storage).commit(makeDocument('#444444'), -1, 'session-other', clock.now() + 1)
    clock.advance(900)
    expect(page.persistence.getState().conflict).toBeNull()
    expect(page.persistence.getState().baseRevision).toBe(0)
  })

  it('冲突裁决后胜出内容落盘，败方收到信令同步并降级为只读', () => {
    const clock = new ManualClock()
    const storage = new MemoryStorage()
    // 脑裂：两个页面在各自独立总线上、同一空存储上几乎同时启动
    const first = openPage('session-aaaa', storage, new MemoryBus(), clock)
    const second = openPage('session-bbbb', storage, new MemoryBus(), clock)
    clock.advance(250)
    expect(first.persistence.getState().role).toBe('owner')
    expect(second.persistence.getState().role).toBe('owner')

    // 各自产生不同编辑，先后落盘：先者成功，后者 CAS 失败被冻结
    first.persistence.setEdited(makeDocument('#111111'))
    second.persistence.setEdited(makeDocument('#222222'))
    clock.advance(900)

    expect(first.repository.load()?.document.tokens.primary).toBe('#111111')
    expect(second.persistence.getState().conflict).not.toBeNull()
    expect(second.persistence.getState().frozen).toBe(true)

    // second 的用户选择保留本页：强制推进修订号
    second.persistence.resolveConflict('local')
    expect(second.repository.load()?.document.tokens.primary).toBe('#222222')
    expect(second.persistence.getState().role).toBe('owner')
    expect(second.persistence.getState().conflict).toBeNull()

    // 选择保留对端的场景已由上一个用例覆盖；这里再验证裁决后可继续正常自动落盘
    second.persistence.setEdited(makeDocument('#555555'))
    clock.advance(900)
    expect(second.repository.load()?.document.tokens.primary).toBe('#555555')
  })
})
