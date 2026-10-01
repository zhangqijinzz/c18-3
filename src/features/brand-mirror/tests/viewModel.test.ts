import { describe, expect, it } from 'vitest'
import { BrandMirrorViewModel } from '../viewmodels/brandMirrorViewModel'
import { INITIAL_TOKENS, type BrandDocument } from '../models/brandMirrorModels'
import { LocalBrandRepository } from '../repositories/brandRepository'
import { WorkspacePersistence } from '../services/workspacePersistence'
import { buildBrandGuidelinesMarkdown, type BrandGuidelinesExporter } from '../services/exportService'
import { ManualClock, ManualLifecycle, MemoryBus } from './persistenceTestUtils'
import type { StorageService } from '../services/storageService'

class MemoryStorage implements StorageService {
  private readonly map = new Map<string, string>()
  read(key: string): string | null { return this.map.get(key) ?? null }
  write(key: string, value: string): void { this.map.set(key, value) }
  remove(key: string): void { this.map.delete(key) }
  keys(): string[] { return [...this.map.keys()] }
}

class MemoryExporter implements BrandGuidelinesExporter {
  received: string | null = null
  export(snapshot: Parameters<BrandGuidelinesExporter['export']>[0]): void { this.received = buildBrandGuidelinesMarkdown(snapshot) }
}

function createViewModel(sessionId = 'session-page') {
  const storage = new MemoryStorage()
  const clock = new ManualClock()
  const lifecycle = new ManualLifecycle()
  const repository = new LocalBrandRepository(storage)
  const persistence = new WorkspacePersistence({
    repository,
    channel: new MemoryBus().connect(),
    clock,
    lifecycle,
    sessionId,
    timing: { autosaveDelay: 900, autosaveMaxWait: 3000, draftDelay: 300, heartbeatInterval: 1500, peerTtl: 5000, electionDelay: 50 },
  })
  const viewModel = new BrandMirrorViewModel(persistence)
  return { viewModel, persistence, repository, storage, clock, lifecycle }
}

describe('BrandMirrorViewModel', () => {
  it('初始化后可更新令牌，并在自动落盘后持久化', () => {
    const { viewModel, repository, clock } = createViewModel()
    viewModel.initialize()
    clock.advance(100)
    viewModel.updateColor('primary', '#123456')
    viewModel.updateScale('typeScale', 0, 18)
    expect(viewModel.getSnapshot().tokens.primary).toBe('#123456')
    expect(viewModel.getSnapshot().tokens.typeScale[0]).toBe(18)
    expect(viewModel.getSnapshot().savePhase).toBe('pending')

    clock.advance(900)
    expect(repository.load()?.document.tokens.primary).toBe('#123456')
    expect(viewModel.getSnapshot().savePhase).toBe('saved')
  })

  it('保存两个版本并进入对比模式', () => {
    const { viewModel, clock } = createViewModel()
    viewModel.initialize()
    clock.advance(100)
    viewModel.saveVersion()
    viewModel.updateColor('primary', '#238B73')
    clock.advance(900)
    viewModel.saveVersion()
    viewModel.toggleCompare()
    expect(viewModel.getSnapshot().versions.map((version) => version.label)).toEqual(['Version A', 'Version B'])
    expect(viewModel.getSnapshot().compareMode).toBe(true)
  })

  it('存储读取失败时编辑仍可继续，状态显示为错误', () => {
    const { viewModel, repository, clock } = createViewModel()
    viewModel.initialize()
    clock.advance(100)
    repository.commit = () => {
      throw new Error('quota exceeded')
    }
    viewModel.updateColor('secondary', '#FFFFFF')
    clock.advance(900)
    expect(viewModel.getSnapshot().status).toBe('error')
    expect(viewModel.getSnapshot().tokens.secondary).toBe('#FFFFFF')
  })

  it('从已有文档启动时载入之前保存的工作区', () => {
    const storage = new MemoryStorage()
    const nightDocument: BrandDocument = {
      version: 1,
      theme: 'night',
      tokens: { primary: '#A98BFF', secondary: '#191829', radiusScale: [6, 10, 14, 22], spacingScale: [4, 8, 12, 18, 28], typeScale: [12, 14, 16, 20, 28, 38] },
      versions: [],
    }
    new LocalBrandRepository(storage).commit(nightDocument, -1, 'seed', 1000)

    const reopened = createOwner(new MemoryBus(), storage, 'session-new')
    expect(reopened.viewModel.getSnapshot().theme).toBe('night')
  })

  it('草稿恢复对话框出现后，选择恢复会把草稿内容带回编辑区', () => {
    const storage = new MemoryStorage()
    const dead = createOwner(new MemoryBus(), storage, 'session-dead')
    dead.persistence.dispose()
    dead.repository.commit({ version: 1, theme: 'studio', tokens: { ...INITIAL_TOKENS }, versions: [] }, -1, 'seed', 1000)
    dead.repository.saveDraft({ tokens: { ...INITIAL_TOKENS, primary: '#ABCDEF' }, theme: 'studio', versions: [], draftAt: dead.clock.now() + 2000, baseRevision: 0, sessionId: 'session-dead' })

    const reopened = createOwner(new MemoryBus(), storage, 'session-alive')
    expect(reopened.viewModel.getSnapshot().recovery).not.toBeNull()
    reopened.viewModel.recoverDraft('recover')
    expect(reopened.viewModel.getSnapshot().tokens.primary).toBe('#ABCDEF')
  })

  it('只读页面拒绝保存版本，接管后才允许', () => {
    const bus = new MemoryBus()
    const storage = new MemoryStorage()
    const first = createOwner(bus, storage, 'session-aaaa')
    const second = createOwner(bus, storage, 'session-bbbb')
    second.viewModel.initialize()
    second.clock.advance(100)
    expect(second.viewModel.getSnapshot().role).toBe('viewer')
    second.viewModel.saveVersion()
    expect(second.viewModel.getSnapshot().message).toContain('只读')

    second.viewModel.requestTakeover()
    expect(second.viewModel.getSnapshot().role).toBe('owner')
    expect(first.viewModel.getSnapshot().role).toBe('viewer')
  })

  it('导出当前令牌系统为品牌规范', () => {
    const env = createViewModel()
    const exporter = new MemoryExporter()
    const viewModel = new BrandMirrorViewModel(env.persistence, exporter)
    viewModel.initialize()
    env.clock.advance(100)
    viewModel.exportBrandGuidelines()
    expect(exporter.received).toContain('# BrandMirror 品牌规范')
    expect(exporter.received).toContain('`primary`')
  })
})

function createOwner(bus: MemoryBus, storage: MemoryStorage, sessionId: string) {
  const clock = new ManualClock()
  const lifecycle = new ManualLifecycle()
  const repository = new LocalBrandRepository(storage)
  const persistence = new WorkspacePersistence({
    repository,
    channel: bus.connect(),
    clock,
    lifecycle,
    sessionId,
    timing: { autosaveDelay: 900, autosaveMaxWait: 3000, draftDelay: 300, heartbeatInterval: 1500, peerTtl: 5000, electionDelay: 50 },
  })
  const viewModel = new BrandMirrorViewModel(persistence)
  viewModel.initialize()
  clock.advance(100)
  return { viewModel, persistence, repository, storage, clock, lifecycle }
}
