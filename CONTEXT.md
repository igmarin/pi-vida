# pi-vida

The product was previously called pi-life (clone my-pi-agent).

Personal Pi Coding Agent harness: pick a vida, load the right extensions and skill packs, run in a target repo.

## Quick reference

| Term | One line |
|---|---|
| **vida** | The language identity you launch: `rust`, `elixir`, `ruby`, or `python`. |
| **profile** | `profiles/<vida>.yaml`, the extensions, skill packs, mantra, and tracker for a vida. |
| **mantra** | Always-on skills every launch gets (listed in `profiles/<vida>.yaml`): `i-have-adhd`, `ponytail`, `ponytail-review`, `deslop`, `clarify`, `requirements-clarifier`, `tdd`, `herdr`. |
| **pack** | A group of optional skills for a vida (e.g. Rails skills), allowlisted in the profile. |
| **tracker** | Where tickets are created (usually `github-issue`). |
| **overlay** | `.pi/capabilities.yaml` in the target repo; turns capabilities on/off per project. |
| **capability** | An optional tool a project enables in its overlay (graphify, rs-guard, playwright, …). |
| **chain** | A named sequence of roles (plan → build → review) run as child sessions. |
| **team** | Dispatcher-only mode that hands work to named specialist agents. |
| **fusion** | Multi-model mode: 2–5 models debate/collaborate in one session. |

The table is a quick reference; the definitions below are authoritative (rs-guard treats them as such).

## Language

**Vida** (Spanish for life):
One of four identities this harness launches: `rust`, `elixir`, `ruby`, or `python`.
_Avoid_: persona, stack, role (those are narrower); `ecto` as a vida (it is a library)

CLI aliases: `phoenix` → `elixir`, `rails` → `ruby`. `rails-python` is not a vida; use `ruby` or `python`.

**API pack**:
Optional GraphQL or REST skill set loaded on a vida. Not a fifth vida.
_Avoid_: calling GraphQL/REST a vida

**Profile**:
Named launch config for a vida: extensions, skill allowlist, tracker, provider class, model policy. Stored as YAML under `profiles/<vida>.yaml`. Shipped files write `vida:`; the parser also accepts `life:`; both set to different values exit 2. Launch is `-e extensions/damage-control-continue.ts` then `--no-skills` then allowlisted `--skill`. Solo mode also appends `-e extensions/status-line.ts` (turn counter in the footer; chain/team do not load it). Invalid YAML, a missing mantra path, or a missing configured tracker path fails closed (exit 2). Omit tracker (elixir) or `tracker: none` = no tracker skill. Missing packs warn. Pack names resolve through `<skills-home>/.dotskills-manifest.json` (`<pack>:<name>` identities, written by the dotskills installer) when the manifest exists. A malformed manifest or a missing installed skill fails closed; a pack with no manifest entries falls back to `<skills-home>/<name>`. The profile's allowlist IS the INV-skills contract (the invariant skill set: damage-control gate + `--no-skills` + only allowlisted `--skill` paths). Launch fails closed when it can't be honored, and rs-guard reviews enforce it.
_Avoid_: theme, preset; TOML for harness config

**Solo**:
Default launch mode. The single primary Pi session with the full per-vida toolset, the solo-only status-line extension, and the solo allowlist. `team` keeps the solo allowlist plus the dispatcher extension; `chain` keeps the solo allowlist plus the chain extension (`/chain`, `/chain-list`, `run_chain`).
_Avoid_: single, default (ambiguous; "solo" names the harness mode specifically)

