const STORAGE_KEY = 'brandmirror.document.v1'

export interface StorageService {
  read(): string | null
  write(value: string): void
}

export class LocalStorageService implements StorageService {
  read(): string | null {
    return window.localStorage.getItem(STORAGE_KEY)
  }

  write(value: string): void {
    window.localStorage.setItem(STORAGE_KEY, value)
  }
}
