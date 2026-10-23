import { Console, Data, Effect, Match, Option } from "effect";

import { Git, type GitFailed } from "../../../clients/git";
import type { PullRequest } from "../../../clients/github/types";
import { Jj, type JjFailed, jjFlag } from "../../../clients/jj";
import { PrDescriptions } from "../../../clients/pr-descriptions";
import { bookmarkRevset, lines, parseDescription, readLog, type StackChange } from "./changes";
import {
  agreedDescription,
  descriptionFrom,
  descriptionSyncFor,
  normalizedDescription,
} from "./plan";

export class DescriptionConflict extends Data.TaggedError("DescriptionConflict")<{
  readonly message: string;
}> {}

/** The description a change and its pull request agree on, and whether GitHub needs it sent. */
export interface SyncedDescription {
  readonly send: boolean;
  readonly text: string;
}

const kept = (text: string): SyncedDescription => ({ send: false, text });
const sent = (text: string): SyncedDescription => ({ send: true, text });

interface DescriptionOptions {
  readonly ignoreClaudeCodeFooter: boolean;
  readonly overwriteDescriptions: boolean;
  /** The commit on `origin`'s branch, where it has one. */
  readonly pushedCommit: string | undefined;
  readonly pushedDescription: string;
}

/** The jj config key that says whether to leave out the Claude Code proxy's footer. */
export const ignoreClaudeCodeFooterKey = "jj-octo.ignore-claude-code-footer";

/**
 * Reads `jj-octo.ignore-claude-code-footer` from the jj config. `true` compares descriptions
 * without the footer that the GitHub proxy of a Claude Code cloud session appends to each pull
 * request body it creates or edits. `false`, the default, compares them as they are.
 */
export const ignoresClaudeCodeFooter: Effect.Effect<boolean, JjFailed, Jj> =
  jjFlag(ignoreClaudeCodeFooterKey);

/** The description of each commit, by commit id, read in one command. */
export const descriptionsOf = (
  commits: readonly string[],
): Effect.Effect<ReadonlyMap<string, string>, JjFailed, Jj> =>
  commits.length === 0
    ? Effect.succeed(new Map<string, string>())
    : readLog(
        commits.join(" | "),
        String.raw`commit_id ++ "\t" ++ description.escape_json() ++ "\n"`,
      ).pipe(
        Effect.map(
          (output) =>
            new Map(
              lines(output).map((line): [string, string] => {
                const [commit = "", json = '""'] = line.split("\t");
                return [commit, parseDescription(json)];
              }),
            ),
        ),
      );

interface Evolution {
  readonly commit: string;
  readonly description: string;
  /** Whether jj took the commit from git, as a fetch does, rather than making it here. */
  readonly isImported: boolean;
  readonly predecessors: readonly string[];
}

/**
 * The change's commits, newest first, read from its evolog. The evolog also holds commits squashed
 * into the change, which belong to other changes, so only commits with the change's id count. That
 * also leaves out what a change had before `jj split` gave it a new id.
 */
const ownHistory = (
  bookmark: string,
  changeId: string,
): Effect.Effect<readonly Evolution[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const output = yield* jj.read([
      "evolog",
      "--no-graph",
      "-r",
      bookmarkRevset(bookmark),
      "-T",
      String.raw`commit.change_id() ++ "\t" ++ commit.commit_id() ++ "\t" ++ predecessors.map(|p| p.commit_id()).join(",") ++ "\t" ++ if(operation, operation.description()) ++ "\t" ++ commit.description().escape_json() ++ "\n"`,
    ]);
    return lines(output).flatMap((line) => {
      const [change = "", commit = "", predecessors = "", operation = "", json = '""'] =
        line.split("\t");
      const isImported =
        operation.startsWith("fetch from git") || operation.startsWith("import git");
      return change === changeId
        ? [
            {
              commit,
              description: parseDescription(json),
              isImported,
              predecessors: predecessors === "" ? [] : predecessors.split(","),
            },
          ]
        : [];
    });
  });

/**
 * Whether the change evolved from the commit with no other description taken from git since, as
 * another clone's rewrite of the branch brings in. A commit taken from git keeps the description
 * where one of its predecessors had it.
 */
