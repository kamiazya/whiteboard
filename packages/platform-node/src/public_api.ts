import { createPlatform, PlatformRef } from '@wb/core';
import { InjectionToken, Provider } from 'injection-js';

const PLATFORM_NAME = 'node';

const PROCESS_INJECTION_TOKEN = new InjectionToken<NodeJS.Process>('process');

const PLATFORM_NODE_STATIC_PROVIDER: Provider[] = [
  {
    provide: PROCESS_INJECTION_TOKEN,
    useValue: process,
  },
];

export function bootstrapPlatformNode(): Promise<PlatformRef> {
  return createPlatform(PLATFORM_NAME, PLATFORM_NODE_STATIC_PROVIDER);
}
