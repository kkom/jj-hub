import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { GitHubFromOrigin } from "../../clients/github/origin";
import { asUserError, revisionFlag, withHelp } from "../command";
import { submit } from "./stack/publish";

export const submitCommand = Command.make(
  "submit",
  {
    overwriteDescriptions: Flag.Boolean("overwrite-descriptions").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Where a description changed both locally and on GitHub, send the local one instead of merging the two",
      ),
    ),
    publish: Flag.Boolean("publish").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Open new pull requests ready for review, instead of as drafts"),
    ),
    revision: revisionFlag("The top change to submit"),
  },
  ({ overwriteDescriptions, publish, revision }) =>
    asUserError(
      submit(revision, { draft: !publish, overwriteDescriptions }).pipe(
        Effect.provide(GitHubFromOrigin),
      ),
    ),
).pipe(
  withHelp(
    "Push a change and the ones below it, and open their pull requests",
    "Pushes the bookmark of each of those changes. An empty working copy means the change below it, so from the top of a stack this submits all of it. Opens a pull request for each branch that has none, with the title and body from the change's description. Points each pull request at the branch below it, and the bottom one at the default branch.",
    "New pull requests are opened as drafts, or ready for review with `--publish`. The flag doesn't change a pull request that already exists.",
    "Keeps each pull request's title and body the same as its change's description. A description edited on GitHub is written into the change, one edited locally is sent to the pull request, and edits on both sides are merged line by line. Edits to the same lines stop the submit before anything is pushed.",
    "First, where any of those changes' pull requests merged or any of their branches changed on GitHub, syncs their stack as `jj gh sync` does, and leaves other stacks alone. That drops the merged changes, takes what GitHub added to the branches, and rebases the rest onto the trunk, so the push doesn't undo GitHub's work.",
    "Stops before changing anything where one of their branches was deleted on GitHub and their change doesn't count as merged: no pull request from it merged, another commit merged, or the change was edited since. It says how to push the change again, or drop it.",
    "Registers the pull requests as one GitHub stack. A stack of one change is a single pull request, which GitHub has no stack for.",
    "If changes were reordered, inserted or dropped since the last submit, the GitHub stack is dissolved and registered again under a new number. The pull requests stay open, including the one of a dropped change.",
  ),
);
