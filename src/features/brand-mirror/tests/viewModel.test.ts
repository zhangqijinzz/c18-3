import { describe, expect, it } from 'vitest'
import { BrandMirrorViewModel } from '../viewmodels/brandMirrorViewModel'
import type { BrandDocument, DraftEnvelope } from '../models/brandMirrorModels'
import { INITIAL_TOKENS, type BrandTokens } from '../models/brandMirrorModels'
import type { BrandRepository } from '../repositories/brandRepository'
import { LocalBrandRepository } from '../repositories/brandRepository'
import { buildBrandGuidelinesMarkdown, type BrandGuidelinesExporter } from '../services/exportService'
import { ManualClock } from '../services/clock'
import { WorkspaceCoordinator } from '../services/workspaceCoordinator'
import { DRAFT_STORAGE_KEY, type StorageListener, type StorageService } from '../services/storageService'

/** localStorage stand-in shared across "tabs": every write notifies other tabs. */
class SharedStorageHub {
  private readonly map = new Map<string, string>()
  private readonly tabs = new Set<HubStorage>()

  attach(tab: HubStorage): void {
    this.tabs.add(tab)
  }

  detach(tab: HubStorage): void {
    this.tabs.delete(tab)
  }

  read(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  write(author: HubStorage, key: string, value: string): void {
    this.map.set(key, value)
    this.tabs.forEach((tab) => {
      if (tab !== author) tab.deliver(key, value)
    })
  }

  remove(author: HubStorage, key: string): void {
    this.map.delete(key)
    this.tabs.forEach((tab) => {
      if (tab !== author) tab.deliver(key, null)
    })
  }
}

class HubStorage implements StorageService {
  private readonly listeners = new Set<StorageListener>()
  constructor(private readonly hub: SharedStorageHub) {
    hub.attach(this)
  }

  read(key: string): string | null {
    return this.hub.read(key)
  }

  write(key: string, value: string): void {
    this.hub.write(this, key, value)
  }

  remove(key: string): void {
    this.hub.remove(this, key)
  }

  subscribe(listener: StorageListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  deliver(key: string, value: string | null): void {
    this.listeners.forEach((listener) => listener(key, value))
  }
}

class MemoryRepository implements BrandRepository {
  document: BrandDocument | null = null
  draft: DraftEnvelope | null = null
  shouldFail = false

  load(): BrandDocument | null {
    return this.document ? JSON.parse(JSON.stringify(this.document)) : null
  }

  save(document: BrandDocument): void {
    if (this.shouldFail) throw new Error('offline')
    this.document = JSON.parse(JSON.stringify(document))
  }

  loadDraft(): DraftEnvelope | null {
    return this.draft ? JSON.parse(JSON.stringify(this.draft)) : null
  }

  saveDraft(envelope: DraftEnvelope): void {
    if (this.shouldFail) throw new Error('offline')
    this.draft = JSON.parse(JSON.stringify(envelope))
  }

  clearDraft(): void {
    this.draft = null
  }
}

class MemoryExporter implements BrandGuidelinesExporter {
  received: string | null = null
  export(snapshot: Parameters<BrandGuidelinesExporter['export']>[0]): void {
    this.received = buildBrandGuidelinesMarkdown(snapshot)
  }
}

function tokens(primary: string, secondary = '#24324A'): BrandTokens {
  return { ...INITIAL_TOKENS, primary, secondary }
}

/** A full VM wired like the real app, plus raw storage for cross-tab checks. */
class Tab {
  readonly storage: HubStorage
  readonly repository: LocalBrandRepository
  readonly coordinator: WorkspaceCoordinator
  readonly vm: BrandMirrorViewModel

