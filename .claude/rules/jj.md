# jj and stacked pull requests

A stack is a linear chain of pull requests on top of the trunk (`main`), each targeting the branch below it, so reviewers see only that layer's diff. Toward the trunk is "downstack", away from it "upstack". GitHub registers such a chain as a stack of its own, and merges it atomically.

Locally a stack is a chain of jj changes, one per pull request, each with the bookmark that names its branch. jj is colocated with git, so each bookmark is also a git branch. Still, make every change to history through jj. `jj gh` does all the work on GitHub. It's a jj alias, and `jj_setup.md` says how a checkout gets it. It uses only the REST API, stacks included, and signs in with `GH_TOKEN` or the token `gh auth login` stored.

```
◯ top-change        claude/top
@ edited-change     claude/middle
◯ bottom-change     claude/bottom
◆ main (trunk)
```

## What a good stack looks like

Every stack is based on `main`. Related work is split into granular pull requests, each with one clear goal, and each change depends on or relates to the ones below it — unrelated work is a separate stack, started with `jj new main`. A change is understandable without reading the ones above it, and includes the tests for its own code. Parts that can ship separately are separate changes, and reverting upstack changes leaves a working system, unless they're irreversible like a data migration.

Each pull request is one change, amended in place for as long as it lives.

## What makes a stack

jj allows any history, but a GitHub stack must be a chain. So `jj gh log`, which shows a stack and its pull requests, and `jj gh links` fail on a change with two children, a merge, or a change with no bookmark or several. `submit` and `merge` run the same check on the changes they act on before they touch the remote. The stack is every change connected to the working copy through mutable changes. Separate stacks meet only at the trunk, which is immutable, so each one is found on its own.

## Commands

All of them run from any directory of the checkout, and `jj help <command>` covers the flags.

| Command | What it does |
| --- | --- |
| `jj new main -m "<message>"` | Starts a stack, or a separate one |
| `jj bookmark create claude/<name> -r @` | Names the change's branch |
| `jj new -m "<message>"` | Adds a change on top of the working copy |
| `jj edit <change>` | Edits a change in place, wherever it sits |
| `jj describe -r <change> -m "<message>"` | Rewords a change |
| `jj squash --from @ --into <change> <path>` | Moves edits from the working copy into a change below |
| `jj split -r <change> <path>...` | Splits a change in two, the named paths going first |
| `jj rebase -r <change> -B <other>` | Moves a change to just below another |
| `jj abandon <change>` | Drops a change, rebasing its descendants onto its parent |
| `jj log -r 'trunk()::'` | Shows the stacks |
| `jj undo` | Undoes the last operation, whatever it was |
| `jj gh init` | Sets up a checkout: colocates jj with git, makes GitHub's default branch `trunk()` and sets the `jj gh` alias |
| `jj gh doctor` | Checks what `jj gh init` sets up, and prints each problem with what fixes it, without changing anything |
| `jj gh log` | Shows the stack's changes, their pull requests and whether each is pushed |
| `jj gh links` | Prints the stack's pull requests as Markdown links, top first, each marked as a draft, ready, merged or closed. `--copy` also puts them on the clipboard as links that Slack pastes |
| `jj gh submit` | Pushes the working copy's change and the ones below it, and makes their pull requests one GitHub stack |
| `jj gh merge -r <change>` | Merges the pull requests of that change and the ones below it, then syncs and republishes the rest of the stack |
| `jj gh sync` | Rebases every stack onto the fetched trunk and drops what merged |

## Building and changing a stack

`jj edit <change>` makes a change the working copy, and every edit from then on is part of it — there is no staging and no amend. Everything upstack is rebased onto the edit as it happens. If that causes a conflict, jj records it in the change instead of stopping. Clear it with `jj resolve` or by editing the file.

jj records every file in the checkout that isn't ignored, so a scratch file written inside it becomes part of the change being edited. Scratch work belongs outside the checkout.

`jj gh sync` keeps every stack current with `main`; the longer one lags, the worse the conflicts. It pushes nothing, so run `jj gh submit` afterwards on a stack whose pull requests should be updated.