const isDescribedHereFrom = (history: readonly Evolution[], commit: string): boolean => {
  const since = history.findIndex((entry) => entry.commit === commit);
  const descriptions = new Map(history.map((entry) => [entry.commit, entry.description]));
  return (
    since !== -1 &&
    history
      .slice(0, since)
      .every(
        ({ description, isImported, predecessors }) =>
          !isImported || predecessors.some((each) => descriptions.get(each) === description),
      )
  );
};

/**
 * Makes a change's description and its pull request's title and body the same text. An edit made
 * on GitHub alone is written into the change here. Returns the text both sides then agree on, and
 * whether it has to be sent to GitHub once the bookmark is pushed.
 *
 * Who changed the description is read against the text both sides last agreed on, which `submit`
 * records for each pull request with the commit it was agreed for. A record counts while the change
 * evolved from that commit and took no other description from git since, as another clone's
 * rewrite of the branch brings in. Without one, it's the pushed description, unless the pull
 * request has a description the change had before: a push made without `submit`, such as
 * `jj git push`, leaves the pull request with that earlier text. A bookmark never pushed has no
 * pushed description, and an empty text is merged from.
 */
export const syncDescription = (
  { bookmark, changeId, description }: StackChange,
  pullRequest: PullRequest,
  {
    ignoreClaudeCodeFooter,
    overwriteDescriptions,
    pushedCommit,
    pushedDescription,
  }: DescriptionOptions,
): Effect.Effect<
  SyncedDescription,
  DescriptionConflict | GitFailed | JjFailed,
  Git | Jj | PrDescriptions
> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const jj = yield* Jj;
    const records = yield* PrDescriptions;
    const describe = (text: string) =>
      jj.run(["describe", "-r", bookmarkRevset(bookmark), "-m", text]);
    const footer = { ignoreClaudeCodeFooter };
    const normalized = (text: string) => normalizedDescription(text, footer);
    const local = normalized(description);
    const onGitHub = normalized(descriptionFrom(pullRequest));
    const pushed = normalized(pushedDescription);
    const record = yield* records.read(pullRequest.number, bookmark);
    // Only a record, or GitHub's text other than the pushed one, needs the evolog where the two
    // sides differ.
    const history =
      local === onGitHub || (Option.isNone(record) && onGitHub === pushed)
        ? []
        : yield* ownHistory(bookmark, changeId);
    const age = (commit: string | undefined) =>
      history.findIndex((entry) => entry.commit === commit);
    // A pull request synced to a commit the change evolved from since the record, as another
    // clone's submit of this clone's push does, last agreed on that commit's description.
    const pushedAge = age(pushedCommit);
    const isPushedAgreedSince = (commit: string) =>
      onGitHub === pushed && pushedAge !== -1 && pushedAge < age(commit);
    const recorded = record.pipe(
      Option.filter(
        ({ commit }) => isDescribedHereFrom(history, commit) && !isPushedAgreedSince(commit),
      ),
      Option.map(({ description: text }) => normalized(text)),
    );
    const isOwnEarlier =
      onGitHub !== pushed && history.some((entry) => normalized(entry.description) === onGitHub);
    const agreed = agreedDescription({ isOwnEarlier, onGitHub, pushed, recorded });

    return yield* Match.value(descriptionSyncFor({ agreed, local, onGitHub })).pipe(
      Match.tag("InSync", () => Effect.succeed(kept(local))),
      Match.tag("TakeGitHub", () =>
        describe(onGitHub).pipe(
          Effect.andThen(
            Console.error(`took the description of #${pullRequest.number} from GitHub`),
          ),
          Effect.as(kept(onGitHub)),
        ),
      ),
      Match.tag("SendLocal", () => Effect.succeed(sent(local))),
      Match.tag("Merge", () =>
        Effect.gen(function* () {
          if (overwriteDescriptions) {
            return sent(local);
          }
          const merged = yield* git.mergeText({ base: agreed, local, remote: onGitHub });
          if (merged.conflicted) {
            return yield* new DescriptionConflict({
              message: [
                `the description of ${bookmark} changed here and in #${pullRequest.number}, in the same lines:`,
                "",
                merged.text,
                "",
                `Write the one to keep with \`jj describe -r ${bookmark}\`, then run \`jj gh submit --overwrite-descriptions\`.`,
              ].join("\n"),
            });
          }
          yield* describe(merged.text);
          return sent(merged.text);
        }),
      ),
      Match.exhaustive,
    );
  });
