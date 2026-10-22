#!/usr/bin/env bash

# Sets this checkout up in a Claude Code cloud session, for an environment whose setup
# runs each checkout's `.claude/hooks/session-start.sh` with a phase: `trunk` before the
# session opens, and `tools` in the background. The line below says it takes them.
# session-start-phases: trunk tools
#
# `jj gh` runs this repository's CLI from source, so a change to it takes effect in the
# next command. `init` sets the alias to the released `jj-octo` where the checkout has none,
# so it's pointed back here afterwards. The CLI's dependencies are installed first, since
# `init` runs from source.

set -euo pipefail

# stdout is kept for a report the environment reads, so progress goes to stderr.
exec 1>&2

case "${1:-}" in
    trunk)
        bun install --frozen-lockfile
        bun src/main.ts init
        jj config set --repo aliases.gh "[\"util\", \"exec\", \"--\", \"bun\", \"${PWD}/src/main.ts\"]"
        ;;
    tools) ;;
    *)
        echo "session-start: unknown phase '${1:-}'" >&2
        exit 1
        ;;
esac