**Agent (persona)**:
YAML under `profiles/<vida>/agents/` or shared `profiles/agents/`, then cwd `.pi/agents/`, then `.claude/.gemini/.codex` (cwd then home). First name wins. `cross-agent` registers `/name` and `/skill:name`. `system-select` `/system` prepends the chosen body. Not passed by `pi-vida` yet. `pi-vida agents <vida>` prints the resolved view (winner, shadows, tools, model, team, both discovery orders) via `resolvedAgentsView` in `extensions/agents-view.ts` (issue #81); the in-session `/agents` command (loaded in every launch mode, #77) shows the same view with UI notify.
_Avoid_: flattening pack playbooks into these files

**Project overlay**:
File in the target repo (`.pi/capabilities.yaml`) that turns capabilities on or off. Default all off; missing file ≡ all off. `bin/pi-vida` parses the overlay (strict, fail closed on bad YAML) and exports the result as `PI_OVERLAY` for `extensions/capabilities.ts`, which appends a `<capabilities>` block to the system prompt at `before_agent_start` when anything is on. When all are off, the prompt is left alone. The model never sees a capability the project has not enabled. The overlay's `extra_skills` and `tracker.skill` are also passed as `--skill` arguments; naming them in the prompt alone would not make them usable. The overlay also carries optional `models:`/`thinking:` role maps (issue #15). See Boot Config.
_Avoid_: settings, config (too broad)

**Boot Config**:
First-launch wizard (issue #15): when `.pi/capabilities.yaml` does not exist, `extensions/boot-config.ts` (loaded before `capabilities.ts` in the `-e` chain) walks the user through the seven capability toggles and optional per-role model/thinking defaults (roles: solo, planner, builder, reviewer, researcher), then writes the overlay only on explicit confirmation. Skipped entirely when the file exists (`PI_OVERLAY_EXISTS=1`, exported by the launcher) or when UI is unavailable. On save it updates `PI_OVERLAY` in-process so `capabilities.ts` reads the fresh overlay and applies the solo model/thinking immediately via `pi.setModel`/`pi.setThinkingLevel`. On later launches the launcher reads the overlay's `models.solo`/`thinking.solo` into `--model`/`--thinking`; profile YAML may carry optional `models:`/`thinking:` defaults that the overlay overrides.
_Avoid_: setup command (it is a launch-time wizard, not a CLI)

**Machine**:
Local facts that never go in git: keys, hardware, tokengate vs personal, rapid-mlx model.
_Avoid_: environment (overloaded)

**Harness**:
This repo: extensions, profiles, `pi-vida`, doctor. Host is Pi. Harness root: `PI_VIDA_HOME`, else `PI_LIFE_HOME`, else `MY_PI_AGENT_HOME`, else the script dir. Active vida name: `PI_VIDA`, else `PI_LIFE`.
_Avoid_: runtime, orchestrator, framework

**Doctor**:
`pi-vida doctor [vida]` health check (replaces the pre-#13 stub). Fail-closed (exit 2): `pi`, `bun`, overlay parse failure, malformed profile/manifest (both modes), and, for the given `[vida]`, a missing required mantra or tracker skill path (the same contract the launcher enforces; mantra skills are user-provisioned under `PI_SKILLS_HOME`/`~/.agents/skills`, never vendored). With no `[vida]`, doctor sweeps every profile and warns (deduped, exit 0) on missing mantra/tracker/pack skills; this is advisory, since users may run a subset of vidas. Warns and exits 0: optional gaps (missing packs for the given `[vida]`, `just`, `rs-guard`, `herdr`, `core.excludesfile` patterns). Prints the report keys `vida`/`harness`/`cwd`/`overlay`/`required`/`optional`. Diagnostics (warnings, parse errors) go to stderr; the report goes to stdout.
_Avoid_: diagnostics on stdout (warnings are `warning: `-prefixed on stderr)

**Mantra**:
Always-on skill overlay for every vida: `i-have-adhd`, `ponytail`, `deslop`, `clarify`, TDD gate, per-vida constraint style, `herdr` (no-ops outside Herdr). Backed by the clarify-gate extension, which blocks `write` and `edit` tool calls until the user runs `/clarify` to accept the prompt; read-only tools stay available. The gate is per-session: once opened, it stays open. Print/JSON mode skips the gate.
_Avoid_: system prompt (the prompt is how mantra is injected)

**Capability**:
Optional tool a project may enable in its overlay (graphify, codegraph, serena, rs-guard, obscura, playwright). Default off. The overlay's `extra_skills` and `tracker.skill` are also capabilities: paths to local skill directories and to a machine-local tracker skill, respectively. The overlay may not invent a fourth vida.
_Avoid_: plugin, MCP (MCP is one way to expose a capability)

**Role**:
Chain/team seat a model or thinking level can be assigned to: `solo` (primary session), `planner`, `builder`, `reviewer`, `researcher`. Configured under optional `models:`/`thinking:` keys in `profiles/<vida>.yaml` (harness defaults) and `.pi/capabilities.yaml` (per-project override). The launcher passes `solo` into `pi --model`/`--thinking` and merges the profile's role maps under the overlay's (overlay wins per role) into `PI_OVERLAY`; chain/team/subagent children dispatch from that merged payload keyed on the child's agent name, falling back to the primary's current model.
_Avoid_: agent (a role is a seat, an agent is a persona file)

The vendored fusion-harness has an internal `Role` type (`ARCHITECT`/`BUILDER`/`FUSION`/`VALIDATOR`) used only inside `extensions/fusion-harness/`. It is not this glossary term; it names fusion-harness agent roles, not chain/team seats.

**Chain**:
Sequential roles (`plan → build → review`) driven by named chains from `agent-chain.yaml` (`/chain`, `/chain-list`, `run_chain`). File precedence: project `.pi/agents/agent-chain.yaml` overrides harness `profiles/<vida>/agents/` then shared `profiles/agents/agent-chain.yaml` (default `plan-build-review`; optional `research-plan-build-review` prepends a researcher step, issue #12). Each step is a child `pi` (`{task}`/`{previous}` templates, fail-fast). A step may set `rs_guard: true` (issue #7, chain-level): when the overlay enables `rs-guard`, the chain shells out to `rs-guard --diff-file` on `git diff HEAD` before the agent runs and feeds the findings into the step; overlay off or empty diff = skills-only; overlay on + missing binary or a non-zero rs-guard exit fails the chain closed. Launched via `pi-vida <vida> chain`, which loads the chain extension on top of the solo allowlist (#8). `pi-vida agents <vida>` shows which chain file won (`chainCandidates` in `extensions/agent-chain.ts`, shared with `resolvedAgentsView`, issue #81).
_Avoid_: pipeline, workflow (those include overnight/unattended systems)

**Subagent**:
Tool that delegates a task to a specialized agent with an isolated context window. Three modes: `single` (one agent, one task), `parallel` (array of tasks, max 8, max 4 concurrent), `chain` (sequential with `{previous}` placeholder, fail-fast on first non-zero exit). Children spawn `pi` in JSON mode and inherit `-e extensions/damage-control-continue.ts --no-skills` (INV-skills). Agent discovery reuses the harness's first-wins order: `profiles/<vida>/agents/` → `profiles/agents/` → cwd `.pi/agents/`. Implementation: `extensions/subagent.ts` (glue) + `extensions/subagentHelpers.ts` (types, pure helpers, child-process plumbing) + `extensions/subagent.test.ts` (bun test).
_Avoid_: orchestrator, multi-agent (overloaded; "subagent" is the harness's name for the single-tool delegation)

**Team**:
Dispatcher-only mode, launched only via `pi-vida <vida> team`. The primary loads `extensions/agent-team.ts`, which sets `dispatch_agent` as the ONLY active tool (no read/write/bash) and dispatches tasks to team members as child `pi` processes that always inherit the damage-control gate. Teams live under the `teams:` key of `agent-chain.yaml` (same file and precedence as chains); the default team is `planner, builder, reviewer, researcher`; `PI_TEAM` env overrides the active team. `/team-list` lists teams with member tool lists (`(no agent file)` when a member has no persona); team `session_start` notifies the active team and members (issue #77). Structurally mutually exclusive with chain (`agent-chain.ts`) and tilldone (`status-line.ts`): the launcher never loads those in team mode, so `setActiveTools` cannot conflict.
_Avoid_: swarm, crew

**Fusion**:
Multi-model mode (`pi-vida <vida> fusion <stack.yaml>`) loading the vendored fusion-harness extension. A stack YAML declares 2–5 slots: exactly one `architect: true` and exactly one non-architect `primary: true` that becomes the host model, with `provider/id` models, thinking levels, and optional per-slot prompts. The extension validates every slot against clean-room children (`pi --no-extensions --list-models`) and configured auth at startup; `/fh-opinion`, `/fh-debate`, `/fh-fusion`, `/fh-collaborate`, `/fh-only`, `/fh-model` run the fan-outs under a single-writer invariant. The launcher drops solo `--model`/`--thinking` in fusion mode (stack primary wins; configured solo values warn on stderr). Stack files are per-target-repo. `stacks/model-stack-trio.yaml` and `stacks/model-stack-cognition.yaml` are the copy templates. Slot models may come from built-in providers or a `~/.pi/agent/models.json` custom provider (e.g. `cognition` for SWE models over `api.cognition.ai/v1`; env-interpolated `apiKey`, visible to clean-room children).
_Avoid_: team (a fixed dispatcher roster, not model slots); overlay `models:`/`thinking:` (those drive chain/team/subagent dispatch; orthogonal to fusion's own slots)

**Tracker**:
Where tickets are created. `rust`, `ruby`, and `python` use `github-issue`. `elixir` (work) uses a machine-local overlay skill for the internal tool. The overlay's `tracker.skill` is loaded as a `--skill` arg in the argv, so the work-internal tool is available without committing its name to the public repo.
_Avoid_: board, project (GitHub Project is a surface of the tracker)

**Herdr**:
Terminal multiplexer that hosts parallel work: workspaces, panes, `herdr worktree`, and `herdr agent start <name> --kind pi -- pi-vida <vida>` as the way to start sibling vidas. Herdr is a host (INV-herdr, amends #19 from a total ban to a prompt-only exception): `pi-vida <vida> team` inside Herdr (`HERDR_ENV=1`) has the launcher split one pane per member (`pane split --current/-chain --direction right|down --cwd "$PWD" --no-focus --env PI_VIDA_WORKER=<member>`) and `herdr agent start <member> --kind pi -- pi-vida <vida> solo`; the primary becomes the dispatcher pane and `dispatch_agent` may call `herdr agent prompt <member> --wait` / `herdr agent read <member> --source recent-unwrapped` only against agents the launcher started (`PI_HERDR_MEMBERS`). Extensions must not start/stop the Herdr server, close foreign panes, or shell out to `herdr` when `HERDR_ENV` is unset. Outside Herdr, team keeps the hidden-child + kill path. Members run solo (never nested team), skip the clarify-gate, and any pane/agent failure exits 2 without a fallback. The `herdr` skill is on the mantra allowlist of every vida but no-ops unless `HERDR_ENV=1`. Doctor warns (never fails) when the `herdr` binary is off PATH.
_Avoid_: multiplexer-as-host confusion (Herdr hosts Pi vidas; Pi is the agent)

## Config format

Harness-authored files (profiles, overlay, chains, damage-control rules) are **YAML**. The harness already depends on `yaml` (npm) for damage-control rules. One format, one dependency. Do not add TOML for those files.

## Rust launcher (issue #82)

`bin/pi-vida` is a wrapper: it execs `crates/pi-vida/target/release/pi-vida` (the Rust launcher, built with `just build`) when that binary exists, else `libexec/pi-vida-launch` (the bash launcher). The Rust binary handles only the interactive gum flow (TTY, no args: host/vida/menus per `docs/host-aware-vida/design.md`) and the non-Pi `--host cline|kilo|claude` path (install via `bun scripts/skills-bootstrap.ts --allowlist <names>`, project skills + personas, exec or print). Launch, `--dry-run`, `doctor`, `doctor-probe`, `agents`, and `--dump-overlay` all delegate to the bash launcher, so the INV-skills argv and overlay handling stay in one place. Build artifacts (`crates/pi-vida/target/`) are gitignored; `just smoke` guards its Rust-specific checks on `command -v cargo`.
