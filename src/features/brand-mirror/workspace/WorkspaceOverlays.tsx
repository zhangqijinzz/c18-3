import type { BrandMirrorSnapshot } from '../models/brandMirrorModels'

interface WorkspaceOverlaysProps {
  snapshot: BrandMirrorSnapshot
  onTakeover: () => void
  onResolveConflict: (choice: 'local' | 'remote') => void
  onRecoverDraft: (choice: 'recover' | 'discard') => void
}

export function WorkspaceOverlays({ snapshot, onTakeover, onResolveConflict, onRecoverDraft }: WorkspaceOverlaysProps) {
  return (
    <>
      {snapshot.role === 'viewer' && !snapshot.conflict && (
        <div className="workspace-banner" role="status">
          <span className="banner-icon">◔</span>
          <div className="banner-copy">
            <strong>同一份工作区正在另一个页面中编辑</strong>
            <small>本页为只读预览，会实时同步那边的更改。自动保存已暂停，不会覆盖对方的内容。</small>
          </div>
          <button className="banner-button" type="button" onClick={onTakeover}>接管此页面的编辑</button>
        </div>
      )}
      {snapshot.savePhase === 'error' && !snapshot.conflict && (
        <div className="workspace-banner warning" role="alert">
          <span className="banner-icon">!</span>
          <div className="banner-copy">
            <strong>自动保存失败</strong>
            <small>当前改动仍保留在页面中，请检查浏览器存储权限后继续编辑，系统会自动重试。</small>
          </div>
        </div>
      )}

      {snapshot.recovery && <RecoveryDialog draftAt={snapshot.recovery.draftAt} committedAt={snapshot.recovery.committedAt} onChoose={onRecoverDraft} />}
      {snapshot.conflict && (
        <ConflictDialog
          local={{ tokens: snapshot.conflict.localTokens, theme: snapshot.conflict.localTheme, updatedAt: snapshot.conflict.localUpdatedAt, sessionId: snapshot.ownerSessionId ?? '' }}
          remote={{ tokens: snapshot.conflict.remoteTokens, theme: snapshot.conflict.remoteTheme, updatedAt: snapshot.conflict.remoteUpdatedAt, sessionId: snapshot.conflict.remoteSessionId }}
          onChoose={onResolveConflict}
        />
      )}
    </>
  )
}

function RecoveryDialog({ draftAt, committedAt, onChoose }: { draftAt: number; committedAt: number | null; onChoose: (choice: 'recover' | 'discard') => void }) {
  return (
    <div className="overlay-backdrop" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <div className="overlay-card">
        <span className="overlay-eyebrow">崩溃恢复</span>
        <h3 id="recovery-title">找回上次未保存的草稿？</h3>
        <p>
          这份工作区上次是异常关闭的，本地留有一份{` `}
          <strong>{formatTime(draftAt)}</strong> 的草稿
          {committedAt ? <>，比最近一次正式保存（{formatTime(committedAt)}）更新</> : '，此前没有正式保存过'}。
          恢复后可以继续编辑，稍后会自动落盘；丢弃则以最近保存的内容为准。
        </p>
        <div className="overlay-actions">
          <button className="primary-button" type="button" onClick={() => onChoose('recover')}>恢复草稿</button>
          <button className="secondary-button" type="button" onClick={() => onChoose('discard')}>丢弃草稿</button>
        </div>
      </div>
    </div>
  )
}

interface ConflictSide {
  tokens: BrandMirrorSnapshot['tokens']
  theme: BrandMirrorSnapshot['theme']
  updatedAt: number
  sessionId: string
}

function ConflictDialog({ local, remote, onChoose }: { local: ConflictSide; remote: ConflictSide; onChoose: (choice: 'local' | 'remote') => void }) {
  return (
    <div className="overlay-backdrop" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div className="overlay-card wide">
        <span className="overlay-eyebrow">编辑冲突</span>
        <h3 id="conflict-title">两个页面同时修改了这份工作区</h3>
        <p>
          检测到另一个页面已经先一步保存了不同内容。为避免任何一方的工作被抹掉，两个页面的自动保存都已暂停。
          请选择要保留哪一份，另一份未保存的改动将无法找回；被关闭编辑权的页面会同步最终结果。
        </p>
        <div className="conflict-cards">
          <ConflictChoice
            tag="本页面"
            time={local.updatedAt}
            tokens={local.tokens}
            theme={local.theme}
            actionLabel="保留本页内容"
            onChoose={() => onChoose('local')}
          />
          <ConflictChoice
            tag={`另一个页面 ${shortSession(remote.sessionId)}`}
            time={remote.updatedAt}
            tokens={remote.tokens}
            theme={remote.theme}
            actionLabel="保留另一页内容"
            onChoose={() => onChoose('remote')}
          />
        </div>
      </div>
    </div>
  )
}

function ConflictChoice({ tag, time, tokens, theme, actionLabel, onChoose }: { tag: string; time: number; tokens: BrandMirrorSnapshot['tokens']; theme: BrandMirrorSnapshot['theme']; actionLabel: string; onChoose: () => void }) {
  return (
    <div className="conflict-choice">
      <div className="conflict-choice-head">
        <strong>{tag}</strong>
        <small>{formatTime(time)}</small>
      </div>
      <div className="conflict-swatches">
        <span style={{ background: tokens.primary }} title="主色" />
        <span style={{ background: tokens.secondary }} title="辅助色" />
      </div>
      <dl className="conflict-meta">
        <div><dt>主题</dt><dd>{theme}</dd></div>
        <div><dt>主色</dt><dd>{tokens.primary}</dd></div>
        <div><dt>辅助色</dt><dd>{tokens.secondary}</dd></div>
        <div><dt>圆角尺度</dt><dd>{tokens.radiusScale.join(' / ')}</dd></div>
        <div><dt>字体比例</dt><dd>{tokens.typeScale.join(' / ')}</dd></div>
      </dl>
      <button className="primary-button" type="button" onClick={onChoose}>{actionLabel}</button>
    </div>
  )
}

export function formatTime(value: number): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function shortSession(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(0, 4)
}
