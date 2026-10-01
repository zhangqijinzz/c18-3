export const DOCUMENT_STORAGE_KEY = 'brandmirror.document.v2'
export const DRAFT_STORAGE_KEY = 'brandmirror.draft.v1'
export const LEGACY_DOCUMENT_STORAGE_KEY = 'brandmirror.document.v1'
export const CHANNEL_STORAGE_KEY = 'brandmirror.channel.v1'

export interface StorageService {
  read(key: string): string | null
  write(key: string, value: string): void
  remove(key: string): void
  keys(): string[]
}

export class LocalStorageService implements StorageService {
  read(key: string): string | null {
    return window.localStorage.getItem(key)
  }

  write(key: string, value: string): void {
    window.localStorage.setItem(key, value)
  }

  remove(key: string): void {
    window.localStorage.removeItem(key)
  }

  keys(): string[] {
    return Object.keys(window.localStorage)
  }
}