`sync` abandons each change whose pull request GitHub reports as merged, unless the change was edited after the merge, and forgets its bookmark. It rebases the rest of that stack onto the trunk even where it conflicts, since the changes it was based on are gone. `sync` leaves any other stack where it was if rebasing it would conflict with the trunk, and prints its name. Rebase that stack with `jj rebase` when you're ready to resolve the conflict. Commits added to a branch on GitHub are squashed into the branch's local change.

## Publishing

Before pushing, `submit` asks GitHub which of the pull requests it submits merged, and which of their branches changed. A stack merge does both: it merges the bottom pull requests and rebases the branches above them. Where anything merged or changed, `submit` syncs that stack alone, as `sync` does, and prints what it did. So a push never undoes what GitHub did to a branch. A branch deleted on GitHub stops `submit` before it changes anything where its change doesn't count as merged: no pull request from it merged, another commit merged, or the change was edited since.

`submit` pushes every branch of the stack, opens the missing pull requests as drafts titled and described by their changes, points each at the branch below it, and registers them as one GitHub stack. A stack of one is a single pull request, which GitHub has no stack for. Then publish the pull requests with `gh pr ready`, as `github.md` describes. `submit --publish` opens new pull requests ready for review instead of as drafts, and doesn't change one that already exists.

`submit` keeps each pull request's title and body the same as its change's description. So write the description the PR template asks for with `jj describe`, or edit it on GitHub, and run `submit` again. An edit made on GitHub is written into the change, one made locally is sent to the pull request, and edits on both sides are merged line by line. That holds for a local edit pushed with `jj git push` too. Edits to the same lines stop `submit` before it pushes, and it prints both versions.

`submit` reads who edited a description against the one both sides last agreed on, which it records for each pull request in `jj-octo/pr-descriptions` under the repository's `.jj/repo`, in the main workspace. Every workspace of the repository shares the records. A record stops counting once the change takes another description from git, as from another clone's rewrite of the branch that a fetch brings in, and once git rewrites the commit, as `git commit --amend` in a colocated checkout does. A rebase that GitHub makes, as after a merge below it, gives the change a new id, so jj can't follow the record through it either. Then `submit` reads against the pushed description, as without a record. Each sync, including the ones `merge` and `submit` run, deletes the records of bookmarks that are gone. Without a record, as in another clone, a local edit pushed with `jj git push` is still sent where GitHub has a description the change had before.

GitHub rejects a base change on a pull request that is in a stack, and can only add pull requests to a stack's top. So when a reorder, a dropped change or an insertion moves any base, `submit` dissolves the stack, moves the bases, and registers the stack again under a new number. The pull requests themselves stay open.

Before pushing, `submit` also points each pull request whose base is moving at the trunk. That's because GitHub closes a pull request as merged as soon as its head is reachable from its base, which the push would otherwise cause for a pull request that moved below its old base.

A change dropped from the stack leaves its pull request open, for closing by hand.

## Merging

Merge with `jj gh merge`, not `gh pr merge` or GitHub's merge button. That's because only `jj gh merge` syncs the checkout afterwards and republishes the rest of the stack.

Merge separate stacks one at a time. Each merge rebases the other stacks onto the new trunk, so run `jj gh submit` on the next stack before merging it.

`merge` fails before merging if the change named, or one below it, has edits that aren't pushed. Run `submit` first.

`merge` squash-merges everything up to and including the pull request of the change named, in one operation that merges all of it or none of it, and GitHub rebases the pull requests above onto the result itself. `merge` then runs `sync`, which fetches, forgets the merged changes' bookmarks whether or not GitHub has deleted their branches yet, abandons the merged changes, and rebases every local stack onto the new trunk. The rest of the merged changes' stack is rebased even where it conflicts with the trunk. `merge` then republishes what was already on GitHub of the changes left in that stack, and leaves unpublished changes local.

Don't use the `gh stack` extension. Its local commands keep their own record of the stack in `.git/gh-stack` and move branches without jj knowing, and `jj gh` already does its GitHub work over REST.
