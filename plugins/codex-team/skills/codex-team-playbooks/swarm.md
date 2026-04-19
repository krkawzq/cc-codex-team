# Playbook: Swarm / Handoff

**Team size:** 2+ · **Pattern:** Workers change role/focus via explicit baton pass. A session's role can shift; Claude mediates every transition.

## Adoption signal

- Work has **multiple phases of different shape** (investigate → implement → verify; triage → fix → land).
- Role boundaries shift as the work progresses.
- You want to reuse a session's thread context across role transitions, because context compounds.

Unlike `pipeline.md` (fixed stages with baton between *different* sessions), swarm lets a single session shift role, OR explicitly hands off context to a new session carrying the discoveries forward.

Examples:

- A bug investigation: investigator session finds root cause, then hands off to an implementer.
- Code exploration: one session maps the codebase, then hands off to another to implement a change using the map.
- Migration: discoverer finds all affected files, then sub-workers (plural) take over to change each.

Not this playbook when:

- Roles are fixed per session → `pipeline.md`.
- Work is independently shardable → `map-reduce.md`.
- You just want one worker all the way through → `solo-worker.md` with changing send prompts.

## Team composition (dynamic)

Swarm has two modes:

### Mode A: role-shift within one session

One session; Claude's sends gradually shift its role. E.g., start by sending investigation-shape prompts, then implementation-shape prompts. The thread carries context across roles.

- **Pro**: zero handoff overhead; the session already knows the code.
- **Con**: the session's work doc must adapt (different sections for different roles); session may get confused if the role shift is sharp.

### Mode B: baton to a new session

Session A discovers. A writes a handoff doc. Claude creates session B (fresh context), pointing B at the handoff doc. A is closed.

- **Pro**: fresh context for B avoids long-thread drift; roles are cleanly separated.
- **Con**: context loss between A and B is real — B only knows what A wrote down.

Default to **Mode B** when the role shift is sharp (investigator vs fixer). Use **Mode A** when the role evolution is gradual (coder who gradually becomes a tester for the same code).

## Shared artefacts

- **Task brief**: `/<repo>/docs/briefs/<task>-brief.md`.
- **Handoff doc** (Mode B only): `/<repo>/docs/swarm/<task>-handoff-<phase>.md`. Carries context from session A to session B.
- **Per-session work doc**: `/<repo>/docs/worker/<session-name>-work.md`.

## Handoff doc shape (Mode B)

```markdown
# Handoff: <task> phase <A → B>

## Summary of previous phase
<what was done, what was learned>

## Key findings
- <finding 1 with evidence (file:line)>
- <finding 2>

## Open questions
- <question 1>
- <question 2>

## Starting point for next phase
<concrete first action for session B>

## Files / areas next phase needs to know about
- <path 1>: <why it matters>
- <path 2>: <why it matters>

## Things to avoid
- <path or approach that's a dead end, with reason>
```

## Communication flow (Mode B)

```
                brief (shared)
                    │
                    ▼
              [session A]
             investigates,
           writes handoff.md
                    │
                    ▼  (Claude closes A, opens B)
              handoff.md
                    │
                    ▼
              [session B]
           reads handoff.md,
             executes
                    │
                    ▼
                 Claude
```

## Iteration loop (Mode B)

```
Phase A:
  1. Create session A (e.g. role=investigator).
  2. Send: execute the first phase; write handoff doc when done.
  3. Wait for turn-done with handoff ready.
  4. Claude reads handoff doc. If incomplete: re-dispatch A for specific fill-ins.

Phase B:
  5. Close session A (thread preserved).
  6. Create session B (e.g. role=fixer).
  7. Send: read handoff doc; execute second phase.
  8. Loop: Phase B may itself spawn Phase C via another handoff.

Phase N:
  9. Final session closes the task. Claude merges.
```

## Iteration loop (Mode A — role-shift within one session)

```
1. Create session W. First send: investigation-shape prompt.
2. Iterate sends in investigator role until the investigation is done.
3. Transition send: "switch role to implementer. Read your work doc's Findings; start implementing based on what you learned."
4. Iterate sends in implementer role.
5. Final: close session.
```

