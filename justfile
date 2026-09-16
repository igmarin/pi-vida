set dotenv-load := false

root := justfile_directory()

default:
    @just --list

# Install JS deps and symlink pi-vida onto PATH
install:
    #!/usr/bin/env bash
    set -euo pipefail
    bun install
    : "${HOME:?HOME must be set}"
    mkdir -p "${HOME}/.local/bin"
    ln -sfn "{{root}}/bin/pi-vida" "${HOME}/.local/bin/pi-vida"
    ln -sfn "{{root}}/bin/pi-life" "${HOME}/.local/bin/pi-life"
    echo "pi-vida -> {{root}}/bin/pi-vida"

# Build the Rust launcher (bin/pi-vida prefers it once present)
build:
    cargo build --release --manifest-path "{{root}}/crates/pi-vida/Cargo.toml"

# Provision PI_SKILLS_HOME from packs.yaml: clone pack/skill repos, symlink
# skills into ~/.agents/skills, write .dotskills-manifest.json. Idempotent.
skills:
    bun "{{root}}/scripts/skills-bootstrap.ts"

# Verify the install symlink and a --dry-run through it (stub skills, no dotskills)
install-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    link="${HOME:?HOME must be set}/.local/bin/pi-vida"
    test -L "${link}" || { echo "install-smoke: ${link} missing or not a symlink (run just install)" >&2; exit 1; }
    test "$(readlink "${link}")" = "{{root}}/bin/pi-vida" || { echo "install-smoke: ${link} -> $(readlink "${link}"), expected {{root}}/bin/pi-vida" >&2; exit 1; }
    tmp="$(mktemp -d)"
    trap 'rm -rf "${tmp}"' EXIT
    for name in i-have-adhd ponytail ponytail-review deslop clarify requirements-clarifier tdd herdr github-issue; do
      mkdir -p "${tmp}/${name}"
      printf '%s\n' "# ${name}" >"${tmp}/${name}/SKILL.md"
    done
    # run from a temp cwd to prove the installed path works outside the clone
    out="$(cd "$(mktemp -d)" && PI_SKILLS_HOME="${tmp}" "${link}" --dry-run ruby)"
    grep -q -- "-e .*extensions/damage-control-continue.ts" <<<"${out}"
    grep -q -- "--no-skills" <<<"${out}"
    echo "install-smoke ok (${link})"

