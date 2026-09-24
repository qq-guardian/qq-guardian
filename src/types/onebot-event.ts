import {
  normalizeOneBotFileId,
  normalizeOneBotId,
  normalizeOneBotMessageId,
  type OneBotId,
} from './onebot.ts';
import type {
  OB11Event,
  OB11Message,
  OB11MessageSegment,
  OB11NoticeEvent,
  OB11RequestEvent,
} from './napcat.ts';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function eventTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalId(source: UnknownRecord, key: string): { valid: boolean; value?: OneBotId } {
  if (source[key] === undefined || source[key] === null || source[key] === '') return { valid: true };
  const value = normalizeOneBotId(source[key]);
  return value === null ? { valid: false } : { valid: true, value };
}

const SEGMENT_ID_KEYS = [
  'self_id',
  'user_id',
  'group_id',
  'target_id',
  'operator_id',
] as const;

function normalizeSegment(value: unknown): OB11MessageSegment | null {
  const segment = record(value);
  if (!segment || typeof segment['type'] !== 'string') return null;
  const sourceData = record(segment['data']);
  if (!sourceData) return null;
  const data: UnknownRecord = { ...sourceData };

  for (const key of SEGMENT_ID_KEYS) {
    if (data[key] === undefined || data[key] === null || data[key] === '') continue;
    const id = normalizeOneBotId(data[key]);
    if (id === null) return null;
    data[key] = id;
  }

  if (data['message_id'] !== undefined && data['message_id'] !== null && data['message_id'] !== '') {
    const messageId = normalizeOneBotMessageId(data['message_id']);
    if (messageId === null) return null;
    data['message_id'] = messageId;
  }

  if (segment['type'] === 'at' && data['qq'] !== undefined && data['qq'] !== 'all') {
    const qq = normalizeOneBotId(data['qq']);
    if (qq === null) return null;
    data['qq'] = qq;
  }
  if (segment['type'] === 'reply' && data['id'] !== undefined) {
    const id = normalizeOneBotMessageId(data['id']);
    if (id === null) return null;
    data['id'] = id;
  }
  if (data['file_id'] !== undefined) {
    const fileId = normalizeOneBotFileId(data['file_id']);
    if (fileId === null) return null;
    data['file_id'] = fileId;
  }

  return { type: segment['type'], data };
}

export function normalizeOB11Message(value: unknown): OB11Message | null {
  const event = record(value);
  if (!event || (event['post_type'] !== 'message' && event['post_type'] !== 'message_sent')) return null;
  if (event['message_type'] !== 'private' && event['message_type'] !== 'group') return null;
  const time = eventTime(event['time']);
  const selfId = normalizeOneBotId(event['self_id']);
  const messageId = normalizeOneBotMessageId(event['message_id']);
  const userId = normalizeOneBotId(event['user_id']);
  const group = optionalId(event, 'group_id');
  const sender = record(event['sender']);
  const senderId = normalizeOneBotId(sender?.['user_id']);
  if (
    time === null || selfId === null || messageId === null || userId === null
    || !group.valid || !sender || senderId === null
    || typeof sender['nickname'] !== 'string'
    || typeof event['raw_message'] !== 'string'
    || (!Array.isArray(event['message']) && typeof event['message'] !== 'string')
    || (event['message_type'] === 'group' && group.value === undefined)
  ) return null;

  // OneBot v11 permits either an array of message segments or a CQ string.
  // Shared handlers already use raw_message as their fallback for string-form
  // events; represent that form as an empty canonical segment list so it is
  // never dropped at ingress or mistaken for parsed structured content.
  const segments = Array.isArray(event['message']) ? event['message'].map(normalizeSegment) : [];
  if (segments.some((segment) => segment === null)) return null;
  const role = sender['role'];
  if (role !== undefined && role !== 'owner' && role !== 'admin' && role !== 'member') return null;
  if (sender['card'] !== undefined && typeof sender['card'] !== 'string') return null;

  return {
    time,
    self_id: selfId,
    post_type: event['post_type'],
    message_type: event['message_type'],
    message_id: messageId,
    user_id: userId,
    ...(group.value === undefined ? {} : { group_id: group.value }),
    message: segments as OB11MessageSegment[],
    raw_message: event['raw_message'],
    sender: {
      user_id: senderId,
      nickname: sender['nickname'],
      ...(sender['card'] === undefined ? {} : { card: sender['card'] }),
      ...(role === undefined ? {} : { role }),
    },
  };
}

function normalizeRequestEvent(event: UnknownRecord): OB11RequestEvent | null {
  if (event['request_type'] !== 'group' && event['request_type'] !== 'friend') return null;
  const time = eventTime(event['time']);
  const selfId = normalizeOneBotId(event['self_id']);
  const userId = normalizeOneBotId(event['user_id']);
  const group = optionalId(event, 'group_id');
  const comment = event['comment'] === undefined || event['comment'] === null
    ? ''
    : typeof event['comment'] === 'string' ? event['comment'] : null;
  if (
    time === null || selfId === null || userId === null || !group.valid
    || comment === null || typeof event['flag'] !== 'string' || event['flag'].length === 0
    || (event['request_type'] === 'group' && group.value === undefined)
    || (event['sub_type'] !== undefined && typeof event['sub_type'] !== 'string')
  ) return null;
  return {
    time,
    self_id: selfId,
    post_type: 'request',
    request_type: event['request_type'],
    ...(event['sub_type'] === undefined ? {} : { sub_type: event['sub_type'] }),
    ...(group.value === undefined ? {} : { group_id: group.value }),
    user_id: userId,
    comment,
    flag: event['flag'],
  };
}

function normalizeNoticeEvent(event: UnknownRecord): OB11NoticeEvent | null {
  const time = eventTime(event['time']);
  const selfId = normalizeOneBotId(event['self_id']);
  const group = optionalId(event, 'group_id');
  const user = optionalId(event, 'user_id');
  const operator = optionalId(event, 'operator_id');
  if (
    time === null || selfId === null || !group.valid || !user.valid || !operator.valid
    || typeof event['notice_type'] !== 'string'
    || (event['sub_type'] !== undefined && typeof event['sub_type'] !== 'string')
  ) return null;
  return {
    time,
    self_id: selfId,
    post_type: 'notice',
    notice_type: event['notice_type'],
    ...(group.value === undefined ? {} : { group_id: group.value }),
    ...(user.value === undefined ? {} : { user_id: user.value }),
    ...(operator.value === undefined ? {} : { operator_id: operator.value }),
    ...(event['sub_type'] === undefined ? {} : { sub_type: event['sub_type'] }),
  };
}

export function normalizeOB11Event(value: unknown): OB11Event | null {
  const event = record(value);
  if (!event) return null;
  if (event['post_type'] === 'request') return normalizeRequestEvent(event);
  if (event['post_type'] === 'notice') return normalizeNoticeEvent(event);
  return null;
}
