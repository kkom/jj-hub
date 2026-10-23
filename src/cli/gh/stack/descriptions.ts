import { Console, Data, Effect, Match, Option } from "effect";

import { Git, type GitFailed } from "../../../clients/git";
import type { PullRequest } from "../../../clients/github/types";
import { Jj, type JjFailed, jjFlag } from "../../../clients/jj";
import { bookmarkRevset, lines, parseDescription, readLog, type StackChange } from "./changes";
import { descriptionFrom, descriptionSyncFor, normalizedDescription } from "./plan";

export class DescriptionConflict extends Data.TaggedError("DescriptionConflict")<{
  readonly message: string;
}> {}

interface DescriptionOptions {
  readonly ignoreClaudeCodeFooter: boolean;
  readonly overwriteDescriptions: boolean;
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

/**
 * Each description the change has had, its current one included, read from its evolog. The evolog
 * also holds commits squashed into the change, which belong to other changes, so only commits with
 * the change's id count. That also leaves out what a change had before `jj split` gave it a new id.
 */
const ownDescriptions = (
  bookmark: string,
  changeId: string,
): Effect.Effect<readonly string[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const output = yield* jj.read([
      "evolog",
      "--no-graph",
      "-r",
      bookmarkRevset(bookmark),
      "-T",
      String.raw`commit.change_id() ++ "\t" ++ commit.description().escape_json() ++ "\n"`,
    ]);
    return lines(output).flatMap((line) => {
      const [change = "", json = '""'] = line.split("\t");
      return change === changeId ? [parseDescription(json)] : [];
    });
  });

/**
 * Makes a change's description and its pull request's title and body the same text. An edit made
 * on GitHub alone is written into the change here. Any other difference returns the description
 * to send to GitHub once the bookmark is pushed.
 *
 * Who changed the description is read against the text both sides last agreed on. That's the
 * description of the commit last pushed, unless the pull request has a description the change had
 * before. A push made without `submit`, such as `jj git push`, leaves the pull request with that
 * earlier text, which nobody edited on GitHub. A bookmark never pushed has no pushed description,
 * and an empty text is merged from.
 */
export const syncDescription = (
  { bookmark, changeId, description }: StackChange,
  pullRequest: PullRequest,
  { ignoreClaudeCodeFooter, overwriteDescriptions, pushedDescription }: DescriptionOptions,
): Effect.Effect<Option.Option<string>, DescriptionConflict | GitFailed | JjFailed, Git | Jj> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const jj = yield* Jj;
    const describe = (text: string) =>
      jj.run(["describe", "-r", bookmarkRevset(bookmark), "-m", text]);
    const local = normalizedDescription(description, { ignoreClaudeCodeFooter });
    const onGitHub = normalizedDescription(descriptionFrom(pullRequest), {
      ignoreClaudeCodeFooter,
    });
    const pushed = normalizedDescription(pushedDescription, { ignoreClaudeCodeFooter });
    // The evolog is read only where GitHub's text is neither side's current one.
    const isOwnEarlier =
      local !== onGitHub &&
      onGitHub !== pushed &&
      (yield* ownDescriptions(bookmark, changeId)).some(
        (text) => normalizedDescription(text, { ignoreClaudeCodeFooter }) === onGitHub,
      );
    if (isOwnEarlier) {
      return Option.some(local);
    }

    return yield* Match.value(descriptionSyncFor({ local, onGitHub, pushed })).pipe(
      Match.tag("InSync", () => Effect.succeed(Option.none<string>())),
      Match.tag("TakeGitHub", () =>
        describe(onGitHub).pipe(
          Effect.andThen(
            Console.error(`took the description of #${pullRequest.number} from GitHub`),
          ),
          Effect.as(Option.none<string>()),
        ),
      ),
      Match.tag("SendLocal", () => Effect.succeed(Option.some(local))),
      Match.tag("Merge", () =>
        Effect.gen(function* () {
          if (overwriteDescriptions) {
            return Option.some(local);
          }
          const merged = yield* git.mergeText({ base: pushed, local, remote: onGitHub });
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
          return Option.some(merged.text);
        }),
      ),
      Match.exhaustive,
    );
  });
