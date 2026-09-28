/**
 * Scheduled curfew (宵禁) — automatic whole-group mute windows.
 *
 * Each group can define a daily [curfewStart, curfewEnd) window in the
 * configured timezone (core.timezone, default Asia/Shanghai — NOT server-local
 * time, because Docker hosts commonly run UTC while QQ members are UTC+8).
 * While inside the window the group is whole-group muted via
 * set_group_whole_ban; when the window ends the mute is lifted. Windows may
 * wrap past midnight (23:00 → 07:00).
 *
 * State rules (the subtle part):
 *  - We only ever call the OneBot API on a TRANSITION of the state we manage,
 *    tracked in an in-memory map of the last state we successfully applied.
 *    Steady state costs zero API calls, and a human admin's mid-window manual
 *    unban is not fought (no transition → no re-ban).
 *  - A failed API call does NOT record state, so the transition retries on
 *    the next tick — a free 30s retry loop.
 *  - First tick after boot: a curfew-enabled group is driven to its desired
 *    state in BOTH directions. Ban when inside the window (obvious), but also
 *    unban when outside it — a crash/unload during a past window would
 *    otherwise leave the group muted forever. Groups that never opted into
 *    curfew are never touched, so manual whole-group bans by human admins in
 *    those groups are never overridden.
 *  - A group leaving the managed set (curfewEnabled or the master protection
 *    toggle turned off) while our ban is active gets exactly one final unmute.
 *  - Invalid HH:MM strings behave as "curfew disabled" (flowing through the
 *    same final-unmute path), never as a frozen ban; warned once per group.
 */
import { configManager } from '../../core/config/index.ts';
import { resolveGroupConfig } from '../../core/config/group.ts';
import { callOneBot as callAction } from '../../runtime/host.ts';
import { bus } from '../../core/events/index.ts';
import { getLogger } from '../../core/logger/index.ts';
import type { OneBotId } from '../../types/onebot.ts';

const TICK_MS = 30_000;
const SHUTDOWN_UNMUTE_TIMEOUT_MS = 10_000;

let _timer: NodeJS.Timeout | null = null;
let _tickPromise: Promise<void> | null = null;
let _configChangedListener: (() => void) | null = null;
let _running = false;
let _generation = 0;
let _startEpoch = 0;
let _stopPromise: Promise<void> | null = null;
/** groupId → whole-group-ban state we last successfully applied */
const _lastApplied = new Map<OneBotId, boolean>();
/** groups already warned about an invalid time, to avoid a warn every 30s */
const _warnedInvalid = new Set<OneBotId>();

