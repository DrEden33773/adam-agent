# Agent evaluation: method and results (public evidence)

## Abstract

adam-agent is measured on a frozen set of real-repository repair tasks drawn from public SWE-bench-style instances. Each task environment is rebuilt so that only the base commit and its reachable ancestors are readable, and the candidate's own edits under verifier-owned test paths are projected out before scoring, so the graded tests are never visible to the solver. A task enters the suite only after a model-free control pair — an empty patch and the task's reference patch — shows that the base fails at least one declared test and the reference patch passes all of them. Two paired runs against mini-swe-agent 2.4.6, on the same model and the same budget, resolved 14/16 and 17/22 scored tasks for adam-agent against 13/16 and 13/22, with identical outcomes across runs on 15/16 shared tasks against 10/16 and about 40% lower nominal cost per resolved task. Every retained grading was independently recomputed from its raw pytest log: one wrong verdict was found and corrected, and two earlier claims were retracted. At this sample size the runs cannot separate patch quality; the defensible advantages are producing a patch inside the budget, run-to-run repeatability, and cost per resolved task. The evaluation code lives in a private workspace; this document publishes the method, the controls and the results so the numbers can be checked.

---

## 1. What we measure and why

We measure a coding agent on **real-repository repair tasks** from public SWE-bench-style instances. The agent receives a frozen commit of a repository and an issue description; it locates the problem, edits, verifies, and exports a patch, which the official grader then judges on hidden tests as `resolved` or not. Three problems have to be solved before that number means anything.

**Task-environment isolation (construction isolation, internal id `base-ancestors-v1`).** The repository inside each task container is not the original clone but a rebuilt, fresh Git object store containing only the frozen base commit and its reachable ancestors. Upstream fix commits, successor commits, unreachable objects, the reflog, and local clone relationships do not exist; ancestor tags that build tooling such as `setuptools_scm` needs are copied, tags that point elsewhere are not. Nested Git stores inside the project are checked for reachability first and are admitted only when they provably cannot read the base's successors. The point is that whether the solver can find the upstream answer and the upstream tests stops being an assumption and becomes something the construction cannot do.

**Verifier-owned test projection (internal id `verifier-tests-v1`).** Before scoring, candidate edits that fall on verifier-owned test paths are projected out of the patch entirely and take no part in scoring; any path a task's hidden tests touch counts as verifier-owned. If one candidate file spans both a verifier-owned test path and other paths, scoring refuses it rather than awarding a partial result. The solver container only ever holds the base commit, and hidden tests are applied in the grading container only. This rules out passing by editing, deleting, or replacing the tests, while keeping the graded tests invisible to the solver.

**Model-free base and reference-patch controls.** Each task runs the official grader twice in the same frozen image before admission: the base (empty patch) must fail at least one declared test, and the reference patch must pass every declared test. This stage makes **zero model calls**. Only tasks that pass both enter the scored set. Deviations from the main rule are recorded per task, for example a declared test that already passes on the base (no discriminating power) or pass-to-pass tests that fail on both the base and the reference patch (a broken environment). When even the reference patch cannot make all declared pass-to-pass tests pass, the task's official `resolved` flag is unreachable for any candidate, so the task cannot separate two systems and we do not count it in the denominator.

## 2. Setup

| Item | Setting |
| --- | --- |
| System under test | adam-agent, archive built from product commit `d5d8718` (sha256 `e5f8b44a…`) |
| Baseline | mini-swe-agent `2.4.6`, revision `04d809ce` |
| Model and reasoning level | the same model `deepseek-flash` at reasoning `high` for both arms |
| Budget | 80 model turns (80 steps for mini) and 1,800 seconds per attempt, identical for both arms |
| Order | interleaved per task (adam first, then mini); the order is frozen before the run |
| Task composition | 12 development tasks plus unseen anchors; r1 has 5 anchors (17 tasks), r2 has 11 (23 tasks) |
| Images | one frozen image per task, referenced by digest and reused from cache without re-pulling |
| Price convention | EC-4 frozen nominal peak prices: input $0.30/M, cached input $0.006/M, output $1.20/M |

A single controller drives the runs serially, and attempts are retained individually (process exit codes, trajectories, provider receipts, patches, grading directories). Consecutive infrastructure failures stop the batch at a threshold.

## 3. Results

