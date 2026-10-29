/**
 * Bounded recovery for a truncated extract_atoms response.
 *
 * A gateway response stopped by the output cap (`stopReason === 'length'`) is
 * never parsed — `parseAtomsOutcome` rejects the whole response, because a
 * clipped JSON array can end mid-atom and the elements before the cut are a
 * PARTIAL extraction of the source. Publishing them would silently lose the
 * tail while the completion receipt marked the item done, which is the one
 * outcome this path must never produce.
 *
 * Recovery keeps that strictness and adds exactly ONE more paid call at a
 * larger output cap (`maxTokens * 2`, never above TRUNCATION_RETRY_MAX_TOKENS)
 * — the same single-escalation retry `facts/extract.ts` and
 * `cycle/propose-takes.ts` use for their truncation failures. Only the
 * RETRY's own response is parsed, and only when it terminated cleanly, so:
 *
 *   - Nothing from a clipped response is ever parsed or published. A retry
 *     that also clips (or refuses, or returns malformed output) leaves the
 *     item with no atoms at all, never the prefix of the first response.
 *   - The retry is bounded twice over: at most one per item per run, and the
 *     escalated cap is clamped to the ceiling. An item already at or above
 *     the ceiling gets no retry, because re-asking at the same cap would just
 *     clip again and bill for it.
 *   - The retry is budget-gated. The caller passes the phase's own headroom
 *     check, so recovery never buys a call the run cannot afford; with no
 *     headroom the truncation stands as the item's counted failure.
 *   - Failure stays visible. A still-truncated retry returns the strict
 *     failure outcome with the escalated cap (and the knob to raise) named in
 *     the reason, so the drain's `last_error`, the bounded failure streak and
 *     the managed failure receipt all keep reporting it.
 *
 * Chunking (re-extracting the source in halves and merging) is deliberately
 * NOT done here: each half would need its own quote-provenance base, and a
 * second half that clipped after the first parsed would publish a partial
 * extraction — the exact outcome this module exists to prevent.
 */
import { parseAtomsOutcome, type AtomsParseOutcome } from './extract-atoms-parse.ts';

/**
 * Hard ceiling for the escalated retry: twice the 4096-token default cap
 * (`DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS`). An operator who already raised
 * `cycle.extract_atoms.max_output_tokens` past this gets no retry — the
 * response was truncated at a cap this module refuses to double.
 */
export const TRUNCATION_RETRY_MAX_TOKENS = 8192;

/** The two fields of a chat result this module reads. */
export interface TruncationChatReply {
  text: string;
  stopReason?: string;
}

export interface TruncationRetryPlan {
  /** Whether one escalated call should be made. */
  retry: boolean;
  /** The cap to use for the retry; the caller's cap when `retry` is false. */
  maxTokens: number;
  /** Why the retry is or is not happening — rides the failure reason when skipped. */
  reason: string;
}

/**
 * Decide the single bounded retry for a truncated response. Pure: no I/O, no
 * clock, so the bound and the budget gate are directly testable.
 */
export function planTruncationRetry(input: {
  maxTokens: number;
  hasBudgetHeadroom: boolean;
}): TruncationRetryPlan {
  const base = Number.isFinite(input.maxTokens) ? Math.floor(input.maxTokens) : 0;
  const escalated = Math.min(base * 2, TRUNCATION_RETRY_MAX_TOKENS);
  if (!(escalated > base)) {
    return {
      retry: false,
      maxTokens: base,
      reason: `already at the ${TRUNCATION_RETRY_MAX_TOKENS}-token truncation-retry ceiling`,
    };
  }
  if (!input.hasBudgetHeadroom) {
    return {
      retry: false,
      maxTokens: base,
      reason: 'no budget headroom left for a truncation retry',
    };
  }
  return { retry: true, maxTokens: escalated, reason: `escalated ${base} -> ${escalated} output tokens` };
}

export interface TruncationRecoveryResult {
  /** The only outcome the caller may act on. Never derived from a clipped response. */
  outcome: AtomsParseOutcome;
  /** One escalated call was made. */
  retried: boolean;
  /** The retry produced parseable atoms (false for a zero-yield retry). */
  recovered: boolean;
  /** The cap the accepted/final response was requested at. */
  maxTokens: number;
  /** Escalation reason, or the reason no retry happened. */
  note?: string;
}

/** Append the recovery note to a stopped/malformed reason without changing its class. */
function withNote(outcome: AtomsParseOutcome, note: string): AtomsParseOutcome {
  if (outcome.ok) return outcome;
  return outcome.stopped
    ? { ok: false, stopped: true, reason: `${outcome.reason} (${note})` }
    : { ok: false, reason: `${outcome.reason} (${note})` };
}

/**
 * Run the extraction call once, and on a `length` stop make the one bounded
 * escalation above and re-parse. `hasBudgetHeadroom` is read AFTER the first
 * call (so it reflects that call's spend) and may be a thunk.
 */
export async function extractAtomsWithTruncationRetry(input: {
  /** One extraction call at the given output cap. */
  call: (maxTokens: number) => Promise<TruncationChatReply>;
  /** The phase's configured output cap for the first call. */
  maxTokens: number;
  /** The phase's own budget-headroom check, evaluated before the retry. */
  hasBudgetHeadroom: boolean | (() => boolean);
  /** Fired just before the escalated call (the phase logs its warning here). */
  onRetry?: (info: { from: number; to: number }) => void;
}): Promise<TruncationRecoveryResult> {
  const first = await input.call(input.maxTokens);
  const firstOutcome = parseAtomsOutcome(first.text, first.stopReason);
  // A `length` stop is not the only way a response arrives unusable: a call
  // that terminates normally but yields an unparseable array fails the same
  // page for the same reason (an emitter cut short by the output budget
  // without reporting it). Both get the one escalation; a parse failure that
  // persists is still reported as a failure.
  // Only a NORMAL stop is treated as a silent clip: a refusal, content filter
  // or other stop is a decision, and re-asking would bill for the same answer.
  const unparseable = first.stopReason === 'end' && !firstOutcome.ok;
  if (first.stopReason !== 'length' && !unparseable) {
    return { outcome: firstOutcome, retried: false, recovered: false, maxTokens: input.maxTokens };
  }

  const headroom = typeof input.hasBudgetHeadroom === 'function'
    ? input.hasBudgetHeadroom()
    : input.hasBudgetHeadroom;
  const plan = planTruncationRetry({ maxTokens: input.maxTokens, hasBudgetHeadroom: headroom });
  if (!plan.retry) {
    return {
      outcome: withNote(firstOutcome, `no truncation retry: ${plan.reason}`),
      retried: false,
      recovered: false,
      maxTokens: input.maxTokens,
      note: plan.reason,
    };
  }

  input.onRetry?.({ from: input.maxTokens, to: plan.maxTokens });
  const retry = await input.call(plan.maxTokens);
  const retryOutcome = parseAtomsOutcome(retry.text, retry.stopReason);
  if (retryOutcome.ok) {
    return {
      outcome: retryOutcome,
      retried: true,
      recovered: retryOutcome.atoms.length > 0,
      maxTokens: plan.maxTokens,
      note: plan.reason,
    };
  }
  // Still unusable: keep the failure class, but name the escalation so the
  // operator sees a bounded retry happened and what to raise.
  const note = `one truncation retry at maxTokens=${plan.maxTokens} did not produce a usable response; ` +
    'raise cycle.extract_atoms.max_output_tokens';
  return {
    outcome: withNote(retryOutcome, note),
    retried: true,
    recovered: false,
    maxTokens: plan.maxTokens,
    note,
  };
}
