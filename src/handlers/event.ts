/**
 * plugin_onevent — handles all non-message OB11 events.
 * Exported from src/index.ts as required by NapCat plugin mechanism.
 */
import type { OB11RequestEvent, OB11NoticeEvent } from '../types/napcat.ts';
import { normalizeOB11Event } from '../types/onebot-event.ts';
import { approvalService } from '../modules/approval/index.ts';
import { handleMemberJoin } from '../application/member-join.ts';
import { getLogger } from '../core/logger/index.ts';
import { recordProviderEvent, recordProviderEventDrop } from '../runtime/host.ts';

export async function plugin_onevent(
  _runtime: unknown,
  providerEvent: unknown
): Promise<void> {
  let correlationId: string | null = null;
  try {
    const event = normalizeOB11Event(providerEvent);
    if (!event) {
      correlationId = recordProviderEventDrop();
      getLogger().child({ module: 'event' }).warn(
        { correlation_id: correlationId },
        'Ignoring malformed non-message event',
      );
      return;
    }
    const rawEvent = providerEvent !== null && typeof providerEvent === 'object'
      ? providerEvent as Record<string, unknown>
      : {};
    correlationId = recordProviderEvent(
      rawEvent['post_type'] === 'meta_event' && rawEvent['meta_event_type'] === 'heartbeat',
    );
    // Group join request → approval flow
    // Narrowing: post_type === 'request' gives us OB11RequestEvent with typed request_type/sub_type.
    if (event.post_type === 'request') {
      const req = event as OB11RequestEvent;
      if (req.request_type === 'group' && req.sub_type === 'add') {
        await approvalService.handleJoinRequest(req);
      }
      return;
    }

    // Member joined → ordered admission pipeline.
    // Narrowing: post_type === 'notice' gives us OB11NoticeEvent with typed notice_type.
    if (event.post_type === 'notice') {
      const notice = event as OB11NoticeEvent;
      if (notice.notice_type === 'group_increase') {
        if (!notice.group_id || !notice.user_id) {
          getLogger().child({ module: 'event' }).warn(
            'Ignoring group-increase notice without valid identifiers'
          );
          return;
        }
        await handleMemberJoin({
          groupId: notice.group_id,
          userId: notice.user_id,
          subType: notice.sub_type === 'invite' ? 'invite' : 'approve',
          timestamp: notice.time * 1000,
        });
      }
      return;
    }
  } catch (e) {
    getLogger().child({ module: 'event' }).error(
      { correlation_id: correlationId, error: e },
      'Error handling event',
    );
  }
}
