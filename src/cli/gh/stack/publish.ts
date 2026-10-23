import { Array as EffectArray, Console, Data, Effect, Match, Option } from "effect";

import type { Git, GitFailed } from "../../../clients/git";
import { GitHub, type GitHubFailed } from "../../../clients/github/client";
import type { PullRequestNumber, RemoteStack } from "../../../clients/github/types";
import { Jj, type JjFailed } from "../../../clients/jj";
import {
  bookmarkTargets,
  changesIn,
  downstackChanges,
  type NotAStack,
  type StackChange,
  stackChanges,
  stackRevset,
} from "./changes";
import {
  type DescriptionConflict,
  descriptionsOf,
  ignoresClaudeCodeFooter,
  syncDescription,
} from "./descriptions";
import { basesFor, mustDissolve, registrationFor, titleAndBody } from "./plan";
import { checkedTrunk, type TrunkMismatch } from "./trunk";

export class SeveralStacks extends Data.TaggedError("SeveralStacks")<{
  readonly message: string;
}> {}

/** The one GitHub stack containing any of the pull requests, if there is one. */
const stackContaining = (pullRequests: readonly PullRequestNumber[]) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const found = yield* Effect.all(
      pullRequests.map((pullRequest) => github.stackOf(pullRequest)),
      { concurrency: "unbounded" },
    );
    const stacks = EffectArray.dedupeWith(
      found.flatMap((stack) => Option.toArray(stack)),
      (a, b) => a.number === b.number,
    );
    if (stacks.length > 1) {
      return yield* new SeveralStacks({
        message: `the pull requests belong to stacks ${stacks.map(({ number }) => `#${number}`).join(" and ")}; unstack all but one`,
      });
    }
    return Option.fromNullishOr(stacks[0]);
  });

/** Makes the pull requests, bottom to top, the open part of one GitHub stack. */
const register = (
  remaining: Option.Option<RemoteStack>,
  pullRequests: readonly PullRequestNumber[],
) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    yield* Match.value(registrationFor(remaining, pullRequests)).pipe(
      Match.tag("Unchanged", () => Effect.void),
      Match.tag("Append", ({ pullRequests: added, stack }) =>
        github
          .addToStack(stack, added)
          .pipe(Effect.andThen(Console.error(`added ${added.join(", ")} to stack #${stack}`))),
      ),
      Match.tag("Create", ({ pullRequests: all }) =>
        github
          .createStack(all)
          .pipe(Effect.flatMap((stack) => Console.error(`registered stack #${stack}`))),
      ),
      Match.exhaustive,
    );
  });

interface PublishOptions {
  /** GitHub's default branch, which the bottom pull request is based on. */
  readonly trunk: string;
  /** How a missing pull request is opened. It changes no existing one. */
  readonly draft: boolean;
  /** Sends the local description where it and the pull request's both changed, without merging. */
  readonly overwriteDescriptions: boolean;
}

export type PublishFailed =
  | DescriptionConflict
  | GitFailed
  | GitHubFailed
  | JjFailed
  | NotAStack
  | SeveralStacks
  | TrunkMismatch;

/**
 * Pushes the changes' bookmarks, opens the pull requests missing, sets their bases, and registers
 * them as one stack. Each pull request's title and body are kept the same as its change's
 * description.
 */
