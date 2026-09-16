# pi-vida how-to

Task-oriented guide: install, launch, configure, run chains and teams, troubleshoot.
Domain terms are in [CONTEXT.md](../CONTEXT.md); project rules in [AGENTS.md](../AGENTS.md).

## Install

```sh
git clone git@github.com:igmarin/pi-vida.git && cd pi-vida
npm i -g @earendil-works/pi-coding-agent   # the pi binary itself
just install          # bun install + symlink pi-vida onto ~/.local/bin (pi-life shim too)
just skills           # provision ~/.agents/skills from packs.yaml
```

That's all you need to *use* `pi-vida` — launch it from your own repos, not from this clone. `pi-life` still works as a shim for one release (`pi-life is now pi-vida` on stderr, then the same argv).

> Only if you're contributing to the harness itself: `git config core.hooksPath .githooks` (rs-guard pre-commit) or `scripts/install-hooks.sh`. Using `pi-vida` in your own repos needs no hooks.

Skills: every allowlisted mantra/pack/tracker name resolves to a directory under `PI_SKILLS_HOME` (default `~/.agents/skills`). `just skills` is the supported bootstrap: it reads `packs.yaml` (allowlist name → `owner/repo`), clones each repo into `~/.local/share/pi-vida/repos`, symlinks every `skills/<name>/SKILL.md` into the skills home, and writes `.dotskills-manifest.json` so pack names resolve to their installed skills. Re-run it after pulling the harness or adding a pack; it is idempotent and never overwrites a non-symlink dir. Manual alternative: install packs with dotskills, or drop/symlink any directory containing a `SKILL.md` in there. Missing **required** paths — a mantra, or a tracker the profile configures — exit 2 at launch; a missing pack only warns and launch continues. A malformed `.dotskills-manifest.json` or a manifest entry missing its `SKILL.md` also exits 2.

Requirements: `pi` and `bun` on PATH (fail-closed, checked by `pi-vida doctor`); optional `just`, `rs-guard`, `herdr` (warn only). The `DEEPSEEK_API_KEY` for rs-guard reviews lives in the environment or `~/.config/rs-guard/env` — never in a target repo.

## Updating

`~/.local/bin/pi-vida` is a symlink into the clone, so `git pull` updates the code in place — no reinstall, no need to remove the command first.

```sh
git pull
just install   # only if bun.lock changed, or you moved the clone (ln -sfn repoints the symlink)
just skills    # re-provision skills if packs.yaml changed; idempotent
```

## First launch in a target repo

`pi-vida` runs from the **target repo** (a Rails app, a Rust crate, whatever), not from the harness clone:

```sh
cd ~/Work/my-rails-app
pi-vida ruby          # solo mode (default)
```

Two things happen on the first launch in a repo:

1. **Clarify gate** — `write`/`edit` are blocked until you run `/clarify` to accept the prompt. Read-only tools stay available so the model can explore. (Three different things share the word "clarify": the `/clarify` **command** opens the gate; the `clarify` **skill** and `requirements-clarifier` **skill** are the always-on mantra skills that help the model refine your prompt. Only the command is something you interact with directly.)
2. **Boot TUI** (only when `.pi/capabilities.yaml` does not exist): the six capability toggles (graphify, codegraph, serena, rs-guard, obscura, playwright) and optional per-role model/thinking. Saving is explicit — a cancelled prompt skips the write.

Second launch with a saved overlay: no TUI. The overlay's `models.solo`/`thinking.solo` become `pi --model`/`--thinking`.

## Daily driver: vidas and modes

```sh
pi-vida ruby solo     # full toolset + footer status line (default)
pi-vida ruby chain    # + /chain, /chain-list, run_chain tool
pi-vida ruby team     # dispatcher-only primary (dispatch_agent is the only tool)
pi-vida python        # mantra only (pandas / FastAPI)
pi-vida elixir        # no github-issue tracker
pi-vida rust
pi-vida --dry-run ruby  # print the pi argv, launch nothing
```

