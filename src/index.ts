/**
 * napcat-plugin-qq-guardian — NapCat plugin entry point
 *
 * Exports required by NapCat's 2026 plugin mechanism:
 *   plugin_init            (required)
 *   plugin_cleanup         (optional)
 *   plugin_onmessage       (optional)
 *   plugin_onevent         (optional)
 *   plugin_config_schema   (optional — defines settings dialog fields)
 *   plugin_get_config      (optional — returns current config values)
 *   plugin_set_config      (optional — applies saved config values)
 */

export { plugin_onmessage } from './handlers/message.ts';
export { plugin_onevent }   from './handlers/event.ts';

import { boot, teardown } from './lifecycle.ts';
import { configManager }  from './core/config/index.ts';
import { parseBoolean }   from './core/config/boolean.ts';
import { createNapCatRuntimeHost } from './adapters/napcat/runtime-host.ts';
import type { NapCatPluginContext, PluginConfigSchema } from './types/napcat.ts';
import { normalizeOneBotId } from './types/onebot.ts';

// ─── Required lifecycle ────────────────────────────────────────────────────────

export async function plugin_init(ctx: NapCatPluginContext): Promise<void> {
  await boot(createNapCatRuntimeHost(ctx));
}

export async function plugin_cleanup(_ctx: NapCatPluginContext): Promise<void> {
  await teardown();
}

// ─── Config UI (fixes "此插件没有配置哦") ────────────────────────────────────

export const plugin_config_schema: PluginConfigSchema = [
  {
    key:         'selfId',
    type:        'string',
    label:       '机器人 QQ 号 / Bot QQ ID',
    description: '运行本插件的机器人 QQ 号 (Bot account QQ number)',
    default:     '0',
  },
  {
    key:         'defaultApproval',
    type:        'select',
    label:       '默认入群审批方式 / Default Approval',
    description: '未单独配置的群的默认处理方式',
    options: [
      { label: '人工审核 (Manual)',         value: 'manual' },
      { label: '自动通过 (Auto-approve)',    value: 'auto_approve' },
      { label: '自动拒绝 (Auto-reject)',     value: 'auto_reject' },
      { label: '验证码 (Captcha)',           value: 'captcha' },
    ],
    default: 'manual',
  },
  {
    key:         'riskEnabled',
    type:        'boolean',
    label:       '启用风险控制 / Enable Risk Control',
    description: '自动检测并处理违规消息。每类检测器的处理动作请在 WebUI 设置页配置 / Per-detector actions are configured in the WebUI Settings page',
    default:     true,
  },
  {
    key:         'autoKickBlacklisted',
    type:        'boolean',
    label:       '自动踢出黑名单用户 / Auto-kick Blacklisted',
    description: '黑名单用户入群时自动踢出',
    default:     true,
  },
  {
    key:         'riskRecallMessage',
    type:        'boolean',
    label:       '撤回违规消息 / Recall Risky Messages',
    description: '检测到风险消息时同时撤回该消息（附加于风险处理动作之上）',
    default:     false,
  },
  {
    key:         'approvalRealtimeSync',
    type:        'boolean',
    label:       '实时同步入群申请 / Realtime Admission Sync',
    description: '定时拉取群系统消息，补处理错过的入群申请（机器人离线/重启期间的申请也会按最新数据审批）',
    default:     true,
  },
  {
    key:         'useBuiltinApproveKeywords',
    type:        'boolean',
    label:       '内置通过关键词 / Built-in Approve Keywords',
    description: '高风险显式选项：申请人可伪造“朋友推荐”等文本；启用后人工审核群会自动放行匹配者。默认关闭，建议改用每群可信规则 / HIGH RISK: applicant-controlled referral text can bypass manual review; prefer trusted per-group rules',
    default:     false,
  },
  {
    key:         'intelEnabled',
    type:        'boolean',
    label:       '云端风控数据 / Cloud Intel Feed',
    description: '启用后默认仅观察；远端审核/处罚还需要超级管理员配置 SHA-256 固定值并选择 enforce / enabled feeds observe by default; remote actions require super-admin SHA-256 pins plus enforce mode',
    default:     false,
  },
  {
    key:         'commandsEnabled',
    type:        'boolean',
    label:       '启用群内指令 / Enable In-chat Commands',
    description: '允许群主/管理员在群内使用指令（如 /guard mute @某人 10）',
    default:     true,
  },
  {
    key:         'commandPrefix',
    type:        'string',
    label:       '指令前缀 / Command Prefix',
    description: '群内指令的前缀，默认 /guard',
    default:     '/guard',
  },
  {
    key:         'githubRepo',
    type:        'string',
    label:       'GitHub 仓库 / GitHub Repo (update check)',
    description: '格式 用户名/仓库名，指向你自己的仓库才能检测到你发布的新版本 / format owner/repo — point at your own fork to detect your own releases',
    default:     'ShiYuPIay/napcat-plugin-qq-guardian',
  },
];