  constructor(
    readonly hub: SharedStorageHub,
    readonly clock: ManualClock,
    id: string,
  ) {
    this.storage = new HubStorage(hub)
    this.repository = new LocalBrandRepository(this.storage)
    this.coordinator = new WorkspaceCoordinator(this.storage, clock, {}, id)
    this.vm = new BrandMirrorViewModel(
      this.repository,
      undefined,
      { coordinator: this.coordinator, storage: this.storage, clock },
    )
    this.vm.initialize()
  }
}

function openTab(hub: SharedStorageHub, clock: ManualClock, id: string): Tab {
  return new Tab(hub, clock, id)
}

describe('BrandMirrorViewModel', () => {
  it('initializes, updates tokens and persists the latest state', () => {
    const repository = new MemoryRepository()
    const clock = new ManualClock()
    const storage = new HubStorage(new SharedStorageHub())
    const coordinator = new WorkspaceCoordinator(storage, clock, {}, 'session-test')
    const viewModel = new BrandMirrorViewModel(repository, undefined, { coordinator, storage, clock })
    viewModel.initialize()
    viewModel.updateColor('primary', '#123456')
    viewModel.updateScale('typeScale', 0, 18)
    expect(viewModel.getSnapshot().tokens.primary).toBe('#123456')
    expect(viewModel.getSnapshot().tokens.typeScale[0]).toBe(18)
    clock.advance(800)
    expect(repository.draft?.document.tokens.primary).toBe('#123456')
  })

  it('debounces autosave: nothing is written immediately, then a checkpoint lands', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const tab = openTab(hub, clock, 'session-a')

    tab.vm.updateColor('primary', '#112233')
    expect(tab.vm.getSnapshot().saveState).toBe('saving')
    expect(tab.repository.loadDraft()).toBeNull()
    clock.advance(500)
    tab.vm.updateColor('primary', '#445566')
    clock.advance(500)
    expect(tab.repository.loadDraft()).toBeNull()
    clock.advance(300)
    const draft = tab.repository.loadDraft()
    expect(draft?.document.tokens.primary).toBe('#445566')
    expect(draft?.closed).toBe(false)
    expect(tab.vm.getSnapshot().saveState).toBe('saved')
  })

  it('saves two versions and enters comparison mode', () => {
    const repository = new MemoryRepository()
    const clock = new ManualClock()
    const storage = new HubStorage(new SharedStorageHub())
    const viewModel = new BrandMirrorViewModel(repository, undefined, {
      coordinator: new WorkspaceCoordinator(storage, clock, {}, 'session-test'),
      storage,
      clock,
    })
    viewModel.initialize()
    viewModel.saveVersion()
    viewModel.updateColor('primary', '#238B73')
    clock.advance(800)
    viewModel.saveVersion()
    viewModel.toggleCompare()
    expect(viewModel.getSnapshot().versions.map((version) => version.label)).toEqual(['Version A', 'Version B'])
    expect(viewModel.getSnapshot().compareMode).toBe(true)
    // Saving a version clears the working draft and writes the committed doc.
    expect(repository.draft).toBeNull()
    expect(repository.document?.versions).toHaveLength(2)
  })

  it('keeps editing usable when persistence fails', () => {
    const repository = new MemoryRepository()
    const clock = new ManualClock()
    const storage = new HubStorage(new SharedStorageHub())
    const viewModel = new BrandMirrorViewModel(repository, undefined, {
      coordinator: new WorkspaceCoordinator(storage, clock, {}, 'session-test'),
      storage,
      clock,
    })
    viewModel.initialize()
    repository.shouldFail = true
    viewModel.updateColor('secondary', '#FFFFFF')
    clock.advance(800)
    expect(viewModel.getSnapshot().status).toBe('editing')
    expect(viewModel.getSnapshot().saveState).toBe('offline')
    expect(viewModel.getSnapshot().tokens.secondary).toBe('#FFFFFF')
  })

  it('recovers a previously committed document on initialization', () => {
    const repository = new MemoryRepository()
    repository.document = { version: 1, theme: 'night', tokens: { ...tokens('#A98BFF', '#191829') }, versions: [] }
    const clock = new ManualClock()
    const storage = new HubStorage(new SharedStorageHub())
    const viewModel = new BrandMirrorViewModel(repository, undefined, {
      coordinator: new WorkspaceCoordinator(storage, clock, {}, 'session-test'),
      storage,
      clock,
    })
    viewModel.initialize()
    expect(viewModel.getSnapshot().theme).toBe('night')
    expect(viewModel.getSnapshot().message).toContain('恢复')
  })

  it('exports the current token system as brand guidelines', () => {
    const repository = new MemoryRepository()
    const exporter = new MemoryExporter()
    const clock = new ManualClock()
    const storage = new HubStorage(new SharedStorageHub())
    const viewModel = new BrandMirrorViewModel(repository, exporter, {
      coordinator: new WorkspaceCoordinator(storage, clock, {}, 'session-test'),
      storage,
      clock,
    })
    viewModel.initialize()
    viewModel.exportBrandGuidelines()
    expect(exporter.received).toContain('# BrandMirror 品牌规范')
    expect(exporter.received).toContain('`primary`')
    expect(viewModel.getSnapshot().message).toContain('导出')
  })

  it('reopens silently after a healthy close', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const first = openTab(hub, clock, 'session-a')
    first.vm.updateColor('primary', '#ABCDEF')
    clock.advance(800)
    first.clock.triggerUnload()

    clock.advance(100)
    const second = openTab(hub, clock, 'session-a')
    expect(second.vm.getSnapshot().tokens.primary).toBe('#ABCDEF')
    expect(second.vm.getSnapshot().draftRecovery).toBeNull()
  })

