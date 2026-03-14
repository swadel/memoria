# Memoria AI Grouping Enhancement — Planning Support

## Purpose

This document supports planning and implementation of backend-only enhancements to Memoria's AI-assisted event grouping pipeline. It is intended to align tightly with Memoria's existing workflow, stack, data flow, and non-destructive design.

This plan assumes the current Memoria application behavior remains intact:
- media is indexed into `/staging/`
- excluded items are moved to `/recycle/`
- finalization copies grouped items into `/organized/<year>/<year - event>/`
- the source/input folder remains unchanged
- the user remains in control through the existing guided phase-based flow

The goal is to improve AI-driven event naming and grouping quality while preserving Memoria's deterministic, auditable, phase-based architecture.

---

## Alignment with the Current Memoria Architecture

From the current README, Memoria is:
- a Windows-first desktop app built with **Tauri 2.0**, **Rust**, **React 18 + TypeScript**, **Tailwind**, and **SQLite via rusqlite**
- organized around a guided phase-based pipeline: **Index Media → Image Review → Video Review → Date Enforcement → Group → Finalize → Reset Session**
- intentionally **non-destructive**, with organized files copied into `/organized/` during finalize rather than moving source originals
- already using AI for **date estimation** and **event naming**
- already grouping **`date_verified`** items by time proximity and allowing users to review and rename event groups before finalize
- already enforcing deterministic naming for misc/holiday-like groups and using AI suggestions for larger clusters fileciteturn0file0L1-L20 fileciteturn0file0L33-L44 fileciteturn0file0L104-L119

This means the recommended enhancement should **not** reinvent Memoria's flow. Instead, it should:
1. stay inside the existing **Group** phase
2. preserve the current **Finalize** behavior of copying grouped items into `/organized/<year>/<year - event>/`
3. extend the current AI event naming logic into a more structured, testable, multi-step backend pipeline
4. remain compatible with the existing review/rename workflow in Event Group Review fileciteturn0file0L45-L53 fileciteturn0file0L106-L118

---

## Recommended High-Level Direction

### Core Recommendation

Introduce a **backend-only, two-pass AI grouping architecture** inside the existing **Group** phase.

### Why this fits Memoria well

Memoria already:
- clusters by time proximity
- tracks pipeline state in SQLite
- uses audit-friendly, deterministic phases
- separates staging/grouping/finalization
- supports user review before final filing

A two-pass architecture improves the quality of AI suggestions without requiring a frontend redesign.

### Pass 1 — Metadata Derivation
Derive structured event cues from a candidate cluster or from representative assets within a cluster.

### Pass 2 — Event Naming / Group Decision
Use the structured cues plus cluster-level context to generate a deterministic folder/event name and confidence.

This is an enhancement to the **existing AI event naming step**, not a replacement for the broader Memoria pipeline.

---

## Important Constraints for the Plan

1. **Backend only**
   - No UI changes are required for the first implementation.
   - Existing Event Group Review remains the user-facing review surface.

2. **Small, incremental steps**
   - Each step should be independently testable.
   - No broad refactor unless clearly necessary.

3. **Use Memoria's existing non-destructive behavior**
   - Do not redesign finalize into move operations.
   - Keep source folder untouched.
   - Keep finalize as copy into `/organized/<year>/<year - event>/`.

4. **Preserve current deterministic grouping flow**
   - Existing time-window grouping remains the initial cluster generator.
   - AI enhances naming and ambiguous clustering behavior.

5. **Settings alignment**
   - There is currently one model setting for image categorization/event naming in the app.
   - Add backend support for a **secondary fallback model** setting.
   - This should be backward compatible.

6. **Folder naming rule**
   - The target folder naming format is:
     `YYYY - OptionalLocation EventName`
   - Full dates should **not** appear in folder names.
   - Examples:
     - `2025 - Chicago Family Vacation`
     - `2024 - Home Christmas Morning`
     - `2023 - Yellowstone Wildlife Trip`
     - `2022 - Soccer Tournament`
     - `2025 - Birthday Party`

