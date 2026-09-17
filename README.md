# pi-vida

A **vida** is a per-language profile (`ruby`, `rust`, `python`, `elixir`): skills, a safety gate, a ticket tracker. `pi-vida` launches one inside your repo, on the agent host you already use:

```sh
cd path/to/your/repo
pi-vida ruby               # Pi: Ruby skill packs + GitHub issue tracker
pi-vida ruby --host kilo   # Kilo: install + project the same skills, run kilo
pi-vida                    # interactive host/vida menu — needs gum
```

- **Non-Pi hosts:** `pi-vida --host cline|kilo|claude` installs the vida's skills and projects them into the host's folder (`~/.agents/skills`, `~/.kilo/skills`, `~/.claude/skills`), then execs the host or prints a start hint. Guide: [docs/how-to.md](docs/how-to.md#use-with-cline-or-kilo).
- **Interactive:** no arguments on a terminal opens the host/vida/mode menu; needs [gum](https://github.com/charmbracelet/gum) (a missing gum exits 2 with an install hint). Without gum, run the Pi path directly (`pi-vida ruby`) or provision skills with `just skills`.
- **Pi-only:** `pi-vida ruby chain` (plan → build → review), `pi-vida ruby team` (dispatch to specialists), `pi-vida doctor` (health check), fusion stacks.
- **First time:** clone this repo, then `just install` + `just skills` ([Install](#install)); Pi hosts also need `npm i -g @earendil-works/pi-coding-agent`, non-Pi hosts also need `just build` (the Rust launcher).
- Glossary: [CONTEXT.md](CONTEXT.md). Full guide: [docs/how-to.md](docs/how-to.md).

## Launch

From the **target repo**, not this one:

```text
pi-vida ruby               # Rails: Ruby skill packs + GitHub issue tracker
pi-vida ruby chain         # + plan → build → review
pi-vida ruby team          # + dispatch to planner/builder/reviewer/researcher
pi-vida ruby fusion .pi/fusion-harness/model-stack-trio.yaml  # + 2-5 model stack
pi-vida python             # pandas / FastAPI (no extra packs yet)
pi-vida elixir             # Elixir/Phoenix (no ticket tracker configured)
pi-vida rust               # Rust crate
pi-vida --dry-run ruby     # print the pi command it would run, launch nothing
pi-vida doctor             # health check for this machine + repo
pi-vida doctor ruby        # same, plus ruby pack checks
```

Aliases: `rails` → `ruby`, `phoenix` → `elixir`. `ecto` and `rails-python` are not vidas.

`pi-vida` loads `profiles/<vida>.yaml`, then execs `pi -e extensions/damage-control-continue.ts --no-skills` plus allowlisted `--skill`. Invalid YAML, a missing mantra path, or a missing configured tracker path exits 2. Omit tracker = no tracker. Missing packs warn. Team mode additionally loads `extensions/agent-team.ts`: the primary is a dispatcher with `dispatch_agent` as its only tool (children inherit the damage-control gate); team definitions live under the `teams:` key of `agent-chain.yaml`. Chain mode additionally loads `extensions/agent-chain.ts` (`/chain`, `/chain-list`, `run_chain`; chains under the `chains:` key of the same file). Blocked `git push` / `reset --hard` / `clean -fd` / `.env` / `auth.json` / writes outside cwd return feedback; the turn continues.

### First launch

On the first `pi-vida` launch in a repo, two things happen:

- **Clarify gate**: `write`/`edit` are blocked until you run `/clarify` to accept the prompt. Read-only tools stay available.
- **Boot config wizard**: when the repo has no `.pi/capabilities.yaml`, it walks the six capability toggles (graphify, codegraph, serena, rs-guard, obscura, playwright) and optional per-role model/thinking defaults (solo, planner, builder, reviewer, researcher), then writes the overlay only after you confirm. A cancelled prompt skips the write; no UI skips the wizard entirely.

Note: "clarify" names three different things (the `/clarify` command, the `clarify` skill, the `requirements-clarifier` skill). See [docs/how-to.md](docs/how-to.md#first-launch-in-a-target-repo). The overlay's solo `models`/`thinking` become `pi --model`/`--thinking` on later launches; chain/team/subagent children dispatch with the per-role values keyed on the child's agent name. Details: [CONTEXT.md](CONTEXT.md) (**Boot Config**, **Role**).

## Install

```sh
npm i -g @earendil-works/pi-coding-agent   # the pi binary
just install                             # bun install + symlink pi-vida onto ~/.local/bin
just skills                              # provision ~/.agents/skills from packs.yaml
just install-smoke                       # verify the symlink + --dry-run through it
```

Skills resolve to directories under `~/.agents/skills`. `just skills` clones the repos in `packs.yaml`, symlinks each skill in, and writes `.dotskills-manifest.json`. Without it, launch exits 2 on a missing required path (packs only warn). Full setup: [docs/how-to.md](docs/how-to.md#install).

## Herdr (host)

Herdr is the host for parallel work: workspaces, panes, `herdr worktree`, and `herdr agent start --kind pi`. Herdr launches `pi-vida` itself; extensions never call `herdr`, and the prompt-only team dispatch below is the one exception. Example: `herdr agent start reviewer --kind pi -- pi-vida ruby`. Inside Herdr, `pi-vida <vida> team` goes pane-native (INV-herdr, amends #19): the launcher splits one pane per team member (`herdr agent start <member> --kind pi -- pi-vida <vida> solo`) and `dispatch_agent` prompts members with `herdr agent prompt --wait`, but only members the launcher started and only while `HERDR_ENV=1`. Outside Herdr team mode stays on hidden children + kill.

The `herdr` skill is on every vida's mantra allowlist; it no-ops unless `HERDR_ENV=1`. `pi-vida doctor` warns (never fails) when `herdr` is not on PATH. Prefer `herdr worktree` when already inside Herdr; `stacked-pr-worktree-workflow` stays for gh-stack PR topology.

## Configuration

- `CONTEXT.md`: domain glossary (vidas, overlay, mantra).
- `ARCHITECTURE.md`: how the launcher, profiles, skills home, and extensions connect (with diagrams).
- `AGENTS.md`: project rules; auto-loaded by rs-guard as supplemental context.
- `.github/review-prompt.md`: the review prompt used by both local and CI runs.
- `.reviewer.toml`: rs-guard configuration (provider, model, timeout).
- `.rs-guardignore`: paths excluded from review diffs.

Harness profiles and project overlays are **YAML** (same parser as damage-control rules). See CONTEXT.md.

## Developing this harness

```text
bun install
just smoke
just ext-purpose-gate   # purpose widget + context meter
just ext-minimal        # model + 10-block context meter
just ext-cross-agent    # .claude/.gemini/.codex commands
just ext-system-select  # /system persona from discovered agents (profiles, .pi, .claude/.gemini/.codex)
just ext-damage-control # continue-variant safety rules
```

`just smoke` ends with `just smoke-rails fixture`: it runs `pi-vida --dry-run ruby` from a synthetic Rails repo and asserts the ruby pack argv; deterministic by default. `just smoke-rails` manually prefers a real repo discovered under `~/Developer` (`Gemfile` containing `gem "rails"`); `just smoke-rails ~/path/to/app` uses that repo and fails loudly (exit 1) if it has no `Gemfile`.

### AI code review

[rs-guard](https://github.com/nebulaideas/rs-guard) reviews staged files on commit and every non-draft pull request.

[open-code-review](https://github.com/alibaba/open-code-review) (`ocr`) is the default interactive review tool. Run it on demand:

```sh
npx -y @alibaba-group/open-code-review
```

`pi-vida doctor` warns when neither `ocr` nor `npx` is available.

#### Pre-commit hook

The hook is in `.githooks/pre-commit`. Activate it for this clone:

```sh
git config core.hooksPath .githooks
```

Or use the helper script:

```sh
./scripts/install-hooks.sh
```

Requirements:

- `rs-guard` 1.8.3 installed (`cargo install rs-guard --locked --version 1.8.3`)
- An API key exported (e.g. `DEEPSEEK_API_KEY`) or in `~/.config/rs-guard/env`

Bypass the hook when needed:

```sh
git commit --no-verify
```

#### CI / GitHub Actions

The workflow `.github/workflows/rs-guard-review.yml` runs on every non-draft pull request. It requires a `DEEPSEEK_API_KEY` repository secret and publishes a GitHub Check Run.

> **Note:** `pull_request` workflows do not receive secrets from forks. Reviews run only for PRs from branches in this repo or for trusted collaborators.

## Acknowledgments

`extensions/fusion-harness/` is vendored (MIT) from [IndyDevDan (disler)](https://github.com/disler)'s [fusion-harness](https://github.com/disler/fusion-harness). His agent-harness teaching shaped the earlier design.
