export const DOCUMENT_STORAGE_KEY = 'brandmirror.document.v1'
export const DRAFT_STORAGE_KEY = 'brandmirror.draft.v1'
export const SESSIONS_STORAGE_KEY = 'brandmirror.sessions.v1'

export type StorageListener = (key: string, value: string | null) => void

export interface StorageService {
  read(key: string): string | null
  write(key: string, value: string): void
  remove(key: string): void
  /** Notified when a *different* tab changes a tracked key. */
  subscribe(listener: StorageListener): () => void
}

export class LocalStorageService implements StorageService {
  private listeners = new Set<StorageListener>()
  private detach?: () => void

  read(key: string): string | null {
    return window.localStorage.getItem(key)
  }

  write(key: string, value: string): void {
    window.localStorage.setItem(key, value)
  }

  remove(key: string): void {
    window.localStorage.removeItem(key)
  }

  subscribe(listener: StorageListener): () => void {
    if (this.listeners.size === 0) this.attach()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.detach?.()
    }
  }

  private attach(): void {
    const onStorage = (event: StorageEvent): void => {
      if (!event.key) return
      this.listeners.forEach((listener) => listener(event.key as string, event.newValue))
    }
    window.addEventListener('storage', onStorage)
    this.detach = () => window.removeEventListener('storage', onStorage)
  }
}

/** Backed by a map that can be shared across "tabs" in tests. */
export class MemoryStorageService implements StorageService {
  private listeners = new Set<StorageListener>()

  constructor(private readonly map: Map<string, string> = new Map()) {}

  read(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  write(key: string, value: string): void {
    this.map.set(key, value)
  }

  remove(key: string): void {
    this.map.delete(key)
  }

  subscribe(listener: StorageListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Simulate another tab persisting a change. */
  emitRemote(key: string, value: string | null): void {
    this.listeners.forEach((listener) => listener(key, value))
  }
}
