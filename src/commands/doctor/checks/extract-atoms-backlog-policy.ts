/**
 * Policy-aware `extract_atoms_backlog` doctor check.
 *
 * A schema pack that does not declare `extract_atoms` is a normal shape, and
 * the phase gate deliberately never infers intent from absence alone. Two
 * operator keys state the absence is deliberate instead of an unobserved leak:
 *
 *   - `cycle.extract_atoms.enabled=false` — the explicit "no" to the paid
 *     phase (the counterpart of the consent command the gate names);
 *   - `autopilot.auto_drain.enabled=false` — automatic atom extraction off.
 *     Only meaningful when the pack does not declare the phase at all: a
 *     declaring pack still runs it in its cycle (or waits for consent).
 *
 * With one of those, the pending pages are a deferred queue: doctor reports
 * `ok` + `severity: info` + `readiness_state: disabled_by_choice` with the
 * pending count and the on-demand drain command, instead of the #1678
 * warning. Without one, the warning path is unchanged. Nothing here infers a
 * rate, extracts, or writes; it reads config and formats one check.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';

export type ExtractAtomsDeferralReason = 'phase_disabled_by_config' | 'auto_drain_disabled';

export interface ExtractAtomsDeferralPolicy {
  deferred: boolean;
  reason?: ExtractAtomsDeferralReason;
  /** The config key that states the policy, for the message and details. */
  key?: string;
}

/**
 * Resolve the explicit deferral policy. Fail-open: an unreadable config is "no
 * policy stated", so the caller keeps the #1678 warning rather than hiding a
 * real backlog behind a guess.
 */
export async function resolveExtractAtomsDeferralPolicy(
  engine: Pick<BrainEngine, 'getConfig'>,
  opts: { packDeclaresPhase: boolean; packResolutionFailed?: boolean },
): Promise<ExtractAtomsDeferralPolicy> {
  try {
    const phase = (await engine.getConfig('cycle.extract_atoms.enabled'))?.trim().toLowerCase();
    if (phase === 'false') {
      return { deferred: true, reason: 'phase_disabled_by_config', key: 'cycle.extract_atoms.enabled' };
    }
    // A declaring pack is not an absent phase: its own branch judges the
    // backlog, so a global auto-drain opt-out must not mask that warning. A
    // pack that failed to resolve is not evidence of deliberate absence
    // either; schema_pack_active owns that failure.
    if (opts.packDeclaresPhase || opts.packResolutionFailed) return { deferred: false };
    const drain = (await engine.getConfig('autopilot.auto_drain.enabled'))?.trim().toLowerCase();
    if (drain === 'false') {
      return { deferred: true, reason: 'auto_drain_disabled', key: 'autopilot.auto_drain.enabled' };
    }
    return { deferred: false };
  } catch {
    return { deferred: false };
  }
}

/**
 * The ok/info check for a backlog the operator's policy defers. `drain` is the
 * on-demand command (paid); it is a hint, not an automatic fix, because the
 * policy itself is the operator's choice and the pack must declare the phase
 * before a cycle can run it.
 */
export function buildExtractAtomsDeferredCheck(args: {
  backlog: number;
  backlogBySource: Array<{ source_id: string; backlog: number }> | null;
  drain: string;
  policy: ExtractAtomsDeferralPolicy;
  approx: string;
}): Check {
  const { backlog, backlogBySource, drain, policy, approx } = args;
  const stated = `${policy.key}=false`;
  return {
    name: 'extract_atoms_backlog',
    status: 'ok',
    severity: 'info',
    readiness_state: 'disabled_by_choice',
    message:
      `${backlog} page(s) pending atom extraction, deferred by policy (${stated}). ` +
      `The active pack does not run extract_atoms, so none are extracted automatically. ` +
      `Drain on demand: ${drain}`,
    details: {
      backlog,
      backlog_by_source: backlogBySource ?? undefined,
      pack_declares_phase: false,
      deferred_by_policy: true,
      policy: { state: 'deferred', reason: policy.reason, key: policy.key },
      fix_hint: drain,
      known_approximation: approx,
    },
  };
}
