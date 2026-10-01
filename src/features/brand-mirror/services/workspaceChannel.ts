import { CHANNEL_STORAGE_KEY } from './storageService'
import type { StorageService } from './storageService'

export type WorkspaceSignalType =
  | 'hello'
  | 'heartbeat'
  | 'bye'
  | 'takeover-request'
  | 'takeover-grant'
  | 'takeover-deny'
  | 'conflict-detected'
  | 'conflict-resolved'

export interface WorkspaceSignal {
  type: WorkspaceSignalType
  from: string
  to?: string
  /** 信号发出方当前持有的修订号 */
  revision: number
  /** 最近一次编辑时间，冲突界面展示用 */
  updatedAt: number
  /** heartbeat / takeover-grant / conflict-resolved 时附带的文档，供落后页面同步 */
  document?: import('../models/brandMirrorModels').BrandDocument
  /** conflict-resolved：最终保留内容属于哪个页面 */
  winnerSessionId?: string
  /** takeover-deny 等场景的说明 */
  reason?: string
}

export interface WorkspaceChannel {
  post(signal: WorkspaceSignal): void
  onMessage(listener: (signal: WorkspaceSignal) => void): () => void
  dispose(): void
}

/** 同源其他标签页触发的 storage 变更（localStorage 不回传给出现在发起的页面） */
export interface StorageReaction {
  onStorageChange(listener: (key: string) => void): () => void
}

export class BroadcastWorkspaceChannel implements WorkspaceChannel {
  private readonly channel: BroadcastChannel
  private readonly listeners = new Set<(signal: WorkspaceSignal) => void>()

  constructor(name = 'brandmirror.workspace.v1') {
    this.channel = new BroadcastChannel(name)
    this.channel.onmessage = (event: MessageEvent<WorkspaceSignal>) => {
      this.listeners.forEach((listener) => listener(event.data))
    }
  }

  post(signal: WorkspaceSignal): void {
    this.channel.postMessage(signal)
  }

  onMessage(listener: (signal: WorkspaceSignal) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.channel.close()
    this.listeners.clear()
  }
}

/** 不支持 BroadcastChannel 时，用 localStorage 写入 + storage 事件实现单向广播 */
export class StorageWorkspaceChannel implements WorkspaceChannel {
  private readonly listeners = new Set<(signal: WorkspaceSignal) => void>()
  private readonly offStorageChange: () => void

  constructor(
    private readonly storage: StorageService,
    private readonly reaction: StorageReaction = browserStorageReaction(),
  ) {
    this.offStorageChange = this.reaction.onStorageChange((key) => {
      if (key !== CHANNEL_STORAGE_KEY) return
      const raw = this.storage.read(CHANNEL_STORAGE_KEY)
      if (!raw) return
      try {
        const signal = JSON.parse(raw) as WorkspaceSignal
        // storage 事件天然只在其他标签页触发，不会自发自收
        this.listeners.forEach((listener) => listener(signal))
      } catch {
        // 写入中的半截数据，忽略
      }
    })
  }

  post(signal: WorkspaceSignal): void {
    this.storage.write(CHANNEL_STORAGE_KEY, JSON.stringify(signal))
  }

  onMessage(listener: (signal: WorkspaceSignal) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.offStorageChange()
    this.listeners.clear()
  }
}

export function browserStorageReaction(): StorageReaction {
  return {
    onStorageChange(listener) {
      const handler = (event: StorageEvent): void => {
        if (event.key) listener(event.key)
      }
      window.addEventListener('storage', handler)
      return () => window.removeEventListener('storage', handler)
    },
  }
}

export function createDefaultWorkspaceChannel(storage: StorageService): WorkspaceChannel {
  if (typeof BroadcastChannel !== 'undefined') return new BroadcastWorkspaceChannel()
  return new StorageWorkspaceChannel(storage)
}
