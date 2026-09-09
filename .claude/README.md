# Claude Code configuration

`settings.json` declares the `agent-skills` plugin so every session
working on this repo gets the same engineering skills: spec, plan, build,
verify, review, ship.

| | |
|---|---|
| Marketplace | `addy-agent-skills` → `sedijohn135-glitch/agent-skills` |
| Plugin | `agent-skills@addy-agent-skills` v0.6.9 |
| Upstream | https://github.com/addyosmani/agent-skills (MIT, © 2025 Addy Osmani) |
| Contents | 34 skills, 4 agents (security-auditor, code-reviewer, test-engineer, web-performance-auditor), 1 SessionStart hook |
| Cost | ~3,600 tokens always-on per session |

The SessionStart hook is 28 lines: it reads the `using-agent-skills`
meta-skill and emits it as session context. No network, no writes.

## Why this file exists

The plugin was installed and enabled on the claude.ai account and still
did not reach Claude Code sessions running on the web. The sync serving
those sessions was observed running mid-session — it rewrote
`~/.claude/skills/synced/…/manifest.json` and delivered the account's
seven claude.ai skills — while `~/.claude/plugins/synced/…/` stayed an
empty directory with no manifest. Plugins enabled on claude.ai do not
currently cross into remote Claude Code containers.

Declaring the marketplace and the plugin here puts the catalog in the
repository, which is cloned into every session.

## If the skills are missing in a session

Declaring a plugin is not the same as installing it. A session that has
the declaration but not the plugin reports it as not installed; run:

```
claude plugin marketplace add sedijohn135-glitch/agent-skills
claude plugin install agent-skills@addy-agent-skills
```

If that is ever unavailable, commit `cc0960d` vendored all 25 skill
files directly into `.claude/skills/`, which loads with no plugin
machinery at all. `git revert` it back and it works again — that copy was
removed only because this plugin supersedes it and having both would
register every skill twice.
