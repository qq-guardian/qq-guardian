import type { OneBotId } from '../../types/onebot.ts';

/**
 * Internal event bus types.
 *
 * The bus decouples EMITTERS from cross-cutting listeners (audit logging,
 * anti-evasion checks, welcome messages, config-change reactions). Direct
 * module-to-module imports remain the normal way to invoke a service —
 * only fan-out notifications go through the bus. Every event declared here
 * has at least one listener; add new events only together with a consumer.
 */

export interface InternalEventMap {
  /** A join request was routed to captcha. Listened by: captcha service
   *  (issues the challenge). */
  CaptchaRequired: {
    approvalId: number;
    groupId: OneBotId;
    userId: OneBotId;
    timestamp: number;
  };
  /** Persisted config was updated. Listened by: curfew scheduler
   *  (re-evaluates windows immediately instead of waiting for the tick). */
  ConfigChanged: {
    section: string;
    timestamp: number;
  };
  /** Something audit-worthy happened. Listened by: audit module (writes the
   *  audit_logs row). */
  AuditCreated: {
    action: string;
    actorId: string | null;
    targetType: string | null;
    targetId: string | null;
    details: Record<string, unknown>;
    timestamp: number;
  };
}

export type InternalEventName = keyof InternalEventMap;
export type InternalEventPayload<T extends InternalEventName> = InternalEventMap[T];
