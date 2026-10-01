import type { BrandMirrorSnapshot } from '../models/brandMirrorModels'

interface DraftRecoveryBannerProps {
  snapshot: BrandMirrorSnapshot
  onKeep: () => void
  onDiscard: () => void
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/** Shown after a crash or unexpected close: confirm before adopting the draft. */
export function DraftRecoveryBanner({ snapshot, onKeep, onDiscard }: DraftRecoveryBannerProps) {
  const recovery = snapshot.draftRecovery
  if (!recovery) return null
  return (
    <div className="recovery-banner" role="status">
      <span className="recovery-icon">↺</span>
      <div className="recovery-copy">
        <strong>找到未保存的草稿</strong>
        <small>页面似乎在编辑过程中被关闭（自动保存于 {formatTime(recovery.updatedAt)}）。当前显示的就是这份草稿，请确认保留或丢弃。</small>
      </div>
      <div className="recovery-actions">
        <button className="primary-button" type="button" onClick={onKeep}>保留草稿</button>
        <button className="text-button" type="button" onClick={onDiscard}>丢弃，回到已保存版本</button>
      </div>
    </div>
  )
}
