# Anti-patterns

Reference for `codex-team-playbooks`. Things that look like sensible playbook design but fail in practice. Read before you commit to an unfamiliar structure.

---

## 1 · Two sessions writing the same work doc

**Symptom.** You spawn `worker` and `reviewer`; both are told to update the same work doc file.

**Why it fails.** Workers don't share memory. Two Codex threads alternately rewriting the same file produce either (a) overwrites of each other's state, (b) merge conflicts the sessions can't resolve, or (c) one session silently loses changes.

**Correct.** One work doc per session, always. Cross-session communication goes through **read-one-session, write-another-session** files: `worker-reviewer.md`'s review doc is written by the reviewer and read by the worker; neither touches the other's work doc.

---

## 2 · Debate without a judge

**Symptom.** You spin up `advocate-A` and `advocate-B` and expect them to reach consensus by talking.

**Why it fails.** The plugin has no cross-session chat. Even if you relay messages, both sessions are biased toward their own position by design. Consensus doesn't emerge; you get two unmoved stances.

**Correct.** `debate.md` requires Claude as the adjudicator. Advocates make their case; Claude reads both; Claude decides. Without Claude in the loop, `debate.md` is useless.

---

## 3 · Self-critique as reflexion

**Symptom.** You want reflexion-style iteration but use only one session with prompts like "critique your own work, then revise".

**Why it fails.** A single session's "critique" runs with the same context that produced the work. It rationalises. Codex is not worse than the average human at this, which is to say it's bad. A fresh session reading the artefact cold catches things the original session can't see.

**Correct.** `reflexion.md` needs a distinct `critic` session, different profile, different work doc. The isolation is the point.

---

## 4 · Workers dispatching workers

**Symptom.** You tell `tech-lead` to "spawn sub-workers for each sub-task".

**Why it fails.** Only Claude can call `codex-team send` / `session create`. The tech-lead worker has no authority — its attempts either fail silently or wander off into shell commands that don't do what you think. More fundamentally, a worker-dispatching tree loses traceability: Claude can't tell what's running where.

**Correct.** Tech-lead writes plans and sub-briefs. Claude dispatches. See `hierarchical.md`. Keep Claude at the root of every send.

---

## 5 · Fake parallelism with dependent chunks

**Symptom.** You spawn 5 workers, each handling one "chunk" of a task. Their outputs turn out to depend on each other's results.

**Why it fails.** Workers can't see each other's state during execution. When chunk 3 needs chunk 1's result, either (a) chunk 3 blocks and fails, (b) chunk 3 re-does chunk 1's work wastefully, or (c) the results silently contradict each other at merge time.

**Correct.** True independence is the prerequisite for `map-reduce.md`. If chunks depend sequentially → `pipeline.md`. If chunks depend partially → `hierarchical.md` so the tech-lead orders them and you dispatch in the right sequence.

---

## 6 · Overloading `solo-worker.md` with review-quality demands

**Symptom.** You want careful review, so you tell a single worker "do the change AND critique your own change before reporting done". Quality drops anyway.

**Why it fails.** Same reasoning as #3: self-critique under the same context isn't critique. Plus, adding "then critique" triples turn duration and burns tokens on poor-quality review.

**Correct.** Use `worker-reviewer.md` (for code) or `reflexion.md` (for artefacts) when you want a second pair of eyes. Don't try to make one session play two roles without a transition.

---

## 7 · Fanning out into a giant map-reduce before you've run one

**Symptom.** You plan `map-reduce.md` with 12 workers across 12 repos for a bulk audit.

**Why it fails.** You'll drown in `turn-done` events. Past ~6 concurrent sessions, the orchestration cost outgrows the parallelism benefit for a single Claude-in-the-loop. The aggregate summary becomes a second full-time task.

**Correct.** Batch. Run 6 workers; write the aggregate; close; run the next 6. Or: if the task is 20+ and highly repetitive, don't use interactive orchestration at all — write a script and hand-audit outliers.

