# GitHub

## Try every path before concluding GitHub is unreachable

GitHub is reachable several ways — the `gh` CLI, plain `git` over HTTPS, and in a Claude Code cloud session the GitHub MCP server's tools — and each is authorized separately. An access error only tells you about the path that returned it, however broadly it's worded. For example, `gh` can return a 403 saying the session has no GitHub access, while the MCP tools can still read the repository and `git push` still works.

So try the other paths, and report the error itself rather than concluding GitHub is unavailable. Once you decide something is unavailable you stop trying it, and quietly do less than was asked.

## Read an empty listing as "not yet"

Checks and runs take minutes to appear, so an empty listing doesn't mean there will be none.

## Leave an abandoned branch in place

A cloud session can't delete a remote branch. `branch-cleanup.yaml` deletes it daily once its last commit is two weeks old, unless it's protected, GitHub Pages publishes from it, or an open pull request has it as its head or base. A branch pushed to after its latest pull request closed is kept until two weeks after that pull request closed. So give work that follows a closed pull request a new branch.

## Follow the PR template

Structure the description as `.github/pull_request_template.md` does, following the guidance in its comments.

## Write the description before publishing

Human and AI reviewers may start as soon as a PR is published. So submit a draft, write its description, then publish it.

When a branch's changes evolve, update its description to match.

## Disclose that you're an AI

When you use a human's access token, say that you're an AI agent, so your actions aren't mistaken for theirs. Name:

- the model (e.g. Claude Opus 5)
- the harness (e.g. local Claude Code)
- the level of autonomy (e.g. prescriptive instruction, vague instruction, acting autonomously to solve a goal)

This applies to PR descriptions and to comments on them. For example, end with _(sent by Claude Opus 5 from local Claude Code on behalf of @user, acting autonomously)_.
