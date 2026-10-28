import { Console, Effect, Option } from "effect";
import { Command } from "effect/cli";

import { GitHub, type GitHubFailed } from "../../clients/github/client";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { PullRequest } from "../../clients/github/types";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, revisionFlag, table, withHelp } from "../command";
import {
  bookmarkTargets,
  type NotAStack,
  type Pushed,
  pushedState,
  stackChanges,
} from "./stack/changes";

interface LogEntry {
  readonly bookmark: string;
  readonly pullRequest: Option.Option<PullRequest>;
  readonly pushed: Pushed;
}

/** One line per change, top first, with the columns aligned. */
const logLines = (entries: readonly LogEntry[]): readonly string[] => {
  const rows = entries.toReversed().map(({ bookmark, pullRequest, pushed }) => [
    bookmark,
    Option.match(pullRequest, {
      onNone: () => "no pull request",
      onSome: ({ draft, number }) => `#${number} ${draft ? "draft" : "ready"}`,
    }),
    pushed,
  ]);
  return table(rows, 2);
};

/** The changes of the stack containing the revision, each with its pull request and push state. */
export const log = (
  revision: string,
): Effect.Effect<readonly string[], GitHubFailed | JjFailed | NotAStack, GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const stack = yield* stackChanges(revision);
    const targets = yield* bookmarkTargets;
    const pullRequests = yield* Effect.all(
      stack.map(({ bookmark }) => github.openPullRequest(bookmark)),
      { concurrency: "unbounded" },
    );
    return logLines(
      stack.map((change, index) => ({
        bookmark: change.bookmark,
        pullRequest: pullRequests[index] ?? Option.none(),
        pushed: pushedState(targets.get(change.bookmark), change),
      })),
    );
  });

export const logCommand = Command.make(
  "log",
  { revision: revisionFlag("A change of the stack to show") },
  ({ revision }) =>
    asUserError(log(revision).pipe(Effect.provide(GitHubFromOrigin))).pipe(
      Effect.flatMap((printed) => Console.log(printed.join("\n"))),
    ),
).pipe(
  withHelp(
    "Show changes and their pull requests",
    "Prints one line per change, top first: its bookmark, its pull request with whether that is a draft or ready for review, and whether the change is pushed, changed since the push, or not pushed.",
    "Fails if the changes aren't a chain, if one has conflicts, or if one doesn't have exactly one bookmark. `submit` makes the same check before it changes anything.",
    "Changes nothing, locally or on GitHub.",
  ),
);