Aliases: `rails` → `ruby`, `phoenix` → `elixir`. `ecto` and `rails-python` are not vidas (exit 2).

Mode exclusivity is structural: solo loads the status line, chain loads the chain extension, team loads the dispatcher, fusion loads the vendored multi-model extension — never more than one of them.

### Inspect what will run

```sh
pi-vida agents ruby            # resolved view for cwd + vida
pi-vida agents nope            # unknown vida → exit 2
```

Prints, per cwd: winner and shadowed personas (`agent:` / `shadows:`), the active team and members (`team:`, `members:`; `PI_TEAM` is marked), the chain file that won, **both** discovery orders with `*` marking candidates that exist on disk, and the `--skill` paths launch would pass (same resolver as launch — missing mantra/tracker exit 2, missing packs warn). The bun-side resolver is `resolvedAgentsView` in `extensions/agents-view.ts` (the in-session `/agents` command builds on it).

## Model fusion

```sh
# one-time per target repo: copy a stack template, then edit model:/thinking: per slot.
# Templates live under stacks/ in the harness clone (e.g. ~/Work/pi-vida/stacks/).
mkdir -p .pi/fusion-harness
cp ~/Work/pi-vida/stacks/model-stack-trio.yaml .pi/fusion-harness/
pi-vida ruby fusion .pi/fusion-harness/model-stack-trio.yaml
```

Slot rules, validation, and the `/fh-*` commands: CONTEXT.md **Fusion**.

### Cognition (SWE) slots

Cognition's SWE models are served over an OpenAI-compatible endpoint but aren't a built-in Pi provider — register one in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "cognition": {
      "baseUrl": "https://api.cognition.ai/v1",
      "api": "openai-completions",
      "apiKey": "$COGNITION_API_KEY",
      "models": [{ "id": "swe-1.7", "name": "SWE 1.7", "contextWindow": 262144, "maxTokens": 32768 }]
    }
  }
}
```

`apiKey` interpolates `$VAR`/`${VAR}` from the environment (or a `!command`, or a literal — keep secrets out of the file per the secrets rule). Because it lives in `models.json`, the provider is visible to clean-room children (`pi --no-extensions --list-models`), which is what fusion's slot validation requires. `stacks/model-stack-cognition.yaml` is the copy template. Set `COGNITION_API_KEY` or put a literal in `models.json` — the launcher does not parse the stack for keys.

`https://api.cognition.ai/v1` is the conventional default, but Cognition provisions endpoints per customer — if a request 401s with a valid key, use the base URL from your Cognition onboarding (as `baseUrl` here, or `COGNITION_API_BASE` for LiteLLM-style tools). Sanity-check the key before touching the stack: `curl https://api.cognition.ai/v1/chat/completions -H "Authorization: Bearer $COGNITION_API_KEY" -d '{"model":"swe-1.7","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'`.

## Project overlay (`.pi/capabilities.yaml`)

Turn capabilities on per project; missing file ≡ all off; malformed YAML exits 2:

```yaml
graphify: true
rs-guard: true
extra_skills:            # local, uncommitted skill dirs (paths relative to the repo)
  - .pi/local-skills/team-rule
tracker:
  skill: .pi/local-tracker/work   # machine-local tracker (elixir vidas use this)
models:
  planner: openrouter/z-ai/glm-5.3-flash
  builder: openrouter/other
thinking:
  planner: max
  builder: low
```

- Capabilities gate the `<capabilities>` system-prompt block; the model never sees a capability that is off.
- `extra_skills` and `tracker.skill` become `--skill` argv entries so the model can actually use them.
- `models`/`thinking` roles: `solo` (primary `--model`/`--thinking`) and `planner`/`builder`/`reviewer`/`researcher` — chain/team/subagent children dispatch with the entry keyed on the **child's agent name**, falling back to the primary's current model when the agent has no entry. Profile-level `models:`/`thinking:` merge under the overlay's as defaults (overlay wins per role), so profile defaults reach children without repeating them in every project.
- Hand-edit freely; the launcher re-parses and re-validates every launch.

