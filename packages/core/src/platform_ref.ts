import { Injectable, InjectionToken, Injector, Provider, ReflectiveInjector, Type } from 'injection-js';
import { resolveReflectiveProviders } from 'injection-js/reflective_provider';

/**
 * A function that will be executed when a platform is initialized.
 */
const PLATFORM_INITIALIZER = new InjectionToken<Array<() => Promise<void>>>('Platform Initializer');
const PLATFORM_INJECTION_TOKEN = new InjectionToken('Platform');

/**
 * A reference to an platform.
 */
@Injectable()
export class PlatformRef {
  constructor(private injector: Injector) {}
  public bootstrap<APP>(applicationType: Type<APP>) {
    //
  }
}

export async function createPlatform(name: string, providers: Provider[]): Promise<PlatformRef> {
  const platformProviders: Provider[] = [
    {
      provide: PLATFORM_INJECTION_TOKEN,
      useValue: name,
    },
  ];

  const resolvedReflectiveProviders = resolveReflectiveProviders(platformProviders.concat(providers));
  const injector: Injector = ReflectiveInjector.fromResolvedProviders(resolvedReflectiveProviders);
  const platformInitializers = injector.get(PLATFORM_INITIALIZER, []);
  platformInitializers.forEach(async platformInitializer => await platformInitializer());
  return injector.get(PlatformRef);
}
