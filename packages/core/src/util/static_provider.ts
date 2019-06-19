import { InjectionToken, Provider } from 'tsyringe';
export type StaticProvider<T = any> = {
  provide: InjectionToken<T>;
} & Provider<T>;