## Per-project agents, chains, teams

Discovery (first-wins on name): `profiles/<vida>/agents/` → `profiles/agents/` → cwd `.pi/agents/` → cwd `.claude/.gemini/.codex` → `$HOME/.claude/.gemini/.codex`.

**Agent file** (`.pi/agents/my-agent.yaml`):

```yaml
name: my-agent
description: One line
tools: read, grep, bash   # comma list or YAML array; empty = default toolset
body: |
  System prompt for this agent.
```

**Custom chain or team** (`.pi/agents/agent-chain.yaml` overrides the harness default entirely):

```yaml
chains:
  my-flow:
    description: One-line description
    steps:
      - agent: my-agent
        task: "Plan: {task}"       # {task} = original request, {previous} = prior step output
      - agent: builder
        rs_guard: true             # rs-guard reviews `git diff HEAD` before this step
teams:
  fast:
    description: Two-member team
    members: [builder, reviewer]
```

`rs_guard: true` needs the overlay's `rs-guard: true` plus the binary on PATH; a non-zero rs-guard exit fails the chain closed.

## Running chains and teams

```sh
pi-vida ruby chain
# in the session:
/chain-list                       # what's available
/chain plan-build-review Fix the N+1 in OrdersController#show
/chain research-plan-build-review <task>   # research-first variant
```

Steps run as child `pi` processes (JSON mode, isolated context, damage-control gate always inherited). Fail-fast: the first failed step stops the chain. The `run_chain` tool lets the primary session run a chain programmatically.

```sh
pi-vida ruby team
# the primary cannot read/write/bash — it plans and dispatches:
# dispatch_agent(agent: "builder", task: "...") for each team member
/team-list                        # teams, active team marked
PI_TEAM=fast pi-vida ruby team    # override the active team (default: planner, builder, reviewer, researcher)
```

## rs-guard review flow

- **Pre-commit**: reviews **staged** files; `REQUEST_CHANGES` (exit 2) aborts the commit. Bypass: `git commit --no-verify`.
- **PRs**: `.github/workflows/rs-guard-review.yml` reviews every non-draft PR.
- **Chain steps**: `rs_guard: true` runs rs-guard on `git diff HEAD` before the step and feeds findings into the agent — the agent verifies findings, it does not re-run the binary.
- Config: `.reviewer.toml` (provider, model); ignore list: `.rs-guardignore`.

## Doctor, excludesfile, herdr

```sh
pi-vida doctor           # machine + cwd health; sweeps every profile's skills (warn-only)
pi-vida doctor ruby      # fail-closed preflight for the ruby vida
```

`doctor <vida>` fails closed on missing `pi`/`bun` or missing mantra/tracker skill paths — the same contract the launcher enforces. Bare `doctor` sweeps all profiles and warns (deduped, exit 0) on missing mantra/tracker/pack skills so a fresh machine shows the gap before launch. Both modes still exit 2 on a malformed profile or `.dotskills-manifest.json` — a broken config is a launch failure, not a warning. Both warn on `just`, `rs-guard`, `ocr` (or `npx` to run it on demand), `herdr`, and a missing/incomplete `git config --get core.excludesfile` (needs: `node_modules`, `.pi/agent-sessions/`, `.env`, `graphify-out/`, `.codegraph/`).

