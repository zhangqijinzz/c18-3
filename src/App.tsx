import { BrandMirrorPage } from './features/brand-mirror/views/BrandMirrorPage'
import { LocalBrandRepository } from './features/brand-mirror/repositories/brandRepository'
import { LocalStorageService } from './features/brand-mirror/services/storageService'
import { BrowserBrandGuidelinesExporter } from './features/brand-mirror/services/exportService'
import { BrandMirrorViewModel } from './features/brand-mirror/viewmodels/brandMirrorViewModel'

const viewModel = new BrandMirrorViewModel(new LocalBrandRepository(new LocalStorageService()), new BrowserBrandGuidelinesExporter())

export default function App() {
  return <BrandMirrorPage viewModel={viewModel} />
}