  it('flushes edits still inside the debounce window when the page closes', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const first = openTab(hub, clock, 'session-a')
    first.vm.updateColor('primary', '#0A0B0C')
    clock.advance(300) // autosave (800ms) has not fired yet
    expect(first.repository.loadDraft()).toBeNull()
    first.clock.triggerUnload()
    const draft = first.repository.loadDraft()
    expect(draft?.document.tokens.primary).toBe('#0A0B0C')
    expect(draft?.closed).toBe(true)

    clock.advance(100)
    const reopened = openTab(hub, clock, 'session-a2')
    expect(reopened.vm.getSnapshot().tokens.primary).toBe('#0A0B0C')
    expect(reopened.vm.getSnapshot().draftRecovery).toBeNull()
  })

  it('surfaces a crash draft (checkpoint never closed) and lets the user choose', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const first = openTab(hub, clock, 'session-a')
    first.vm.updateColor('primary', '#ABCDEF')
    clock.advance(800)
    // Tab killed (process gone): no unload event, timers stop.
    first.vm.kill()
    clock.advance(7_000)

    const reopened = openTab(hub, clock, 'session-b')
    expect(reopened.vm.getSnapshot().tokens.primary).toBe('#ABCDEF')
    expect(reopened.vm.getSnapshot().draftRecovery).not.toBeNull()
    expect(reopened.vm.getSnapshot().status).toBe('editing')

    reopened.vm.discardRecoveredDraft()
    expect(reopened.vm.getSnapshot().tokens.primary).toBe(INITIAL_TOKENS.primary)
    expect(hub.read(DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('keeping a recovered draft anchors it as the new baseline', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const first = openTab(hub, clock, 'session-a')
    first.vm.updateColor('primary', '#ABCDEF')
    clock.advance(800)
    clock.advance(1000)

    const reopened = openTab(hub, clock, 'session-c')
    reopened.vm.keepRecoveredDraft()
    expect(reopened.vm.getSnapshot().draftRecovery).toBeNull()
    expect(reopened.repository.loadDraft()?.closed).toBe(false)
  })
})

describe('multi-tab coordination', () => {
  it('opens the second tab read-only and locks its controls', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    openTab(hub, clock, 'session-aaa')
    const second = openTab(hub, clock, 'session-bbb')
    expect(second.vm.getSnapshot().canEdit).toBe(false)
    expect(second.vm.getSnapshot().status).toBe('readonly')

    second.vm.updateColor('primary', '#FF0000')
    expect(second.vm.getSnapshot().tokens.primary).toBe(INITIAL_TOKENS.primary)
  })

  it('streams owner edits into the read-only tab without overwriting', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const owner = openTab(hub, clock, 'session-aaa')
    const reader = openTab(hub, clock, 'session-bbb')

    owner.vm.updateColor('primary', '#238B73')
    clock.advance(800)
    expect(reader.vm.getSnapshot().tokens.primary).toBe('#238B73')
    expect(reader.vm.getSnapshot().canEdit).toBe(false)
  })