The scored set means the tasks where both arms have a verdict and the official `resolved` flag is reachable. Costs below are in US dollars.

| Measure | r1 adam | r1 mini | r2 adam | r2 mini |
| --- | --- | --- | --- | --- |
| Scored tasks | 16 | 16 | 22 | 22 |
| Resolved | **14 / 16** | 13 / 16 | **17 / 22** | 13 / 22 |
| Development group | 10 / 11 | 8 / 11 | 9 / 11 | 6 / 11 |
| Unseen anchors | 4 / 5 | **5 / 5** | **8 / 11** | 7 / 11 |
| Empty submissions | 0 | 1 | 0 | 6 |
| Provider calls | 696 | 816 | 1,015 | 1,116 |
| Input / output tokens | 30.02 M / 0.41 M | 38.58 M / 0.52 M | 43.06 M / 0.64 M | 55.11 M / 0.75 M |
| Attempt wall clock | 76.2 min | 101.9 min | 126.5 min | 122.3 min |
| Nominal cost (scored set) | $9.50 | $12.20 | $13.69 | $17.43 |
| Nominal cost per resolved task | **$0.68** | $0.94 | **$0.81** | $1.34 |
| Nominal cost, all attempts including the excluded task | $10.93 | $13.23 | $15.35 | $18.63 |

**Repeatability.** Of the 16 tasks scored in both runs, adam-agent produced an identical outcome on **15** and mini on **10**; both runs resolved 13 against 8; at least one run resolved 14 against 14. Taken over the combined 22-task scored set, each system resolved 18 tasks, and each has exactly one task the other never resolved.

**Paired outcomes.** In r1 both arms resolved 12 tasks, adam-agent alone resolved 2, mini alone 1. In r2 both resolved 13, adam-agent alone 4, mini alone 0. All four discordant r2 tasks favour adam-agent, exact two-sided McNemar p = 0.125; r1 is 2 against 1, p = 1.0.

**The task removed from the scored set.** `BerriAI__litellm-10198` has 8 declared pass-to-pass tests that fail on both the base and the reference patch (an environment problem inside the same image), so its official `resolved` flag is unreachable for any candidate. The task is marked `diagnostic-only` and removed from the scored denominator and the paired tables; every attempt, grading, and its spend remain in the raw records, neither deleted nor rewritten.

**How attempts ended.** Across all 23 paired attempts, adam-agent submitted inside the budget 21 times and hit the 80-turn ceiling twice (once without submitting a patch at all); mini submitted 16 times and hit the ceiling 7 times (all 7 without submitting). Restricted to the scored set the same row reads adam-agent 21 / 1 / 0 and mini 16 / 6 / 6.

## 4. One grading-correction case

We recomputed **every retained grading** independently from its own raw pytest log — 143 comparable gradings, plus one empty submission with no test log, whose verdict is the official empty-patch outcome. The recomputation follows the official rule: a declared test passes only when the log records `PASSED`, fails on `FAILED`/`ERROR` or when it is missing from the log, and `SKIPPED`/`XFAIL`/`XPASS` count as neither.

Exactly **1 of the 143 disagreed** with the retained official verdict, in the r1 baseline arm of `py-pdf__pypdf-3317`: the stored report said unresolved and marked the whole declared pass-to-pass group as failing (`success: 0, failure: 972`), while the same run's raw log recorded 983 passes and 1 failure — and that single failure is a network-dependent test outside the declared scored set that also fails on the reference patch. Recomputed from the log, the declared fail-to-pass test for that attempt is `PASSED`, so the attempt **did resolve** the task. We corrected the verdict and retracted two claims that had already been published:

1. "the baseline never resolved a task adam-agent did not" — false; this task is a counterexample;
2. "the baseline's r1 patch for that task left 972 pass-to-pass tests failing" — false; that patch passed every declared pass-to-pass test.

The root cause is that the official grader wrote a corrupted pass-to-pass report column in some runs of that task (4 of its 6 gradings). It changes the verdict only when the fail-to-pass test itself passes; otherwise the outcome is unresolved either way. The defect did not reproduce on any other task. With the correction, the baseline's r1 total moves from 12 to 13.

