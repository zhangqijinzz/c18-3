import { useMemo, useState } from 'react'
import type { BrandTokens } from '../models/brandMirrorModels'

type TokenCategory = 'all' | 'color' | 'radius' | 'spacing' | 'type'
type TokenEntry = { key: string; label: string; category: Exclude<TokenCategory, 'all'>; value: string }

const filters: { id: TokenCategory; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'color', label: '颜色' },
  { id: 'radius', label: '圆角' },
  { id: 'spacing', label: '间距' },
  { id: 'type', label: '字体' },
]

export function TokenExplorer({ tokens }: { tokens: BrandTokens }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<TokenCategory>('all')
  const entries = useMemo<TokenEntry[]>(() => [
    { key: 'color.primary', label: '主色', category: 'color', value: tokens.primary },
    { key: 'color.secondary', label: '辅助色', category: 'color', value: tokens.secondary },
    ...tokens.radiusScale.map((value, index) => ({ key: `radius.${index + 1}`, label: `圆角 ${index + 1}`, category: 'radius' as const, value: `${value}px` })),
    ...tokens.spacingScale.map((value, index) => ({ key: `spacing.${index + 1}`, label: `间距 ${index + 1}`, category: 'spacing' as const, value: `${value}px` })),
    ...tokens.typeScale.map((value, index) => ({ key: `type.${index + 1}`, label: `字体 ${index + 1}`, category: 'type' as const, value: `${value}px` })),
  ], [tokens])
  const normalizedQuery = query.trim().toLowerCase()
  const visibleEntries = entries.filter((entry) => {
    const matchesCategory = category === 'all' || entry.category === category
    const matchesQuery = !normalizedQuery || `${entry.key} ${entry.label} ${entry.value}`.toLowerCase().includes(normalizedQuery)
    return matchesCategory && matchesQuery
  })

  return <section className="control-section token-explorer"><div className="section-label"><span>令牌搜索</span><span className="muted">{visibleEntries.length} / {entries.length}</span></div><label className="token-search"><span>⌕</span><input aria-label="搜索令牌" placeholder="搜索 primary / 主色" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="清空搜索" type="button" onClick={() => setQuery('')}>×</button>}</label><div className="filter-chips">{filters.map((filter) => <button className={category === filter.id ? 'active' : ''} key={filter.id} type="button" onClick={() => setCategory(filter.id)}>{filter.label}</button>)}</div><div className="token-results">{visibleEntries.length > 0 ? visibleEntries.map((entry) => <div className="token-result" key={entry.key}><span><strong>{entry.label}</strong><small>{entry.key}</small></span><code>{entry.value}</code></div>) : <div className="token-no-result">没有匹配的令牌</div>}</div></section>
}
