import { configManager } from '../core/config/index.ts';
import { resolveGroupConfig } from '../core/config/group.ts';
import { locks, withLock } from '../core/locks.ts';
import { getLogger } from '../core/logger/index.ts';
import { handleBlacklistMemberJoin } from '../modules/blacklist/index.ts';
import { intelService } from '../modules/intel/index.ts';
import { punishmentService } from '../modules/punishment/index.ts';
import { sendWelcomeForMemberJoin } from '../modules/welcome/index.ts';
import type { MemberJoinEvent, MemberJoinStageResult } from '../types/member-join.ts';

export type { MemberJoinStageResult } from '../types/member-join.ts';

export interface MemberJoinStage {
  name: string;
  run(event: MemberJoinEvent): Promise<MemberJoinStageResult>;
}

export interface MemberJoinPipelineResult {
  status: 'completed' | 'stopped' | 'failed' | 'ignored';
  stage?: string;
}

/**
 * Runs member-admission stages in order. A terminal enforcement decision or
 * a stage failure stops the pipeline so later side effects cannot greet a
 * member who may be in the middle of being removed.
 */
export async function runMemberJoinPipeline(
  event: MemberJoinEvent,
  stages: readonly MemberJoinStage[],
  onStageError: (stage: string, error: unknown) => void = () => {}
): Promise<MemberJoinPipelineResult> {
  for (const stage of stages) {
    try {
      if (await stage.run(event) === 'stop') {
        return { status: 'stopped', stage: stage.name };
      }
    } catch (error) {
      onStageError(stage.name, error);
      return { status: 'failed', stage: stage.name };
    }
  }
  return { status: 'completed' };
}

const stages: readonly MemberJoinStage[] = [
  { name: 'blacklist', run: handleBlacklistMemberJoin },
  {
    name: 'punishment',
    async run(event) {
      return (await punishmentService.checkAndReapplyOnJoin(event.groupId, event.userId))
        ? 'stop'
        : 'continue';
    },
  },
  { name: 'intel', run: (event) => intelService.handleMemberJoin(event) },
  {
    name: 'welcome',
    async run(event) {
      await sendWelcomeForMemberJoin(event);
      return 'continue';
    },
  },
];

/**
 * Routes a normalized OneBot group-increase notice through the single
 * admission pipeline. Duplicate notices for the same member are serialized;
 * different members and groups remain independent.
 */
export async function handleMemberJoin(event: MemberJoinEvent): Promise<MemberJoinPipelineResult> {
  return withLock(locks.memberJoin(event.groupId, event.userId), async () => {
    const config = configManager.get();
    if (event.userId === config.core.selfId || !resolveGroupConfig(config, event.groupId).enabled) {
      return { status: 'ignored' };
    }

    return runMemberJoinPipeline(event, stages, (stage, error) => {
      getLogger().child({ module: 'member-join' }).error(
        { stage, group_id: event.groupId, user_id: event.userId, error },
        'Member-join stage failed; skipping remaining stages'
      );
    });
  });
}