# Help + dry-run profile smoke (does not launch Pi TUI)
smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{root}}"
    bin="${root}/bin/pi-vida"
    "$bin" --help >/dev/null
    tmp="$(mktemp -d)"
    trap 'rm -rf "${tmp}"' EXIT
    for name in i-have-adhd ponytail ponytail-review deslop clarify requirements-clarifier tdd herdr \
                github-issue agnostic-planning-skills ruby-core-skills rails-agent-skills elixir-phoenix-skills; do
      mkdir -p "${tmp}/${name}"
      printf '%s\n' "# ${name}" >"${tmp}/${name}/SKILL.md"
    done
    export PI_SKILLS_HOME="${tmp}"

    rust_out="$("${bin}" --dry-run rust 2>"${tmp}/rust.err")"
    rust_solo_out="$("${bin}" --dry-run rust solo 2>"${tmp}/rust-solo.err")"
    rust_chain_out="$("${bin}" --dry-run rust chain 2>"${tmp}/rust-chain.err")"
    rust_team_out="$("${bin}" --dry-run rust team 2>"${tmp}/rust-team.err")"
    elixir_out="$("${bin}" --dry-run elixir 2>"${tmp}/elixir.err")"
    ruby_out="$("${bin}" --dry-run ruby 2>"${tmp}/ruby.err")"
    rails_out="$("${bin}" --dry-run rails 2>"${tmp}/rails.err")"
    python_out="$("${bin}" --dry-run python 2>"${tmp}/python.err")"

    case "${rust_out}" in
      pi\ -e\ *damage-control-continue.ts\ *capabilities.ts\ *clarify-gate.ts\ --no-skills\ *) ;;
      *) echo "INV-skills: rust argv must include -e damage-control-continue -e capabilities.ts -e clarify-gate.ts --no-skills: ${rust_out}" >&2; exit 1 ;;
    esac
    echo "${rust_out}" | grep -q -- "-e ${root}/extensions/damage-control-continue.ts"
    echo "${rust_out}" | grep -q -- "-e ${root}/extensions/boot-config.ts"
    echo "${rust_out}" | grep -q -- "-e ${root}/extensions/capabilities.ts"
    echo "${rust_out}" | grep -q -- "-e ${root}/extensions/clarify-gate.ts"
    echo "${rust_out}" | grep -q -- "--skill ${tmp}/ponytail"
    echo "${rust_out}" | grep -q -- "--skill ${tmp}/herdr"
    echo "${rust_out}" | grep -q -- "--skill ${tmp}/github-issue"
    ! grep -q -- "elixir-phoenix-skills" <<<"${rust_out}"
    ! grep -q -- "rails-agent-skills" <<<"${rust_out}"
    grep -q 'missing pack rust-core-skills' "${tmp}/rust.err"

    echo "${rust_out}" | grep -q -- "-e ${root}/extensions/status-line.ts"
    echo "${rust_solo_out}" | grep -q -- "-e ${root}/extensions/status-line.ts"
    ! grep -q -- "status-line.ts" <<<"${rust_chain_out}"
    ! grep -q -- "status-line.ts" <<<"${rust_team_out}"
    # Issue #8: team mode loads the dispatcher-only primary.
    echo "${rust_team_out}" | grep -q -- "-e ${root}/extensions/agent-team.ts"
    ! grep -q -- "agent-team.ts" <<<"${rust_solo_out}"
    # Chain mode loads the /chain commands + run_chain tool, not the
    # status line or the team dispatcher.
    echo "${rust_chain_out}" | grep -q -- "-e ${root}/extensions/agent-chain.ts"
    ! grep -q -- "agent-chain.ts" <<<"${rust_solo_out}"
    ! grep -q -- "agent-chain.ts" <<<"${rust_team_out}"
    ! grep -q -- "agent-team.ts" <<<"${rust_chain_out}"

    # (p) fusion mode loads the vendored multi-model extension with an
    # explicit stack file; solo/team/chain argv never carry it.
    fusion_stack="${tmp}/model-stack-trio.yaml"
    cp "${root}/stacks/model-stack-trio.yaml" "${fusion_stack}"
    test -f "${root}/extensions/fusion-harness/fusion-harness.ts"
    fusion_out="$("${bin}" --dry-run rust fusion "${fusion_stack}" 2>"${tmp}/fusion.err")"
    echo "${fusion_out}" | grep -q -- "-e ${root}/extensions/fusion-harness/fusion-harness.ts"
    echo "${fusion_out}" | grep -q -- "--fh-config ${fusion_stack}"
    ! grep -q -- "fusion-harness.ts" <<<"${rust_solo_out}"
    ! grep -q -- "fusion-harness.ts" <<<"${rust_chain_out}"
    ! grep -q -- "fusion-harness.ts" <<<"${rust_team_out}"
    ! grep -q -- "memory.ts" <<<"${fusion_out}"
    status=0
    "${bin}" --dry-run rust fusion >/dev/null 2>"${tmp}/fusion-noarg.err" || status=$?
    test "${status}" -eq 2
    status=0
    "${bin}" --dry-run rust fusion "${tmp}/no-such-stack.yaml" >/dev/null 2>"${tmp}/fusion-nofile.err" || status=$?
    test "${status}" -eq 2
    grep -q 'fusion stack not found' "${tmp}/fusion-nofile.err"
    fusion_cog_out="$("${bin}" --dry-run rust fusion "${root}/stacks/model-stack-cognition.yaml" 2>/dev/null)"
    echo "${fusion_cog_out}" | grep -q -- "--fh-config ${root}/stacks/model-stack-cognition.yaml"

    echo "${elixir_out}" | grep -q -- "--skill ${tmp}/elixir-phoenix-skills"
    ! grep -q -- "github-issue" <<<"${elixir_out}"
    ! grep -q -- "rails-agent-skills" <<<"${elixir_out}"

    echo "${ruby_out}" | grep -q -- "--skill ${tmp}/rails-agent-skills"
    echo "${ruby_out}" | grep -q -- "--skill ${tmp}/ruby-core-skills"
    echo "${ruby_out}" | grep -q -- "--skill ${tmp}/github-issue"
    ! grep -q -- "elixir-phoenix-skills" <<<"${ruby_out}"
    [[ "${rails_out}" == "${ruby_out}" ]]

    # Issue #75: pi-life shim warns once on stderr and execs the same argv.
    shim_out="$("${root}/bin/pi-life" --dry-run ruby 2>"${tmp}/shim.err")"
    [[ "$(head -n1 "${tmp}/shim.err")" == "pi-life is now pi-vida" ]]
    [[ "${shim_out}" == "${ruby_out}" ]]

    echo "${python_out}" | grep -q -- "--no-skills"
    echo "${python_out}" | grep -q -- "--skill ${tmp}/ponytail"
    echo "${python_out}" | grep -q -- "--skill ${tmp}/herdr"
    ! grep -q -- "rails-agent-skills" <<<"${python_out}"
    echo "${python_out}" | grep -q -- "--skill ${tmp}/github-issue"
    # Issue #76: memory extension is gone; no vida/mode may load it.
    for out in "${rust_out}" "${elixir_out}" "${ruby_out}" "${python_out}" \
               "${rust_solo_out}" "${rust_chain_out}" "${rust_team_out}"; do
      ! grep -q -- "memory.ts" <<<"${out}"
    done

    status=0
    out="$("${bin}" rails-python 2>&1)" || status=$?
    test "${status}" -eq 2
    [[ "${out}" == *"use ruby or python"* ]]
    [[ "${out}" == *"not a vida"* ]]

    status=0
    out="$("${bin}" nosuch 2>&1)" || status=$?
    test "${status}" -eq 2
    [[ "${out}" == *"unknown vida"* ]]

    # Issue #75: life: still parses; vida and life set to different values exit 2.
    legacy="$(mktemp -d)"
    mkdir -p "${legacy}/profiles" "${legacy}/i-have-adhd"
    printf '%s\n' '# i-have-adhd' >"${legacy}/i-have-adhd/SKILL.md"
    printf '%s\n' 'life: python' 'tracker: none' 'packs: []' 'mantra: [i-have-adhd]' >"${legacy}/profiles/python.yaml"
    legacy_out="$(MY_PI_AGENT_HOME="${legacy}" PI_SKILLS_HOME="${legacy}" "${bin}" --dry-run python 2>/dev/null)"
    echo "${legacy_out}" | grep -q -- "--skill ${legacy}/i-have-adhd"
    rm -rf "${legacy}"
    conflict="$(mktemp -d)"
    mkdir -p "${conflict}/profiles"
    printf '%s\n' 'vida: python' 'life: ruby' 'tracker: none' 'packs: []' 'mantra: []' >"${conflict}/profiles/python.yaml"
    status=0
    PI_VIDA_HOME="${conflict}" PI_SKILLS_HOME="${tmp}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/conflict.err" || status=$?
    test "${status}" -eq 2
    grep -q 'vida and life both set and differ' "${tmp}/conflict.err"
    rm -rf "${conflict}"

    # Issue #84 review: PI_VIDA_HOME wins over MY_PI_AGENT_HOME (legacy fallback).
    vidahome="$(mktemp -d)"
    mkdir -p "${vidahome}/profiles" "${vidahome}/i-have-adhd"
    printf '%s\n' '# i-have-adhd' >"${vidahome}/i-have-adhd/SKILL.md"
    printf '%s\n' 'tracker: none' 'packs: []' 'mantra: [i-have-adhd]' >"${vidahome}/profiles/python.yaml"
    legacyhome="$(mktemp -d)"
    mkdir -p "${legacyhome}/profiles"
    printf '%s\n' 'models: solo' >"${legacyhome}/profiles/python.yaml"
    vidahome_out="$(PI_VIDA_HOME="${vidahome}" MY_PI_AGENT_HOME="${legacyhome}" PI_SKILLS_HOME="${vidahome}" "${bin}" --dry-run python 2>"${tmp}/vidahome.err")"
    echo "${vidahome_out}" | grep -q -- "--skill ${vidahome}/i-have-adhd"
    rm -rf "${vidahome}" "${legacyhome}"

    bad="$(mktemp -d)"
    mkdir -p "${bad}/profiles"
    printf ':\n  [\n' >"${bad}/profiles/python.yaml"
    status=0
    MY_PI_AGENT_HOME="${bad}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/bad.err" || status=$?
    test "${status}" -eq 2
    grep -q 'invalid profile YAML' "${tmp}/bad.err"
    rm -rf "${bad}"

    empty="$(mktemp -d)"
    status=0
    PI_SKILLS_HOME="${empty}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/empty.err" || status=$?
    test "${status}" -eq 2
    grep -q 'missing required mantra' "${tmp}/empty.err"
    rm -rf "${empty}"

    notrack="$(mktemp -d)"
    for name in i-have-adhd ponytail ponytail-review deslop clarify requirements-clarifier tdd herdr; do
      mkdir -p "${notrack}/${name}"
      printf '%s\n' "# ${name}" >"${notrack}/${name}/SKILL.md"
    done
    status=0
    PI_SKILLS_HOME="${notrack}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/notrack.err" || status=$?
    test "${status}" -eq 2
    grep -q 'missing required tracker' "${tmp}/notrack.err"
    rm -rf "${notrack}"

    none="$(mktemp -d)"
    mkdir -p "${none}/profiles"
    printf '%s\n' 'vida: python' 'tracker: none' 'packs: []' 'mantra: [i-have-adhd]' >"${none}/profiles/python.yaml"
    mkdir -p "${tmp}/omit-tracker/i-have-adhd"
    printf '%s\n' '# i-have-adhd' >"${tmp}/omit-tracker/i-have-adhd/SKILL.md"
    none_out="$(MY_PI_AGENT_HOME="${none}" PI_SKILLS_HOME="${tmp}/omit-tracker" "${bin}" --dry-run python 2>"${tmp}/none.err")"
    echo "${none_out}" | grep -q -- "--skill ${tmp}/omit-tracker/i-have-adhd"
    ! grep -E -- '--skill [^[:space:]]+/none([[:space:]]|$)' <<<"${none_out}"
    rm -rf "${none}"

    badmap="$(mktemp -d)"
    mkdir -p "${badmap}/profiles"
    printf '%s\n' 'vida: python' 'tracker: github-issue' 'packs: {bad: true}' 'mantra: [i-have-adhd]' >"${badmap}/profiles/python.yaml"
    status=0
    MY_PI_AGENT_HOME="${badmap}" PI_SKILLS_HOME="${tmp}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/badmap.err" || status=$?
    test "${status}" -eq 2
    grep -q 'must be a string or list of strings' "${tmp}/badmap.err"
    rm -rf "${badmap}"
    status=0
    "${bin}" ecto >/dev/null 2>&1 || status=$?
    test "${status}" -eq 2
    # Issue #18: doctor-probe exercises check_excludesfile in isolation.
    # Read-only: writes to a temp HOME/cwd, never touches the real ~/.gitignore_global.
    probe_home="$(mktemp -d)"
    probe_cwd="$(mktemp -d)"
    git -C "${probe_cwd}" init -q
    probe_ignore="${probe_home}/fake-gitignore-global"
    printf 'node_modules\n.pi/agent-sessions/\n.env\ngraphify-out/\n.codegraph/\n' >"${probe_ignore}"
    git -C "${probe_cwd}" config core.excludesfile "${probe_ignore}"
    status=0
    out="$(cd "${probe_cwd}" && HOME="${probe_home}" XDG_CONFIG_HOME="${probe_home}" GIT_CONFIG_NOSYSTEM=1 \
        "${bin}" doctor-probe 2>&1)" || status=$?
    test "${status}" -eq 0
    [[ "${out}" == *"excludesfile: ${probe_ignore} ok"* ]]
    printf 'node_modules\n.pi/agent-sessions/\ngraphify-out/\n.codegraph/\n' >"${probe_ignore}"
    status=0
    out="$(cd "${probe_cwd}" && HOME="${probe_home}" XDG_CONFIG_HOME="${probe_home}" GIT_CONFIG_NOSYSTEM=1 \
        "${bin}" doctor-probe 2>&1)" || status=$?
    test "${status}" -eq 1
    [[ "${out}" == *"missing patterns: .env"* ]]
    # Unsetting the local value falls back to global, which is empty under the temp HOME
    # (XDG_CONFIG_HOME too — git reads $XDG_CONFIG_HOME/git/ignore).
    git -C "${probe_cwd}" config --unset core.excludesfile
    status=0
    out="$(cd "${probe_cwd}" && HOME="${probe_home}" XDG_CONFIG_HOME="${probe_home}" GIT_CONFIG_NOSYSTEM=1 \
        "${bin}" doctor-probe 2>&1)" || status=$?
    test "${status}" -eq 1
    [[ "${out}" == *"missing patterns:"* ]]
    rm -rf "${probe_home}" "${probe_cwd}"
    # Issue #13: doctor. (i) all required present, exit 0 + structured report.
    # Uses PI_SKILLS_HOME="${tmp}" (the stub-skills dir from the top of smoke:
    # ruby-core-skills etc all exist there, so (i) has zero pack warnings).
    doc_cwd="$(mktemp -d)"
    status=0
    out="$(cd "${doc_cwd}" && PI_SKILLS_HOME="${tmp}" "${bin}" doctor 2>&1)" || status=$?
    test "${status}" -eq 0
    grep -q "harness: ${root}" <<<"${out}"
    grep -q "cwd: ${doc_cwd}" <<<"${out}"
    grep -q 'overlay:' <<<"${out}"
    grep -q 'required: ok' <<<"${out}"
    grep -q 'optional:' <<<"${out}"
    # (i2) bare doctor sweeps every profile: missing required skills warn
    # (deduped, exit 0) instead of silently passing — the sweep is advisory,
    # `doctor <life>` stays fail-closed.
    doc_empty_home="$(mktemp -d)"
    status=0
    out="$(cd "${doc_cwd}" && PI_SKILLS_HOME="${doc_empty_home}" "${bin}" doctor 2>&1)" || status=$?
    test "${status}" -eq 0
    grep -q 'warning: missing mantra requirements-clarifier' <<<"${out}"
    grep -q 'warning: missing tracker github-issue' <<<"${out}"
    grep -q 'warning: missing pack ruby-core-skills' <<<"${out}"
    rm -rf "${doc_empty_home}"
    # (n) just skills bootstrap -> manifest -> resolver round-trip: a fixture
    # pack installed by skills-bootstrap.ts must resolve through
    # resolve_pack_paths (the manifest schema the launcher consumes).
    boot_src="$(mktemp -d)"
    mkdir -p "${boot_src}/skills/fixture-skill"
    printf '%s\n' '# fixture-skill' >"${boot_src}/skills/fixture-skill/SKILL.md"
    boot_packs="$(mktemp)"
    printf 'packs:\n  fixture-pack: %s\n' "${boot_src}" >"${boot_packs}"
    boot_home="$(mktemp -d)"
    boot_repos="$(mktemp -d)"
    PACKS_YAML="${boot_packs}" PI_SKILLS_HOME="${boot_home}" PI_VIDA_REPOS="${boot_repos}" \
      bun "${root}/scripts/skills-bootstrap.ts" >/dev/null
    test -f "${boot_home}/.dotskills-manifest.json"
    test -e "${boot_home}/fixture-skill/SKILL.md"
    boot_prof="$(mktemp -d)"
    mkdir -p "${boot_prof}/profiles"
    printf '%s\n' 'vida: ruby' 'tracker: none' 'packs: [fixture-pack]' 'mantra: []' >"${boot_prof}/profiles/ruby.yaml"
    boot_cwd="$(mktemp -d)"
    boot_out="$(cd "${boot_cwd}" && MY_PI_AGENT_HOME="${boot_prof}" PI_SKILLS_HOME="${boot_home}" "${bin}" --dry-run ruby)"
    grep -q -- "--skill ${boot_home}/fixture-skill" <<<"${boot_out}"
    rm -rf "${boot_src}" "${boot_home}" "${boot_repos}" "${boot_prof}" "${boot_packs}" "${boot_cwd}"
    # (j) doctor <life> with packs missing -> exit 0, warnings named. Uses a
    # DEDICATED skills home that has every required mantra/tracker stubbed
    # (copied from ${tmp}) but no ruby packs, so the missing-pack warning
    # genuinely fires and nothing else fails.
    doc_life_cwd="$(mktemp -d)"
    doc_packs_home="$(mktemp -d)"
    for name in i-have-adhd ponytail ponytail-review deslop clarify requirements-clarifier tdd herdr github-issue; do
      cp -r "${tmp}/${name}" "${doc_packs_home}/${name}"
    done
    status=0
    out="$(cd "${doc_life_cwd}" && PI_SKILLS_HOME="${doc_packs_home}" "${bin}" doctor ruby 2>&1)" || status=$?
    test "${status}" -eq 0
    grep -q 'vida: ruby' <<<"${out}"
    grep -q 'warning: missing pack ruby-core-skills' <<<"${out}"
    # (j2) doctor <life> with a missing required mantra path -> exit 2, same
    # message the launcher prints (doctor is a launch preflight).
    doc_nomantra_home="$(mktemp -d)"
    mkdir -p "${doc_nomantra_home}/github-issue"
    printf '%s\n' '# github-issue' >"${doc_nomantra_home}/github-issue/SKILL.md"
    status=0
    out="$(cd "${doc_life_cwd}" && PI_SKILLS_HOME="${doc_nomantra_home}" "${bin}" doctor ruby 2>&1)" || status=$?
    test "${status}" -eq 2
    grep -q 'missing required mantra' <<<"${out}"
    # (k) doctor with overlay parse failure -> exit 2.
    doc_bad="$(mktemp -d)"
    mkdir -p "${doc_bad}/.pi"
    printf ':\n  [\n' >"${doc_bad}/.pi/capabilities.yaml"
    status=0
    out="$(cd "${doc_bad}" && PI_SKILLS_HOME="${tmp}" "${bin}" doctor 2>&1)" || status=$?
    test "${status}" -eq 2
    grep -q 'invalid overlay YAML' <<<"${out}"
    # (j3) doctor <life> with a missing required tracker path -> exit 2.
    doc_notrk_home="$(mktemp -d)"
    for name in i-have-adhd ponytail ponytail-review deslop clarify requirements-clarifier tdd herdr; do
      cp -r "${tmp}/${name}" "${doc_notrk_home}/${name}"
    done
    status=0
    out="$(cd "${doc_life_cwd}" && PI_SKILLS_HOME="${doc_notrk_home}" "${bin}" doctor ruby 2>&1)" || status=$?
    test "${status}" -eq 2
    grep -q 'missing required tracker' <<<"${out}"
    # (j4) tracker: none and omitted tracker never preflight-fail: read_profile
    # emits no tracker row for either, so doctor stays exit 0. Pins the
    # sentinel contract against regressions in the doctor loop.
    doc_none_home="$(mktemp -d)"
    mkdir -p "${doc_none_home}/profiles" "${doc_none_home}/i-have-adhd"
    printf '%s\n' '# i-have-adhd' >"${doc_none_home}/i-have-adhd/SKILL.md"
    printf '%s\n' 'vida: ruby' 'tracker: none' 'packs: []' 'mantra: [i-have-adhd]' >"${doc_none_home}/profiles/ruby.yaml"
    status=0
    out="$(cd "${doc_life_cwd}" && MY_PI_AGENT_HOME="${doc_none_home}" PI_SKILLS_HOME="${doc_none_home}" "${bin}" doctor ruby 2>&1)" || status=$?
    test "${status}" -eq 0
    grep -q 'required: ok' <<<"${out}"
    doc_omit_home="$(mktemp -d)"
    mkdir -p "${doc_omit_home}/profiles" "${doc_omit_home}/i-have-adhd"
    printf '%s\n' '# i-have-adhd' >"${doc_omit_home}/i-have-adhd/SKILL.md"
    printf '%s\n' 'vida: ruby' 'packs: []' 'mantra: [i-have-adhd]' >"${doc_omit_home}/profiles/ruby.yaml"
    status=0
    out="$(cd "${doc_life_cwd}" && MY_PI_AGENT_HOME="${doc_omit_home}" PI_SKILLS_HOME="${doc_omit_home}" "${bin}" doctor ruby 2>&1)" || status=$?
    test "${status}" -eq 0
    grep -q 'required: ok' <<<"${out}"
    # (l) doctor <life> with a malformed profile -> exit 2 (not swallowed).
    doc_badprof_home="$(mktemp -d)"
    mkdir -p "${doc_badprof_home}/profiles"
    printf '%s\n' 'vida: ruby' 'packs: {bad: true}' >"${doc_badprof_home}/profiles/ruby.yaml"
    doc_badprof_cwd="$(mktemp -d)"
    status=0
    out="$(cd "${doc_badprof_cwd}" && MY_PI_AGENT_HOME="${doc_badprof_home}" PI_SKILLS_HOME="${tmp}" "${bin}" doctor ruby 2>&1)" || status=$?
    test "${status}" -eq 2
    grep -q 'must be a string or list of strings' <<<"${out}"
    # (m) doctor with an existing overlay but bun absent from PATH -> clean
    # "required: FAIL missing: bun" (checked before read_overlay spawns bun).
    doc_nobun_home="$(mktemp -d)"
    mkdir -p "${doc_nobun_home}/bin"
    printf '%s\n' '#!/bin/bash' 'exit 0' >"${doc_nobun_home}/bin/pi"
    chmod +x "${doc_nobun_home}/bin/pi"
    doc_nobun_cwd="$(mktemp -d)"
    mkdir -p "${doc_nobun_cwd}/.pi"
    printf '%s\n' 'graphify: true' >"${doc_nobun_cwd}/.pi/capabilities.yaml"
    status=0
    out="$(cd "${doc_nobun_cwd}" && PATH="${doc_nobun_home}/bin:/bin:/usr/bin" MY_PI_AGENT_HOME="${doc_badprof_home}" PI_SKILLS_HOME="${tmp}" "${bin}" doctor 2>&1)" || status=$?
    test "${status}" -eq 2
    grep -q 'required: FAIL missing: bun' <<<"${out}"
    # (m2) Issue #19: with required pieces satisfied but herdr off PATH,
    # doctor still exits 0 and warns (optional gap, never a failure).
    # Sandbox PATH so ONLY the stub bin is visible: pi+bun stubs plus symlinks
    # for the coreutils doctor/pi-vida need. No system dirs on PATH, so the
    # real /bin/herdr and /usr/bin/just on this machine cannot leak into
    # `command -v` probing — just/rs-guard/herdr are simply absent.
    doc_nohome="$(mktemp -d)"
    mkdir -p "${doc_nohome}/bin"
    printf '%s\n' '#!/bin/bash' 'exit 0' >"${doc_nohome}/bin/pi"
    printf '%s\n' '#!/bin/bash' 'exit 0' >"${doc_nohome}/bin/bun"
    chmod +x "${doc_nohome}/bin/pi" "${doc_nohome}/bin/bun"
    for tool in env bash sh git sed grep mktemp rm mkdir head cat chmod dirname readlink pwd; do
      for dir in /bin /usr/bin; do
        if [[ -x "${dir}/${tool}" ]]; then
          ln -sf "${dir}/${tool}" "${doc_nohome}/bin/${tool}"
          break
        fi
      done
    done
    doc_noh_cwd="$(mktemp -d)"
    status=0
    out="$(cd "${doc_noh_cwd}" && PATH="${doc_nohome}/bin" PI_SKILLS_HOME="${tmp}" "${bin}" doctor 2>&1)" || status=$?
    test "${status}" -eq 0
    grep -q 'warning: herdr not on PATH' <<<"${out}"
    grep -q 'optional:' <<<"${out}"
    rm -rf "${doc_cwd}" "${doc_life_cwd}" "${doc_packs_home}" "${doc_nomantra_home}" "${doc_notrk_home}" "${doc_none_home}" "${doc_omit_home}" "${doc_bad}" "${doc_badprof_home}" "${doc_badprof_cwd}" "${doc_nobun_home}" "${doc_nobun_cwd}" "${doc_nohome}" "${doc_noh_cwd}"
    status=0
    "${bin}" ruby team typo >/dev/null 2>&1 || status=$?
    test "${status}" -eq 2
    # Issue #11: capabilities overlay. Smoke calls `bin/pi-vida --dump-overlay`
    # to exercise the real read_overlay function, not a copy of it.
    # (a) Missing overlay -> all-off payload.
    nooverlay="$(mktemp -d)"
    nooverlay_payload="$("${bin}" --dump-overlay "${nooverlay}")"
    case "${nooverlay_payload}" in
      *'"graphify":false'*'"codegraph":false'*'"serena":false'*'"rs-guard":false'*'"obscura":false'*'"playwright":false'*) ;;
      *) echo "expected all-off overlay, got: ${nooverlay_payload}" >&2; exit 1 ;;
    esac
    # (b) Overlay on -> reflects the on capabilities.
    mkdir -p "${nooverlay}/.pi"
    printf '%s\n' 'graphify: true' 'codegraph: true' >"${nooverlay}/.pi/capabilities.yaml"
    on_payload="$("${bin}" --dump-overlay "${nooverlay}")"
    case "${on_payload}" in
      *'"graphify":true'*'"codegraph":true'*) ;;
      *) echo "expected graphify+codegraph on, got: ${on_payload}" >&2; exit 1 ;;
    esac
    # (c) Malformed overlay YAML -> exit 2 (fail closed).
    printf ':\n  [\n' >"${nooverlay}/.pi/capabilities.yaml"
    status=0
    "${bin}" --dump-overlay "${nooverlay}" >/dev/null 2>"${tmp}/badoverlay.err" || status=$?
    test "${status}" -eq 2
    grep -q 'invalid overlay YAML' "${tmp}/badoverlay.err"
    # (d) Schema error (unknown top-level key) -> exit 2.
    printf '%s\n' 'graphify: true' 'kittens: true' >"${nooverlay}/.pi/capabilities.yaml"
    status=0
    "${bin}" --dump-overlay "${nooverlay}" >/dev/null 2>"${tmp}/badkey.err" || status=$?
    test "${status}" -eq 2
    grep -q 'unknown key.*kittens' "${tmp}/badkey.err"
    # (e) Schema error (unknown tracker key) -> exit 2.
    printf '%s\n' 'tracker:' '  skill: local/x' '  retries: 3' >"${nooverlay}/.pi/capabilities.yaml"
    status=0
    "${bin}" --dump-overlay "${nooverlay}" >/dev/null 2>"${tmp}/badtracker.err" || status=$?
    test "${status}" -eq 2
    grep -q 'tracker has unknown key.*retries' "${tmp}/badtracker.err"
    # (f) Overlay extra_skills and tracker.skill become --skill args.
    # We need a valid profile + valid skills home for launch_life to run,
    # so this is a separate test scaffold.
    overlay_life="$(mktemp -d)"
    overlay_profile="$(mktemp -d)"
    overlay_skill1="${overlay_life}/.pi/local-skills/team-rule"
    overlay_skill2="${overlay_life}/.pi/local-tracker/work"
    mkdir -p "${overlay_skill1}" "${overlay_skill2}"
    mkdir -p "${overlay_profile}/profiles"
    printf '%s\n' 'vida: python' 'tracker: github-issue' 'packs: []' 'mantra: [i-have-adhd]' >"${overlay_profile}/profiles/python.yaml"
    mkdir -p "${tmp}/overlay-skills-home/i-have-adhd" "${tmp}/overlay-skills-home/github-issue"
    printf '%s\n' '# i-have-adhd' '# github-issue' >"${tmp}/overlay-skills-home/i-have-adhd/SKILL.md" "${tmp}/overlay-skills-home/github-issue/SKILL.md"
    printf '%s\n' >"${overlay_skill1}/SKILL.md"
    printf '%s\n' >"${overlay_skill2}/SKILL.md"
    printf '%s\n' 'graphify: true' 'extra_skills:' "  - ${overlay_skill1}" 'tracker:' "  skill: ${overlay_skill2}" >"${overlay_life}/.pi/capabilities.yaml"
    overlay_out="$(cd "${overlay_life}" && MY_PI_AGENT_HOME="${overlay_profile}" PI_SKILLS_HOME="${tmp}/overlay-skills-home" "${bin}" --dry-run python 2>"${tmp}/overlay.err")"
    case "${overlay_out}" in
      *"--skill ${overlay_skill1}"*) ;;
      *) echo "expected --skill ${overlay_skill1} in argv, got: ${overlay_out}" >&2; exit 1 ;;
    esac
    case "${overlay_out}" in
      *"--skill ${overlay_skill2}"*) ;;
      *) echo "expected --skill ${overlay_skill2} in argv, got: ${overlay_out}" >&2; exit 1 ;;
    esac
    # (g) --dump-overlay . from a relative path works (cwd is normalized).
    dumprel="$(mktemp -d)"
    mkdir -p "${dumprel}/.pi"
    printf 'graphify: true\n' >"${dumprel}/.pi/capabilities.yaml"
    dumprel_payload="$(cd "${dumprel}" && "${bin}" --dump-overlay .)"
    case "${dumprel_payload}" in
      *'"graphify":true'*) ;;
      *) echo "expected graphify on for --dump-overlay ., got: ${dumprel_payload}" >&2; exit 1 ;;
    esac
    # (h) Missing overlay skill path produces a warning, not a fail.
    printf '%s\n' 'graphify: true' 'extra_skills:' '  - /no/such/skill' >"${dumprel}/.pi/capabilities.yaml"
    warn_out="$(cd "${dumprel}" && MY_PI_AGENT_HOME="${overlay_profile}" PI_SKILLS_HOME="${tmp}/overlay-skills-home" "${bin}" --dry-run python 2>&1)"
    case "${warn_out}" in
      *"missing overlay overlay (/no/such/skill)"*) ;;
      *) echo "expected missing-overlay warning, got: ${warn_out}" >&2; exit 1 ;;
    esac
    # (i) Issue #17: overlay tracker.skill works for a profile that omits
    # tracker. The only way the tracker path appears in argv is from the
    # overlay, proving the path is data-driven and local — never committed.
    notrack_overlay_life="$(mktemp -d)"
    notrack_overlay_profile="$(mktemp -d)"
    notrack_tracker="${notrack_overlay_life}/.pi/local-tracker/work"
    mkdir -p "${notrack_tracker}" "${notrack_overlay_profile}/profiles"
    # Profile omits `tracker:` like profiles/elixir.yaml.
    printf '%s\n' 'vida: elixir' 'packs: []' 'mantra: [i-have-adhd]' >"${notrack_overlay_profile}/profiles/elixir.yaml"
    mkdir -p "${tmp}/notrack-overlay-skills-home/i-have-adhd"
    printf '%s\n' '# i-have-adhd' >"${tmp}/notrack-overlay-skills-home/i-have-adhd/SKILL.md"
    printf '%s\n' >"${notrack_tracker}/SKILL.md"
    printf '%s\n' 'tracker:' "  skill: ${notrack_tracker}" >"${notrack_overlay_life}/.pi/capabilities.yaml"
    notrack_out="$(cd "${notrack_overlay_life}" && MY_PI_AGENT_HOME="${notrack_overlay_profile}" PI_SKILLS_HOME="${tmp}/notrack-overlay-skills-home" "${bin}" --dry-run elixir 2>"${tmp}/notrack.err")"
    case "${notrack_out}" in
      *"--skill ${notrack_tracker}"*) ;;
      *) echo "expected overlay tracker.skill in argv, got: ${notrack_out}" >&2; exit 1 ;;
    esac
    # Profile did not require a tracker, so no "missing required tracker" error.
    ! grep -q 'missing required tracker' "${tmp}/notrack.err"
    # (k) Issue #15: overlay models/thinking round-trip through --dump-overlay.
    printf '%s\n' 'models:' '  solo: openrouter/z-ai/glm-5.3-flash' 'thinking:' '  solo: medium' >"${dumprel}/.pi/capabilities.yaml"
    models_payload="$("${bin}" --dump-overlay "${dumprel}")"
    case "${models_payload}" in
      *'"models":{"solo":"openrouter/z-ai/glm-5.3-flash"}'*'"thinking":{"solo":"medium"}'*) ;;
      *) echo "expected models/thinking in overlay payload, got: ${models_payload}" >&2; exit 1 ;;
    esac
    # (l) Issue #15: profile models/thinking defaults become --model/--thinking
    # for the primary session (solo role); an existing overlay's solo model
    # overrides the profile default.
    solo_life="$(mktemp -d)"
    mkdir -p "${solo_life}/profiles" "${solo_life}/i-have-adhd"
    printf '%s\n' '# i-have-adhd' >"${solo_life}/i-have-adhd/SKILL.md"
    printf '%s\n' 'vida: python' 'tracker: none' 'packs: []' 'mantra: [i-have-adhd]' \
      'models:' '  solo: openrouter/profile-default' 'thinking:' '  solo: medium' \
      >"${solo_life}/profiles/python.yaml"
    solo_out="$(cd "${solo_life}" && MY_PI_AGENT_HOME="${solo_life}" PI_SKILLS_HOME="${tmp}" "${bin}" --dry-run python 2>"${tmp}/solo.err")"
    case "${solo_out}" in
      *"--model openrouter/profile-default"*) ;;
      *) echo "expected --model openrouter/profile-default from profile, got: ${solo_out}" >&2; exit 1 ;;
    esac
    case "${solo_out}" in
      *"--thinking medium"*) ;;
      *) echo "expected --thinking medium from profile, got: ${solo_out}" >&2; exit 1 ;;
    esac
    mkdir -p "${solo_life}/.pi"
    printf '%s\n' 'models:' '  solo: openrouter/override' >"${solo_life}/.pi/capabilities.yaml"
    solo_override_out="$(cd "${solo_life}" && MY_PI_AGENT_HOME="${solo_life}" PI_SKILLS_HOME="${tmp}" "${bin}" --dry-run python 2>"${tmp}/solo2.err")"
    case "${solo_override_out}" in
      *"--model openrouter/override"*) ;;
      *) echo "expected overlay solo model override, got: ${solo_override_out}" >&2; exit 1 ;;
    esac
    case "${solo_override_out}" in
      *"--model openrouter/profile-default"*)
        echo "overlay must override the profile solo model, got: ${solo_override_out}" >&2; exit 1 ;;
    esac
    # (q) fusion mode: the stack's primary slot becomes the host model, so
    # solo --model/--thinking are dropped; a configured solo override warns.
    fusion_solo_out="$(cd "${solo_life}" && MY_PI_AGENT_HOME="${solo_life}" PI_SKILLS_HOME="${tmp}" "${bin}" --dry-run python fusion "${fusion_stack}" 2>"${tmp}/fusion-solo.err")"
    ! grep -q -- "--model" <<<"${fusion_solo_out}"
    ! grep -q -- "--thinking" <<<"${fusion_solo_out}"
    grep -q 'solo model/thinking dropped' "${tmp}/fusion-solo.err"
    # (m) Issue #15: malformed profile models -> exit 2 (fail closed).
    badmodels="$(mktemp -d)"
    mkdir -p "${badmodels}/profiles"
    printf '%s\n' 'vida: python' 'tracker: none' 'packs: []' 'mantra: [i-have-adhd]' 'models: solo' >"${badmodels}/profiles/python.yaml"
    status=0
    MY_PI_AGENT_HOME="${badmodels}" PI_SKILLS_HOME="${tmp}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/badmodels.err" || status=$?
    test "${status}" -eq 2
    grep -q 'models must be a mapping' "${tmp}/badmodels.err"
    # (m2) Issue #15: invalid thinking level and unknown role -> exit 2
    # (shared contract with the overlay parser; no quiet typo failures).
    badlevel="$(mktemp -d)"
    mkdir -p "${badlevel}/profiles"
    printf '%s\n' 'vida: python' 'tracker: none' 'packs: []' 'mantra: [i-have-adhd]' 'thinking:' '  solo: highh' >"${badlevel}/profiles/python.yaml"
    status=0
    MY_PI_AGENT_HOME="${badlevel}" PI_SKILLS_HOME="${tmp}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/badlevel.err" || status=$?
    test "${status}" -eq 2
    grep -q 'thinking.solo must be a thinking level' "${tmp}/badlevel.err"
    badrole="$(mktemp -d)"
    mkdir -p "${badrole}/profiles"
    printf '%s\n' 'vida: python' 'tracker: none' 'packs: []' 'mantra: [i-have-adhd]' 'models:' '  sol: openrouter/x' >"${badrole}/profiles/python.yaml"
    status=0
    MY_PI_AGENT_HOME="${badrole}" PI_SKILLS_HOME="${tmp}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/badrole.err" || status=$?
    test "${status}" -eq 2
    grep -q 'models.sol is not a known role' "${tmp}/badrole.err"
    # (m3) overlay thinking level and role are validated the same way.
    printf '%s\n' 'thinking:' '  solo: highh' >"${dumprel}/.pi/capabilities.yaml"
    status=0
    "${bin}" --dump-overlay "${dumprel}" >/dev/null 2>"${tmp}/badovl.err" || status=$?
    test "${status}" -eq 2
    grep -q 'thinking.solo must be a thinking level' "${tmp}/badovl.err"
    printf '%s\n' 'models:' '  sol: openrouter/x' >"${dumprel}/.pi/capabilities.yaml"
    status=0
    "${bin}" --dump-overlay "${dumprel}" >/dev/null 2>"${tmp}/badovl2.err" || status=$?
    test "${status}" -eq 2
    grep -q 'models.sol is not a known role' "${tmp}/badovl2.err"
    # (n) Live merge: profile role maps reach PI_OVERLAY (the payload children
    # dispatch from) even with no project overlay; an overlay entry wins.
    merge_life="$(mktemp -d)"
    mkdir -p "${merge_life}/profiles" "${merge_life}/i-have-adhd"
    printf '%s\n' '# i-have-adhd' >"${merge_life}/i-have-adhd/SKILL.md"
    printf '%s\n' 'vida: python' 'tracker: none' 'packs: []' 'mantra: [i-have-adhd]' \
      'models:' '  planner: openrouter/profile-planner' '  builder: openrouter/profile-builder' \
      'thinking:' '  planner: high' \
      >"${merge_life}/profiles/python.yaml"
    (cd "${merge_life}" && MY_PI_AGENT_HOME="${merge_life}" PI_SKILLS_HOME="${merge_life}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/merge.err")
    merge_payload="$(grep '^PI_OVERLAY=' "${tmp}/merge.err")" || { echo "no PI_OVERLAY line: $(cat "${tmp}/merge.err")" >&2; exit 1; }
    for needle in '"planner":"openrouter/profile-planner"' '"builder":"openrouter/profile-builder"' '"thinking":{"planner":"high"}'; do
      case "${merge_payload}" in
        *"${needle}"*) ;;
        *) echo "expected ${needle} merged into PI_OVERLAY, got: $(cat "${tmp}/merge.err")" >&2; exit 1 ;;
      esac
    done
    mkdir -p "${merge_life}/.pi"
    printf '%s\n' 'models:' '  planner: openrouter/overlay-planner' >"${merge_life}/.pi/capabilities.yaml"
    (cd "${merge_life}" && MY_PI_AGENT_HOME="${merge_life}" PI_SKILLS_HOME="${merge_life}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/merge2.err")
    merge2_payload="$(grep '^PI_OVERLAY=' "${tmp}/merge2.err")" || { echo "no PI_OVERLAY line: $(cat "${tmp}/merge2.err")" >&2; exit 1; }
    for needle in '"planner":"openrouter/overlay-planner"' '"builder":"openrouter/profile-builder"'; do
      case "${merge2_payload}" in
        *"${needle}"*) ;;
        *) echo "expected ${needle} (overlay win + profile gap-fill), got: $(cat "${tmp}/merge2.err")" >&2; exit 1 ;;
      esac
    done
    rm -rf "${merge_life}" "${solo_life}" "${badmodels}" "${badlevel}" "${badrole}"
    # (o) Pack manifest resolution: a hand-authored .dotskills-manifest.json in
    # PI_SKILLS_HOME expands a pack into its installed skills, and a broken
    # install (missing SKILL.md) fails closed — no dotskills checkout needed.
    pack_life="$(mktemp -d)"
    pack_home="${tmp}/pack-skills-home"
    mkdir -p "${pack_life}/profiles" "${pack_home}/i-have-adhd" "${pack_home}/build"
    printf '%s\n' '# i-have-adhd' >"${pack_home}/i-have-adhd/SKILL.md"
    printf '%s\n' '# build' >"${pack_home}/build/SKILL.md"
    printf '%s\n' 'vida: python' 'tracker: none' 'mantra: [i-have-adhd]' 'packs: [my-pack]' >"${pack_life}/profiles/python.yaml"
    printf '%s\n' '{"schema_version":1,"skills":{"my-pack:build":{"path":"build","source":"o/my-pack"}}}' >"${pack_home}/.dotskills-manifest.json"
    pack_out="$(cd "${pack_life}" && MY_PI_AGENT_HOME="${pack_life}" PI_SKILLS_HOME="${pack_home}" "${bin}" --dry-run python 2>"${tmp}/pack.err")"
    case "${pack_out}" in
      *"--skill ${pack_home}/build "*|*"--skill ${pack_home}/build") ;;
      *) echo "expected manifest-resolved --skill ${pack_home}/build, got: ${pack_out}" >&2; exit 1 ;;
    esac
    # Manifest present but the pack has no entries -> legacy <home>/<name> dir.
    printf '%s\n' '{"schema_version":1,"skills":{"other-pack:x":{"path":"build","source":"o/other"}}}' >"${pack_home}/.dotskills-manifest.json"
    mkdir -p "${pack_home}/my-pack"
    printf '%s\n' '# my-pack' >"${pack_home}/my-pack/SKILL.md"
    pack_legacy_out="$(cd "${pack_life}" && MY_PI_AGENT_HOME="${pack_life}" PI_SKILLS_HOME="${pack_home}" "${bin}" --dry-run python 2>"${tmp}/pack-legacy.err")"
    case "${pack_legacy_out}" in
      *"--skill ${pack_home}/my-pack "*|*"--skill ${pack_home}/my-pack") ;;
      *) echo "expected legacy dir fallback --skill ${pack_home}/my-pack, got: ${pack_legacy_out}" >&2; exit 1 ;;
    esac
    rm -rf "${pack_home}/my-pack"
    # A malformed manifest is a resolver failure: fail closed (exit 2).
    printf '%s\n' 'not json{' >"${pack_home}/.dotskills-manifest.json"
    status=0
    (cd "${pack_life}" && MY_PI_AGENT_HOME="${pack_life}" PI_SKILLS_HOME="${pack_home}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/pack-badjson.err") || status=$?
    test "${status}" -eq 2
    # Restore a valid manifest, then removing the installed skill fails closed.
    printf '%s\n' '{"schema_version":1,"skills":{"my-pack:build":{"path":"build","source":"o/my-pack"}}}' >"${pack_home}/.dotskills-manifest.json"
    # Removing an installed skill fails the launch closed (exit 2).
    rm "${pack_home}/build/SKILL.md"
    status=0
    (cd "${pack_life}" && MY_PI_AGENT_HOME="${pack_life}" PI_SKILLS_HOME="${pack_home}" "${bin}" --dry-run python >/dev/null 2>"${tmp}/pack-broken.err") || status=$?
    test "${status}" -eq 2
    grep -q 'missing installed skill' "${tmp}/pack-broken.err"
    rm -rf "${pack_life}"
    # (j) Issue #17: no work-internal tracker name/URL/token in the public repo.
    # The sentinel is a placeholder; if it ever matches a real identifier, the
    # harness has leaked a private name. Excludes the justfile itself (which
    # contains the literal pattern) and CONTEXT.md (the doc is allowed to
    # describe the invariant). Includes everything else: code, profiles,
    # scripts, extensions, configs, .github.
    if grep -RIE 'worktracker|work-internal-tracker|http(s)?://[^[:space:]]*work[^[:space:]]*tracker' \
        "${root}" \
        --exclude-dir=.git \
        --exclude-dir=node_modules \
        --exclude=justfile \
        --exclude=CONTEXT.md \
        >"${tmp}/leakcheck.out" 2>/dev/null; then
      echo "public-repo invariant: work-internal tracker identifier leaked:" >&2
      cat "${tmp}/leakcheck.out" >&2
      exit 1
    fi
    rm -rf "${nooverlay}" "${overlay_life}" "${overlay_profile}" "${dumprel}" \
           "${notrack_overlay_life}" "${notrack_overlay_profile}"
    # Issue #6: agent-chain. (a) shared harness default parses and resolves.
    MY_PI_AGENT_HOME="{{root}}" bun -e '
      import { resolveChainFile, parseChainFile, parseAgentTeams, pickTeam, renderStepTask } from "{{root}}/extensions/agent-chain.ts";
      const file = resolveChainFile(process.cwd(), import.meta.url, undefined);
      if (!file) { console.error("agent-chain: no default chain file resolved"); process.exit(1); }
      const chains = parseChainFile(await Bun.file(file.path).text());
      const pbr = chains.get("plan-build-review");
      if (!pbr) { console.error("agent-chain: plan-build-review missing"); process.exit(1); }
      if (pbr.steps.map((s) => s.agent).join(",") !== "planner,builder,reviewer") {
        console.error("agent-chain: wrong default steps", pbr.steps); process.exit(1);
      }
      if (renderStepTask("A {task} {previous}", "T", "") !== "A T ") {
        console.error("agent-chain: renderStepTask"); process.exit(1);
      }
      const teams = parseAgentTeams(await Bun.file(file.path).text());
      const dflt = pickTeam(teams);
      if (dflt.members.join(",") !== "planner,builder,reviewer,researcher") {
        console.error("agent-team: default team members wrong", dflt); process.exit(1);
      }
      const rchain = parseChainFile(await Bun.file(file.path).text()).get("research-plan-build-review");
      if (!rchain || rchain.steps.map((s) => s.agent).join(",") !== "researcher,planner,builder,reviewer") {
        console.error("agent-chain: research-plan-build-review missing or wrong", rchain); process.exit(1);
      }
      console.log("agent-chain default chain ok");
    '
    bun test "{{root}}/extensions/agentScan.test.ts" "{{root}}/extensions/capabilities.test.ts" "{{root}}/extensions/boot-config.test.ts" "{{root}}/extensions/clarify-gate.test.ts" "{{root}}/extensions/agent-chain.test.ts" "{{root}}/extensions/agent-team.test.ts" "{{root}}/extensions/subagent.test.ts" "{{root}}/extensions/installed-skills.test.ts" "{{root}}/extensions/fusion-harness/tests" "{{root}}/scripts/skills-bootstrap.test.ts"
    bun build "{{root}}/extensions/themeMap.ts" "{{root}}/extensions/minimal.ts" "{{root}}/extensions/purpose-gate.ts" \
      "{{root}}/extensions/cross-agent.ts" "{{root}}/extensions/system-select.ts" \
      "{{root}}/extensions/damage-control-continue.ts" \
      "{{root}}/extensions/boot-config.ts" \
      "{{root}}/extensions/capabilities.ts" \
      "{{root}}/extensions/clarify-gate.ts" \
      "{{root}}/extensions/agent-chain.ts" \
      "{{root}}/extensions/agent-team.ts" \
      "{{root}}/extensions/status-line.ts" \
      "{{root}}/extensions/subagent.ts" "{{root}}/extensions/subagentHelpers.ts" \
      "{{root}}/extensions/installed-skills.ts" \
      "{{root}}/extensions/fusion-harness/fusion-harness.ts" \
      --outdir="${TMPDIR:-/tmp}/mpa-ext-smoke" --packages=external
    bun -e '
      import { formatTurnLine } from "./extensions/status-line.ts";
      const noop = (_, s) => s;
      const ready = formatTurnLine("ready", 0, { fg: noop });
      if (ready !== " Ready") { console.error("ready expected \" Ready\", got", JSON.stringify(ready)); process.exit(1); }
      const running = formatTurnLine("running", 3, { fg: noop });
      if (running !== "● Turn 3...") { console.error("running expected \"● Turn 3...\", got", JSON.stringify(running)); process.exit(1); }
      const done = formatTurnLine("done", 3, { fg: noop });
      if (done !== "✓ Turn 3 complete") { console.error("done expected \"✓ Turn 3 complete\", got", JSON.stringify(done)); process.exit(1); }
      console.log("status-line format ok");
    '
    bun -e '
      import { parse } from "yaml";
      import { readFileSync } from "node:fs";
      const r = parse(readFileSync("damage-control-rules.yaml", "utf8"));
      const hit = (cmd) => r.bashToolPatterns.some((p) => new RegExp(p.pattern).test(cmd));
      for (const cmd of ["git push origin main", "git reset --hard", "git clean -fd", "git clean -fdx"]) {
        if (!hit(cmd)) { console.error("expected block:", cmd); process.exit(1); }
      }
      if (hit("git status")) { console.error("false positive: git status"); process.exit(1); }
      if (!r.noDeletePaths?.includes(".git")) { console.error("expected noDeletePaths .git"); process.exit(1); }
    '
    bun -e '
      import { isPathMatch, bashWriteTargets, expansionOperandRisk } from "./extensions/damage-control-continue.ts";
      import { resolve } from "node:path";
      const cwd = process.cwd();
      const m = (p, pat) => isPathMatch(resolve(cwd, p), pat, cwd);
      if (m("/work/docs-archive/file", "docs")) { console.error("docs matched docs-archive"); process.exit(1); }
      if (!m(cwd + "/docs/file", "docs/")) { console.error("dir pattern failed"); process.exit(1); }
      if (!m(cwd + "/.env", ".env")) { console.error(".env not matched"); process.exit(1); }
      if (!bashWriteTargets("echo data > /tmp/damage-control-test").targets.includes("/tmp/damage-control-test")) { console.error("redir target missed"); process.exit(1); }
      if (bashWriteTargets("echo hi > ./ok.txt").targets.length !== 1) { console.error("cwd target missed"); process.exit(1); }
      if (!bashWriteTargets("gzip -c .env | tee /tmp/out").targets.includes("/tmp/out")) { console.error("tee target missed"); process.exit(1); }
      if (!bashWriteTargets("dd if=a of=$UNSET").unresolvable) { console.error("unresolvable not flagged"); process.exit(1); }
      if (!expansionOperandRisk("rm -rf .g[it]")) { console.error("bracket rm not flagged"); process.exit(1); }
      if (!expansionOperandRisk("rm -rf \"$DIR\"")) { console.error("var rm not flagged"); process.exit(1); }
      if (expansionOperandRisk("rm -rf build/cache")) { console.error("plain rm flagged"); process.exit(1); }
      if (expansionOperandRisk("git mv a b")) { console.error("git mv flagged"); process.exit(1); }
      console.log("damage-control unit checks ok");
    '
    # Issue #14: smoke also runs from a Rails repo — the synthetic fixture, so
    # the default run is deterministic (a discovered repo's own overlay could
    # inject argv). `just smoke-rails` manually prefers a real repo.
    just smoke-rails fixture
    echo "smoke ok"

