import type { BrandMirrorViewModel } from '../viewmodels/brandMirrorViewModel'
import { useBrandMirrorViewModel } from '../hooks/useBrandMirrorViewModel'
import { ComponentGallery } from '../preview-gallery/ComponentGallery'
import { PageGallery } from '../preview-gallery/PageGallery'
import { TokenControls } from '../token-editor/TokenControls'
import { TokenExplorer } from '../token-search/TokenExplorer'
import { VersionCompare } from '../versioning/VersionCompare'
import { WorkspaceOverlays, formatTime } from '../workspace/WorkspaceOverlays'

export function BrandMirrorPage({ viewModel }: { viewModel: BrandMirrorViewModel }) {
  const snapshot = useBrandMirrorViewModel(viewModel)
  const readOnly = snapshot.role === 'viewer' || !!snapshot.conflict
  return (
    <div className="app-shell">
      <WorkspaceOverlays
        snapshot={snapshot}
        onTakeover={() => viewModel.requestTakeover()}
        onResolveConflict={(choice) => viewModel.resolveConflict(choice)}
        onRecoverDraft={(choice) => viewModel.recoverDraft(choice)}
      />
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark">✦</span><span>BrandMirror</span><span className="brand-subtitle">品牌视觉实验室</span></div>
        <div className="topbar-right">
          <span className={`save-state ${snapshot.savePhase} ${readOnly ? 'readonly' : ''}`}><span className="live-dot" />{saveLabel(snapshot)}</span>
          <span className="avatar-small">M</span>
        </div>
      </header>
      <main className="workspace">
        <div>
          <TokenControls
            snapshot={snapshot}
            readOnly={readOnly}
            onThemeChange={(theme) => viewModel.selectTheme(theme)}
            onColorChange={(field, value) => viewModel.updateColor(field, value)}
            onScaleChange={(field, index, value) => viewModel.updateScale(field, index, value)}
            onReset={() => viewModel.reset()}
          />
          <TokenExplorer tokens={snapshot.tokens} />
        </div>
        <div className="preview-area">
          <div className="hero-heading">
            <div>
              <span className="eyebrow">BRAND SYSTEM / 2024</span>
              <h1>一套令牌，<em>无限可能。</em></h1>
              <p>调整左侧令牌，观察它们如何在不同组件和页面中保持一致。</p>
            </div>
            <div className="feedback-toast"><span className="toast-icon">✦</span><span><strong>{snapshot.message || '准备开始探索'}</strong><small>实时视觉反馈</small></span></div>
          </div>
          <ComponentGallery tokens={snapshot.tokens} />
          <PageGallery tokens={snapshot.tokens} />
          <VersionCompare snapshot={snapshot} readOnly={readOnly} onSave={() => viewModel.saveVersion()} onToggle={() => viewModel.toggleCompare()} onExport={() => viewModel.exportBrandGuidelines()} />
        </div>
      </main>
      <footer className="bottom-status"><span><span className="live-dot" />{snapshot.role === 'viewer' ? '只读预览 · 编辑权在另一个页面' : '已连接到本地工作区'}</span><span>BrandMirror v0.1 <span className="footer-sep">·</span> 本地优先 · 自动保存</span></footer>
    </div>
  )
}

function saveLabel(snapshot: ReturnType<BrandMirrorViewModel['getSnapshot']>): string {
  if (snapshot.conflict) return '自动保存已暂停 · 等待冲突处理'
  switch (snapshot.role) {
    case 'starting':
      return '正在连接本地工作区…'
    case 'viewer':
      return '只读 · 另一页面编辑中'
    default:
      break
  }
  switch (snapshot.savePhase) {
    case 'pending':
      return '编辑中 · 将自动保存'
    case 'saving':
      return '正在保存…'
    case 'error':
      return '自动保存未完成'
    case 'saved':
      return snapshot.savedAt ? `已于 ${formatTime(snapshot.savedAt)} 自动保存` : '所有更改已保存'
    default:
      return '所有更改已保存'
  }
}
