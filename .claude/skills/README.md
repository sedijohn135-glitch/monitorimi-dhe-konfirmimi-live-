# Vendored skills

25 engineering skills, copied here rather than installed as a plugin.

## Why they live in the repo

They were installed and enabled as the `agent-skills` plugin on the
account, and they still did not reach Claude Code sessions running on the
web. The sync that serves those sessions was observed running mid-session
— it rewrote `~/.claude/skills/synced/…/manifest.json` and delivered the
account's seven claude.ai skills — while `~/.claude/plugins/synced/…/`
stayed an empty directory with no manifest at all. Plugins enabled on
claude.ai do not currently cross into remote Claude Code containers.

The repository does cross: it is cloned into every session. So the skills
are vendored here, where they load for anyone working on this repo, in
any session, with no dependency on plugin sync.

## Source

| | |
|---|---|
| Upstream | https://github.com/addyosmani/agent-skills |
| Via | https://github.com/sedijohn135-glitch/agent-skills |
| Commit | `48cb116` |
| Version | 0.6.9 |
| Licence | MIT — Copyright (c) 2025 Addy Osmani (see `LICENSE`) |

## What was deliberately left out

Only the `skills/` tree was copied. The upstream repository also ships
`hooks/`, `agents/`, `commands/` and `scripts/`. The hooks in particular
run shell scripts automatically on session start and around tool calls;
nothing that executes on its own was brought into a repository that
operates a live trading monitor. The single shell script inside the
skills tree (`idea-refine/scripts/idea-refine.sh`, 15 lines) only creates
a `docs/ideas` directory, and runs only if that skill is invoked.

## Updating

Re-copy `skills/` from a newer upstream commit and update the table
above. Nothing here is patched, so there is no local diff to preserve.