const publish = (
  stack: readonly StackChange[],
  { draft, overwriteDescriptions, trunk }: PublishOptions,
): Effect.Effect<void, PublishFailed, Git | GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const jj = yield* Jj;
    const bookmarks = stack.map(({ bookmark }) => bookmark);
    const bases = basesFor(bookmarks, trunk);
    const found = yield* Effect.all(
      stack.map((change, index) =>
        github
          .openPullRequest(change.bookmark)
          .pipe(
            Effect.map((pullRequest) => ({ base: bases[index] ?? trunk, change, pullRequest })),
          ),
      ),
      { concurrency: "unbounded" },
    );
    const targets = yield* bookmarkTargets;
    const pushedDescriptions = yield* descriptionsOf(
      bookmarks.flatMap((bookmark) => targets.get(bookmark)?.origin ?? []),
    );
    const ignoreClaudeCodeFooter = yield* ignoresClaudeCodeFooter;

    // Before anything changes on GitHub, so a conflict in a description stops the whole submit.
    // One at a time, because rewording a change rewrites the ones above it.
    const changes = [];
    for (const entry of found) {
      const pushed = targets.get(entry.change.bookmark)?.origin;
      changes.push({
        ...entry,
        description: Option.isNone(entry.pullRequest)
          ? Option.none<string>()
          : yield* syncDescription(entry.change, entry.pullRequest.value, {
              ignoreClaudeCodeFooter,
              overwriteDescriptions,
              pushedDescription:
                (pushed === undefined ? undefined : pushedDescriptions.get(pushed)) ?? "",
            }),
      });
    }

    // GitHub rejects a base change on a pull request that is in a stack, and can only add to a
    // stack's top, so a stack that doesn't fit what is wanted is dissolved first.
    const moving = changes.flatMap(({ base, pullRequest }) =>
      Option.isSome(pullRequest) && pullRequest.value.base !== base ? [pullRequest.value] : [],
    );
    const wanted = changes.map(({ pullRequest }) =>
      Option.isSome(pullRequest) ? Option.some(pullRequest.value.number) : Option.none(),
    );
    const existing = yield* stackContaining(wanted.flatMap((number) => Option.toArray(number)));
    const dissolve = mustDissolve(existing, wanted, moving.length > 0);
    if (dissolve && Option.isSome(existing)) {
      yield* github.unstack(existing.value.number);
      yield* Console.error(`dissolved stack #${existing.value.number}`);
    }

    // GitHub closes a pull request as merged once its head is reachable from its base, and pushing
    // a pull request that moved below its old base does exactly that. Pointing it at the trunk first
    // prevents this, because its branch still has commits the trunk doesn't have.
    for (const { number } of moving.filter(({ base }) => base !== trunk)) {
      yield* github.setBase(number, trunk);
    }
    const moved = new Set(moving.map(({ number }) => number));

    // Jj only creates a branch on the remote for a bookmark that tracks it.
    for (const bookmark of bookmarks.filter((name) => targets.get(name)?.tracked !== true)) {
      yield* jj.run(["bookmark", "track", `exact:${bookmark}`, "--remote", "origin"]);
    }
    yield* jj.run([
      "git",
      "push",
      ...bookmarks.flatMap((bookmark) => ["--bookmark", `exact:${bookmark}`]),
    ]);

    const numbers = [];
    for (const { base, change, description, pullRequest } of changes) {
      if (Option.isNone(pullRequest)) {
        const created = yield* github.createPullRequest({
          ...titleAndBody(change.description),
          base,
          draft,
          head: change.bookmark,
        });
        yield* Console.error(`opened #${created} for ${change.bookmark}`);
        numbers.push(created);
      } else {
        const { number } = pullRequest.value;
        if (moved.has(number) && base !== trunk) {
          yield* github.setBase(number, base);
        }
        if (Option.isSome(description)) {
          yield* github.setDescription(number, titleAndBody(description.value));
          yield* Console.error(`updated the description of #${number}`);
        }
        numbers.push(number);
      }
    }

    yield* register(dissolve ? Option.none() : existing, numbers);
  });

/** Publishes the revision's change and the ones below it in its stack. */
export const submit = (
  revision: string,
  options: Omit<PublishOptions, "trunk">,
): Effect.Effect<void, PublishFailed, Git | GitHub | Jj> =>
  Effect.gen(function* () {
    const trunk = yield* checkedTrunk;
    yield* publish(yield* downstackChanges(revision), { ...options, trunk });
  });

/**
 * Publishes the stack containing the revision again, up to the highest bookmark already pushed, so
 * local work above it stays unpublished. Does nothing when the stack has no changes left or was
 * never pushed.
 */
export const republish = (
  revision: string,
  trunk: string,
): Effect.Effect<void, PublishFailed, Git | GitHub | Jj> =>
  Effect.gen(function* () {
    if ((yield* changesIn(stackRevset(revision))).length === 0) {
      return;
    }
    const stack = yield* stackChanges(revision);
    const targets = yield* bookmarkTargets;
    const top = stack.findLastIndex(({ bookmark }) => targets.get(bookmark)?.origin !== undefined);
    if (top !== -1) {
      yield* publish(stack.slice(0, top + 1), { draft: true, overwriteDescriptions: false, trunk });
    }
  });
