#!/bin/bash
# Install this repo's plugins if the session does not already have them.
#
# settings.json declares the marketplaces and which plugins are enabled,
# but a declaration is not an installation: a fresh container starts with
# an empty plugin store, and Claude Code then reports the plugin as "not
# installed" rather than fetching it. Sessions on the web get a fresh
# container every time, so without this the declaration alone would leave
# every new session without the plugins.
#
# Safe to run on every session start: each install is skipped when the
# plugin is already present, so the normal case costs one `plugin list`.
# Never fails the session — a plugin that cannot be fetched (network,
# a renamed repo) is reported and skipped, because losing a helper is not
# a reason to stop the operator working.

set -uo pipefail

emit() {
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' \
    "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
}

command -v claude >/dev/null 2>&1 || { emit "plugin install skipped: no claude CLI on PATH"; exit 0; }

installed="$(claude plugin list 2>/dev/null || true)"

# marketplace|plugin@marketplace
WANTED="
sedijohn135-glitch/agent-skills|agent-skills@addy-agent-skills
sedijohn135-glitch/ponytail|ponytail@ponytail
sedijohn135-glitch/graphify|graphify@graphify
sedijohn135-glitch/ruflo|ruflo-core@ruflo
"

added=(); failed=()
for line in $WANTED; do
  repo="${line%%|*}"; plugin="${line##*|}"
  case "$installed" in *"$plugin"*) continue ;; esac
  claude plugin marketplace add "$repo" >/dev/null 2>&1
  if claude plugin install "$plugin" >/dev/null 2>&1; then
    added+=("$plugin")
  else
    failed+=("$plugin")
  fi
done

msg=""
[ ${#added[@]} -gt 0 ]  && msg="installed: ${added[*]}. "
[ ${#failed[@]} -gt 0 ] && msg="${msg}could not install: ${failed[*]} — run 'claude plugin install <name>' by hand. "
[ -n "$msg" ] && emit "Repo plugins — ${msg}"
exit 0
