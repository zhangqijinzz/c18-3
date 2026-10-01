import type { BrandMirrorSnapshot } from '../models/brandMirrorModels'

interface ReadonlyNoticeProps {
  snapshot: BrandMirrorSnapshot
  onTakeOver: () => void
}

/** Non-blocking bar shown while another tab owns the workspace. */
export function ReadonlyNotice({ snapshot, onTakeOver }: ReadonlyNoticeProps) {
  if (snapshot.canEdit || snapshot.conflict || snapshot.draftRecovery) return null
  return (
    <div className="readonly-banner" role="status">
      <span className="readonly-icon">🔒</span>
      <div className="readonly-copy">
        <strong>只读模式{snapshot.ownerLabel ? ` · 编辑来自页面 ${snapshot.ownerLabel}` : ''}</strong>
        <small>另一个页面正在编辑这份工作区，你看到的内容会随它实时更新。接管前本页不会修改任何内容。</small>
      </div>
      <button className="secondary-button" type="button" onClick={onTakeOver}>接管并在此编辑</button>
    </div>
  )
}
