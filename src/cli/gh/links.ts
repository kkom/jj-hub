import { Console, Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import {
  Clipboard,
  type ClipboardFailed,
  ClipboardLive,
  type ClipboardWrite,
} from "../../clients/clipboard";
import { GitHub, type GitHubFailed } from "../../clients/github/client";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { ListedPullRequest, PullRequestState } from "../../clients/github/types";
import { type Jj, JjFailed } from "../../clients/jj";
import { asUserError, revisionFlag, withHelp } from "../command";
import {
  anyOf,
  bookmarkTargets,
  lines,
  type NotAStack,
  readLog,
  stackChanges,
} from "./stack/changes";

export class NoPullRequests extends Data.TaggedError("NoPullRequests")<{
  readonly message: string;
}> {}

const EMOJI: Readonly<Record<PullRequestState, string>> = {
  closed: "🚫",
  draft: "📝",
  merged: "🏁",
  ready: "👀",
};

const OPEN: Readonly<Record<PullRequestState, boolean>> = {
  closed: false,
  draft: true,
  merged: false,
  ready: true,
};

/** What `--copy` prints after the links, for each outcome of the clipboard's `write`. */
const COPY_REPORT: Readonly<Record<ClipboardWrite, string>> = {
  copied: "copied the links to the clipboard",
  unreachable: [
    "This Claude Code cloud session can't reach the user's clipboard.",
    "To give the user the links, put the Markdown links this command printed in your reply, outside a code block.",
    "The Claude app shows them as links, which paste into Slack as links.",
  ].join(" "),
};

/** The lines a change adds and removes. */
interface LineCounts {
  readonly added: number;
  readonly removed: number;
}

/** A change's pull request, with the lines the change adds and removes. */
export interface LinkedPullRequest extends ListedPullRequest, LineCounts {}

const lineCounts = ({ added, removed }: LineCounts): string => `+${added}/-${removed}`;

/** One Markdown line per pull request. */
export const markdownLinks = (pullRequests: readonly LinkedPullRequest[]): string =>
  pullRequests
    .map(
      ({ added, number, removed, state, title, url }) =>
        `${EMOJI[state]} [#${number} ${title}](${url}) ${lineCounts({ added, removed })}`,
    )
    .join("\n");

/**
 * The same lines as HTML, which apps such as Slack paste as links. The charset keeps the emoji
 * intact where the app reads the HTML without one.
 */
export const htmlLinks = (pullRequests: readonly LinkedPullRequest[]): string =>
  `<meta charset="utf-8">${pullRequests
    .map(
      ({ added, number, removed, state, title, url }) =>
        `${EMOJI[state]} <a href="${Bun.escapeHTML(url)}">#${number} ${Bun.escapeHTML(title)}</a> ${lineCounts({ added, removed })}`,
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

const LINE_COUNTS = String.raw`commit_id ++ "\t" ++ diff.stat().total_added() ++ "\t" ++ diff.stat().total_removed() ++ "\n"`;

/**
 * The lines each of the commits adds and removes, by commit id. It skips the snapshot, since
 * `bookmarkTargets` takes one at the same time, and two would be concurrent operations.
 */
const lineCountsOf = (
  commitIds: readonly string[],
): Effect.Effect<ReadonlyMap<string, LineCounts>, JjFailed, Jj> =>
  Effect.gen(function* () {
    const logged = yield* readLog(anyOf(commitIds), LINE_COUNTS, { ignoreWorkingCopy: true });
    const counts = new Map<string, LineCounts>();
    for (const line of lines(logged)) {
      const { added, commitId, removed } =
        /^(?<commitId>\w+)\t(?<added>\d+)\t(?<removed>\d+)$/u.exec(line)?.groups ?? {};
      if (added === undefined || commitId === undefined || removed === undefined) {
        return yield* new JjFailed({
          message: `jj printed ${JSON.stringify(line)} for the lines a commit adds and removes`,
        });
      }
      counts.set(commitId, { added: Number(added), removed: Number(removed) });
    }
    return counts;
  });

/** The pull request of each change of the revision's stack, top first. */
export const stackPullRequests = (
  revision: string,
): Effect.Effect<readonly LinkedPullRequest[], GitHubFailed | JjFailed | NotAStack, GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const stack = yield* stackChanges(revision);
    const [targets, counts, found] = yield* Effect.all(
      [
        bookmarkTargets,
        lineCountsOf(stack.map(({ commitId }) => commitId)),
        Effect.forEach(stack, ({ bookmark }) => github.pullRequestsFrom(bookmark), {
          concurrency: "unbounded",
        }),
      ],
      { concurrency: "unbounded" },
    );
    const linked = stack.flatMap(({ bookmark, commitId }, index) =>
      Option.toArray(
        pullRequestOf(found[index] ?? [], commitId, targets.get(bookmark)?.origin),
      ).map((pullRequest) =>
        Option.match(Option.fromNullishOr(counts.get(commitId)), {
          onNone: () =>
            Effect.fail(new JjFailed({ message: `jj printed no line counts for ${commitId}` })),
          onSome: (changed) => Effect.succeed<LinkedPullRequest>({ ...pullRequest, ...changed }),
        }),
      ),
    );
    return (yield* Effect.all(linked)).toReversed();
  });

/** Prints the links to the stack's pull requests, and writes them to the clipboard if asked. */
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
      const written = yield* clipboard.write({ html: htmlLinks(pullRequests), text });
      yield* Console.error(COPY_REPORT[written]);
    }
  });

export const linksCommand = Command.make(
  "links",
  {
    copy: Flag.Boolean("copy").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Also copy the links to the clipboard, as links that Slack pastes, or in a Claude Code cloud session say how to give them to the user",
      ),
    ),
    revision: revisionFlag("A change of the stack to list"),
  },
  (options) => asUserError(links(options).pipe(Effect.provide([GitHubFromOrigin, ClipboardLive]))),
).pipe(
  withHelp(
    "Print the stack's pull requests as Markdown links",
    "Prints one line per pull request, top first: 📝 for a draft, 👀 for one ready for review, 🏁 for a merged one and 🚫 for one closed unmerged, then a Markdown link showing its number and title, then the lines its change adds and removes, as `+123/-45`.",
    "A change's pull request is the open one from its branch, or else the newest closed one whose head is the change or the commit pushed for it. A change with no pull request is left out, as is one that `sync` abandoned because its pull request merged. Fails where no change has one.",
    "With `--copy`, also puts the links on the clipboard as HTML, which Slack and other apps paste as links. That runs `osascript` on macOS, which also copies the Markdown as plain text, and `wl-copy` or `xclip` on Linux, which copy the HTML alone.",
    "In a Claude Code cloud session, where `CLAUDE_CODE_REMOTE` is `true`, `--copy` copies nothing. It tells the agent to put the Markdown in its reply, which the Claude app shows as links that paste into Slack.",
    "Fails if the changes aren't a chain, if one has conflicts, or if one doesn't have exactly one bookmark, as `log` does. Changes nothing, locally or on GitHub.",
  ),
);