export async function plugin_get_config(_ctx: NapCatPluginContext): Promise<Record<string, unknown>> {
  // Guard: configManager may not be initialized if called before plugin_init
  try {
    const cfg = configManager.get();
    return {
      selfId:              cfg.core?.selfId          ?? '0',
      defaultApproval:     cfg.approval?.defaultAction ?? 'manual',
      riskEnabled:         cfg.risk?.enabled          ?? true,
      autoKickBlacklisted: cfg.blacklist?.autoKickOnJoin ?? true,
      riskRecallMessage:   cfg.risk?.recallMessage    ?? false,
      approvalRealtimeSync:      cfg.approval?.realtimeSyncEnabled     ?? true,
      useBuiltinApproveKeywords: cfg.approval?.useBuiltinApproveKeywords ?? false,
      intelEnabled:        cfg.intel?.enabled         ?? false,
      commandsEnabled:     cfg.commands?.enabled      ?? true,
      commandPrefix:       cfg.commands?.prefix       ?? '/guard',
      githubRepo:          cfg.update?.githubRepo     ?? 'ShiYuPIay/napcat-plugin-qq-guardian',
    };
  } catch {
    return { selfId:'0', defaultApproval:'manual', riskEnabled:true, autoKickBlacklisted:true, riskRecallMessage:false, approvalRealtimeSync:true, useBuiltinApproveKeywords:false, intelEnabled:false, commandsEnabled:true, commandPrefix:'/guard', githubRepo:'ShiYuPIay/napcat-plugin-qq-guardian' };
  }
}

export async function plugin_set_config(_ctx: NapCatPluginContext, config: unknown): Promise<void> {
  // Guard: configManager.get() returns undefined (not a throw) if uninitialized
  if (!configManager.get()) return;
  const c = config as Record<string, unknown>;
  const requestedSelfId = c['selfId'];
  const selfId = requestedSelfId === undefined
    ? undefined
    : normalizeOneBotId(requestedSelfId, { allowZero: true });
  if (requestedSelfId !== undefined && selfId === null) {
    throw new TypeError('selfId must be an exact unsigned 64-bit decimal identifier');
  }
  configManager.update({
    core:      { selfId:       selfId ?? undefined },
    approval: {
      defaultAction: (['auto_approve', 'auto_reject', 'manual', 'captcha'] as const).includes(c['defaultApproval'] as never)
        ? (c['defaultApproval'] as 'auto_approve' | 'auto_reject' | 'manual' | 'captcha')
        : undefined,
      realtimeSyncEnabled:       parseBoolean(c['approvalRealtimeSync']),
      useBuiltinApproveKeywords: parseBoolean(c['useBuiltinApproveKeywords']),
    },
    intel: { enabled: parseBoolean(c['intelEnabled']) },
    risk: {
      enabled:       parseBoolean(c['riskEnabled']),
      recallMessage: parseBoolean(c['riskRecallMessage']),
    },
    blacklist: { autoKickOnJoin: parseBoolean(c['autoKickBlacklisted']) },
    commands: {
      enabled: parseBoolean(c['commandsEnabled']),
      prefix:  typeof c['commandPrefix'] === 'string' && c['commandPrefix'].trim() ? c['commandPrefix'].trim() : undefined,
    },
    update:    { githubRepo: c['githubRepo'] !== undefined ? String(c['githubRepo']) : undefined },
  });
}
