import { cloneTokens } from '../domain/brandRules'
import type { BrandDocument, BrandMirrorSnapshot } from '../models/brandMirrorModels'

interface ConflictDialogProps {
  snapshot: BrandMirrorSnapshot
  onKeepMine: () => void
  onKeepTheirs: () => void
  onKeepBrowsing: () => void
}

function describeSide(document: BrandDocument): { colors: string; scales: string; versions: number } {
  const tokens = cloneTokens(document.tokens)
  return {
    colors: `${tokens.primary} / ${tokens.secondary}`,
    scales: `圆角 ${tokens.radiusScale[2]} · 字号 ${tokens.typeScale[2]}`,
    versions: document.versions.length,
  }
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function ConflictDialog({ snapshot, onKeepMine, onKeepTheirs, onKeepBrowsing }: ConflictDialogProps) {
  const conflict = snapshot.conflict
  if (!conflict) return null
  const mine = describeSide({ version: 1, tokens: snapshot.tokens, theme: snapshot.theme, versions: snapshot.versions })
  const theirs = describeSide(conflict.remoteDocument)
  const demoted = conflict.reason === 'demoted-dirty'

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <div className="conflict-head">
          <span className="conflict-icon">⚠</span>
          <div>
            <span className="eyebrow">WORKSPACE CONFLICT</span>
            <h2 id="conflict-title">同一份工作区在两个页面中被编辑</h2>
          </div>
        </div>

        <p className="conflict-explain">
          {demoted
            ? '另一个页面刚接管了这份工作区。你在本页的改动还没有写入，两边内容已经不同。在你做出选择之前，任何一个页面都不会覆盖对方的内容。'
            : '检测到另一个页面保存的内容与本页不同。在你做出选择之前，本页已暂停自动保存，不会覆盖对方的工作区。'}
        </p>

        <div className="conflict-sides">
          <article className="conflict-side mine">
            <header><strong>本页内容</strong><small>{demoted ? '未保存' : '当前显示'}</small></header>
            <div className="conflict-swatches">
              <span style={{ background: snapshot.tokens.primary }} />
              <span style={{ background: snapshot.tokens.secondary }} />
            </div>
            <dl>
              <dt>配色</dt><dd>{mine.colors}</dd>
              <dt>尺度</dt><dd>{mine.scales}</dd>
              <dt>已存版本</dt><dd>{mine.versions} 个</dd>
            </dl>
          </article>

          <span className="conflict-vs">VS</span>

          <article className="conflict-side theirs">
            <header>
              <strong>另一个页面</strong>
              <small>更新于 {formatTime(conflict.remoteUpdatedAt)}</small>
            </header>
            <div className="conflict-swatches">
              <span style={{ background: conflict.remoteDocument.tokens.primary }} />
              <span style={{ background: conflict.remoteDocument.tokens.secondary }} />
            </div>
            <dl>
              <dt>配色</dt><dd>{theirs.colors}</dd>
              <dt>尺度</dt><dd>{theirs.scales}</dd>
              <dt>已存版本</dt><dd>{theirs.versions} 个</dd>
            </dl>
          </article>
        </div>

        <div className="conflict-actions">
          <button className="primary-button" type="button" onClick={onKeepMine}>保留本页内容并接管</button>
          <button className="secondary-button" type="button" onClick={onKeepTheirs}>采用另一个页面</button>
          <button className="text-button" type="button" onClick={onKeepBrowsing}>只读浏览，暂不决定</button>
        </div>
        <p className="conflict-hint">点击之前不会覆盖任何一方；做出选择后，另一个页面会收到通知并切换为只读。</p>
      </div>
    </div>
  )
}
