import {
  DependencyContainer,
  injectable,
  InjectionToken,
  isClassProvider,
  isFactoryProvider,
  isValueProvider,
} from 'tsyringe';
import { StaticProvider, Type } from './util';

const PLATFORM_INJECTION_TOKEN: InjectionToken = 'Platform';
const CONTAINER_INJECTION_TOKEN: InjectionToken = 'Container';

/**
 * A reference to an platform.
 */
@injectable()
export class PlatformRef {
  constructor(private readonly container: DependencyContainer) {}
  public bootstrap<APP>(applicationType: Type<APP>) {
    this.container.register('application', {
      useClass: applicationType,
    });
  }
}

export function createPlatform(name: string, container: DependencyContainer, providers: StaticProvider[]): PlatformRef {
  container
    .register(PLATFORM_INJECTION_TOKEN, { useValue: name })
    .register(CONTAINER_INJECTION_TOKEN, { useValue: container });

  providers.forEach(provider => {
    if (isClassProvider(provider)) {
      container.register(provider.provide, provider);
    } else if (isValueProvider(provider)) {
      container.register(provider.provide, provider);
    } else if (isValueProvider(provider)) {
      container.register(provider.provide, provider);
    } else if (isFactoryProvider(provider)) {
      container.register(provider.provide, provider);
    }
  });
  return container.resolve(PlatformRef);
}