---

## What Should Happen to the Existing Prompt

### Recommendation
The current prompt should **not** remain the only grouping prompt.

It should be:
- **revised**, and
- used specifically as the basis for the **second-pass event naming prompt**.

### Why
The current prompt is good at:
- naming a likely event from a sampled set of photos
- encouraging specificity
- emitting compact JSON

But it is weak for:
- deterministic backend routing
- typed schema evolution
- fallback model decisions
- ambiguity handling beyond `high|medium|low`
- explicit compliance with Memoria's folder naming format
- safe handling of name inference
- future testing of intermediate AI outputs

### Best use going forward
- **Pass 1 prompt**: produce structured event cues and metadata
- **Pass 2 prompt**: produce final event/folder name and confidence for a candidate cluster

---

## Recommended Backend Design

## 1. Preserve Current Time-Based Cluster Creation
Memoria already groups `date_verified` items by time proximity. Keep this as the first deterministic step. fileciteturn0file0L106-L113

Recommended sequence inside the Group phase:
1. Query all active `date_verified` items
2. Apply the existing grouping time window logic
3. Produce initial candidate clusters deterministically
4. Run AI enrichment on clusters that meet configurable thresholds
5. Persist the final suggested event group metadata
6. Continue to the existing Event Group Review screen for user review/rename/reassignment

This keeps the AI role bounded and testable.

## 2. Introduce a Two-Pass AI Service Layer
Add or extend a Rust backend service under the grouping/business logic layer to separate:
- deterministic clustering
- AI metadata derivation
- AI event naming
- persistence of AI results

Suggested backend service seams:
- `grouping_cluster_service` — existing/proximate deterministic clustering logic
- `grouping_ai_metadata_service` — pass 1 AI metadata derivation
- `grouping_ai_naming_service` — pass 2 AI naming
- `grouping_decision_service` — routing, confidence thresholds, fallback, prompt selection
- `grouping_persistence_service` — saves outputs to DB and audit/log fields

These names are illustrative. Align with existing Rust service patterns in `src-tauri/src/services/`. fileciteturn0file0L214-L224

## 3. Keep Filesystem Actions Separate from AI
The Group phase should only decide and persist group membership and event naming metadata.

Finalize already copies grouped items into:
`/organized/<year>/<year - event>/` fileciteturn0file0L120-L128

That means:
- AI should not perform file IO decisions directly
- AI should output typed event suggestions
- existing finalize logic should consume reviewed/approved groups as it does today

## 4. Add Secondary Fallback Model Support
Memoria currently routes AI tasks across providers for date estimation and event naming. The README explicitly notes OpenAI/Anthropic routing. fileciteturn0file0L73-L80

This aligns well with adding:
- `primary_grouping_model`
- `fallback_grouping_model`

Fallback should be invoked for:
- low-confidence primary result
- unresolved ambiguity
- empty/invalid primary schema output after bounded retry
- conflict rules if implemented in a later phase

## 5. Persist Intermediate AI Outputs
Because Memoria is already audit-oriented and stateful in SQLite, the AI enhancement should persist intermediate structured outputs where useful.

At minimum, persist:
- prompt version
- model used
- pass 1 result JSON (or normalized columns if preferred)
- pass 2 result JSON (or normalized columns if preferred)
- confidence
- fallback_used boolean
- timestamp

This will dramatically improve observability and regression testing.

---

## Proposed Data Contract Direction

These are planning-level contracts. The implementation can choose whether to store them as normalized SQLite columns, JSON blobs with schema versioning, or a mixed model.

## Pass 1 — Cluster Metadata Contract

Purpose: derive structured event clues from a candidate cluster before naming.

