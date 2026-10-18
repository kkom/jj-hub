#!/usr/bin/env bash

# Claude Code runs each Bash command in a copy of the shell it captured when the session
# started, so PATH keeps the tool versions that mise.toml pinned then. mise updates PATH
# before each prompt, and these shells show no prompt. Claude Code runs CLAUDE_ENV_FILE
# before each Bash command, so the line this writes there updates PATH instead. It takes a
# few milliseconds when nothing changed.

set -euo pipefail

[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0

# mise is looked up when each command runs, because it may be installed after this hook
# runs, or not at all. Without `--shell`, mise writes for the shell that MISE_SHELL or SHELL
# names, which is the shell Claude Code runs commands in.
# shellcheck disable=SC2016 # The line runs before each Bash command, not here
line='if command -v mise > /dev/null; then eval "$(mise hook-env)"; fi'

# SessionStart also fires on resume, clear and compact, which keep the file.
grep --quiet --line-regexp --fixed-strings "${line}" "${CLAUDE_ENV_FILE}" 2> /dev/null \
    || echo "${line}" >> "${CLAUDE_ENV_FILE}"
