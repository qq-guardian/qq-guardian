/**
 * Unit tests for the pure helpers behind the 1.1.0 features:
 *  - curfew window math (parseHHMM / isInCurfewWindow / minutesOfDayIn)
 *  - in-chat command parsing (extractCommandInput / parseCommand /
 *    resolveTarget / resolveMinutes)
 *  - welcome template rendering (buildWelcomeSegments)
 *
 * Run with:  npm run test:unit
 * These exercise pure functions only — no NapCat runtime, config, or DB calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseHHMM, isInCurfewWindow, minutesOfDayIn } from '../../src/modules/curfew/index.ts';
import { pickMostSevere, normalizeRuleAction, hasCardSegment } from '../../src/modules/risk/index.ts';
import { extractCommandInput, parseCommand, resolveTarget, resolveMinutes } from '../../src/modules/commands/index.ts';
import { buildWelcomeSegments, DEFAULT_TEMPLATE } from '../../src/modules/welcome/index.ts';
import { rawToJsdelivr } from '../../src/modules/intel/index.ts';
import type { OB11MessageSegment } from '../../src/types/napcat.ts';

// ── curfew ───────────────────────────────────────────────────────────────────

describe('parseHHMM', () => {
  it('parses strict 24h times', () => {
    assert.equal(parseHHMM('00:00'), 0);
    assert.equal(parseHHMM('23:59'), 23 * 60 + 59);
    assert.equal(parseHHMM('07:05'), 7 * 60 + 5);
  });
  it('rejects invalid strings', () => {
    for (const bad of ['24:00', '7:00', '23:60', '25:99', '7:00 PM', '', 'aa:bb', '12:3']) {
      assert.equal(parseHHMM(bad), null, `should reject "${bad}"`);
    }
  });
});

describe('isInCurfewWindow', () => {
  const m = (h: number, min = 0) => h * 60 + min;
  it('handles a same-day window [22:00, 23:30)', () => {
    assert.equal(isInCurfewWindow(m(21, 59), m(22), m(23, 30)), false);
    assert.equal(isInCurfewWindow(m(22),      m(22), m(23, 30)), true);  // start inclusive
    assert.equal(isInCurfewWindow(m(23, 29),  m(22), m(23, 30)), true);
    assert.equal(isInCurfewWindow(m(23, 30),  m(22), m(23, 30)), false); // end exclusive
  });
  it('handles an overnight window [23:00, 07:00)', () => {
    assert.equal(isInCurfewWindow(m(23),     m(23), m(7)), true);
    assert.equal(isInCurfewWindow(m(2),      m(23), m(7)), true);
    assert.equal(isInCurfewWindow(m(6, 59),  m(23), m(7)), true);
    assert.equal(isInCurfewWindow(m(7),      m(23), m(7)), false);
    assert.equal(isInCurfewWindow(m(12),     m(23), m(7)), false);
    assert.equal(isInCurfewWindow(m(22, 59), m(23), m(7)), false);
  });
  it('treats start === end as an empty window, never 24h', () => {
    assert.equal(isInCurfewWindow(m(12), m(12), m(12)), false);
    assert.equal(isInCurfewWindow(m(0),  m(12), m(12)), false);
  });
});

describe('minutesOfDayIn', () => {
  it('computes minutes of day in a fixed-offset timezone', () => {
    // 2026-01-15T16:30:00Z is 00:30 on the 16th in Asia/Shanghai (UTC+8)
    const d = new Date('2026-01-15T16:30:00Z');
    assert.equal(minutesOfDayIn('Asia/Shanghai', d), 30);
    assert.equal(minutesOfDayIn('UTC', d), 16 * 60 + 30);
  });
  it('returns null for an invalid timezone', () => {
    assert.equal(minutesOfDayIn('Not/AZone', new Date()), null);
  });
});

// ── risk actions ─────────────────────────────────────────────────────────────

describe('pickMostSevere', () => {
  it('orders kick > mute > notify_admin > log_only', () => {
    assert.equal(pickMostSevere(['log_only']), 'log_only');
    assert.equal(pickMostSevere(['log_only', 'notify_admin']), 'notify_admin');
    assert.equal(pickMostSevere(['notify_admin', 'mute', 'log_only']), 'mute');
    assert.equal(pickMostSevere(['mute', 'kick', 'log_only']), 'kick');
  });
  it('defaults to log_only for an empty list', () => {
    assert.equal(pickMostSevere([]), 'log_only');
  });
});

describe('hasCardSegment', () => {
  it('returns true for a json segment', () => {
    assert.equal(hasCardSegment([{ type: 'json', data: {} }]), true);
  });
  it('returns true for a miniapp segment', () => {
    assert.equal(hasCardSegment([{ type: 'miniapp', data: {} }]), true);
  });
  it('returns true when a json segment is mixed with text', () => {
    assert.equal(hasCardSegment([{ type: 'text', data: { text: 'hi' } }, { type: 'json', data: {} }]), true);
  });
  it('returns false for plain text messages', () => {
    assert.equal(hasCardSegment([{ type: 'text', data: { text: 'hello' } }]), false);
  });
  it('returns false for an empty segment array', () => {
    assert.equal(hasCardSegment([]), false);
  });
});

describe('normalizeRuleAction', () => {
  it('passes valid actions through and falls back to mute', () => {
    assert.equal(normalizeRuleAction('kick'), 'kick');
    assert.equal(normalizeRuleAction('off'), 'off');
    assert.equal(normalizeRuleAction('DELETE * FROM'), 'mute');
    assert.equal(normalizeRuleAction(undefined), 'mute');
  });
});

// ── commands ─────────────────────────────────────────────────────────────────

const seg = {
  text: (t: string): OB11MessageSegment => ({ type: 'text', data: { text: t } }),
  at:   (qq: string): OB11MessageSegment => ({ type: 'at', data: { qq } }),
  reply: (): OB11MessageSegment => ({ type: 'reply', data: { id: '1' } }),
};

describe('extractCommandInput', () => {
  it('flattens text segments and collects at-mentions', () => {
    const input = extractCommandInput([seg.text('/guard mute '), seg.at('123456'), seg.text(' 10')], 'raw');
    assert.equal(input.text, '/guard mute  10');
    assert.deepEqual(input.atTargets, ['123456']);
    assert.equal(input.hasReply, false);
  });
  it('excludes at-all mentions and flags reply segments', () => {
    const input = extractCommandInput([seg.reply(), seg.at('all'), seg.text('/guard kick')], 'raw');
    assert.deepEqual(input.atTargets, []);
    assert.equal(input.hasReply, true);
  });
  it('falls back to raw_message when the segment array is empty', () => {
    const input = extractCommandInput([], '/guard help');
    assert.equal(input.text, '/guard help');
  });
});

describe('parseCommand', () => {
  it('parses name and args', () => {
    assert.deepEqual(parseCommand('/guard mute 123456 10', '/guard'), { name: 'mute', args: ['123456', '10'] });
    assert.deepEqual(parseCommand('  /guard STATUS  ', '/guard'), { name: 'status', args: [] });
  });
  it('bare prefix means help', () => {
    assert.deepEqual(parseCommand('/guard', '/guard'), { name: 'help', args: [] });
  });
  it('requires a word boundary after the prefix', () => {
    assert.equal(parseCommand('/guardian rocks', '/guard'), null);
    assert.equal(parseCommand('/guards', '/guard'), null);
  });
  it('ignores non-command text and empty prefixes', () => {
    assert.equal(parseCommand('hello world', '/guard'), null);
    assert.equal(parseCommand('/guard help', ''), null);
  });
});

describe('resolveTarget', () => {
  it('prefers the at-mention over numeric args', () => {
    assert.equal(resolveTarget({ atTargets: ['111111'] }, ['222222', '10']), '111111');
  });
  it('falls back to a 5-12 digit argument, skipping durations', () => {
    assert.equal(resolveTarget({ atTargets: [] }, ['10', '222222']), '222222');
    assert.equal(resolveTarget({ atTargets: [] }, ['10']), null);       // too short to be a QQ id
    assert.equal(resolveTarget({ atTargets: [] }, []), null);
  });
});

describe('resolveMinutes', () => {
  it('picks the first plausible duration and defaults to 10', () => {
    assert.equal(resolveMinutes(['123456', '30']), 30);  // 6-digit target is not a duration
    assert.equal(resolveMinutes(['123456']), 10);
    assert.equal(resolveMinutes([]), 10);
  });
  it('clamps zero to the 1-minute floor', () => {
    assert.equal(resolveMinutes(['0']), 1); // duration 0 would silently UNMUTE via set_group_ban
  });
  it('reaches the documented 30-day cap and clamps beyond it', () => {
    assert.equal(resolveMinutes(['43200']), 43200); // 30 days — 5-digit durations must parse
    assert.equal(resolveMinutes(['99999']), 43200); // out of range → clamped to the cap
  });
});

// ── welcome ──────────────────────────────────────────────────────────────────

describe('buildWelcomeSegments', () => {
  it('replaces {user} with an at segment and {group} with the group name', () => {
    const segs = buildWelcomeSegments('欢迎 {user} 加入 {group}！', '123', 'My Group', '456');
    assert.deepEqual(segs, [
      { type: 'text', data: { text: '欢迎 ' } },
      { type: 'at', data: { qq: '123' } },
      { type: 'text', data: { text: ' 加入 My Group！' } },
    ]);
  });
  it('prepends an at-mention when the template has no {user}', () => {
    const segs = buildWelcomeSegments('请阅读群公告', '123', 'G', '456');
    assert.deepEqual(segs[0], { type: 'at', data: { qq: '123' } });
    assert.equal((segs[2].data as { text: string }).text, '请阅读群公告');
  });
  it('falls back to the default template when empty, and to the group id when unnamed', () => {
    const segs = buildWelcomeSegments('   ', '123', '', '456');
    const text = segs.filter(s => s.type === 'text').map(s => (s.data as { text: string }).text).join('');
    assert.equal(text, DEFAULT_TEMPLATE.replace('{user}', '').replace('{group}', '456'));
  });
  it('handles multiple {user} placeholders', () => {
    const segs = buildWelcomeSegments('{user}{user}', '9', 'G', '1');
    assert.equal(segs.filter(s => s.type === 'at').length, 2);
  });
});

// ── rawToJsdelivr ─────────────────────────────────────────────────────────────
describe('rawToJsdelivr', () => {
  it('converts a standard GitHub raw URL to jsDelivr', () => {
    assert.equal(
      rawToJsdelivr('https://raw.githubusercontent.com/owner/repo/main/intel/feed.json'),
      'https://cdn.jsdelivr.net/gh/owner/repo@main/intel/feed.json',
    );
  });
  it('handles nested paths', () => {
    assert.equal(
      rawToJsdelivr('https://raw.githubusercontent.com/ShiYuPIay/napcat-plugin-qq-guardian/main/intel/feed.json'),
      'https://cdn.jsdelivr.net/gh/ShiYuPIay/napcat-plugin-qq-guardian@main/intel/feed.json',
    );
  });
  it('returns null for non-GitHub-raw URLs', () => {
    assert.equal(rawToJsdelivr('https://example.com/feed.json'), null);
  });
  it('returns null for an empty string', () => {
    assert.equal(rawToJsdelivr(''), null);
  });
});
