import { useEffect, useState } from 'react'
import type { BrandMirrorSnapshot } from '../models/brandMirrorModels'
import { BrandMirrorViewModel } from '../viewmodels/brandMirrorViewModel'

export function useBrandMirrorViewModel(viewModel: BrandMirrorViewModel): BrandMirrorSnapshot {
  const [snapshot, setSnapshot] = useState(viewModel.getSnapshot())
  useEffect(() => {
    const unsubscribe = viewModel.subscribe(() => setSnapshot(viewModel.getSnapshot()))
    viewModel.initialize()
    return unsubscribe
  }, [viewModel])
  return snapshot
}
