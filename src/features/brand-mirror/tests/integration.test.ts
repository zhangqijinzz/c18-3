// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { LocalBrandRepository } from '../repositories/brandRepository'
import { LocalStorageService, DOCUMENT_STORAGE_KEY, DRAFT_STORAGE_KEY } from '../services/storageService'
import { createDefaultWorkspaceChannel } from '../services/workspaceChannel'
import { WorkspacePersistence } from '../services/workspacePersistence'
import { BrandMirrorViewModel } from '../viewmodels/brandMirrorViewModel'
import type { BrandDocument } from '../models/brandMirrorModels'
import { INITIAL_TOKENS } from '../models/brandMirrorModels'

function makeDocument(primary: string): BrandDocument {
  return { version: 1, tokens: { ...INITIAL_TOKENS, primary }, theme: 'studio', versions: [] }
}

function createRealStack(sessionId: string) {
  const storage = new LocalStorageService()
  const persistence = new WorkspacePersistence({
    repository: new LocalBrandRepository(storage),
    channel: createDefaultWorkspaceChannel(storage),
    sessionId,
  })
  const viewModel = new BrandMirrorViewModel(persistence)
  viewModel.initialize()
  return { viewModel, persistence, storage }
}

describe('真实浏览器环境集成（localStorage + BroadcastChannel）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('编辑后自动写入文档与草稿 key，落盘后清草稿', async () => {
    const { viewModel, persistence, storage } = createRealStack('session-a')
    // 等选举窗口（200ms）
    await wait(260)
    expect(persistence.getState().role).toBe('owner')

    viewModel.updateColor('primary', '#123456')
    // 草稿防抖 300ms
    await wait(320)
    expect(storage.read(DRAFT_STORAGE_KEY)).toContain('#123456')
    // 自动落盘防抖 900ms
    await wait(650)
    expect(storage.read(DOCUMENT_STORAGE_KEY)).toContain('#123456')
    expect(storage.read(DRAFT_STORAGE_KEY)).toBeNull()
    persistence.dispose()
  })

  it('异常关闭遗留草稿，重开提示恢复并能找回', async () => {
    {
      const { viewModel, persistence } = createRealStack('session-dead')
      await wait(260)
      viewModel.updateColor('primary', '#ABCDEF')
      await wait(320) // 草稿已写、自动落盘未触发
      persistence.dispose() // 不经过 pagehide，模拟崩溃
    }

    const reopened = createRealStack('session-alive')
    await wait(260)
    expect(reopened.viewModel.getSnapshot().recovery?.tokens.primary).toBe('#ABCDEF')
    reopened.viewModel.recoverDraft('recover')
    expect(reopened.viewModel.getSnapshot().tokens.primary).toBe('#ABCDEF')
    reopened.persistence.dispose()
  })

  it('v1 旧版本数据能平滑读取', async () => {
    localStorage.setItem('brandmirror.document.v1', JSON.stringify(makeDocument('#777777')))
    const { persistence, storage } = createRealStack('session-a')
    await wait(260)
    expect(persistence.getDocument().tokens.primary).toBe('#777777')
    persistence.setEdited(makeDocument('#888888'))
    await wait(950)
    expect(storage.read(DOCUMENT_STORAGE_KEY)).toContain('#888888')
    persistence.dispose()
  })

  it('两个标签页通过 BroadcastChannel 协调：后者只读，接管后前者降级', async () => {
    const first = createRealStack('session-aaaa')
    await wait(260)
    first.viewModel.updateColor('primary', '#123456')
    await wait(950)

    const second = createRealStack('session-bbbb')
    await wait(260)
    expect(second.persistence.getState().role).toBe('viewer')
    expect(second.persistence.canEdit()).toBe(false)
    expect(second.viewModel.getSnapshot().tokens.primary).toBe('#123456')

    // 只读页面的编辑被拒绝
    second.viewModel.updateColor('primary', '#FFFFFF')
    expect(second.viewModel.getSnapshot().tokens.primary).toBe('#123456')

    // 显式接管：owner 先落盘再交接
    second.viewModel.requestTakeover()
    await wait(50)
    expect(second.persistence.getState().role).toBe('owner')
    expect(first.persistence.getState().role).toBe('viewer')
    second.viewModel.updateColor('primary', '#ABCDEF')
    await wait(950)
    expect(first.viewModel.getSnapshot().tokens.primary).toBe('#ABCDEF')

    first.persistence.dispose()
    second.persistence.dispose()
  })
})

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
