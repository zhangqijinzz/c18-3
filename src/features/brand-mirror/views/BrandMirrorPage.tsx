import type { BrandMirrorViewModel } from '../viewmodels/brandMirrorViewModel'
import { useBrandMirrorViewModel } from '../hooks/useBrandMirrorViewModel'
import { ComponentGallery } from '../preview-gallery/ComponentGallery'
import { PageGallery } from '../preview-gallery/PageGallery'
import { TokenControls } from '../token-editor/TokenControls'
import { TokenExplorer } from '../token-search/TokenExplorer'
import { VersionCompare } from '../versioning/VersionCompare'
import { ConflictDialog } from '../conflict/ConflictDialog'
import { ReadonlyNotice } from '../conflict/ReadonlyNotice'
import { DraftRecoveryBanner } from '../recovery/DraftRecoveryBanner'

function saveLabel(snapshot: ReturnType<BrandMirrorViewModel['getSnapshot']>): string {
  if (snapshot.status === 'conflict') return '已暂停自动保存 · 等待处理冲突'
  if (!snapshot.canEdit) return '只读模式 · 另一个页面正在编辑'
  if (snapshot.saveState === 'saving') return '正在自动保存…'
  if (snapshot.saveState === 'offline') return '本地保存需检查'
  if (snapshot.saveState === 'saved') return '所有更改已自动保存'
  return snapshot.status === 'error' ? '本地保存需检查' : '所有更改已保存'
}

export function BrandMirrorPage({ viewModel }: { viewModel: BrandMirrorViewModel }) {
  const snapshot = useBrandMirrorViewModel(viewModel)
  const remote = snapshot.conflict?.remoteDocument
  return <div className="app-shell"><header className="topbar"><div className="brand-lockup"><span className="brand-mark">✦</span><span>BrandMirror</span><span className="brand-subtitle">品牌视觉实验室</span></div><div className="topbar-right"><span className={`save-state ${snapshot.status === 'conflict' ? 'save-state-warning' : ''}`}><span className={`live-dot ${snapshot.saveState === 'saving' ? 'live-dot-busy' : snapshot.canEdit ? '' : 'live-dot-idle'}`} />{saveLabel(snapshot)}</span><span className="avatar-small">M</span></div></header>
    <DraftRecoveryBanner snapshot={snapshot} onKeep={() => viewModel.keepRecoveredDraft()} onDiscard={() => viewModel.discardRecoveredDraft()} />
    <ReadonlyNotice snapshot={snapshot} onTakeOver={() => viewModel.requestTakeOver()} />
    <main className="workspace"><div><TokenControls snapshot={snapshot} canEdit={snapshot.canEdit} onThemeChange={(theme) => viewModel.selectTheme(theme)} onColorChange={(field, value) => viewModel.updateColor(field, value)} onScaleChange={(field, index, value) => viewModel.updateScale(field, index, value)} onReset={() => viewModel.reset()} /><TokenExplorer tokens={snapshot.tokens} /></div><div className="preview-area"><div className="hero-heading"><div><span className="eyebrow">BRAND SYSTEM / 2024</span><h1>一套令牌，<em>无限可能。</em></h1><p>调整左侧令牌，观察它们如何在不同组件和页面中保持一致。</p></div><div className="feedback-toast"><span className="toast-icon">✦</span><span><strong>{snapshot.message || '准备开始探索'}</strong><small>{snapshot.canEdit ? '实时视觉反馈' : '只读浏览中'}</small></span></div></div><ComponentGallery tokens={snapshot.tokens} /><PageGallery tokens={snapshot.tokens} /><VersionCompare snapshot={snapshot} canEdit={snapshot.canEdit} onSave={() => viewModel.saveVersion()} onToggle={() => viewModel.toggleCompare()} onExport={() => viewModel.exportBrandGuidelines()} /></div></main><footer className="bottom-status"><span><span className={`live-dot ${snapshot.canEdit ? '' : 'live-dot-idle'}`} />{snapshot.canEdit ? '已连接到本地工作区' : `正在查看页面 ${snapshot.ownerLabel ?? ''} 的工作区`}</span><span>BrandMirror v0.1 <span className="footer-sep">·</span> 本地优先 · 自动保存</span></footer>
    {snapshot.conflict && remote && (
      <ConflictDialog snapshot={snapshot} onKeepMine={() => viewModel.resolveKeepMine()} onKeepTheirs={() => viewModel.resolveKeepTheirs(remote)} onKeepBrowsing={() => viewModel.resolveKeepBrowsing(remote)} />
    )}
  </div>
}
