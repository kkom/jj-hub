import type { Effect } from "effect";

import { type SubmitFailed, submit } from "../cli/gh/stack/publish";
import { fakeGitHub, inRepository, openPullRequest, stackOf } from "./fake-github";
import { pushedStack, type ScratchRepository } from "./scratch-repository";

/** Submits the revision in the repository, against the fake GitHub. */
export const submitIn = (
  repository: ScratchRepository,
  github: ReturnType<typeof fakeGitHub>,
  {
    draft = true,
    env = {},
    overwriteDescriptions = false,
    revision = "@",
  }: {
    readonly draft?: boolean;
    /** The environment the submit runs in. */
    readonly env?: Readonly<Record<string, string>>;
    readonly overwriteDescriptions?: boolean;
    readonly revision?: string;
  } = {},
): Effect.Effect<void, SubmitFailed> =>
  submit(revision, { draft, overwriteDescriptions }).pipe(inRepository(repository, github, env));

/** The revision's description. */
export const description = (repository: ScratchRepository, revision: string): string =>
  repository.jj("log", "--no-graph", "-r", revision, "-T", "description").trimEnd();

/** A stack of `a` and `b`, pushed with `a` described as three paragraphs. */
export const pushed = (): ScratchRepository => {
  const repository = pushedStack("a", "b");
  repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond");
  repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
  return repository;
};

/** A fake GitHub with pull requests #1 for `a`, with the title and body, and #2 for `b`. */
export const githubWith = (title: string, body: string): ReturnType<typeof fakeGitHub> =>
  fakeGitHub(
    { a: { ...openPullRequest("main", 1, title), body }, b: openPullRequest("a", 2, "b") },
    stackOf(1, 2),
  );
