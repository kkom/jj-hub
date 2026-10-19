# jj-octo

A [jj](https://github.com/jj-vcs/jj) subcommand for working with GitHub that supports stacking.

> [!WARNING]
> `jj-octo` is in early development, and its commands may change. So far it is largely vibe coded.

## Usage

Run `jj gh --help` to list the commands.

## Install

`jj-octo` runs on [Node](https://nodejs.org) 22.19 or later, and calls `jj`. Both must be on `PATH`. It also runs on [Bun](https://bun.sh) 1.4 or later, as below.

### For one repository

With [mise](https://mise.jdx.dev), in the repository's `mise.toml`, where `A.B.C` is a Node version and `X.Y.Z` a [released version](https://www.npmjs.com/package/jj-octo?activeTab=versions) of `jj-octo`:

```toml
[tools]
node = "A.B.C"

[tools."npm:jj-octo"]
version = "X.Y.Z"
# mise holds back a package that is new or rarely downloaded, and this approves it.
allow_low_downloads = true
```

Then set up each checkout, since jj doesn't read config from a committed file:

```
jj-octo init
```

It makes the checkout a jj repository colocated with git, makes GitHub's default branch `trunk()`, and sets the `jj gh` alias.

### For every repository

```
npm install --global jj-octo
jj config set --user aliases.gh '["util", "exec", "--", "jj-octo"]'
```

Then run `jj-octo init` once in each checkout, as above. To update it later, run `npm install --global jj-octo@latest`.

`bun install --global jj-octo` installs it with Bun instead. The command starts with `#!/usr/bin/env node`, so it needs Node on `PATH` either way. `bun x --bun jj-octo` runs the installed command on Bun.

## GitHub access

`jj-octo` reads the repository from the `origin` remote. It takes its token from `GH_TOKEN` or `GITHUB_TOKEN`, and otherwise from `gh auth token`. It sends requests through the proxy that `HTTPS_PROXY` names, or `HTTP_PROXY` where that is unset, unless `NO_PROXY` matches `api.github.com`, and trusts the certificate authorities in `NODE_EXTRA_CA_CERTS` as well as the runtime's own.

It uses only GitHub's REST API, so that it works in a [Claude Code](https://claude.com/claude-code) cloud session. There, GitHub is reached through a proxy that allows REST calls for the session's repository and blocks GraphQL, which `gh pr` depends on.

Where git reaches github.com through a proxy that adds the credentials itself, as in a Claude Code cloud session that keeps the token outside the sandbox, have `jj-octo` use that proxy too:

```
jj config set --repo jj-octo.github-auth git-proxy
```

`jj-octo` then sends its requests through the `http.proxy` that git uses for `https://github.com`, trusts the certificate authorities in git's `http.sslCAInfo` for it, and sends a placeholder token that the proxy replaces. It reads git's settings on each run, so it follows a proxy that moves to another port. `token`, the default, sends your own token.

## Development

```
bun install
bun run check    # format, lint, types, tests and build
bun run fix      # format and lint fixes
```

To release, run `bun run release:patch`, `release:minor` or `release:major` in a pull request, which raises `version` in `package.json`. Once it is merged and the checks pass on `main`, the same workflow publishes that version to npm and tags it.
