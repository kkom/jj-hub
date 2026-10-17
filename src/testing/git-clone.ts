import { writeFileSync } from "node:fs";
import path from "node:path";

import type { Layer } from "effect";

import type { Git } from "../clients/git";
import type { Jj } from "../clients/jj";
import {
  executor,
  isolatedEnv,
  layerAt,
  type ScratchRepository,
  scratchDirectory,
} from "./scratch-repository";

/**
 * A plain git clone of a repository's `origin`, with no jj repository, and git's identity, under
 * `name`, set in its own config. jj reads an empty configuration, so it has no identity of its own.
 */
export const gitClone = (
  repository: ScratchRepository,
  name = "Cloner",
): {
  readonly jj: (...args: readonly string[]) => string;
  readonly layer: Layer.Layer<Git | Jj>;
} => {
  const root = scratchDirectory("clone-");
  const env = isolatedEnv(root);
  writeFileSync(path.join(root, "config.toml"), "");
  const execute = executor(env);
  const checkout = path.join(root, "checkout");
  const origin = repository.git("remote", "get-url", "origin").trim();
  execute(root, ["git", "clone", "--quiet", origin, checkout]);
  execute(checkout, ["git", "config", "user.name", name]);
  execute(checkout, ["git", "config", "user.email", "cloner@example.com"]);
  return { jj: (...args) => execute(checkout, ["jj", ...args]), layer: layerAt(checkout, env) };
};
