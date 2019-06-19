import { createPlatform, PlatformRef, StaticProvider } from '@wb/core';
import { container, InjectionToken } from 'tsyringe';

const PLATFORM_NAME = 'node';

const PROCESS_INJECTION_TOKEN: InjectionToken<NodeJS.Process> = 'process';

const PLATFORM_NODE_STATIC_PROVIDER: StaticProvider[] = [
  {
    provide: PROCESS_INJECTION_TOKEN,
    useValue: process,
  },
];

export function bootstrapPlatformNode(): PlatformRef {
  return createPlatform(PLATFORM_NAME, container.createChildContainer(), PLATFORM_NODE_STATIC_PROVIDER);
}
