/**
 * Cost-gate decision for the extract_atoms BudgetTracker.
 *
 * Split out of extract-atoms.ts so the decision is a pure, unit-testable
 * function and the phase file stays under the module-size cap. See the
 * "cost cap" comment at the tracker construction site in extract-atoms.ts
 * for the defect this closes.
 */

import { isAvailable, getEmbeddingModel } from '../ai/gateway.ts';
import { isModelPriceable, type PricingOverrides } from '../budget/budget-tracker.ts';
import { noPricingGuidance, noPricingMessage, pricingSetCommand, type NoPricingGuidance } from '../budget/no-pricing.ts';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { classifyRunStop, upsertExtractRollup } from '../extract/rollup-writer.ts';

/**
 * Cost-gate decision for the extract_atoms BudgetTracker.
 *
 * `enforceCap: true` → construct the tracker with `maxCostUsd`. `false` → run
 * uncapped (the tracker then warns once on unpriced models instead of throwing)
 * and `unpricedModel`/`unpricedKind` name the call that made the cap
 * unenforceable. `refusal` → a billable route is unpriced, so the run makes no
 * model call and reports the native `no_pricing` guidance. Pure: no config or
 * gateway access, so it is unit-testable.
 */
export interface ExtractAtomsCostGate {
  enforceCap: boolean;
  unpricedModel?: string;
  unpricedKind?: 'chat' | 'embed';
  /**
   * Which cap the unpriced route made unenforceable: `operator` = the operator
   * SET `cycle.extract_atoms.budget_usd`, `default` = the built-in cap. Carried
   * so the recorded receipt names the cap truthfully instead of implying the
   * operator chose one.
   */
  unpricedCapSource?: 'operator' | 'default';
  /**
   * A billable route is unpriced: refuse, with the no_pricing guidance. This is
   * the ONLY outcome for an unpriced route — there is no uncapped-run fallback
   * (see resolveExtractAtomsCostGate).
   */
  refusal?: NoPricingGuidance;
}

/**
 * Both models that bill under the extract_atoms tracker must be priceable for
 * a cap to be enforceable: the extraction chat model AND the embedding model
 * the atom import path calls (pass `null` when embedding is unavailable, in
 * which case the import runs with `noEmbed` and nothing embeds). Operator
 * `pricing.overrides` are consulted first, matching BudgetTracker.reserve().
 *
 * `explicitBudget` = the operator SET `cycle.extract_atoms.budget_usd`. It does
 * not decide WHETHER an unpriced route refuses — an explicit cap always refuses
 * (`do not duplicate its explicit-budget behavior` on the retained overlay) — it
 * only labels which cap was unenforceable, so the receipt and the doctor message
 * name the right one.
 *
 * `unpricedPolicy` is the caller's policy for an unpriced billable route under a
 * DEFAULT (non-explicit) cap:
 *
 *   - `refuse` (default): fail closed with the `no_pricing` guidance and zero
 *     model calls. extract_atoms takes this because it cannot account for the
 *     run otherwise — the tracker bills an unpriced served model at nothing, so
 *     `totalSpent` would under-report an uncapped run's real spend, and the
 *     phase's `estimated_spend_usd` would read like "$0, this route is free".
 *   - `uncapped`: drop the cap, warn once, and run (the pre-B11 behavior), for a
 *     caller that accounts for unknown spend itself instead of refusing. The
 *     Life Chronicle phase does exactly that (`unpriced_calls`, rows marked
 *     `unpriced: true`), so it opts out explicitly.
 *
 * Either way the gate never invents spend: a listed price/API-rate equivalent is
 * NOT an invoice charge, and no `pricing.overrides` row is written.
 */
export function resolveExtractAtomsCostGate(
  extractModel: string,
  embedModel: string | null,
  overrides?: PricingOverrides,
  opts: { explicitBudget?: boolean; unpricedPolicy?: 'refuse' | 'uncapped' } = {},
): ExtractAtomsCostGate {
  const unpriced: { model: string; kind: 'chat' | 'embed' } | null =
    !isModelPriceable(extractModel, 'chat', overrides) ? { model: extractModel, kind: 'chat' }
      : embedModel !== null && !isModelPriceable(embedModel, 'embed', overrides) ? { model: embedModel, kind: 'embed' }
        : null;
  if (!unpriced) return { enforceCap: true };
  const policy = opts.explicitBudget ? 'refuse' : (opts.unpricedPolicy ?? 'refuse');
  if (policy === 'uncapped') {
    return { enforceCap: false, unpricedModel: unpriced.model, unpricedKind: unpriced.kind };
  }
  return {
    enforceCap: true,
    unpricedModel: unpriced.model,
    unpricedKind: unpriced.kind,
    unpricedCapSource: opts.explicitBudget ? 'operator' : 'default',
    refusal: noPricingGuidance(unpriced.model, unpriced.kind),
  };
}

/** Config key holding the last refusal for a source; doctor's extract_health reads every one. */
export const ATOMS_NO_PRICING_KEY_PREFIX = 'cycle.extract_atoms.no_pricing.';

