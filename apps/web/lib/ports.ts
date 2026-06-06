/** Small injectable ports so services stay deterministic and testable. */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function createUuidGenerator(): IdGenerator {
  return { next: () => crypto.randomUUID() };
}
