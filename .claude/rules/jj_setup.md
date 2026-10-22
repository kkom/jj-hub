# jj in this checkout

## The `jj gh` alias

Here `jj gh` is a jj alias for this repository's own CLI, run from source, so a change to the CLI takes effect in the next command. Set the checkout up once, from its root. `init` sets the alias to the released `jj-octo` where the checkout has none, so the second command points it back at the source. Later runs of `init` keep it:

```
bun src/main.ts init
jj config set --repo aliases.gh "[\"util\", \"exec\", \"--\", \"bun\", \"$PWD/src/main.ts\"]"
```

`.claude/hooks/session-start.sh` runs both commands in a Claude Code cloud session whose environment runs each checkout's session-start hook.