/** "HH:MM" → minutes since midnight, or null if not a strict 24h time. */
export function parseHHMM(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Whether `nowMinutes` (minutes since midnight) falls inside [start, end).
 * start > end means the window wraps past midnight. start === end is treated
 * as an empty window, never a 24h one — a 24h mute is a misconfiguration.
 */
export function isInCurfewWindow(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/** Minutes since midnight in the given IANA timezone, or null when invalid. */
export function minutesOfDayIn(timeZone: string, date: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const h = Number(parts.find(p => p.type === 'hour')?.value);
    const m = Number(parts.find(p => p.type === 'minute')?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m; // some engines format midnight as "24"
  } catch {
    return null;
  }
}

function isCurrent(generation: number): boolean {
  return _running && generation === _generation;
}

async function applyState(generation: number, groupId: OneBotId, enable: boolean, curfewEnd: string): Promise<void> {
  if (!isCurrent(generation)) return;
  const log = getLogger().child({ module: 'curfew' });
  const prev = _lastApplied.get(groupId);
  await callAction('set_group_whole_ban', { group_id: String(groupId), enable });

  // A OneBot action can finish after shutdown begins. Preserve a successful
  // mute long enough for shutdown to lift it, but do not emit stale effects.
  _lastApplied.set(groupId, enable);
  if (!isCurrent(generation)) return;
  log.info({ group_id: groupId, enable }, enable ? 'Curfew started — whole-group mute on' : 'Curfew ended — whole-group mute lifted');
  bus.emit('AuditCreated', {
    action: enable ? 'curfew.start' : 'curfew.end',
    actorId: null, targetType: 'group', targetId: String(groupId),
    details: { enable }, timestamp: Date.now(),
  });

  // Announce inside the group so members know why they are (un)muted.
  // Boot-time transitions (prev === undefined) are silent in BOTH directions:
  // an unban outside the window usually confirms an already-unmuted group,
  // and a re-ban inside the window would re-announce 宵禁开始 to an
  // already-muted group on every NapCat restart during curfew hours.
  if (enable && prev !== undefined) {
    await callAction('send_group_msg', {
      group_id: String(groupId),
      message: [{ type: 'text', data: { text: `🌙 宵禁开始，全群禁言至 ${curfewEnd}。` } }],
    }).catch(() => {});
  } else if (prev === true) {
    await callAction('send_group_msg', {
      group_id: String(groupId),
      message: [{ type: 'text', data: { text: '☀️ 宵禁结束，已解除全群禁言。' } }],
    }).catch(() => {});
  }
}

async function tick(generation: number): Promise<void> {
  if (!isCurrent(generation)) return;
    // Config is read fresh every tick — configManager.update() replaces the
    // object, so a captured reference would go permanently stale.
    const cfg = configManager.get();
    const log = getLogger().child({ module: 'curfew' });
    const nowMinutes = minutesOfDayIn(cfg.core.timezone, new Date())
      ?? new Date().getHours() * 60 + new Date().getMinutes();

    for (const gidStr of Object.keys(cfg.approval.groups)) {
      if (!isCurrent(generation)) return;
      const groupId = gidStr;
      const groupCfg = resolveGroupConfig(cfg, groupId);

      let desired = false;
      if (groupCfg.enabled && groupCfg.curfewEnabled) {
        const start = parseHHMM(groupCfg.curfewStart);
        const end = parseHHMM(groupCfg.curfewEnd);
        if (start === null || end === null) {
          // Fail safe: behave as "no curfew" so an already-applied ban is
          // lifted below rather than frozen in place.
          if (!_warnedInvalid.has(groupId)) {
            _warnedInvalid.add(groupId);
            log.warn({ group_id: groupId, start: groupCfg.curfewStart, end: groupCfg.curfewEnd }, 'Invalid curfew time — treating curfew as disabled');
          }
        } else {
          _warnedInvalid.delete(groupId);
          desired = isInCurfewWindow(nowMinutes, start, end);
        }
      } else if (!_lastApplied.get(groupId)) {
        // Curfew not active for this group and we never banned it (or already
        // lifted our ban) — nothing to manage. Record false without an API
        // call so a manual admin ban is never overridden.
        _lastApplied.set(groupId, false);
        continue;
      }

      if (_lastApplied.get(groupId) === desired) continue;
      try {
        await applyState(generation, groupId, desired, groupCfg.curfewEnd);
      } catch (e) {
        // State intentionally NOT recorded — the transition retries next tick.
        log.error({ group_id: groupId, desired, error: String(e) }, 'Failed to apply curfew state');
      }
    }
}

function scheduleTick(generation: number): Promise<void> {
  if (!isCurrent(generation)) return Promise.resolve();
  if (_tickPromise) return _tickPromise;

  const task = tick(generation).catch((error) => {
    getLogger().child({ module: 'curfew' }).error(error, 'Curfew scheduler tick failed');
  });
  _tickPromise = task;
  void task.then(
    () => { if (_tickPromise === task) _tickPromise = null; },
    () => { if (_tickPromise === task) _tickPromise = null; },
  );
  return task;
}

async function callBeforeDeadline(action: string, params: Record<string, unknown>, deadline: number): Promise<void> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error('OneBot action skipped because the shutdown deadline elapsed');

  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      callAction(action, params),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`OneBot action timed out before the ${SHUTDOWN_UNMUTE_TIMEOUT_MS}ms shutdown deadline`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function unmuteManagedGroups(): Promise<void> {
  const log = getLogger().child({ module: 'curfew' });
  const managedMutedGroups = [..._lastApplied]
    .filter(([, enabled]) => enabled)
    .map(([groupId]) => groupId);
  const deadline = Date.now() + SHUTDOWN_UNMUTE_TIMEOUT_MS;

  await Promise.all(managedMutedGroups.map(async (groupId) => {
    try {
      // Deliberately silent: this is shutdown recovery, not a scheduled end.
      // Every group shares one deadline, so a stalled endpoint cannot spend
      // the service-manager stop budget one group at a time.
      await callBeforeDeadline('set_group_whole_ban', { group_id: String(groupId), enable: false }, deadline);
      _lastApplied.set(groupId, false);
      bus.emit('AuditCreated', {
        action: 'curfew.end',
        actorId: null,
        targetType: 'group',
        targetId: String(groupId),
        details: { enable: false, reason: 'plugin_shutdown' },
        timestamp: Date.now(),
      });
      log.info({ group_id: groupId }, 'Lifted Guardian-managed curfew during shutdown');
    } catch (error) {
      // Continue with every other group. A failed unmute is visible in logs
      // and never prevents lifecycle cleanup for unrelated resources.
      log.warn({ group_id: groupId, error: String(error) }, 'Could not lift Guardian-managed curfew during shutdown');
    }
  }));
}

export async function initCurfewModule(): Promise<void> {
  const startEpoch = ++_startEpoch;
  await stopCurfewModuleInternal(false); // guard against double-start on hot-reload
  // An external lifecycle stop that arrived while the prior scheduler was
  // draining wins over this initialization attempt.
  if (startEpoch !== _startEpoch) return;
  _running = true;
  const generation = ++_generation;
  _timer = setInterval(() => { void scheduleTick(generation); }, TICK_MS);
  // React to WebUI toggles immediately instead of waiting for the next tick.
  _configChangedListener = () => { void scheduleTick(generation); };
  bus.on('ConfigChanged', _configChangedListener);
  await scheduleTick(generation); // drive groups to their desired state immediately at boot
}

/**
 * Stops scheduling first, waits for an in-flight transition, then lifts only
 * whole-group mutes that Guardian itself successfully applied. Lifecycle
 * awaits this before releasing the OneBot host or SQLite audit listener.
 */
async function stopCurfewModuleInternal(invalidateStart: boolean): Promise<void> {
  if (invalidateStart) _startEpoch += 1;
  if (_stopPromise) return _stopPromise;
  _running = false;
  _generation += 1;
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_configChangedListener) {
    bus.off('ConfigChanged', _configChangedListener);
    _configChangedListener = null;
  }

  const inFlightTick = _tickPromise;
  const task = (async () => {
    // A tick that has already sent a mute must finish and record its result
    // before shutdown picks the final unmute set, otherwise a late mute could
    // win the race after cleanup.
    if (inFlightTick) await inFlightTick;
    await unmuteManagedGroups();
    _lastApplied.clear();
    _warnedInvalid.clear();
  })();
  _stopPromise = task;
  try {
    await task;
  } finally {
    if (_stopPromise === task) _stopPromise = null;
  }
}

export async function stopCurfewModule(): Promise<void> {
  await stopCurfewModuleInternal(true);
}
