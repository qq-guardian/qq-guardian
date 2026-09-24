import type { PluginConfig } from './types.ts';
import { randomBytes } from 'crypto';

export function buildDefaults(): PluginConfig {
  return {
    core: {
      selfId: '0',
      superAdmins: [],
      timezone: 'Asia/Shanghai',
    },
    webui: {
      jwtSecret: randomBytes(32).toString('hex'),
      jwtExpiresIn: '2h',
      refreshExpiresIn: '7d',
    },
    approval: {
      defaultAction: 'manual',
      groups: {},
      pendingTtlSeconds: 86400, // 24h
      defaultGroupEnabled: false,
      useBuiltinRejectKeywords: true,
      // Applicant-controlled referral text is not authentication. Operators
      // may explicitly enable this convenience heuristic after accepting the
      // admission-bypass risk; manual review must remain manual by default.
      useBuiltinApproveKeywords: false,
      realtimeSyncEnabled: true,
      syncIntervalSeconds: 30,
    },
    captcha: {
      ttlSeconds: 300,
      maxAttempts: 3,
      types: ['math', 'question'],
      questions: [],
    },
    risk: {
      enabled: true,
      detectorActions: {
        advertising: 'mute',
        fraud: 'mute',
        grayMarket: 'mute',
        pornography: 'kick',
        political: 'kick',
        gambling: 'mute',
        shortLinks: 'log_only',
        duplicateMessages: 'mute',
        spam: 'mute',
        cardMessage: 'log_only',
        aiViolation: 'off',
      },
      muteDurationSeconds: 600,
      aiMinScore: 70,
      recallMessage: false,
    },
    punishment: {
      defaultMuteDurationSeconds: 600,
      escalateToKickAfter: 3,
      escalateToBlacklistAfter: 5,
    },
    blacklist: {
      autoKickOnJoin: true,
    },
    auth: {
      maxLoginAttempts: 5,
      lockoutSeconds: 900,
      rateLimitRequests: 100,
      rateLimitWindowMs: 60000,
    },
    monitor: {
      intervalMs: 30000,
      diskAlertMb: 500,
      memoryAlertPercent: 90,
    },
    update: {
      githubRepo: 'ShiYuPIay/napcat-plugin-qq-guardian',
      autoCheckOnStartup: true,
    },
    ai: {
      provider: 'disabled',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      timeoutMs: 15000,
      riskPrompt:
        'Analyze the following QQ group message for risk. Respond with JSON: {"score":0-100,"reason":"...","tags":[]}. Score: 0=safe, 100=extremely harmful.',
    },
    commands: {
      enabled: true,
      prefix: '/guard',
    },
    intel: {
      // Fetching is opt-in and enforcement is a second, pinned opt-in. Legacy
      // enabled configurations migrate to observation-only behavior.
      enabled: false,
      enforcementMode: 'observe',
      feedUrls: [
        'https://raw.githubusercontent.com/ShiYuPIay/napcat-plugin-qq-guardian/main/intel/feed.json',
      ],
      feedPins: {},
      refreshIntervalSeconds: 300,
    },
  };
}
