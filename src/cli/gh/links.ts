import { Console, Effect, Option } from "effect";
import { Command } from "effect/cli";

import { GitHub, type GitHubFailed } from "../../clients/github/client";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { ListedPullRequest, PullRequestState } from "../../clients/github/types";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, revisionFlag, withHelp } from "../command";
import { bookmarkTargets, type NotAStack, stackChanges } from "./stack/changes";

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

const linkLine = ({ number, state, title, url }: ListedPullRequest): string =>
  `${EMOJI[state]} [#${number} ${title}](${url})`;

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

/** A Markdown link to the pull request of each change of the revision's stack, top first. */
export const links = (
  revision: string,
): Effect.Effect<readonly string[], GitHubFailed | JjFailed | NotAStack, GitHub | Jj> =>
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
      .toReversed()
      .map((link) => linkLine(link));
  });

export const linksCommand = Command.make(
  "links",
  { revision: revisionFlag("A change of the stack to list") },
  ({ revision }) =>
    asUserError(links(revision).pipe(Effect.provide(GitHubFromOrigin))).pipe(
      Effect.flatMap((printed) =>
        printed.length === 0
          ? Console.error("no change of the stack has a pull request")
          : Console.log(printed.join("\n")),
      ),
    ),
).pipe(
  withHelp(
    "Print the stack's pull requests as Markdown links",
    "Prints one line per pull request, top first: 📝 for a draft, 👀 for one ready for review, ✅ for a merged one and 🚫 for one closed unmerged, then a Markdown link showing its number and title.",
    "A change's pull request is the open one from its branch, or else the newest closed one whose head is the change or the commit pushed for it. A change with no pull request is left out, as is one that `sync` abandoned because its pull request merged. Where no change has one, a message says so.",
    "Fails if the changes aren't a chain, if one has conflicts, or if one doesn't have exactly one bookmark, as `log` does. Changes nothing, locally or on GitHub.",
  ),
);
