# Question audit

The single most expensive failure mode is a **well-answered wrong question**:
a model (or a human) confidently answers what was asked, while the real
question sits unasked. This file forces the question to the surface before
the answer. Format reference: MenteViva `docs/question-audit.md`.

Rule: **for each decision, name the question, check whether it is the *real*
question, then say how we'll answer it — research, Jev, or owner.** A Jev
call whose `state` is wrong is wrong no matter how confident the output.

## 1. Direction (gates everything else)

- ❌ Wrong version: "what features should we integrate?" — jumps to solutions
  before the product's job is named; every integration looks attractive in a
  vacuum.
- ✅ Real version: **what is pi-vida's job for the next ~3 months — a hardened
  personal daily driver for the owner, or a distributable tool other people
  install and run?** "How likely are users to use X" is unanswerable until
  "users" exists as a category.
- **Answered (owner, 2026-09-22):** hybrid — personal harness, but the
  skills/packs layer is meant to be shared. Logged in `docs/decisions.md`.
- Consequence: every other question in this file gets re-read through the
  answer (personal → cut/polish; distributable → install UX, docs, support
  surface).

## 2. Feature usage (evidence, not vibes)

- ❌ Wrong version: "how likely are users to use the current features?" —
  there are no users to survey, and a model guessing about hypothetical users
  is the expensive failure mode.
- ✅ Real version: two parts — (a) **which shipped features (chain, team,
  fusion, `--host cline|kilo|claude`, herdr panes, boot-config, agents view,
  codegraph/graphify/serena capabilities) has the owner actually run in the
  last 30 days?** — measurable from shell history, herdr logs, git history.
  (b) **which unused features carry ongoing cost** (INV- invariants rs-guard
  enforces, smoke tests, docs surface) — and earn their keep or get cut?
- How answered: **research** (measure real usage), then **Jev** scores
  cost-vs-value per feature against the measured state.
- Evidence so far (2026-09-22, shell history ~6 weeks / 3813 entries):
  `pi-vida` typed in a terminal **3×**; chain/team/fusion/doctor/agents/
  `--host` **0×**; direct `pi` launches **0×**. Meanwhile: graphify **82×**,
  codegraph **39×**, serena **20×**, herdr **15×**; herdr worktrees exist for
  my-pi-agent, rs-guard, rs-nightshift; this very session runs in a
  Cline-spawned worktree.
- ⚠️ Caveat confirmed by owner (2026-09-22): sessions start via a **mix —
  Cline spawns worktrees, herdr hosts parallel repos, terminal rarely**. The
  blind spot was real: terminal history undercounts actual harness use.
  Consequence for Q3/Q5: the host paths (Cline, herdr) ARE the launch
  surface, so host integrations outrank terminal-only UX. Remaining gap:
  per-feature usage *within* those paths — owner fills the table below,
  then Jev 001 scores keep/cut/park.
- 🔄 State correction (2026-09-22): **the dogfood machine is another
  computer** — this machine's history is the wrong state entirely, not just
  an incomplete one. The terminal evidence above is void for scoring; the
  owner's recall of the other machine is the state source. (Same lesson as
  MenteViva Jev 001→007: fix the state before trusting the answer.)
- ✅ Owner usage (other machine, 2026-09-22): 1 D · 2 D · 3 D (kilo ~70% /
  cline ~30% / claude never) · 4 D · 5 D.
- ✅ **Jev 001 fired 2026-09-22** (`jev-json/001-feature-investment.*`, model
  jev-1.13.0, 1494 in / 104 out tokens). Six Score questions, legend
  0 = park/cut, 1 = keep as-is, 2 = invest/harden:

  | Feature | Score | Conf | P(0/1/2) | Verdict |
  |---|---|---|---|---|
  | modes (chain/team/fusion) | **1.99** | 0.99 | 0/.01/.99 | Invest — strongest signal |
  | host projection cline/kilo | **1.96** | 0.94 | 0/.04/.96 | Invest |
  | solo launch | 1.91 | 0.86 | 0/.09/.91 | Invest |
  | herdr integration | 1.91 | 0.87 | 0/.09/.91 | Invest |
  | host projection claude | 0.89 | 0.83 | .11/.89/0 | **Keep cold** — don't cut, don't invest |
  | terminal-only UX (gum menu, status-line) | **0.25** | 0.63 | .76/.24/0 | Leans **park** |

- Read: the invest set = exactly what the hybrid direction predicts (core
  path + modes + the two host projections the owner lives in + herdr).
  Claude rides along as shared-layer surface at zero investment. Terminal UX
  is the only park-lean, and at 0.63 confidence it's a lean, not a mandate —
  note the gum menu is also the fallback entry when hosts are absent.
