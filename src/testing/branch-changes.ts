import type { ScratchRepository } from "./scratch-repository";

// What GitHub does to branches by itself, done in the clone and pushed to `origin`.

/** Adds a commit to a branch, as applying a review suggestion does. */
export const addCommitOnGitHub = (
  repository: ScratchRepository,
  branch: string,
  file = "suggestion.txt",
): void => {
  repository.git("fetch", "--quiet");
  repository.git("checkout", "--quiet", "-B", branch, `origin/${branch}`);
  repository.writeOnGitHub(file, "suggestion\n");
  repository.git("add", ".");
  repository.git("commit", "--quiet", "-m", "apply a suggestion");
  repository.git("push", "--quiet", "origin", branch);
};

/** Adds a commit to `main`. */
export const moveTrunkOnGitHub = (repository: ScratchRepository, file = "trunk.txt"): void => {
  repository.git("fetch", "--quiet");
  repository.git("checkout", "--quiet", "-B", "main", "origin/main");
  repository.writeOnGitHub(file, "trunk\n");
  repository.git("add", ".");
  repository.git("commit", "--quiet", "-m", "trunk moves");
  repository.git("push", "--quiet", "origin", "main");
};

/**
 * Moves `main`, then rebases a branch onto it and force-pushes it, as the "Update branch" button
 * does. With `extra`, the rewritten commit also gets a file the branch didn't have.
 */
export const rebaseOnGitHub = (
  repository: ScratchRepository,
  branch: string,
  { extra = false }: { readonly extra?: boolean } = {},
): void => {
  moveTrunkOnGitHub(repository);
  repository.git("checkout", "--quiet", "-B", branch, `origin/${branch}`);
  repository.git("rebase", "--quiet", "main");
  if (extra) {
    repository.writeOnGitHub("extra.txt", "extra\n");
    repository.git("add", ".");
    repository.git("commit", "--quiet", "--amend", "--no-edit");
  }
  repository.git("push", "--quiet", "--force", "origin", branch);
};

/**
 * Adds a file to the change of each branch in another jj checkout, and force-pushes them. Unlike
 * a rewrite by GitHub, the rewritten commits keep the ids of the local changes.
 */
export const rewriteElsewhere = (
  repository: ScratchRepository,
  ...branches: readonly string[]
): void => {
  repository.elsewhere("git", "fetch");
  for (const branch of branches) {
    repository.elsewhere("bookmark", "track", `${branch}@origin`);
  }
  for (const branch of branches) {
    repository.elsewhere("edit", branch);
    repository.writeElsewhere(`${branch}-elsewhere.txt`, "elsewhere\n");
  }
  repository.elsewhere("git", "push", ...branches.flatMap((branch) => ["--bookmark", branch]));
};

/**
 * Squash-merges a branch into `main` as one commit, together with the branches `below` it, as
 * GitHub's stack merge does. Records each one's pull request as merged, and with `deleted` also
 * deletes the branches. Rebases the branches `above` it onto the new `main` in order, as GitHub
 * does for the rest of a stack.
 */
export const squashMergeOnGitHub = (
  repository: ScratchRepository,
  branch: string,
  {
    above = [],
    below = [],
    deleted = true,
  }: {
    readonly above?: readonly string[];
    readonly below?: readonly string[];
    readonly deleted?: boolean;
  } = {},
): void => {
  repository.git("fetch", "--quiet");
  repository.git("checkout", "--quiet", "-B", "main", "origin/main");
  repository.git("merge", "--quiet", "--squash", `origin/${branch}`);
  repository.git("commit", "--quiet", "-m", `${branch} (#1)`);
  repository.git("push", "--quiet", "origin", "main");
  for (const name of [...below, branch]) {
    repository.mergedOnGitHub(name, repository.git("rev-parse", `origin/${name}`).trim());
  }
  let previous = repository.git("rev-parse", `origin/${branch}`).trim();
  let base = "main";
  for (const name of above) {
    const pushed = repository.git("rev-parse", `origin/${name}`).trim();
    repository.git("checkout", "--quiet", "-B", name, pushed);
    repository.git("rebase", "--quiet", "--onto", base, previous, name);
    repository.git("push", "--quiet", "--force", "origin", name);
    previous = pushed;
    base = name;
  }
  if (deleted) {
    repository.git("push", "--quiet", "origin", "--delete", ...below, branch);
  }
};
