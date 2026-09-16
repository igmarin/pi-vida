#!/usr/bin/env bash
# Real installer -> pi-vida allowlist, with local Git fixture sources and a temp home.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dotskills="${DOTSKILLS_HOME:-${root}/../dotskills}"
[[ -f "$dotskills/install.sh" ]] || { echo 'Set DOTSKILLS_HOME to a dotskills checkout.' >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home/.dotskills" "$tmp/source/skills/sample-implementation" "$tmp/harness/profiles" "$tmp/target"
printf '%s\n' '---' 'name: sample-implementation' 'description: Fixture implementation skill' '---' '# Implement' > "$tmp/source/skills/sample-implementation/SKILL.md"
git -C "$tmp/source" init -q
git -C "$tmp/source" add skills
git -C "$tmp/source" -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null commit -qm fixture
printf '[repos]\nowned = ["owner/ruby-core-skills|%s/source|skills"]\n' "$tmp" > "$tmp/home/.dotskills/config.toml"
HOME="$tmp/home" bash "$dotskills/install.sh" > "$tmp/install.log"
# No unrelated global skill or private profile config enters the fixture.
cat > "$tmp/harness/profiles/ruby.yaml" <<'YAML'
vida: ruby
mantra: []
packs:
  - ruby-core-skills
tracker: none
YAML
(
  cd "$tmp/target"
  PI_SKILLS_HOME="$tmp/home/.agents/skills" MY_PI_AGENT_HOME="$tmp/harness" "$root/bin/pi-vida" --dry-run ruby > "$tmp/launch.log" 2> "$tmp/launch.err"
)
grep -q -- "--skill $tmp/home/.agents/skills/sample-implementation" "$tmp/launch.log"
! grep -q 'missing pack ruby-core-skills' "$tmp/launch.err"
# Removing an advertised skill must fail closed, rather than silently broaden discovery.
rm "$tmp/home/.agents/skills/sample-implementation/SKILL.md"
status=0
(cd "$tmp/target" && PI_SKILLS_HOME="$tmp/home/.agents/skills" MY_PI_AGENT_HOME="$tmp/harness" "$root/bin/pi-vida" --dry-run ruby) > "$tmp/broken.log" 2>&1 || status=$?
[[ "$status" -eq 2 ]]
grep -q 'missing installed skill' "$tmp/broken.log"
echo 'dotskills install -> Pi discovery: passed'