---

## 8 · Missing explicit role on transition

**Symptom.** In swarm Mode A, you send "now start implementing" without naming the role change. Worker continues in investigator mode.

**Why it fails.** Codex doesn't infer role shifts from tone. It continues doing what the previous turn was doing unless told explicitly.

**Correct.** The transition send must announce the shift loudly: "SWITCH ROLE: you are no longer an investigator; you are now the implementer. Your new goal is …". See `swarm.md` §Mode A.

---

## 9 · Stuffing the whole task into the send, not a brief

**Symptom.** Your first send is 600 words describing objective, scope, constraints, references, success criteria — all inline.

**Why it fails.** (a) Shell quoting hell. (b) Hard to review before dispatch. (c) Can't share across workers for multi-agent patterns. (d) Can't revise without re-sending. (e) `history.md` becomes unreadable.

**Correct.** Write a brief file (`manage-codex-team/send-patterns.md` §2.3). The send points at it.

---

## 10 · Running `watchdog` on short tasks

**Symptom.** You arm `/codex-team:watch` for a 30-minute task "just in case".

**Why it fails.** Watchdog's purpose is re-anchoring on long-horizon work. For short tasks, its ticks add noise without utility. The `events` stream already covers real-time signals.

**Correct.** Watchdog is opt-in for >1h wall-clock work with mostly-idle orchestrator. See `manage-codex-team` §Watchdog.

---

## 11 · Escalating the ladder on the long-context quirk

**Symptom.** First mismatched reply → `interrupt → restart → kill`.

**Why it fails.** The long-context prompt-apply skip is a known Codex quirk, not a failure (`recover-codex-team/known-quirks.md`). The ladder destroys queue state and wastes the thread's context. The correct response is a single re-send.

**Correct.** Re-send the same prompt once. Only escalate if two consecutive re-sends both behave badly.

---

## 12 · Letting the worker own git

**Symptom.** A worker runs `git commit -m "fix"` in its turn. Sometimes even pushes.

**Why it fails.** Workers have `danger_full_access` sandbox — they *can* run git. But they don't see your branching strategy, your PR template, your CI, your squash policy, or the work's relationship to the overall merge plan. They will make commits that look fine in isolation and horrifying in a PR.

**Correct.** Invariant #2 in `using-codex-team` — git belongs to Claude. Profile `developer_instructions` must forbid `git commit | merge | push | branch | tag`. See `configure-codex-team/profiles.md`.

---

## 13 · Treating the work doc as optional

**Symptom.** You skip creating the work doc for a "quick" task. Two turns later you're trying to reconstruct state from history.

**Why it fails.** The work doc is load-bearing for every other mechanism in this plugin: compaction, watchdog anchoring, your own auditing, cross-worker communication in `worker-reviewer.md` and `reflexion.md`. Skipping it is a local optimisation that costs global clarity.

**Correct.** Every session has exactly one work doc. Even the quickest solo worker gets one. The first send creates it.

---

## 14 · Polling session status instead of arming events

**Symptom.** You loop `codex-team session status` to check if the turn finished.

**Why it fails.** Every poll burns your context window on noise. The `events` Monitor stream was built for this.

**Correct.** Arm `events` once (`/codex-team:bootstrap` or `manage-codex-team` §Arming events). Sleep between ticks. If events aren't arriving, diagnose the monitor — don't substitute polling.

---

## 15 · Designing a 5-playbook-deep nesting

**Symptom.** Hierarchical outer → debate for plan selection → pipeline for execution → reflexion at stage 3 → worker-reviewer inside stage 3's critic. You've composed five playbooks.

**Why it fails.** Human operators — and Claude — lose the plot past about 2 levels of composition. Every level is a decision point you have to hold in your head.

**Correct.** Pick the dominant outer shape. Adopt inner playbooks only where pain is obvious. Most real tasks need one playbook; some need two nested; three is rare; more is a design smell pointing at an under-specified brief.
