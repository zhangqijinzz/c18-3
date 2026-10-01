export interface Clock {
  now(): number
  setInterval(handler: () => void, timeout: number): number
  clearInterval(handle: number): void
  setTimeout(handler: () => void, timeout: number): number
  clearTimeout(handle: number): void
  /** Fires when the page is hidden or unloaded, i.e. the last reliable flush points. */
  onUnload(handler: () => void): () => void
}

export function createBrowserClock(): Clock {
  return {
    now: () => Date.now(),
    setInterval: (handler, timeout) => window.setInterval(handler, timeout),
    clearInterval: (handle) => window.clearInterval(handle),
    setTimeout: (handler, timeout) => window.setTimeout(handler, timeout),
    clearTimeout: (handle) => window.clearTimeout(handle),
    onUnload(handler) {
      const onVisibility = (): void => {
        if (document.visibilityState === 'hidden') handler()
      }
      const onPageHide = (): void => handler()
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('pagehide', onPageHide)
      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pagehide', onPageHide)
      }
    },
  }
}

interface PendingTimer {
  id: number
  fn: () => void
  period: number
  nextAt: number
  repeat: boolean
}

/** Deterministic clock for tests: time only moves when `advance` is called. */
export class ManualClock implements Clock {
  private time = 0
  private nextId = 1
  private timers = new Set<PendingTimer>()
  private unloadHandlers: (() => void)[] = []

  now(): number {
    return this.time
  }

  setTime(value: number): void {
    this.time = value
  }

  setInterval(handler: () => void, timeout: number): number {
    const timer: PendingTimer = { id: this.nextId++, fn: handler, period: timeout, nextAt: this.time + timeout, repeat: true }
    this.timers.add(timer)
    return timer.id
  }

  setTimeout(handler: () => void, timeout: number): number {
    const timer: PendingTimer = { id: this.nextId++, fn: handler, period: timeout, nextAt: this.time + timeout, repeat: false }
    this.timers.add(timer)
    return timer.id
  }

  clearInterval(handle: number): void {
    this.clear(handle)
  }

  clearTimeout(handle: number): void {
    this.clear(handle)
  }

  advance(ms: number): void {
    const target = this.time + ms
    const guard = { iterations: 0 }
    let due = this.nextDue(target)
    while (due) {
      if (guard.iterations++ > 10000) throw new Error('ManualClock: timer loop did not settle')
      this.time = due.nextAt
      if (due.repeat) due.nextAt = this.time + due.period
      else this.timers.delete(due)
      due.fn()
      due = this.nextDue(target)
    }
    this.time = target
  }

  triggerUnload(): void {
    this.unloadHandlers.forEach((handler) => handler())
  }

  onUnload(handler: () => void): () => void {
    this.unloadHandlers.push(handler)
    return () => {
      this.unloadHandlers = this.unloadHandlers.filter((candidate) => candidate !== handler)
    }
  }

  private clear(id: number): void {
    for (const timer of this.timers) {
      if (timer.id === id) {
        this.timers.delete(timer)
        return
      }
    }
  }

  private nextDue(target: number): PendingTimer | null {
    let winner: PendingTimer | null = null
    for (const timer of this.timers) {
      if (timer.nextAt <= target && (!winner || timer.nextAt < winner.nextAt)) winner = timer
    }
    return winner
  }
}