- Consequence: pending owner sign-off → decision entry in `docs/decisions.md`;
  "park" means freeze new work + keep smoke coverage, not delete.
- Consequence: a keep/cut/polish list with evidence attached; integrations
  only get considered for features that survive.

## 3. Cline/Kilo SDK (pain first, SDK second)

- ❌ Wrong version: "should we integrate most closely with cline using the SDK
  and also kilo with their SDK?" — presupposes "yes, integrate closely" and
  skips what problem the SDK solves.
- ✅ Real version: (a) **what is broken or missing in the current `--host
  cline|kilo|claude` path** (skills projection + exec/print)? (b) **does the
  Cline SDK enable something the CLI path structurally can't** (programmatic
  task control, in-editor lifecycle, headless runs)?
- ✅ 3a answered (owner, 2026-09-22): **no pain** — "so far all good" with
  the current `--host cline|kilo` path. Pain-driven SDK work is parked with
  the reason recorded (not vibes).
- ✅ 3b research (2026-09-22): the SDKs offer surfaces the CLI projection
  structurally can't — Cline SDK (`@cline/sdk`, Node 22+): plugins with
  bundled file-based SKILL.md (auto slash commands, npm/git distribution),
  tool-intercept hooks (damage-control as enforcement, not prompt level),
  configured agents/teams, cron scheduling, ClineCore headless sessions
  (events, persistence, no TTY). Kilo: `@kilocode/sdk` v7 exists
  (server-based v2 API). Six improvement candidates scored by Jev 002
  (raw pair `jev-json/002`): five to backlog; plugin packaging was a coin
  flip (1.51, conf 0.27) until the owner supplied the sharing timeline
  (imminent, specific recipient) — refired as Jev 002b → **1.96, conf 0.94,
  build now**. Decision logged in `docs/decisions.md`.
- Consequence: either a scoped SDK spike with a named job, or a recorded
  "CLI path is sufficient" decision with a revisit trigger.

## 4. Other tools (friction first, tools second)

- ❌ Wrong version: "what other tools should we consider?" — unbounded
  brainstorm; a model will confidently return a fashionable list.
- ✅ Real version: **which recurring frictions in the owner's actual sessions
  (last N) are unsolved by the current harness?** Candidate tools are then a
  bounded Choice per friction, not a free-floating list.
- How answered: **owner + research** build the friction list from real
  sessions; **Jev** ranks candidate tools against each named friction.
- Consequence: at most 1–2 tool evaluations, each tied to a felt pain;
  everything else parked with the friction it would have solved.

## 5. Herdr (workflows first, features second)

- ❌ Wrong version: "what herdr functionalities should we integrate?" —
  catalogs herdr's surface instead of naming the workflow that hurts.
- ✅ Real version: **which multi-agent / multi-repo workflows does the owner
  actually run, and where does the current INV-herdr pane-native team path
  fall short of them?**
- ✅ 5a answered (owner, 2026-09-22): **no pain** — "not really, it's more
  about improving the support". Same shape as Q3: improvement-driven.
- ✅ 5b research (2026-09-22): current INV-herdr surface (`start_herdr_team`
  in `libexec/pi-vida-launch`, `herdrDispatch` in `agent-team.ts`): pane per
  member, `PI_VIDA_WORKER` reduced member base, prompt/read dispatch against
  `PI_HERDR_MEMBERS` only, 15-min wall clock on `--wait` (dead members hang
  until timeout), doctor warns on missing binary only. Five improvement
  candidates scored by Jev 003 (raw pair `jev-json/003`): four backlog;
  per-member model override was a coin flip (1.43, conf 0.29) — resolved by
  owner call: **backlog all five** (2026-09-22, session ended). Decision
  logged in `docs/decisions.md`.
- Consequence: herdr work scoped to named workflows, or a recorded
  "current integration is sufficient" decision.

## 6. Jev's role inside pi-vida (meta)

- ❌ Wrong version: "how do we integrate jev into pi-vida?" — assumes runtime
  integration before identifying a judgment-shaped problem.
- ✅ Real version: **which pi-vida decisions recur and are judgment-shaped
  (not deterministic)?** Candidates: feature keep/cut (Q2), skill-pack
  selection per repo, per-role model/thinking defaults, chain/team routing,
  this question-audit process itself.
- How answered: **owner** picks the recurring decision points; **Jev** pilots
  on the next real one (this audit is the pilot — MenteViva rule: Jev is
  seasoning, code/owner owns policy).
- Consequence: first slice stays decision-support (docs + archived raw
  pairs); runtime integration only after the pilot proves value.

## Open re-asks (queued)

- [x] Jev 000 — connectivity smoke test from this workspace (done, archived
  in `docs/jev-json/000`)