/** Who settles a gate: the phase name, its log label and where its refusal is recorded for doctor. */
export interface CostGateTarget {
  phase: 'extract_atoms' | 'chronicle';
  /** Config key prefix of the recorded refusal; the source id is appended. */
  keyPrefix: string;
  /** extract_atoms also counts the refusal in its extraction rollup. */
  rollup: boolean;
}

const ATOMS_TARGET: CostGateTarget = { phase: 'extract_atoms', keyPrefix: ATOMS_NO_PRICING_KEY_PREFIX, rollup: true };

/**
 * Act on the gate before any work item. Default-cap drop: warn and return
 * null (the run proceeds uncapped). Refusal: record it for doctor, count the
 * run as an expected limit (not a halt), and return the `warn` phase result
 * the caller returns as-is — no model call. Any run past the gate clears the
 * source's recorded refusal. A dry run records nothing. extract_atoms and the
 * Life Chronicle phase share this policy through `target`.
 */
export async function settleExtractAtomsCostGate(
  engine: BrainEngine,
  sourceId: string,
  gate: ExtractAtomsCostGate,
  run: { budgetCap: number; extractModel: string; dryRun: boolean },
  target: CostGateTarget = ATOMS_TARGET,
): Promise<PhaseResult | null> {
  const key = `${target.keyPrefix}${sourceId}`;
  if (!gate.refusal) {
    // No refusal: the gate is enforceable. `enforceCap: false` is kept as a
    // fallback shape for callers that build an ExtractAtomsCostGate directly;
    // resolveExtractAtomsCostGate no longer produces it for an unpriced route
    // (an unpriced billable model now always refuses), so this branch no longer
    // means "an unpriced route is running uncapped".
    if (!gate.enforceCap) {
      console.error(
        `[${target.phase}] ${gate.unpricedKind} model "${gate.unpricedModel}" is not in the pricing maps; ` +
          `running without a cost gate (a default cap cannot be enforced on an unpriced model). Look up its per-token price and register it to restore the cap: ` +
          `${pricingSetCommand(gate.unpricedModel!, gate.unpricedKind ?? 'chat')} (--rate 0 for local inference).`,
      );
    }
    if (!run.dryRun) await engine.unsetConfig(key).catch(() => 0);
    return null;
  }
  const message = noPricingMessage(gate.refusal, { capUsd: run.budgetCap });
  console.error(`[${target.phase}] ${message}`);
  const capSource = gate.unpricedCapSource ?? 'default';
  if (!run.dryRun) {
    await engine.setConfig(key, JSON.stringify({ ...gate.refusal, cap_source: capSource, at: new Date().toISOString() })).catch(() => {});
    if (target.rollup) await upsertExtractRollup(engine, { kind: 'atoms', source_id: sourceId, cost_delta: 0, ...classifyRunStop({ budget_exhausted: true }) });
  }
  return {
    phase: target.phase,
    status: 'warn',
    duration_ms: 0,
    summary: `${target.phase}: ${message}`,
    details: {
      reason: 'no_pricing',
      source_id: sourceId,
      no_pricing: gate.refusal,
      ...(target.phase === 'extract_atoms' ? { atoms_extracted: 0 } : {}),
      budget_usd: run.budgetCap,
      budget_exhausted: true,
      cap_source: capSource,
      model: run.extractModel,
      dry_run: run.dryRun,
    },
  };
}

/**
 * Doctor's extract_health overlay, applied in place: a recorded refusal turns
 * the check into a warning that names the model, what to look up and the
 * registration command.
 */
export function applyExtractAtomsNoPricing(
  check: { status: 'ok' | 'warn' | 'fail'; message: string; details?: Record<string, unknown> },
  refusals: Array<NoPricingGuidance & { source_id: string }>,
): void {
  if (refusals.length === 0) return;
  const first = refusals[0]!;
  if (check.status !== 'fail') check.status = 'warn';
  check.message = `extract_atoms refused under its cost cap in ${refusals.length} source(s): no price for ${first.model}. ` +
    `${first.lookup} Then run on the brain host: ${first.register_command}; ${check.message}`;
  check.details = { ...(check.details ?? {}), no_pricing: refusals };
}

/** Every source's recorded extract_atoms refusal, for doctor's extract_health. */
export async function readExtractAtomsNoPricing(engine: BrainEngine): Promise<Array<NoPricingGuidance & { source_id: string }>> {
  const out: Array<NoPricingGuidance & { source_id: string }> = [];
  for (const key of await engine.listConfigKeys(ATOMS_NO_PRICING_KEY_PREFIX)) {
    try {
      const value = JSON.parse((await engine.getConfig(key)) ?? '');
      if (value && value.code === 'no_pricing') out.push({ ...value, source_id: key.slice(ATOMS_NO_PRICING_KEY_PREFIX.length) });
    } catch { /* unreadable record: skip */ }
  }
  return out;
}

/**
 * The embedding model the atom import will bill under this phase's tracker,
 * or `null` when embedding is unavailable (the write site then passes
 * `noEmbed: true` and no embed call happens). Mirrors the write site's own
 * `isAvailable('embedding')` check so the gate and the import agree.
 */
export function resolveEmbedModelForCostGate(): string | null {
  try {
    return isAvailable('embedding') ? getEmbeddingModel() : null;
  } catch {
    return null;
  }
}