```json
{
  "schema_version": "1",
  "cluster_id": "string",
  "year": 2025,
  "date_range": {
    "start": "2025-07-01",
    "end": "2025-07-04",
    "day_count": 4
  },
  "asset_count": 128,
  "sampled_asset_ids": ["a1", "a2", "a3"],
  "location_available": true,
  "location_hint": "Chicago, IL",
  "scene_signals": [
    "waterfront",
    "family gathering",
    "city skyline",
    "fireworks"
  ],
  "event_candidates": [
    "Fourth of July",
    "Family Vacation",
    "City Trip"
  ],
  "location_candidates": [
    "Chicago",
    "Navy Pier"
  ],
  "holiday_candidates": [
    "Fourth of July"
  ],
  "activity_candidates": [
    "fireworks",
    "family outing"
  ],
  "dominant_context": "holiday",
  "people_focus": "family",
  "naming_confidence": "medium",
  "reasoning": "Repeated summer outdoor waterfront scenes and fireworks strongly suggest a Fourth of July family outing.",
  "needs_fallback": false
}
```

## Pass 2 — Final Event Naming Contract

Purpose: produce the final deterministic event/folder name suggestion for a candidate group.

```json
{
  "schema_version": "1",
  "cluster_id": "string",
  "folder_name": "2025 - Chicago Fourth of July",
  "confidence": "high",
  "event_type": "holiday",
  "location_used": "Chicago",
  "reasoning": "The cluster spans early July and repeatedly shows waterfront fireworks and family gathering scenes.",
  "needs_fallback": false
}
```

## Minimal Alternative
If a smaller first increment is needed, introduce only the pass 2 contract first, and keep pass 1 as an internal prompt output not yet persisted. That is the safest stepping stone.

---

## Recommended Prompt Design

## Pass 1 Prompt — Cluster Metadata Derivation

Use this to derive structured event cues from a candidate cluster sampled from Memoria's existing time-based grouping.

```text
You are assisting a desktop photo organization application named Memoria.

Memoria already grouped these assets into a candidate event cluster using deterministic time-proximity rules after date verification. Your job is NOT to move files or create folders. Your job is to analyze the provided representative assets and cluster context, then return structured event clues that will later be used for deterministic event naming.

You are given:
- a sample of representative images and/or video keyframes from one candidate cluster
- the cluster year
- the cluster date range
- the total asset count in the cluster
- whether location data exists
- an optional location hint

Important rules:
- Be specific but conservative.
- Do not invent personal names from faces.
- Only use a location when it is strongly supported by the provided metadata/context.
- Prefer concrete event clues over generic labels.
- If the event is ambiguous, return multiple plausible event candidates.
- Output valid JSON only.
- Do not include markdown.
- Do not include explanatory text outside the JSON.

Return JSON in exactly this shape:
{
  "schema_version": "1",
  "dominant_context": "holiday|birthday|vacation|sports|school|family|anniversary|graduation|misc|other",
  "scene_signals": ["string"],
  "event_candidates": ["string"],
  "location_candidates": ["string"],
  "holiday_candidates": ["string"],
  "activity_candidates": ["string"],
  "people_focus": "family|individual|mixed|unknown",
  "naming_confidence": "high|medium|low",
  "reasoning": "One sentence explaining the strongest visual/contextual clues.",
  "needs_fallback": true
}
```

## Pass 2 Prompt — Final Event Naming

Use this as the revised version of the current event naming prompt.