The transition send is critical — it explicitly tells the session its role has changed. Without it, the session may keep acting as the previous role.

## Send templates

### Mode A — role-shift within one session

**First send (investigator phase):**

```
codex-team send W "investigate: read <brief-path>; walk the codebase starting from <entry-points>; produce a map in <work-path>'s Findings section covering <what to find>. Do not modify code in this phase. Reply 'investigation complete' with a one-line summary of what you discovered"
```

**Transition send (to implementer phase):**

```
codex-team send W "switch role: you are now the implementer. Read <work-path>'s Findings section you wrote in the previous phase; act on <specific-finding>. You may modify code now. Update <work-path>'s Progress section. Reply 'implementation turn 1 done' with a one-line summary"
```

**Continue send (implementer phase):**

```
codex-team send W "continue implementer: read <work-path>'s Next up; tackle the top item; update Progress/Findings/Next up; reply 'done' when complete"
```

### Mode B — baton to a new session

**Session A (e.g. investigator) — first send:**

```
codex-team send investigator "investigate: read <brief-path>; walk the codebase starting from <entry-points>; find <what you want found>. Produce the handoff doc at <handoff-path> using the template (Summary / Key findings / Open questions / Starting point for next phase / Files and areas / Things to avoid). Also create your own work doc at <investigator-work-path>. Do not modify code. Reply 'investigation complete, handoff ready' when done"
```

**Claude hands off** (close A, open B):

```bash
codex-team session close investigator
codex-team session create fixer --cwd <abs-path> --profile worker
```

**Session B (e.g. fixer) — first send:**

```
codex-team send fixer "start: read <brief-path> for the overall task; read <handoff-path> — this is the summary of prior investigation; your phase is implementation. Follow the 'Starting point for next phase' pointer in the handoff. Create the work doc at <fixer-work-path>. Reply 'implementation started' with a one-line summary of your approach"
```

**Session B — continue:**

```
codex-team send fixer "continue: read <fixer-work-path>, tackle the top Next up item; if the handoff's Open questions become relevant, read the handoff again; update Progress/Findings/Next up; reply 'done' when complete"
```

## Exit criteria

- Final phase's session reports done.
- All handoff docs are complete and have been read.
- Claude has merged and audited.

## Failure modes

| Smell | Fix |
|---|---|
| Handoff doc is thin — no evidence or specifics | Prompt must require file:line evidence + concrete first action. Re-dispatch session A. |
| Session B asks questions that were covered in handoff | Your first send didn't require a careful read. Re-anchor: "re-read the handoff; your question is answered in <section>". |
| Mode A session gets confused mid-role-shift | Transition send was too subtle. Be louder: "YOUR ROLE HAS CHANGED. You were an investigator; you are now the implementer. Your new goal is ...". |
| Handoff doc grows into a second work doc | Distinguish: handoff is a one-time baton at role transition; work doc is the session's ongoing state. Keep handoff read-once, actionable. |
| You spawn 3+ phases without reading each handoff | Don't. Every phase transition is a checkpoint. Skip reading handoffs and you're flying blind. |
| Mode A session wants to keep investigating after you said "switch role" | Interrupt + re-dispatch with a firmer transition send. The session is over-committed to its old role. |
| Mode B's new session re-explores everything session A already discovered | Handoff lacked specifics. Re-dispatch A (temporarily reopening) to add concrete findings; or accept the re-exploration cost. |

## Variants

- **Swarm with parallel phase B**: session A investigates, then Claude spawns multiple session-B workers in parallel, each tackling one of A's findings. Hybrid with `map-reduce.md`.
- **Swarm with critic reflexion during phase B**: phase B's implementation uses `reflexion.md` internally.
- **Multi-phase swarm**: phase A → B → C → D with handoffs at each step. Like `pipeline.md` but the roles aren't predefined up front — they emerge from what each phase discovers.

## Related

- If phases are fixed and defined up front → `pipeline.md` is cleaner.
- If you want session reuse across phases → Mode A of this playbook.
- If phase 1 independently reveals N parallel sub-tasks → Mode B + then `map-reduce.md` for the parallel phase.