The same review found **3 r2 attempts that had no verdict at all**: the grading stage failed on two projection rules that were too strict (declarative test data was not recognised as a verifier-owned path; a captured `git diff` carried shell start-up text before its first diff header). After repairing both rules we re-graded those 3 attempts from their retained patches with **zero model calls** — two unresolved, one resolved, which makes it a task both arms resolved — and a projection-replay tool confirmed that only those 3 of 120 retained candidate patches changed policy. Independent re-grading is now a fixed part of the readout rather than an optional spot check.

## 5. Conclusions and limits

- **At this sample size the suite cannot separate patch quality.** On the 16 r2 tasks where both arms produced a patch, adam-agent resolved 14 and mini 13 with a single discordant task (p = 1.0); inside the scored set mini did not fail more submitted patches than adam-agent (3 against 5). The whole r2 margin comes from producing a patch inside the turn budget: mini had 6 empty submissions, adam-agent none.
- **Only three claims are defensible**: a higher share of attempts producing a patch inside the budget; higher run-to-run repeatability (15/16 against 10/16); and lower nominal cost per resolved task ($0.81 against $1.34, about 40% lower). Over the combined 22 tasks each system resolved 18, with one exclusive task each.
- **Statistics.** All four discordant r2 tasks favour adam-agent at an exact two-sided p = 0.125, short of 5%; r1's 2 against 1 is not significant at all. We do **not** claim a capability improvement or a lead over the baseline.
- **Cost convention.** The nominal peak prices (uncached input $0.30/M, output $1.20/M) are an accounting convention, and all input is charged at the uncached peak rate, so the figures are an upper bound, not a reconciled bill.
- **Verifiability.** The evaluation code, raw logs, and archives live in a private workspace. This document publishes the method and the results so the numbers can be checked and challenged, but a reader cannot re-run the historical attempts from the public repository alone.

## 6. Reproduction checklist

Required components, all relative paths inside the private workspace's `evaluation/` directory:

| Stage | Script |
| --- | --- |
| Task set and both build identities | `lean_suite.py` |
| Task-environment isolation and export boundary | `repository.py` (`prepare`, `collect_candidate`); the isolation receipt is produced by `verify_isolation.py` |
| Candidate test projection | `candidate_policy.py` (`scoring_projection`), with the replay audit `lean_projection_replay.py` |
| Model-free base/reference control matrix | `lean_controls.py`, `lean_controls_report.py` |
| Paired run driver (frozen order, budgets, circuit breaker) | `lean_run.py` |
| One attempt (inference and grading) | `run.py --lean-suite`, with the grading adapters `grade_strict.py` / `grade_calibration.py` |
| Late grading (re-score a retained attempt without inference) | `dispatch.py _grade <run_id>` |
| Independent re-grade and readout | `lean_regrade.py`, `lean_run_report.py` |

External requirements: Docker (able to pull or already caching the frozen task images), Python 3.12 with the locked uv project environment, the pinned official grader and dataset revision inside the grading environment, and provider access to the model under test; both build artifacts (the adam-agent archive and the mini-swe-agent revision) are also needed. The control matrix needs no model access.

What is not fully reproducible: images are pinned by digest and whether they can be pulled again depends on registry availability and cache; task texts are not distributed with this repository and must be fetched from the public dataset and checked against the revision; the price version is a frozen accounting convention; and the raw grading logs and archives live in a private workspace, so the public repository carries the method and the results only.

## 7. Publication notes (for the public repository)

- Suggested path: `docs/evaluation/agent-evaluation-evidence.md` in the public product repository, linked from the README's evaluation section.
- Redaction rules: do not publish hidden test names, hidden test data file names, or reference-patch content; do not publish private absolute paths (use repository-relative paths or "private workspace"); refer to tasks only by their public dataset instance names; do not publish candidate patch bodies or raw log excerpts.
- Wording rules: no "significant improvement" or "beats the baseline"; every comparison carries its sample size, budget, and grading convention; the `diagnostic-only` exclusion and the grading correction must appear on the same page as the results.

## What this does not claim

This document does not claim that adam-agent outperforms mini-swe-agent or any other baseline, nor that the results generalise beyond the frozen task set. The four discordant r2 tasks give p = 0.125; on the 16 tasks where both arms produced a patch the two are indistinguishable (14 against 13, p = 1.0). mini-swe-agent is a fixed reference implementation measured under the same model, budget, and grader — not a deliberately weak baseline.