```text
You are assisting a desktop photo organization application named Memoria.

Memoria already grouped these assets into a candidate event cluster using deterministic time-proximity rules after date verification. Your job is to identify the most likely real-world event or occasion represented by this candidate cluster and return a deterministic folder/event name suggestion.

You are given:
- a representative sample of assets from one candidate cluster
- the cluster year
- the cluster date range
- the total number of assets
- whether location data exists
- an optional location hint
- optional structured event clues from a previous analysis pass

Folder naming requirements:
- Output folder_name in this exact format:
  YYYY - OptionalLocation EventName
- Use the year only, not full dates.
- If a reliable location is known and materially improves specificity, include it.
- If location is not reliable or not useful, omit it cleanly.
- Examples:
  2025 - Chicago Family Vacation
  2024 - Home Christmas Morning
  2023 - Yellowstone Wildlife Trip
  2022 - Soccer Tournament
  2025 - Birthday Party

Rules:
- Be specific, not generic.
- Prefer a concrete event or occasion over broad categories.
- Use visual cues such as cakes, candles, decorations, costumes, holiday themes, sports settings, school settings, landmarks, beaches, mountains, restaurants, animals, signs, and repeated environments.
- Use contextual cues such as trip length, date clustering, repeated people/settings, weather/seasonal signals, and location hints.
- Use standard names for major holidays when appropriate: Christmas, Thanksgiving, Fourth of July, Easter, Halloween.
- Use standard names for recurring personal events when appropriate: Birthday Party, Anniversary, Graduation, Family Vacation, School Event, Soccer Tournament.
- Do not invent personal names from appearance alone.
- If the event is ambiguous but still has a likely category, choose the most specific defensible name.
- If truly ambiguous after careful analysis, use:
  YYYY - Misc
- Output valid JSON only.
- Do not include markdown.
- Do not include explanatory text outside the JSON.

Return JSON in exactly this shape:
{
  "schema_version": "1",
  "folder_name": "YYYY - OptionalLocation EventName",
  "confidence": "high|medium|low",
  "event_type": "holiday|birthday|vacation|sports|school|family|anniversary|graduation|misc|other",
  "location_used": "string or null",
  "reasoning": "One sentence explaining the strongest visual/contextual cues behind the result.",
  "needs_fallback": true
}
```

---

## Incremental Implementation Strategy

The planning prompt should direct the agent to recommend minimal-risk delivery. A good target sequence is:

### Phase 0 — Baseline Discovery / Smallest Safe Step
- document the current grouping flow in code
- identify the existing event naming service/prompt boundary
- identify the current settings model and persistence path
- identify the finalize dependency on event/folder names
- confirm where AI provider routing already exists

### Phase 1 — Prompt/Contract Tightening Only
- keep the current grouping flow
- replace or wrap the current naming prompt with the revised pass 2 prompt
- add strict schema validation for pass 2 output
- add tests for deterministic naming format and fallback behavior on invalid output

This is likely the safest first implementation.

### Phase 2 — Add Secondary Fallback Model Support
- add backend config/settings support for fallback model
- keep primary model behavior unchanged by default
- invoke fallback on schema failure / low confidence / bounded retry rules
- add tests for missing fallback config, fallback success, and fallback disagreement logging

### Phase 3 — Add Pass 1 Metadata Derivation
- introduce pass 1 prompt and orchestration
- persist or at least validate pass 1 structured output
- feed pass 1 result into pass 2
- add fixtures and regression tests

### Phase 4 — Persist AI Observability / Versioning
- record prompt version, pass results, model used, confidence, and fallback flag
- make outputs easy to inspect in logs / DB

### Phase 5 — Ambiguous Cluster Handling Improvements
- add conservative rules for ambiguous clusters
- refine misc handling
- add stronger duplicate folder-name collision rules

---

## Testing Guidance

The planning prompt should require tests for every phase.

## Unit Tests
- naming format validation (`YYYY - OptionalLocation EventName`)
- schema validation for pass 1 and pass 2 outputs
- confidence routing behavior
- fallback routing behavior
- invalid/empty model result handling
- deterministic misc naming
- sanitization of filesystem-invalid characters

## Integration Tests
- deterministic cluster → AI naming → persisted group record flow
- finalize compatibility with revised folder names
- backward compatibility when only primary model is configured
- fallback model path when primary returns low confidence or invalid JSON

## Manual Validation
Use representative real-world clusters:
- holiday cluster
- birthday cluster
- travel/vacation cluster
- sports cluster
- school event cluster
- ambiguous/misc cluster
- cluster with no location data
- cluster with location data that should not be used
- mixed video/photo cluster if supported by the current grouping sample flow

