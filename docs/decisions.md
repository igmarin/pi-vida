# Decisions

Newest first. Format: date — decision — why — what would make us revisit.
Format reference: MenteViva `docs/decisions.md`.

Rule (adopted from MenteViva): significant decisions get a Jev judgment
archived in `docs/jev-json/` before being logged here. Jev is evidence, not
truth — the human decides, and disagreements are recorded, not smoothed over.

Rule (owner, 2026-09-22): final decisions are also filed as GitHub issues
via the `github-issue` skill, labeled `improvement`, stage `todo`.

## 2026-09-22 — Herdr improvements: all five to backlog

From question-audit Q5: owner reports no pain with daily herdr team panes
("more about improving the support"). Jev 003 (raw pair `jev-json/003`)
scored five improvement candidates; the one coin flip (per-member model
overrides, 1.43 / conf 0.29) was resolved by owner call, not a refire:
**backlog all five** — session ended, work continues 2026-09-23.

- Backlog: member recovery (1.03), team status view (1.07), doctor herdr
  depth (1.16), dispatch ergonomics (1.17), per-member model overrides
  (1.43 — revisit if per-role model routing becomes real).

Revisit when: a member pane actually dies mid-session (recovery jumps the
queue), per-role model routing is adopted, or ~2026-12-22.

## 2026-09-22 — Investment map: four invest, claude cold, terminal UX parked

From question-audit Q2: Jev 001 (raw pair `docs/jev-json/001`, six Score
questions against owner-reported usage from the primary machine), owner
signed off as-is.

- **Invest/harden:** modes chain/team/fusion (1.99, conf 0.99), host
  projection cline/kilo (1.96, conf 0.94), solo launch (1.91), herdr
  integration (1.91).
- **Keep cold:** `--host claude` (0.89, conf 0.83 — keep as-is) — stays
  shipped as shared-layer surface for others, zero new investment.
- **Park:** terminal-only UX (gum interactive menu, solo status-line) —
  freeze new work, keep existing smoke coverage, do not delete (0.25 but
  conf 0.63 = a lean, and the gum menu is the no-host fallback entry).

Revisit when: usage on the primary machine shifts (terminal launches return),
or a host-side change (kilo/cline/claude) forces the projection layer open.

## 2026-09-22 — SDK improvements: five to backlog, plugin packaging is build-now

From question-audit Q3: owner reports **no pain** with `--host cline|kilo`
(pain-driven SDK work parked with reason). Jev 002 (raw pair `jev-json/002`)
scored six improvement candidates; Jev 002b refired one with corrected state.

- **Backlog** (recorded, revisit in ~3 months or when pain appears):
  enforcement hooks (1.21), native teams on Cline SDK (0.88 — two working
  team impls already), SDK scheduling (0.93), headless CI runs (0.98),
  kilo SDK path (0.99).
- **Build now: plugin packaging** (SKILL.md bundles distributable via
  npm/git, auto slash commands). Jev 002 scored it 1.51 at conf 0.27 — a
  coin flip. The missing state fact was the sharing timeline; once "first
  outside consumer is imminent" was supplied, 002b returned **1.96, conf
  0.94, P(build) = 0.97**. Target host depends on the recipient's host
  (cline plugin vs kilo equivalent); record it when known.

Filed as issues (label `improvement`, stage `todo`): #119 plugin packaging
(priority:high), #120 SDK backlog (priority:low), #121 park terminal UX.

Revisit when: the recipient's host is known (sets the packaging target), or
any backlogged candidate develops a named pain.

## 2026-09-22 — Direction: personal harness, shared skills/packs layer

pi-vida's job for the next ~3 months (owner's call, question-audit Q1): a
**personal** daily-driver harness, but the **skills/packs layer is built to be
shared**. Consequences: harden the launch path the owner actually uses; cut or
park features with no usage evidence; treat the packs/manifest surface
(`skills-bootstrap`, `.dotskills-manifest.json`) as the shareable artifact; no
install-UX/docs-for-strangers work on the harness itself yet.

Revisit when: someone besides the owner tries to install the harness itself
(not just the packs), or the packs layer gets consumed by another project.

**Addendum (2026-09-22):** the first outside consumer is **imminent** — the
owner has a specific person/team in mind for the skills/packs layer.

## 2026-09-22 — Jev (TypeSafe) is the judgment layer for pi-vida work

Jev calls are made from this workspace via `zsh -ic` (the key lives in
`~/.zshrc` as `TYPESAFE_AI_KEY`; non-interactive shells don't inherit it).
Verified live 2026-09-22: model served `jev-1.13.0`, raw pair in
`docs/jev-json/000`. The key is never printed, committed, or written to
any file in this repo.

Revisit when: the key rotates, the API contract changes (check
https://docs.typesafe.ai/llms.txt), or calls start failing non-transiently.

## 2026-09-22 — Decisions and questions are documented in this repo

`docs/decisions.md` (this file), `docs/question-audit.md`, and
`docs/jev-json/` mirror the MenteViva docs format. Product decisions for
MenteViva itself stay in MenteViva's own docs; this log covers pi-vida
harness work.

Revisit when: the work moves repos or the MenteViva format changes.
