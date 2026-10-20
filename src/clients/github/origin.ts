import { Effect, Layer, Option } from "effect";

import { Jj } from "../jj";
import { GitHubFailed, GitHubLive } from "./client";
import { connection } from "./connection";
import { repositoryFromUrl } from "./repository";

// The GitHub repository behind the `origin` remote, which jj reads whether or not the
// workspace is a git checkout.
export const GitHubFromOrigin = Layer.unwrap(
  Effect.gen(function* () {
    const jj = yield* Jj;
    const remotes = yield* jj.read(["git", "remote", "list"]);
    const origin = remotes.split("\n").find((line) => line.startsWith("origin "));
    const repository = repositoryFromUrl(origin?.slice("origin ".length) ?? "");
    if (Option.isNone(repository)) {
      return yield* new GitHubFailed({ message: "the `origin` remote isn't a GitHub repository" });
    }
    return GitHubLive(repository.value, yield* connection);
  }),
);