# Issue #14: run pi-vida ruby from a Rails repo. repo is a path (must contain
# a Gemfile), "discover" (auto-detect under ~/Developer, default), or
# "fixture" (temp synthetic Rails repo — what `just smoke` uses).
smoke-rails repo='discover':
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{justfile_directory()}}"
    bin="${root}/bin/pi-vida"
    repo="{{repo}}"
    if [[ "${repo}" == "discover" ]]; then
      repo="$(find "${HOME}/Developer" -maxdepth 4 -name Gemfile -not -path '*/node_modules/*' \
        -exec grep -lE '^gem .rails.' {} + 2>/dev/null | head -1 | xargs -I{} dirname {} 2>/dev/null || true)"
    elif [[ "${repo}" == "fixture" ]]; then
      repo=""
    elif [[ -n "${repo}" && ( ! -d "${repo}" || ! -f "${repo}/Gemfile" ) ]]; then
      echo "smoke-rails: not a Rails repo (no Gemfile): ${repo}" >&2
      exit 1
    fi
    fixture=""
    if [[ -z "${repo}" ]]; then
      fixture="$(mktemp -d)"
      repo="${fixture}"
      printf 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n' >"${repo}/Gemfile"
    fi
    tmp="$(mktemp -d)"
    trap 'rm -rf "${tmp}" ${fixture:+"${fixture}"}' EXIT
    for name in i-have-adhd ponytail ponytail-review deslop clarify requirements-clarifier tdd herdr \
                github-issue ruby-core-skills rails-agent-skills; do
      mkdir -p "${tmp}/${name}"
      printf '%s\n' "# ${name}" >"${tmp}/${name}/SKILL.md"
    done
    out="$(cd "${repo}" && PI_SKILLS_HOME="${tmp}" "${bin}" --dry-run ruby 2>"${tmp}/err")"
    case "${out}" in
      pi\ -e\ *damage-control-continue.ts\ *capabilities.ts\ *clarify-gate.ts\ --no-skills\ *) ;;
      *) echo "smoke-rails: INV-skills argv wrong: ${out}" >&2; exit 1 ;;
    esac
    echo "${out}" | grep -q -- "--skill ${tmp}/ruby-core-skills"
    echo "${out}" | grep -q -- "--skill ${tmp}/rails-agent-skills"
    echo "${out}" | grep -q -- "--skill ${tmp}/github-issue"
    ! grep -q -- "elixir-phoenix-skills" <<<"${out}"
    ! grep -q -- "python" <<<"${out}"
    ! grep -q -- "memory.ts" <<<"${out}"
    if [[ -n "${fixture}" ]]; then
      echo "smoke-rails ok (synthetic fixture; no local Rails repo found)"
    else
      echo "smoke-rails ok (${repo})"
    fi

# Manual e2e: real dotskills install -> pi-vida manifest resolution.
# Needs a dotskills checkout (DOTSKILLS_HOME or ../dotskills); not in smoke.
test-dotskills:
    "{{root}}/scripts/test-dotskills-install.sh"

# Harness-dev: damage-control-continue (does not launch via pi-vida)
ext-damage-control:
    cd "{{root}}" && pi -e extensions/damage-control-continue.ts

# Harness-dev: model name + 10-block context meter
ext-minimal:
    cd "{{root}}" && pi -e extensions/minimal.ts

# Harness-dev: purpose-gate then minimal footer (does not launch via pi-vida)
ext-purpose-gate:
    cd "{{root}}" && pi -e extensions/purpose-gate.ts -e extensions/minimal.ts

# Harness-dev: register .claude/.gemini/.codex commands (does not launch via pi-vida)
ext-cross-agent:
    cd "{{root}}" && pi -e extensions/cross-agent.ts -e extensions/minimal.ts

# Harness-dev: /system persona picker (does not launch via pi-vida)
ext-system-select:
    cd "{{root}}" && pi -e extensions/system-select.ts -e extensions/minimal.ts