Herdr hosts parallel vidas: `herdr agent start reviewer --kind pi -- pi-vida ruby`. The `herdr` skill is allowlisted everywhere but no-ops unless `HERDR_ENV=1`.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| exit 2, `missing required mantra …` | allowlisted skill path does not exist under `PI_SKILLS_HOME` (or `~/.agents/skills`) | create/symlink the skill dir, or set `PI_SKILLS_HOME` |
| exit 2, `invalid YAML` | profile or overlay failed the strict parser | fix the YAML; one format, one parser (`yaml` npm) |
| exit 2, `unknown key(s): …` | overlay has a key the parser doesn't know (e.g. a removed capability) | delete the key from `.pi/capabilities.yaml` |
| exit 2, `invalid skill identity manifest` / `missing installed skill` | `.dotskills-manifest.json` is corrupt or an installed skill dir was removed | reinstall the pack with dotskills, or remove the manifest to fall back to plain dirs |
| exit 2, `unknown vida` / `not a vida` | typo or `ecto`/`rails-python` | use `rust`, `elixir`, `ruby`, `python` (or alias) |
| `Unknown session` | resume/attach with an ID the local store doesn't know | start from the same repo/machine; `pi --list-sessions`; or just relaunch `pi-vida <vida>` |
| `Damage-Control: <tool> blocked` | the gate caught `git push`, `reset --hard`, `clean`, a protected path (`.env`, `auth.json`), or a write outside cwd | intended behavior; ask the user how to proceed — the turn continues |
| `Clarify gate: write/edit is blocked…` | the session hasn't accepted a prompt yet | run `/clarify` after landing the prompt you want |
| `chain … rs-guard failed (exit 2)` | rs-guard `REQUEST_CHANGES` on the diff | address the findings, commit, re-run the chain |
| `rs-guard: Error occurred (exit 1)` / `Request timed out` | the review provider's API is unreachable — a transport failure, not a verdict | retry; bypass with `git commit --no-verify` while the provider is down |
| `401: incorrect_api_key` when the agent speaks | the configured pi model's key is wrong or absent | `/model` to a working provider, or fix the key in pi's config |
| write prompt missing on first boot | no UI (print/JSON mode) | boot TUI needs a terminal; run interactively once |
| child `pi` still running after Escape / Ctrl+C / `/exit` | parent waited on a child that ignored SIGTERM, or a bash descendant was outside the process group | wait 5s for SIGKILL; leftover processes after that are a bug. Wall-clock kill is `PI_CHILD_TIMEOUT_MS` (default 15 minutes) |

## Environment variables

| Var | Purpose |
|---|---|
| `PI_SKILLS_HOME` | skill root (default `~/.agents/skills`) |
| `PI_VIDA_HOME` | harness root override (harness internal; default: the directory containing `pi-vida`) |
| `PI_LIFE_HOME` | fallback for `PI_VIDA_HOME` (one release) |
| `MY_PI_AGENT_HOME` | fallback for `PI_VIDA_HOME` (one release) |
| `PI_TEAM` | active team in team mode |
| `PI_CHILD_TIMEOUT_MS` | wall-clock timeout for chain/team/subagent child `pi` processes (default `900000` = 15 minutes). Failed result with `timeout` stopReason. |
| `PI_VIDA` | exported to children; agent/chain discovery uses it (harness internal) |
| `PI_LIFE` | fallback for `PI_VIDA` (one release) |
| `PI_OVERLAY` / `PI_OVERLAY_EXISTS` | launcher → extension overlay payload / first-launch skip flag (harness internal) |
| `HERDR_ENV` | set by Herdr; enables the `herdr` skill |
| `DEEPSEEK_API_KEY` | rs-guard provider key (env or `~/.config/rs-guard/env`) |
| `COGNITION_API_KEY` | Cognition SWE endpoint key for fusion stacks (`models.json` interpolates `$COGNITION_API_KEY`) |

## Harness development

```sh
just smoke        # the proof: launches nothing, asserts argv invariants, ends with smoke-rails
bun test          # unit suites for extensions
just test-dotskills  # manual e2e: real dotskills install -> pack resolution (needs a dotskills checkout)
just --list       # ext-* recipes for hacking on extensions standalone
```

Never add a `justfile` to a target repo. Harness config (profiles, overlays, damage-control rules, chains) is YAML — do not introduce TOML.
