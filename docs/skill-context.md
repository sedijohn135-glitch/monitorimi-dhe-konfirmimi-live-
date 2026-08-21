# `skill_context` — the analysis skill's contract with the monitor

The analysis skill and this monitor each confirm things the other never
sees, and until now neither told the other. The skill reads HTF market
structure, classifies the trap phase, watches liquidity get swept and
sees the M5 structure shift print — often minutes **before** price
returns to the entry zone. The monitor then waits for the touch and
re-derives the same M5 sequence from scratch, so its confirmation lands
five to fifteen minutes after the move the analyst actually called.

`skill_context` closes that gap. It is an optional object on
`register_watch` carrying what the analysis already proved, and the
monitor uses it to decide **which live proof is required** and **how long
it must hold**.

It does not decide that no proof is required.

## The three rules that bound it

1. **A claim is never evidence.** The fast lane a context opens still
   demands a market-structure shift *and* a displacement, both carried by
   bars that closed **after** the touch. It moves that obligation from M5
   to M1; it never removes it. The evidence machine — acceptance plus a
   graduated technical signal — is untouched in every lane.
2. **Nothing here touches safety.** Stop loss, invalidation rule, expiry,
   spread anomaly, news blackout, kill zone and the price-scale
   falsification run exactly as they did before, in every lane, on every
   tick.
3. **Claims expire and are audited.** A context past its freshness window
   confers nothing. A context whose `htf_bias` disagrees with the
   direction it is attached to confers nothing at all. Every claim is
   written into the resolution record next to what the market then did.

Omit `skill_context` entirely and the monitor behaves exactly as it did
before it existed.

## The payload

```jsonc
{
  "symbol": "XAUUSD",
  "direction": "buy",
  "entry": 4330.0,
  "sl": 4310.0,
  "tp1": 4390.0,
  "entry_zone_low": 4328.0,
  "entry_zone_high": 4332.0,

  "skill_context": {
    // What the analysis proved, and when.
    "htf_mss_confirmed": true,
    "htf_mss_at": 4220.0,
    "htf_mss_at_ms": 1730000000000,

    "trap_phase": "delivery",          // accumulation|manipulation|distribution|delivery|unknown
    "trap_sub_type": "Type 1",
    "liquidity_swept": true,
    "liquidity_target": 4255.0,

    // The one claim that makes the post-touch M5 sequence a
    // re-derivation rather than a discovery.
    "m5_mss_already_observed": true,
    "m5_mss_at_ms": 1730001800000,

    "htf_bias": "bullish",             // bullish/bearish or buy/sell
    "conviction": "HIGH",              // HIGH|MEDIUM|LOW

    // How the monitor should treat this watch.
    "suggested_min_hold_ms": 15000,
    "suggested_max_age_ms": 180000,
    "skip_m5_sequence_if": "m5_mss_already_observed",
    "require_m1_only_if": "m5_mss_already_observed",

    "expected_displacement_tf": "M5",
    "analysis_at_ms": 1730001800000,
    "note": "London sweep of Asia low, delivery into NY AM"
  }
}
```

Every field is optional. Unknown keys are dropped.

### What each field buys

| Field | Effect |
|---|---|
| `conviction` | Only `HIGH` can shorten the confirmation hold. Anything unrecognised is read as `MEDIUM`. |
| `suggested_min_hold_ms` | Lengthening is **always** honoured. Shortening needs `HIGH` conviction, a non-adverse forward state, and never goes below the 15 s floor. |
| `suggested_max_age_ms` | How long the analysis stays fresh. Defaults to 3 min, capped at 15 min. Past it the context confers nothing. |
| `skip_m5_sequence_if` / `require_m1_only_if` | Names one of this context's own claims — `m5_mss_already_observed`, `htf_mss_confirmed`, `liquidity_swept`, or `always`. If that claim is true, the post-touch M5 sequence is replaced by M1 continuation. Defaults to `never`: **absent means nothing changes**. |
| `htf_bias` | Cross-checked against `direction`. Disagreement refuses the fast lane outright — the watch still runs. |
| `htf_mss_confirmed`, `trap_phase`, `liquidity_swept`, `liquidity_target`, `trap_sub_type`, `note` | Recorded and audited; they gate the fast lane only when a condition field names them. |
| `analysis_at_ms` | Anchors the freshness window. Defaults to the freshest timestamp in the context, then to registration time. |

Booleans must be an explicit `true`. `"false"`, `0`, `null` and absence
all mean the claim was not made, and a claim the skill did not make is
never read as one it did.

## What the monitor does with it, after the touch

Forward validation asks the one question the analysis could not: what did
price actually do after the touch? It is measured in **R** — multiples of
the entry-to-invalidation distance — from the entry.

| State | When | Effect |
|---|---|---|
| `WITHIN_ZONE` | price has moved less than 0.15R either way | standard M5 sequence; no fast lane |
| `FAVORABLE_EARLY` | ≥ 0.15R in favour | fast lane opens, pending M1 continuation |
| `STRONG_MOVE` | ≥ 0.5R in favour | fast lane; with `HIGH` conviction the hold drops to the floor |
| `STALE` | the freshness window closed with price still undecided | fast lane refused, one Telegram message, standard sequence continues |
| `FAILED` | ≥ 0.5R against | fast lane and hold shortening both revoked; safety still owns the stop |

**M1 continuation** is the fast lane's proof obligation and is checked on
every tick that could take it:

- at least 2 closed M1 bars since the touch (`SKILL_CONTEXT_M1_MIN_BARS`);
- an M1 market-structure shift whose breaking bar closed after the touch;
- an M1 displacement — a body at least 1.8× the recent average — on the
  latest closed bar.

All three, or the watch stays on the standard sequence. A watch that has
met them reports stage `M1_CONTINUATION_CONFIRMED`, and its execution
record names the lane rather than claiming an M5 sequence it never had.

### The lanes

| Lane | Reached when | Confirmation path |
|---|---|---|
| `STANDARD` | no context, an expired one, a refused one, or none requested | rejection → M5 MSS → displacement, 60 s hold |
| `M1_FAST` | context requested it, forward state favourable, M1 continuation proven | M1 MSS + M1 displacement, hold as configured |
| `SKILL_VALIDATED` | the same, plus `STRONG_MOVE` and `HIGH` conviction | M1 MSS + M1 displacement, hold at the 15 s floor |

In every lane the evidence machine still has to graduate: live acceptance
plus at least one technical signal, surviving both the hold and an M1 bar
boundary. The lanes change *which structural proof* is required and *how
long* it must hold — not whether proof is required.

## Reading the result back

`register_watch` returns a `skill_context` block reporting exactly what
the monitor accepted, including every clamp and refusal:

```jsonc
{
  "accepted": true,
  "conviction": "HIGH",
  "fast_lane_requested": true,
  "fast_lane_available": true,
  "fast_lane_refused_because": null,
  "freshness_window_ms": 180000,
  "hold_floor_ms": 15000,
  "effective_hold_ms": 15000,
  "warnings": null
}
```

A context that was silently clamped, dropped or refused would otherwise
look identical from the skill's side to one that was honoured. Read
`warnings` — it names the fields the monitor did not take at face value.

Structural nonsense is rejected loudly instead: a non-object
`skill_context`, or a numeric field that is not numeric, fails the whole
registration. Out-of-range values are clamped and reported.

## Closing the loop: `get_skill_context_audit`

Every watch registered with a context resolves with a
`skill_context_audit` record holding what was claimed, which lane the
entry came through, the forward state, the hold used, and the outcome.
`get_skill_context_audit` (also `GET /skill_context_audit`) aggregates
them:

```jsonc
{
  "summary": {
    "by_conviction": { "HIGH": { "total": 12, "executed": 9, "failed": 3 } },
    "by_lane": { "SKILL_VALIDATED": { "total": 5, "executed": 4, "failed": 1 } },
    "by_forward_state": { "STRONG_MOVE": { "total": 5, "executed": 4 } },
    "mean_touch_to_confirm_ms": 84000
  }
}
```

Verdicts read `skill_said_HIGH_but_failed`, `skill_said_LOW_and_confirmed`
and so on. `HIGH` that keeps resolving `FAILED` is a miscalibrated
conviction scale, not a monitor bug. `LOW` that keeps resolving
`CONFIRMED` is a conservative one. Compare `by_lane` before widening the
fast lane: it is only worth having if its outcomes match the standard
sequence's.

## Operator switches

| Variable | Default | Notes |
|---|---|---|
| `SKILL_CONTEXT_ENABLED` | `true` | `false` records contexts and audits them but lets none of them change anything |
| `SKILL_CONTEXT_FAST_LANE_ENABLED` | `true` | `false` keeps hold tuning but always requires the M5 sequence |
| `SKILL_CONTEXT_MIN_HOLD_FLOOR_MS` | `15000` | the shortest hold any context can buy; floor of 5000 |
| `SKILL_CONTEXT_M1_MIN_BARS` | `2` | closed M1 bars required since the touch |
| `SKILL_CONTEXT_FAVORABLE_R` | `0.15` | `FAVORABLE_EARLY` threshold |
| `SKILL_CONTEXT_STRONG_R` | `0.5` | `STRONG_MOVE` threshold |
| `SKILL_CONTEXT_ADVERSE_R` | `0.5` | `FAILED` threshold |

Both switches are read at boot. Turning the fast lane off is the
immediate response to a `by_lane` comparison that goes the wrong way; it
takes effect on the next tick of every active watch, including ones
already registered with a context.

## For the skill author

Add `skill_context` to the `register_watch` call your skill already
makes. Populate it from the analysis you have already done:

| Analysis output | Context field |
|---|---|
| HTF MSS on D1/H4/H1 | `htf_mss_confirmed`, `htf_mss_at`, `htf_mss_at_ms` |
| `trap_analysis.manipulation_phase` | `trap_phase` |
| `trap_analysis.trap_sub_type` | `trap_sub_type` |
| `primary_objective.level`, sweep status | `liquidity_target`, `liquidity_swept` |
| M5 MSS observed pre-touch | `m5_mss_already_observed`, `m5_mss_at_ms` |
| `bias` | `htf_bias` |
| `confidence` | `conviction` |
| `expected_displacement_tf` | `expected_displacement_tf` |

Then declare what you want it to mean. The conservative pairing, and the
one worth starting with:

```jsonc
"conviction": "HIGH",
"suggested_min_hold_ms": 15000,
"suggested_max_age_ms": 180000,
"skip_m5_sequence_if": "m5_mss_already_observed"
```

Send nothing you did not actually observe. The audit will tell on you,
and it is the same record you will want when calibrating the conviction
scale.
