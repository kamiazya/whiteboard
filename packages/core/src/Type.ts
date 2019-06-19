/**
 * Represents a type.
 */
export type Type<T> = new (...args: any[]) => T;
