import type { OneBotId } from './onebot.ts';

/**
 * A normalized group-member admission event. Platform event handlers map
 * OneBot notices to this shape before application services process them.
 */
export interface MemberJoinEvent {
  groupId: OneBotId;
  userId: OneBotId;
  subType: 'approve' | 'invite';
  timestamp: number;
}

/** A stage either lets admission processing continue or terminates it. */
export type MemberJoinStageResult = 'continue' | 'stop';
