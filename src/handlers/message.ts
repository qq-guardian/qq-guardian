/**
 * plugin_onmessage — handles all OB11 message events.
 * Exported from src/index.ts as required by NapCat plugin mechanism.
 */
import { normalizeOB11Message } from '../types/onebot-event.ts';
import { captchaService } from '../modules/captcha/index.ts';
import { riskService } from '../modules/risk/index.ts';
import { commandService } from '../modules/commands/index.ts';
import { getLogger } from '../core/logger/index.ts';
import { recordProviderEvent, recordProviderEventDrop } from '../runtime/host.ts';

export async function plugin_onmessage(
  _runtime: unknown,
  providerEvent: unknown
): Promise<void> {
  let correlationId: string | null = null;
  try {
    const event = normalizeOB11Message(providerEvent);
    if (!event) {
      correlationId = recordProviderEventDrop();
      getLogger().child({ module: 'message' }).warn(
        { correlation_id: correlationId },
        'Ignoring malformed message event',
      );
      return;
    }
    correlationId = recordProviderEvent();
    // Never process the bot's own outgoing messages: a curfew announcement or
    // welcome reply containing a flagged keyword must not risk-score (and
    // potentially mute/kick) the bot itself, nor be treated as a captcha answer.
    if (event.post_type === 'message_sent' || event.user_id === event.self_id) return;
    if (event.message_type === 'private') {
      await captchaService.handlePrivateMessage(event);
      return;
    }
    if (event.message_type === 'group') {
      // Admin commands are checked first; a consumed command is not risk-scored.
      // Non-admin messages are never consumed, so prefixing spam with the
      // command prefix cannot bypass risk detection.
      if (await commandService.handleGroupCommand(event)) return;
      await riskService.handleGroupMessage(event);
      return;
    }
  } catch (e) {
    getLogger().child({ module: 'message' }).error(
      { correlation_id: correlationId, error: e },
      'Error handling message',
    );
  }
}
