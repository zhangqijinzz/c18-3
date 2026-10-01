import type { BrandMirrorSnapshot, BrandTheme } from '../models/brandMirrorModels'

interface TokenControlsProps {
  snapshot: BrandMirrorSnapshot
  readOnly?: boolean
  onThemeChange: (theme: BrandTheme) => void
  onColorChange: (field: 'primary' | 'secondary', value: string) => void
  onScaleChange: (field: 'radiusScale' | 'spacingScale' | 'typeScale', index: number, value: number) => void
  onReset: () => void
}

const themes: { id: BrandTheme; label: string; note: string }[] = [
  { id: 'studio', label: 'Studio warm', note: '热烈 · 友好' },
  { id: 'editorial', label: 'Editorial green', note: '克制 · 自然' },
  { id: 'night', label: 'Night signal', note: '锐利 · 数字' },
]

export function TokenControls({ snapshot, readOnly = false, onThemeChange, onColorChange, onScaleChange, onReset }: TokenControlsProps) {
  return (
    <aside className={`control-panel ${readOnly ? 'readonly' : ''}`}>
      <div className="panel-heading">
        <div>
          <span className="eyebrow">01 / TOKENS</span>
          <h2>视觉令牌</h2>
        </div>
        <button className="text-button" type="button" disabled={readOnly} onClick={onReset}>恢复默认</button>
      </div>

      <section className="control-section">
        <div className="section-label"><span>基础主题</span><span className="muted">快速起点</span></div>
        <div className="theme-list">
          {themes.map((theme) => (
            <button className={`theme-option ${snapshot.theme === theme.id ? 'selected' : ''}`} key={theme.id} disabled={readOnly} onClick={() => onThemeChange(theme.id)} type="button">
              <span className={`theme-dot ${theme.id}`} />
              <span><strong>{theme.label}</strong><small>{theme.note}</small></span>
              {snapshot.theme === theme.id && <span className="check-mark">✓</span>}
            </button>
          ))}
        </div>
      </section>

      <section className="control-section">
        <div className="section-label"><span>品牌色</span><span className="muted">HEX / 6 位</span></div>
        <div className="color-fields">
          <ColorField label="主色" value={snapshot.tokens.primary} readOnly={readOnly} onChange={(value) => onColorChange('primary', value)} />
          <ColorField label="辅助色" value={snapshot.tokens.secondary} readOnly={readOnly} onChange={(value) => onColorChange('secondary', value)} />
        </div>
        <div className={`contrast-note ${snapshot.contrastWarning ? 'warning' : ''}`}>
          <span className="contrast-icon">◐</span>
          <span>对比度 <strong>{snapshot.contrastRatio.toFixed(1)}:1</strong> · {snapshot.contrastWarning ? '建议提高对比度' : '适合界面使用'}</span>
        </div>
      </section>

      <ScaleControl label="圆角尺度" hint="px" values={snapshot.tokens.radiusScale} field="radiusScale" readOnly={readOnly} onChange={onScaleChange} />
      <ScaleControl label="间距体系" hint="px" values={snapshot.tokens.spacingScale} field="spacingScale" readOnly={readOnly} onChange={onScaleChange} />
      <ScaleControl label="字体比例" hint="px" values={snapshot.tokens.typeScale} field="typeScale" readOnly={readOnly} onChange={onScaleChange} />

      <div className="panel-footer"><span className="live-dot" />{readOnly ? '只读模式 · 编辑权在另一个页面' : '所有调整实时同步到预览'}</div>
    </aside>
  )
}

function ColorField({ label, value, readOnly, onChange }: { label: string; value: string; readOnly: boolean; onChange: (value: string) => void }) {
  return <label className="color-field"><span>{label}</span><div className="color-input"><input aria-label={label} type="color" value={value} disabled={readOnly} onChange={(event) => onChange(event.target.value)} /><input aria-label={`${label} HEX`} value={value} disabled={readOnly} onChange={(event) => onChange(event.target.value)} /></div></label>
}

function ScaleControl({ label, hint, values, field, readOnly, onChange }: { label: string; hint: string; values: number[]; field: 'radiusScale' | 'spacingScale' | 'typeScale'; readOnly: boolean; onChange: (field: 'radiusScale' | 'spacingScale' | 'typeScale', index: number, value: number) => void }) {
  return <section className="control-section scale-section"><div className="section-label"><span>{label}</span><span className="muted">{hint}</span></div><div className="scale-inputs">{values.map((value, index) => <label key={`${field}-${index}`}><span>{index + 1}</span><input aria-label={`${label}${index + 1}`} type="number" min={field === 'typeScale' ? 10 : 0} max={field === 'typeScale' ? 72 : field === 'spacingScale' ? 64 : 40} value={value} disabled={readOnly} onChange={(event) => onChange(field, index, Number(event.target.value))} /></label>)}</div></section>
}
