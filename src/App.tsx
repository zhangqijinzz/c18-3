import { BrandMirrorPage } from './features/brand-mirror/views/BrandMirrorPage'
import { LocalBrandRepository } from './features/brand-mirror/repositories/brandRepository'
import { LocalStorageService } from './features/brand-mirror/services/storageService'
import { createDefaultWorkspaceChannel } from './features/brand-mirror/services/workspaceChannel'
import { WorkspacePersistence } from './features/brand-mirror/services/workspacePersistence'
import { BrowserBrandGuidelinesExporter } from './features/brand-mirror/services/exportService'
import { BrandMirrorViewModel } from './features/brand-mirror/viewmodels/brandMirrorViewModel'

const storage = new LocalStorageService()
const persistence = new WorkspacePersistence({
  repository: new LocalBrandRepository(storage),
  channel: createDefaultWorkspaceChannel(storage),
})
const viewModel = new BrandMirrorViewModel(persistence, new BrowserBrandGuidelinesExporter())

export default function App() {
  return <BrandMirrorPage viewModel={viewModel} />
}
