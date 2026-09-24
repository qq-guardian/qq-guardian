/**
 * Resolves the EFFECTIVE settings for a given group, merging any per-group
 * override (cfg.approval.groups[groupId]) with the global defaults.
 * A group with no override behaves exactly like the global config.
 */
import type { PluginConfig, GroupApprovalConfig } from './types.ts';
import type { OneBotId } from '../../types/onebot.ts';

/** Fallbacks shared by resolveGroupConfig() and buildNewGroupConfig() so the
 *  two can never drift apart. */
export const GROUP_FALLBACKS = {
  rejectReason: '不符合入群要求',
  curfewStart: '23:00',
  curfewEnd: '07:00',
} as const;

export interface ResolvedGroupConfig {
  enabled: boolean;
  action: GroupApprovalConfig['action'];
  approveKeywords: string[];
  rejectKeywords: string[];
  approvePatterns: string[];
  rejectPatterns: string[];
  rejectReason: string;
  riskEnabled: boolean;
  autoKickBlacklisted: boolean;
  notifyOnRisk: boolean;
  notifyOnJoin: boolean;
  groupName: string;
  welcomeEnabled: boolean;
  welcomeTemplate: string;
  curfewEnabled: boolean;
  curfewStart: string;
  curfewEnd: string;
}

export function resolveGroupConfig(cfg: PluginConfig, groupId: OneBotId): ResolvedGroupConfig {
  const g = cfg.approval.groups[groupId];
  return {
    enabled:             g?.enabled             ?? cfg.approval.defaultGroupEnabled,
    action:              g?.action              ?? cfg.approval.defaultAction,
    approveKeywords:     g?.approveKeywords      ?? [],
    rejectKeywords:      g?.rejectKeywords       ?? [],
    approvePatterns:     g?.approvePatterns      ?? [],
    rejectPatterns:      g?.rejectPatterns       ?? [],
    rejectReason:        g?.rejectReason         ?? GROUP_FALLBACKS.rejectReason,
    riskEnabled:         g?.riskEnabled          ?? cfg.risk.enabled,
    autoKickBlacklisted: g?.autoKickBlacklisted  ?? cfg.blacklist.autoKickOnJoin,
    notifyOnRisk:        g?.notifyOnRisk         ?? false,
    notifyOnJoin:        g?.notifyOnJoin         ?? false,
    groupName:           g?.groupName            ?? '',
    welcomeEnabled:      g?.welcomeEnabled       ?? false,
    welcomeTemplate:     g?.welcomeTemplate      ?? '',
    curfewEnabled:       g?.curfewEnabled        ?? false,
    curfewStart:         g?.curfewStart          ?? GROUP_FALLBACKS.curfewStart,
    curfewEnd:           g?.curfewEnd            ?? GROUP_FALLBACKS.curfewEnd,
  };
}

/**
 * Full config for a group discovered for the first time: strict-boolean
 * defaults derived from the global settings, protection off unless
 * approval.defaultGroupEnabled opts new groups in.
 */
export function buildNewGroupConfig(cfg: PluginConfig, groupName: string): GroupApprovalConfig {
  return {
    enabled:             Boolean(cfg.approval.defaultGroupEnabled),
    action:              cfg.approval.defaultAction,
    approveKeywords:     [],
    rejectKeywords:      [],
    approvePatterns:     [],
    rejectPatterns:      [],
    rejectReason:        GROUP_FALLBACKS.rejectReason,
    riskEnabled:         Boolean(cfg.risk.enabled),
    autoKickBlacklisted: Boolean(cfg.blacklist.autoKickOnJoin),
    notifyOnRisk:        false,
    notifyOnJoin:        false,
    groupName,
    welcomeEnabled:      false,
    welcomeTemplate:     '',
    curfewEnabled:       false,
    curfewStart:         GROUP_FALLBACKS.curfewStart,
    curfewEnd:           GROUP_FALLBACKS.curfewEnd,
  };
}
