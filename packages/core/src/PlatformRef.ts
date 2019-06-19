import { injectable } from 'tsyringe';
import { Type } from './Type';

/**
 * A reference to an platform.
 */
@injectable()
export class PlatformRef {
  public bootstrap<APP>(applicationType: Type<APP>) {
    //
  }
}