## Regression Checks
- no change to phase order
- no change to existing Event Group Review behavior
- no change to finalize copy behavior
- no change to soft-delete/recycle behavior
- no UI changes required

---

## Additional Design Considerations the Planner Should Include

1. **Folder collision policy**
   - If multiple clusters resolve to the same `YYYY - EventName`, define whether they merge, suffix, or flag.

2. **Destination copy idempotency**
   - Finalize already copies files. Reruns should not repeatedly create broken duplicate organized output.

3. **Prompt versioning**
   - Store a prompt/version identifier with AI-generated naming results.

4. **Schema versioning**
   - Start schema versioning immediately for pass outputs.

5. **Sampling strategy**
   - Define how representative assets are selected from a cluster, especially for large clusters.

6. **Provider abstraction alignment**
   - Since the stack already supports OpenAI/Anthropic routing, plan should integrate with the current provider abstraction rather than introducing a parallel model client.

7. **Cost cap behavior**
   - Memoria already has an AI cost cap setting. The plan should ensure pass 1/pass 2/fallback behavior remains aligned with the existing cost cap logic. fileciteturn0file0L170-L176

8. **Runtime logging alignment**
   - Memoria already emits backend logs for long-running operations. The grouping enhancement should extend that logging pattern rather than inventing a separate mechanism. fileciteturn0file0L177-L188

---

## Recommended Planning Prompt

Use the following prompt in Cursor's planning agent context.

