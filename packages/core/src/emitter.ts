import type { EventStore } from "./event-store.js";
import { newEvent, type NewEventInput, type SrectlEvent } from "./events.js";
import type { Logger } from "./log.js";

export interface Emitter {
  (input: NewEventInput): Promise<SrectlEvent>;
}

/**
 * One place that appends to the event store.
 *
 * Emission must never take down the work it is describing: a dashboard write
 * failing is not a reason for a review to fail. Errors are logged and
 * swallowed here, deliberately, and nowhere else.
 */
export function createEmitter(store: EventStore, logger?: Logger): Emitter {
  return async (input: NewEventInput) => {
    const event = newEvent(input);
    try {
      await store.append(event);
    } catch (err) {
      logger?.warn("event append failed", { type: event.type, error: (err as Error).message });
    }
    return event;
  };
}

/** No-op emitter, for paths that run without a database. */
export const nullEmitter: Emitter = async (input) => newEvent(input);
