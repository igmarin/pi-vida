# pi-vida — Project Rules

This repo is the **pi-vida** harness. Host is Pi. Run `pi-vida` from the **target repo**.

Pointers (load when the topic comes up):

- `CONTEXT.md` — glossary (vida, profile, mantra, overlay, tracker, chain, team)
- `docs/how-to.md` — task-oriented usage guide (install, launch, overlay, chains, teams, troubleshooting)
- `README.md` — launch, install, rs-guard hook/CI
- `ARCHITECTURE.md` — system boundary, launch pipeline, INV-skills, extension ownership
- `.github/review-prompt.md` — rs-guard axes, severity, verdict metadata

## Shipped

- Vidas: `rust` | `elixir` | `ruby` | `python`. Aliases: `phoenix` → `elixir`, `rails` → `ruby`. `ecto` and `rails-python` exit 2 (`use ruby or python`).
- Profiles: YAML at `profiles/<vida>.yaml` (`vida:`; `life:` still parses; both set to different values exit 2). Launch is `pi -e extensions/damage-control-continue.ts --no-skills` then `--skill` for each allowlisted mantra, pack, and tracker — the INV-skills contract (invariant: damage-control gate + `--no-skills` + only allowlisted `--skill` paths). Env: `PI_VIDA_HOME` then `PI_LIFE_HOME` then `MY_PI_AGENT_HOME`; `PI_VIDA` then `PI_LIFE`.
- Fail closed (exit 2): invalid YAML; missing mantra path; missing path for a **configured** tracker. `tracker: none` or omitting tracker (elixir) loads no tracker skill. Missing packs warn and still launch.
- `chain` loads `extensions/agent-chain.ts` (`/chain`, `/chain-list`, `run_chain`) on top of the solo allowlist. `team` loads `extensions/agent-team.ts`: dispatcher-only primary (`dispatch_agent` as the only tool), teams defined under the `teams:` key of `agent-chain.yaml` (default: planner, builder, reviewer, researcher). `pi-vida doctor [vida]` checks required launcher pieces (`pi`, `bun`) and required mantra/tracker skill paths fail-closed; bare `doctor` sweeps every profile and warns (deduped, exit 0) on missing skills. Warns on optional gaps (packs, `just`, `rs-guard`, `ocr`, `herdr`, excludesfile), and prints the resolved overlay. `pi-vida agents <vida>` prints the resolved agents view for cwd (winner/shadows, team, chain file, both discovery orders, resolved `--skill` paths; resolver `resolvedAgentsView` in `extensions/agents-view.ts`).
- Skills bootstrap: `just skills` runs `scripts/skills-bootstrap.ts` — reads `packs.yaml` (allowlist name → `owner/repo`), clones into `~/.local/share/pi-vida/repos`, symlinks skills into `PI_SKILLS_HOME`/`~/.agents/skills`, writes `.dotskills-manifest.json`. Idempotent; never overwrites a non-symlink dir.
- `python` is pandas/FastAPI, not a Rails companion. GraphQL/REST are API packs, not vidas.
- Extensions: `export default function (pi)`. Skip `ctx.ui` when `!ctx.hasUI`. Stacked `-e`: first extension wins the theme. `cross-agent` / `system-select` live under `extensions/` but are not passed by `pi-vida` yet. `fusion` loads vendored `extensions/fusion-harness/` (MIT, disler/fusion-harness @ `01a3482`): `pi-vida <vida> fusion <stack.yaml>` passes `--fh-config`; stack `primary` is the host model (solo `--model`/`--thinking` dropped with a warning). Copy templates in `stacks/`; Cognition SWE setup in docs/how-to.md. Agent search: `profiles/<vida>/agents/` (YAML), shared `profiles/agents/`, cwd `.pi/agents/`, then `.claude/.gemini/.codex` (cwd), then `~/.claude/.gemini/.codex`. First-wins on name. Alias `rails` → `ruby`.
- Config for profiles/overlays/damage-control is YAML. Do not add TOML for those files. `yaml` npm is the parser.
- Skills live under `PI_SKILLS_HOME` or `~/.agents/skills`. Do not vendor packs into this repo. A pack name resolves via `.dotskills-manifest.json` (`<pack>:<name>` identities, written by the dotskills installer) when present; a malformed manifest, a missing installed skill, or a resolver failure exits 2; a pack with no manifest entries falls back to the legacy `<skills-home>/<name>` dir.
- Harness tasks: `bun` + `just`. Never add a `justfile` to a target repo. Proof: `just smoke` (no tokengate, no mlx).
- Herdr is a host: `herdr agent start <name> --kind pi -- pi-vida <vida>`. INV-herdr (#79, amends #19): inside Herdr (`HERDR_ENV=1`) the launcher splits one pane per team member and starts each with `herdr agent start <member> --kind pi -- pi-vida <vida> solo` (PI_VIDA_WORKER member base, no boot-config/clarify-gate); `dispatch_agent` then prompts via `herdr agent prompt <member> --wait` and reads via `herdr agent read --source recent-unwrapped`, but ONLY for members the launcher started (`PI_HERDR_MEMBERS`). No starting/stopping the Herdr server, no closing foreign panes, and no `herdr` calls when `HERDR_ENV` is unset — outside Herdr team keeps hidden children + kill.
- Boot config: first launch with no `.pi/capabilities.yaml` runs the `extensions/boot-config.ts` wizard (skips when `PI_OVERLAY_EXISTS=1` or no UI). Overlay `models.solo`/`thinking.solo` override profile `models:`/`thinking:` defaults into `pi --model`/`--thinking`; chain/team/subagent children dispatch with the merged per-role model/thinking (profile defaults under overlay overrides) keyed on the child's agent name (planner/builder/reviewer/researcher), falling back to the primary's current model.
- Ponytail: shortest working code. `ponytail-review` the staged diff before every push; cut findings first.
- Secrets stay in the environment or `~/.config/rs-guard/env`. Never commit keys, `auth.json`, or `.env`, and never read them from a target repo.

## rs-guard

rs-guard 1.8.3 reviews **staged** files on commit (`.githooks/pre-commit`) and every non-draft PR (`.github/workflows/rs-guard-review.yml`). It auto-loads this file as project rules (`project_rules_enabled`). Prompt: `.github/review-prompt.md`. Ignore: `.rs-guardignore` (includes `graphify-out/`).

Pre-commit: `REQUEST_CHANGES` is exit 2 and **aborts the commit**. `[Critical]` / `[Security]` / `NEGATIVE` must block. `[Important]` below the threshold is COMMENT, not a merge gate. Bypass: `git commit --no-verify`.

Provider: DeepSeek (`DEEPSEEK_API_KEY`). Prefer `deepseek-v4-flash` for local reviews.

## Docs

Changed launch invariants or new domain terms → update `CONTEXT.md`, keep `README.md` short, extend `just smoke`.
