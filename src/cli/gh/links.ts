import { Console, Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import { Clipboard, type ClipboardFailed, ClipboardLive } from "../../clients/clipboard";
import { GitHub, type GitHubFailed } from "../../clients/github/client";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { ListedPullRequest, PullRequestState } from "../../clients/github/types";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, revisionFlag, withHelp } from "../command";
import { bookmarkTargets, type NotAStack, stackChanges } from "./stack/changes";

export class NoPullRequests extends Data.TaggedError("NoPullRequests")<{
  readonly message: string;
}> {}

const EMOJI: Readonly<Record<PullRequestState, string>> = {
  closed: "🚫",
  draft: "📝",
  merged: "✅",
  ready: "👀",
};

const OPEN: Readonly<Record<PullRequestState, boolean>> = {
  closed: false,
  draft: true,
  merged: false,
  ready: true,
};

/** One Markdown line per pull request. */
export const markdownLinks = (pullRequests: readonly ListedPullRequest[]): string =>
  pullRequests
    .map(({ number, state, title, url }) => `${EMOJI[state]} [#${number} ${title}](${url})`)
    .join("\n");

/**
 * The same lines as HTML, which apps such as Slack paste as links. The charset keeps the emoji
 * intact where the app reads the HTML without one.
 */
export const htmlLinks = (pullRequests: readonly ListedPullRequest[]): string =>
  `<meta charset="utf-8">${pullRequests
    .map(
      ({ number, state, title, url }) =>
        `${EMOJI[state]} <a href="${Bun.escapeHTML(url)}">#${number} ${Bun.escapeHTML(title)}</a>`,
    )
    .join("<br>")}`;

/**
 * The change's pull request: the open one from its branch, or else the newest closed one whose
 * head is the change or the commit pushed for it. A closed pull request with another head is for
 * an earlier version of the change, or from an earlier branch of the same name.
 */
const pullRequestOf = (
  pullRequests: readonly ListedPullRequest[],
  commitId: string,
  pushed: string | undefined,
): Option.Option<ListedPullRequest> =>
  Option.fromNullishOr(
    pullRequests.find(({ state }) => OPEN[state]) ??
      pullRequests.find(({ head }) => head === commitId || head === pushed),
  );

/** The pull request of each change of the revision's stack, top first. */
export const stackPullRequests = (
  revision: string,
): Effect.Effect<readonly ListedPullRequest[], GitHubFailed | JjFailed | NotAStack, GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const stack = yield* stackChanges(revision);
    const [targets, found] = yield* Effect.all(
      [
        bookmarkTargets,
        Effect.forEach(stack, ({ bookmark }) => github.pullRequestsFrom(bookmark), {
          concurrency: "unbounded",
        }),
      ],
      { concurrency: "unbounded" },
    );
    return stack
      .flatMap(({ bookmark, commitId }, index) =>
        Option.toArray(pullRequestOf(found[index] ?? [], commitId, targets.get(bookmark)?.origin)),
      )
      .toReversed();
  });

/** Prints the links to the stack's pull requests, and copies them to the clipboard if asked. */
export const links = ({
  copy,
  revision,
}: {
  readonly copy: boolean;
  readonly revision: string;
}): Effect.Effect<
  void,
  ClipboardFailed | GitHubFailed | JjFailed | NoPullRequests | NotAStack,
  Clipboard | GitHub | Jj
> =>
  Effect.gen(function* () {
    // Failing leaves the clipboard as it was, rather than as if it held the links.
    const pullRequests = yield* stackPullRequests(revision).pipe(
      Effect.filterOrFail(
        (found) => found.length > 0,
        () => new NoPullRequests({ message: "no change of the stack has a pull request" }),
      ),
    );
    const text = markdownLinks(pullRequests);
    yield* Console.log(text);
    if (copy) {
      const clipboard = yield* Clipboard;
      yield* clipboard.write({ html: htmlLinks(pullRequests), text });
      yield* Console.error("copied the links to the clipboard");
    }
  });

export const linksCommand = Command.make(
  "links",
  {
    copy: Flag.Boolean("copy").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Also copy the links to the clipboard, as links that Slack pastes"),
    ),
    revision: revisionFlag("A change of the stack to list"),
  },
  (options) => asUserError(links(options).pipe(Effect.provide([GitHubFromOrigin, ClipboardLive]))),
).pipe(
  withHelp(
    "Print the stack's pull requests as Markdown links",
    "Prints one line per pull request, top first: 📝 for a draft, 👀 for one ready for review, ✅ for a merged one and 🚫 for one closed unmerged, then a Markdown link showing its number and title.",
    "A change's pull request is the open one from its branch, or else the newest closed one whose head is the change or the commit pushed for it. A change with no pull request is left out, as is one that `sync` abandoned because its pull request merged. Fails where no change has one.",
    "With `--copy`, also puts the links on the clipboard as HTML, which Slack and other apps paste as links. That runs `osascript` on macOS, which also copies the Markdown as plain text, and `wl-copy` or `xclip` on Linux, which copy the HTML alone.",
    "Fails if the changes aren't a chain, if one has conflicts, or if one doesn't have exactly one bookmark, as `log` does. Changes nothing, locally or on GitHub.",
  ),
);
