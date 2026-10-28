import { Array as EffectArray, Console, Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import {
  Clipboard,
  type ClipboardFailed,
  ClipboardLive,
  type ClipboardWrite,
} from "../../clients/clipboard";
import { GitHub, type GitHubFailed } from "../../clients/github/client";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { ListedPullRequest, PullRequestState, StackLink } from "../../clients/github/types";
import { type Jj, JjFailed } from "../../clients/jj";
import { asUserError, revisionFlag, withHelp } from "../command";
import {
  bookmarkTargets,
  type LineCounts,
  lineCountsAt,
  type NotAStack,
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

const STACK_EMOJI = "📚";

const OPEN: Readonly<Record<PullRequestState, boolean>> = {
  closed: false,
  draft: true,
  merged: false,
  ready: true,
};

/** What `--copy` reports after the links, for each outcome of the clipboard's `write`. */
const COPY_REPORT: Readonly<Record<ClipboardWrite, string>> = {
  copied: "copied the links to the clipboard",
  unreachable: [
    "This Claude Code cloud session can't reach the user's clipboard.",
    "Copy the lines between the markers into your reply verbatim: without the markers, a code block or added backticks.",
    "They then show as links that paste into Slack.",
  ].join(" "),
};

/** What `--copy` prints of the links, for each outcome of the clipboard's `write`. */
const COPY_PRINT: Readonly<Record<ClipboardWrite, (text: string) => string>> = {
  copied: (text) => text,
  unreachable: (text) =>
    ["-----BEGIN TEXT TO PASTE VERBATIM-----", text, "-----END TEXT TO PASTE VERBATIM-----"].join(
      "\n",
    ),
};

/** A change's pull request, with the lines the change adds and removes. */
export interface LinkedPullRequest extends ListedPullRequest, LineCounts {}

const lineCounts = ({ added, removed }: LineCounts): string => `+${added}/-${removed}`;

/**
 * The GitHub stack of the open pull requests. A merged one can be in an older stack, which `submit`
 * dissolved and registered again under a new number.
 */
const currentStack = (pullRequests: readonly LinkedPullRequest[]): Option.Option<StackLink> =>
  EffectArray.findFirst(pullRequests, ({ stack, state }) => (OPEN[state] ? stack : Option.none()));

/** How a line of links writes a link and a code span: as Markdown or as HTML. */
interface LinkFormat {
  readonly code: (text: string) => string;
  readonly link: (text: string, url: string) => string;
}

/** One line for the stack of the open pull requests, where they are in one, then one per pull request. */
const linkLines = (
  pullRequests: readonly LinkedPullRequest[],
  { code, link }: LinkFormat,
): readonly string[] => [
  ...Option.toArray(currentStack(pullRequests)).map(
    ({ number, url }) => `${STACK_EMOJI} Current stack: ${link(`#${number}`, url)}`,
  ),
  ...pullRequests.map(
    (pullRequest) =>
      `${EMOJI[pullRequest.state]} ${link(`#${pullRequest.number} ${pullRequest.title}`, pullRequest.url)} ${code(lineCounts(pullRequest))}`,
  ),
];

const MARKDOWN: LinkFormat = {
  code: (text) => `\`${text}\``,
  link: (text, url) => `[${text}](${url})`,
};

const HTML: LinkFormat = {
  code: (text) => `<code>${text}</code>`,
  link: (text, url) => `<a href="${Bun.escapeHTML(url)}">${Bun.escapeHTML(text)}</a>`,
};

/** The links as Markdown, one per line. */
export const markdownLinks = (pullRequests: readonly LinkedPullRequest[]): string =>
  linkLines(pullRequests, MARKDOWN).join("\n");

/**
 * The same lines as HTML, which apps such as Slack paste as links. The charset keeps the emoji
 * intact where the app reads the HTML without one.
 */
export const htmlLinks = (pullRequests: readonly LinkedPullRequest[]): string =>
  `<meta charset="utf-8">${linkLines(pullRequests, HTML).join("<br>")}`;

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
): Effect.Effect<readonly LinkedPullRequest[], GitHubFailed | JjFailed | NotAStack, GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const stack = yield* stackChanges(revision);
    const [targets, counts, found] = yield* Effect.all(
      [
        bookmarkTargets,
        lineCountsAt(stack.map(({ commitId }) => commitId)),
        Effect.forEach(stack, ({ bookmark }) => github.pullRequestsFrom(bookmark), {
          concurrency: "unbounded",
        }),
      ],
      { concurrency: "unbounded" },
    );
    const linked: LinkedPullRequest[] = [];
    for (const [index, { bookmark, commitId }] of stack.entries()) {
      const pullRequest = pullRequestOf(
        found[index] ?? [],
        commitId,
        targets.get(bookmark)?.origin,
      );
      const changed = counts.get(commitId);
      if (Option.isSome(pullRequest)) {
        if (changed === undefined) {
          return yield* new JjFailed({ message: `jj printed no line counts for ${commitId}` });
        }
        linked.push({ ...pullRequest.value, ...changed });
      }
    }
    return linked.toReversed();
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
    if (copy) {
      const clipboard = yield* Clipboard;
      // The links still reach the terminal where the clipboard fails.
      const written = yield* clipboard
        .write({ html: htmlLinks(pullRequests), text })
        .pipe(Effect.tapError(() => Console.log(text)));
      yield* Console.log(COPY_PRINT[written](text));
      yield* Console.error(COPY_REPORT[written]);
    } else {
      yield* Console.log(text);
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
    'Prints a link to the GitHub stack of the open pull requests, where they are in one. It says "Current stack", since `submit` registers a stack again under a new number when it moves a base. Then prints one line per pull request, top first: 📝 for a draft, 👀 for one ready for review, 🏁 for a merged one and 🚫 for one closed unmerged, then a Markdown link showing its number and title, then the lines its change adds and removes, in inline code, as `+123/-45`.',
    "A change's pull request is the open one from its branch, or else the newest closed one whose head is the change or the commit pushed for it. A change with no pull request is left out, as is one that `sync` abandoned because its pull request merged. Fails where no change has one.",
    "With `--copy`, also puts the links on the clipboard as HTML, which Slack and other apps paste as links. That runs `osascript` on macOS, which also copies the Markdown as plain text, and `wl-copy` or `xclip` on Linux, which copy the HTML alone.",
    "In a Claude Code cloud session, where `CLAUDE_CODE_REMOTE` is `true`, `--copy` copies nothing. It prints the Markdown between begin and end markers, and tells the agent to copy what is between them into its reply. The Claude app shows that as links that paste into Slack.",
    "Fails if the changes aren't a chain, if one has conflicts, or if one doesn't have exactly one bookmark, as `log` does. Changes nothing, locally or on GitHub.",
  ),
);
