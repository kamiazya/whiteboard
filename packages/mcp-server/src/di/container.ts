import { Container, type ContainerModule } from 'inversify'
import { storeMemoryModule } from './store-memory.module.js'

export function createContainer(storeModule: ContainerModule = storeMemoryModule): Container {
  const container = new Container()
  container.load(storeModule)
  return container
}