  it('reader take-over raises a conflict when content differs and writes nothing until decided', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const owner = openTab(hub, clock, 'session-aaa')
    const reader = openTab(hub, clock, 'session-bbb')

    // Owner publishes version 1, reader follows it.
    owner.vm.updateColor('primary', '#111111')
    clock.advance(800)
    expect(reader.vm.getSnapshot().tokens.primary).toBe('#111111')

    // Owner then buffers version 2 that never reaches disk.
    owner.vm.updateColor('primary', '#222222')

    // Reader asks to take over; the disk draft still shows version 1 which is
    // exactly what the reader has, so no conflict appears yet.
    reader.vm.requestTakeOver()
    expect(reader.coordinator.getRole()).toBe('owner')

    // Owner is demoted while holding unsaved #222222 and, once its debounce
    // would run, must surface the conflict instead of overwriting anything.
    clock.advance(800)
    const ownerSnapshot = owner.vm.getSnapshot()
    expect(ownerSnapshot.status).toBe('conflict')
    expect(ownerSnapshot.tokens.primary).toBe('#222222')

    // Until the user decides, disk keeps the pre-takeover draft.
    expect(JSON.parse(hub.read(DRAFT_STORAGE_KEY) as string).document.tokens.primary).toBe('#111111')

    // Owner chooses to keep its version and takes the workspace back.
    owner.vm.resolveKeepMine()
    expect(owner.coordinator.getRole()).toBe('owner')
    clock.advance(800)
    expect(JSON.parse(hub.read(DRAFT_STORAGE_KEY) as string).document.tokens.primary).toBe('#222222')
  })

  it('demotes the owner when the reader takes over, protecting owner edits', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const owner = openTab(hub, clock, 'session-aaa')
    const reader = openTab(hub, clock, 'session-bbb')

    owner.vm.updateColor('primary', '#AAAAAA')
    clock.advance(400) // still buffered: autosave has not fired
    reader.vm.requestTakeOver() // demotion + baseline draft arrive synchronously

    const ownerSnapshot = owner.vm.getSnapshot()
    expect(owner.coordinator.getRole()).toBe('reader')
    expect(ownerSnapshot.status).toBe('conflict')
    // Owner's buffered color is retained on screen for the user to choose.
    expect(ownerSnapshot.tokens.primary).toBe('#AAAAAA')
    // The buffered color never reached disk and is therefore not lost from memory.
    expect(JSON.parse(hub.read(DRAFT_STORAGE_KEY) as string).document.tokens.primary).toBe(INITIAL_TOKENS.primary)
  })

  it('lets the demoted owner keep its own content and re-take over', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const owner = openTab(hub, clock, 'session-aaa')
    const reader = openTab(hub, clock, 'session-bbb')
    owner.vm.updateColor('primary', '#AAAAAA')
    clock.advance(400)
    reader.vm.requestTakeOver()

    owner.vm.resolveKeepMine()
    expect(owner.coordinator.getRole()).toBe('owner')
    expect(owner.vm.getSnapshot().tokens.primary).toBe('#AAAAAA')
    clock.advance(800)
    expect(JSON.parse(hub.read(DRAFT_STORAGE_KEY) as string).document.tokens.primary).toBe('#AAAAAA')
  })

  it('lets the demoted owner adopt the other tab content instead', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const owner = openTab(hub, clock, 'session-aaa')
    const reader = openTab(hub, clock, 'session-bbb')

    // The reader follows #AAAAAA, then the owner buffers a different color.
    owner.vm.updateColor('primary', '#AAAAAA')
    clock.advance(800)
    owner.vm.updateColor('primary', '#CCCCCC')
    reader.vm.requestTakeOver()

    // The owner's conflict dialog offers the disk draft (#AAAAAA) as "theirs".
    const remote = owner.vm.getSnapshot().conflict?.remoteDocument
    expect(remote).toBeDefined()
    expect(remote?.tokens.primary).toBe('#AAAAAA')
    owner.vm.resolveKeepTheirs(remote as BrandDocument)
    expect(owner.vm.getSnapshot().tokens.primary).toBe('#AAAAAA')
    expect(owner.vm.getSnapshot().status).toBe('ready')
    expect(owner.coordinator.getRole()).toBe('owner')
  })

  it('allows staying read-only after a takeover prompt', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const owner = openTab(hub, clock, 'session-aaa')
    const reader = openTab(hub, clock, 'session-bbb')
    owner.vm.updateColor('primary', '#777777')
    clock.advance(800)
    reader.vm.requestTakeOver()
    reader.vm.resolveKeepBrowsing()
    expect(reader.coordinator.getRole()).toBe('reader')
    expect(reader.vm.getSnapshot().status).toBe('readonly')
    expect(reader.vm.getSnapshot().conflict).toBeNull()
  })

  it('takeover with no diverging content is immediate and editable', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    openTab(hub, clock, 'session-aaa')
    const reader = openTab(hub, clock, 'session-bbb')
    expect(reader.vm.getSnapshot().canEdit).toBe(false)
    reader.vm.requestTakeOver()
    expect(reader.vm.getSnapshot().status).toBe('ready')
    expect(reader.vm.getSnapshot().conflict).toBeNull()
    reader.vm.updateColor('primary', '#123123')
    expect(reader.vm.getSnapshot().tokens.primary).toBe('#123123')
    clock.advance(800)
    expect(JSON.parse(hub.read(DRAFT_STORAGE_KEY) as string).document.tokens.primary).toBe('#123123')
  })

  it('promotes a reader to owner after the owner tab closes cleanly', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const owner = openTab(hub, clock, 'session-aaa')
    const reader = openTab(hub, clock, 'session-bbb')
    owner.vm.updateColor('primary', '#556677')
    clock.advance(800)
    owner.clock.triggerUnload()
    expect(reader.vm.getSnapshot().canEdit).toBe(true)
    expect(reader.vm.getSnapshot().tokens.primary).toBe('#556677')
    reader.vm.updateColor('primary', '#888888')
    clock.advance(800)
    expect(JSON.parse(hub.read(DRAFT_STORAGE_KEY) as string).document.tokens.primary).toBe('#888888')
  })

  it('promotes a reader when the owner crashes (stale heartbeat)', () => {
    const hub = new SharedStorageHub()
    const clock = new ManualClock()
    const owner = openTab(hub, clock, 'session-aaa')
    const reader = openTab(hub, clock, 'session-bbb')
    owner.vm.updateColor('primary', '#556677')
    clock.advance(800)
    // Owner process dies. Reader only advances its own clock-driven timers.
    owner.vm.kill()
    clock.advance(6_000 + 1_500 + 50)
    expect(reader.coordinator.getRole()).toBe('owner')
  })
})
