import { Injectable, InjectionToken, Injector, Provider, ReflectiveInjector, Type } from 'injection-js';
export const PLATFORM_INJECTION_TOKEN = new InjectionToken<string>('Platform');

/**
 * A reference to an platform.
 */
@Injectable()
export class PlatformRef {
  public bootstrap<APP>(applicationType: Type<APP>) {
    //
  }
}

export async function createPlatform(name: string, providers: Provider[]): Promise<PlatformRef> {
  const platformProviders: Provider[] = [
    PlatformRef,
    {
      provide: PLATFORM_INJECTION_TOKEN,
      useValue: name,
    },
  ];

  const injector: Injector = ReflectiveInjector.resolveAndCreate(platformProviders.concat(providers));
  return injector.get(PlatformRef);
}
