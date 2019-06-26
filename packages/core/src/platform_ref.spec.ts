import 'reflect-metadata';
import { createPlatform, PLATFORM_INJECTION_TOKEN } from './platform_ref';

describe('createPlatform', () => {
  it('platform name to be "test"', async () => {
    const platformRef = await createPlatform('test', []);
    const name = platformRef.injector.get(PLATFORM_INJECTION_TOKEN);
    expect(name).toEqual('test');
  });
});
