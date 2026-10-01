import type { WorkspaceChannel, WorkspaceSignal } from '../services/workspaceChannel'
import type { PersistenceClock, PersistenceLifecycle } from '../services/workspacePersistence'

/** 同进程内模拟多个标签页共享的 BroadcastChannel */
export class MemoryBus {
  private readonly channels = new Set<MemoryChannel>()

  connect(): MemoryChannel {
    return new MemoryChannel(this)
  }

  register(channel: MemoryChannel): void {
    this.channels.add(channel)
  }

  disconnect(channel: MemoryChannel): void {
    this.channels.delete(channel)
  }

  dispatch(sender: MemoryChannel, signal: WorkspaceSignal): void {
    this.channels.forEach((channel) => {
      if (channel !== sender) channel.deliver(signal)
    })
  }
}

export class MemoryChannel implements WorkspaceChannel {
  private readonly listeners = new Set<(signal: WorkspaceSignal) => void>()

  constructor(private readonly bus: MemoryBus) {
    bus.register(this)
  }

  post(signal: WorkspaceSignal): void {
    this.bus.dispatch(this, signal)
  }

  deliver(signal: WorkspaceSignal): void {
    this.listeners.forEach((listener) => listener(signal))
  }

  onMessage(listener: (signal: WorkspaceSignal) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.bus.disconnect(this)
    this.listeners.clear()
  }
}

interface TimerEntry {
  id: ReturnType<typeof setTimeout>
  runAt: number
  callback: () => void
  interval: number | null
}

/** 手动推进的时钟，避免测试依赖真实定时器 */
export class ManualClock implements PersistenceClock {
  private nowValue: number
  private nextId = 1
  private readonly timers = new Map<number, TimerEntry>()

  constructor(startAt = 1_000_000) {
    this.nowValue = startAt
  }

  now(): number {
    return this.nowValue
  }

  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++
    this.timers.set(id, { id: id as unknown as ReturnType<typeof setTimeout>, runAt: this.nowValue + delay, callback, interval: null })
    return id as unknown as ReturnType<typeof setTimeout>
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number)
  }

  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval> {
    const id = this.nextId++
    this.timers.set(id, { id: id as unknown as ReturnType<typeof setTimeout>, runAt: this.nowValue + delay, callback, interval: delay })
    return id as unknown as ReturnType<typeof setInterval>
  }

  clearInterval(handle: ReturnType<typeof setInterval>): void {
    this.timers.delete(handle as unknown as number)
  }

  advance(ms: number): void {
    const target = this.nowValue + ms

    let due = [...this.timers.values()].filter((entry) => entry.runAt <= target).sort((a, b) => a.runAt - b.runAt)
    while (due.length > 0) {
      const first = due[0]
      this.nowValue = first.runAt
      if (first.interval !== null) {
        first.runAt = this.nowValue + first.interval
      } else {
        this.timers.delete(first.id as unknown as number)
      }
      first.callback()
      due = [...this.timers.values()].filter((entry) => entry.runAt <= target).sort((a, b) => a.runAt - b.runAt)
    }
    this.nowValue = target
  }
}

export class ManualLifecycle implements PersistenceLifecycle {
  private hideListeners = new Set<() => void>()
  private hiddenListeners = new Set<() => void>()

  onPageHide(callback: () => void): () => void {
    this.hideListeners.add(callback)
    return () => this.hideListeners.delete(callback)
  }

  onPageHidden(callback: () => void): () => void {
    this.hiddenListeners.add(callback)
    return () => this.hiddenListeners.delete(callback)
  }

  firePageHide(): void {
    this.hideListeners.forEach((listener) => listener())
  }

  fireHidden(): void {
    this.hiddenListeners.forEach((listener) => listener())
  }
}
