import { EventEmitter } from 'events';
import type { InternalEventName, InternalEventPayload } from './types.ts';

/**
 * Typed event bus for cross-cutting notifications (see types.ts).
 */
class TypedEventBus extends EventEmitter {
  constructor() {
    super();
    super.setMaxListeners(50);
  }

  emit<T extends InternalEventName>(event: T, payload: InternalEventPayload<T>): boolean {
    return super.emit(event, payload);
  }

  on<T extends InternalEventName>(
    event: T,
    listener: (payload: InternalEventPayload<T>) => void | Promise<void>
  ): this {
    return super.on(event, listener);
  }
}

export const bus = new TypedEventBus();
