import { Effect, Option } from "effect";

import type { NotCombined } from "../cli/gh/stack/reconcile";
import { sync } from "../cli/gh/sync";
import type { GitHubFailed } from "../clients/github/client";
import type { JjFailed } from "../clients/jj";
import { fakeGitHub, inRepository } from "./fake-github";
import type { ScratchRepository } from "./scratch-repository";

/** Syncs the repository, with GitHub reporting the pull requests `squashMergeOnGitHub` merged. */
export const syncing = (
  repository: ScratchRepository,
): Effect.Effect<void, GitHubFailed | JjFailed | NotCombined> =>
  sync().pipe(
    inRepository(
      repository,
      fakeGitHub({}, Option.none(), { pullRequestsFrom: repository.pullRequestsFrom }),
    ),
  );

export const syncIn = (repository: ScratchRepository): Promise<void> =>
  Effect.runPromise(syncing(repository));