```text
You are helping plan backend-only enhancements to Memoria's existing AI-assisted event grouping pipeline.

Memoria is a Windows-first desktop application with a guided, phase-based workflow. It uses Tauri 2.0 with a Rust backend, React 18 + TypeScript frontend, SQLite via rusqlite, bundled exiftool/ffmpeg, and existing OpenAI/Anthropic routing for AI tasks. The current pipeline is: Index Media → Image Review → Video Review → Date Enforcement → Group → Finalize → Reset Session. Finalize copies grouped items into `/organized/<year>/<year - event>/`. The source/input folder remains unchanged. Event Group Review already exists as the user-facing review/rename/reassignment surface. This work must align tightly with that architecture and flow.

I want a cautious, backend-only, incremental plan. Do not propose UI changes. Do not propose broad refactors unless they are clearly required. The goal is to improve grouping quality, event naming consistency, AI resiliency, fallback behavior, observability, and testability while preserving Memoria's deterministic and auditable design.

Key constraints and goals:
- Backend only. No UI changes.
- Small incremental steps only.
- Each phase must be fully implemented, tested, and manually validated before moving to the next.
- Keep Memoria's existing non-destructive behavior.
- Do not redesign finalize into move operations.
- Keep the source/input folder unchanged.
- Keep finalize as copy into `/organized/<year>/<year - event>/`.
- Preserve the existing phase flow and Event Group Review flow.
- Memoria already groups `date_verified` items by time proximity. Keep that deterministic grouping step.
- My app currently has one model setting for image categorization / event naming. Include adding backend support for a secondary fallback model setting.
- Folder naming format must be:
  YYYY - OptionalLocation EventName
- Do not include full dates in folder names.
- If location is not reliable or not useful, omit it cleanly.
- The plan should align with existing OpenAI/Anthropic routing, SQLite statefulness, runtime logging, and AI cost cap behavior.

There is an existing event naming prompt in the app today. Part of the plan must evaluate whether that prompt should remain as-is, be revised, or be split into multiple prompts. The recommendation should be tightly aligned with Memoria's current grouping flow.

Current prompt in use:

You are an expert at identifying life events from photo collections.
I will provide you with a sample of photos from a single group, along with the date range they were taken.
Date range: {start_date} to {end_date} ({day_count} days)
Number of photos in group: {total_count}
Location data available: {true|false}
{location_hint_if_available}
Your job is to identify what event or occasion these photos represent and suggest a short, specific folder name.
Guidelines:
- Be SPECIFIC. "Portland Trip" is better than "Travel". "Thatcher Birthday" is better than "Birthday". "Mexico Beach Vacation" is better than "Vacation".
- Look for visual cues: birthday cakes, candles, presents, decorations, costumes, holiday decorations, beach/ocean, mountains, landmarks, restaurants, sports fields, school settings, etc.
- Look for contextual cues: if photos span 5-10 days in a warm location with beaches, it is likely a vacation. If photos show a cake with candles and people gathered, it is a birthday.
- If you can identify a location (city, country, landmark, region), include it in the name.
- If you can identify a person the event is centered on, include their name if it appears context is a personal celebration.
- For holidays use standard names: "Christmas", "Thanksgiving", "Fourth of July", "Easter", "Halloween".
- For recurring personal events use: "Birthday", "Anniversary", "Graduation".
- If truly ambiguous after careful analysis, use "Misc".
Respond with ONLY a JSON object in this exact format, no other text:
{
  "folder_name": "Short Event Name",
  "confidence": "high|medium|low",
  "reasoning": "One sentence explaining what visual or contextual cues led to this name"
}

Recommended architectural direction:
1. Preserve the existing deterministic time-based cluster creation for `date_verified` items.
2. Introduce a backend-only two-pass AI enhancement within the Group phase:
   - Pass 1: derive structured event clues / metadata from a representative sample of assets from one candidate cluster.
   - Pass 2: produce the final deterministic event/folder name suggestion for that candidate cluster.
3. Keep AI responsibilities separate from file IO. Grouping AI should decide and persist event-group metadata only. Existing finalize logic should continue to copy grouped items into `/organized/<year>/<year - event>/`.
4. Add backend support for a secondary fallback model setting. Keep backward compatibility if only the primary model is configured.
5. Add strict schema validation for AI outputs.
6. Add prompt/model/schema versioning and logging where practical.
7. Preserve compatibility with the existing Event Group Review and Finalize phases.

Recommended pass 1 prompt:

You are assisting a desktop photo organization application named Memoria.

Memoria already grouped these assets into a candidate event cluster using deterministic time-proximity rules after date verification. Your job is NOT to move files or create folders. Your job is to analyze the provided representative assets and cluster context, then return structured event clues that will later be used for deterministic event naming.

You are given:
- a sample of representative images and/or video keyframes from one candidate cluster
- the cluster year
- the cluster date range
- the total asset count in the cluster
- whether location data exists
- an optional location hint

Important rules:
- Be specific but conservative.
- Do not invent personal names from faces.
- Only use a location when it is strongly supported by the provided metadata/context.
- Prefer concrete event clues over generic labels.
- If the event is ambiguous, return multiple plausible event candidates.
- Output valid JSON only.
- Do not include markdown.
- Do not include explanatory text outside the JSON.

Return JSON in exactly this shape:
{
  "schema_version": "1",
  "dominant_context": "holiday|birthday|vacation|sports|school|family|anniversary|graduation|misc|other",
  "scene_signals": ["string"],
  "event_candidates": ["string"],
  "location_candidates": ["string"],
  "holiday_candidates": ["string"],
  "activity_candidates": ["string"],
  "people_focus": "family|individual|mixed|unknown",
  "naming_confidence": "high|medium|low",
  "reasoning": "One sentence explaining the strongest visual/contextual clues.",
  "needs_fallback": true
}

Recommended pass 2 prompt:

You are assisting a desktop photo organization application named Memoria.

Memoria already grouped these assets into a candidate event cluster using deterministic time-proximity rules after date verification. Your job is to identify the most likely real-world event or occasion represented by this candidate cluster and return a deterministic folder/event name suggestion.

You are given:
- a representative sample of assets from one candidate cluster
- the cluster year
- the cluster date range
- the total number of assets
- whether location data exists
- an optional location hint
- optional structured event clues from a previous analysis pass

Folder naming requirements:
- Output folder_name in this exact format:
  YYYY - OptionalLocation EventName
- Use the year only, not full dates.
- If a reliable location is known and materially improves specificity, include it.
- If location is not reliable or not useful, omit it cleanly.
- Examples:
  2025 - Chicago Family Vacation
  2024 - Home Christmas Morning
  2023 - Yellowstone Wildlife Trip
  2022 - Soccer Tournament
  2025 - Birthday Party

Rules:
- Be specific, not generic.
- Prefer a concrete event or occasion over broad categories.
- Use visual cues such as cakes, candles, decorations, costumes, holiday themes, sports settings, school settings, landmarks, beaches, mountains, restaurants, animals, signs, and repeated environments.
- Use contextual cues such as trip length, date clustering, repeated people/settings, weather/seasonal signals, and location hints.
- Use standard names for major holidays when appropriate: Christmas, Thanksgiving, Fourth of July, Easter, Halloween.
- Use standard names for recurring personal events when appropriate: Birthday Party, Anniversary, Graduation, Family Vacation, School Event, Soccer Tournament.
- Do not invent personal names from appearance alone.
- If the event is ambiguous but still has a likely category, choose the most specific defensible name.
- If truly ambiguous after careful analysis, use:
  YYYY - Misc
- Output valid JSON only.
- Do not include markdown.
- Do not include explanatory text outside the JSON.

Return JSON in exactly this shape:
{
  "schema_version": "1",
  "folder_name": "YYYY - OptionalLocation EventName",
  "confidence": "high|medium|low",
  "event_type": "holiday|birthday|vacation|sports|school|family|anniversary|graduation|misc|other",
  "location_used": "string or null",
  "reasoning": "One sentence explaining the strongest visual/contextual cues behind the result.",
  "needs_fallback": true
}

Please produce:
1. An executive summary
2. Missing considerations / what I may be missing
3. A recommendation on whether the current prompt should remain as-is, be revised, or be split
4. A proposed phased implementation plan
5. A detailed phase-by-phase breakdown
6. Data contracts / schema recommendations
7. Configuration/settings changes needed for the fallback model
8. Logging / observability recommendations
9. Testing plan
10. Risks and rollback strategy
11. Open questions / assumptions

For each phase, include:
- objective
- exact backend changes
- exact files/modules likely involved based on the existing Tauri/Rust architecture
- schema/data model changes
- settings/config changes
- prompt changes
- tests to add
- manual validation steps
- risks / rollback notes
- definition of done

Additional planning requirements:
- Prefer additive changes over disruptive rewrites.
- Prefer backend seams/interfaces that let current behavior continue while new logic is phased in.
- Prefer the smallest safe first step.
- No UI changes.
- No skipping tests.
- No moving to the next phase until the current one is implemented and validated.
- Keep alignment with Memoria's existing runtime logging and AI cost-cap behavior.
- Explicitly address folder collision policy and idempotency considerations in finalize compatibility.
- Explicitly address prompt/model/schema versioning.
- Explicitly address how fallback behaves if no fallback model is configured.

Also, if the current codebase suggests a smaller first implementation than the full two-pass pipeline, recommend that smaller first implementation and explain why.
```

---

## Final Recommendation

The planning agent should be steered toward this conclusion:

- **Do not replace Memoria's existing grouping architecture.**
- **Enhance the Group phase incrementally.**
- **Revise the current naming prompt and treat it as pass 2.**
- **Add fallback model support early.**
- **Introduce pass 1 only after pass 2 schema hardening is in place.**
- **Keep all work backend-only and compatible with existing Event Group Review and Finalize behavior.**

This is the tightest alignment with the README, the stack, and Memoria's current non-destructive, auditable design. fileciteturn0file0L10-L20 fileciteturn0file0L64-L80 fileciteturn0file0L167-L188
