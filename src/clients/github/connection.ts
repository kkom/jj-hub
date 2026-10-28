import { Config, Effect, FileSystem, Match, Option, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { GH_TOKEN, GITHUB_TOKEN, GITHUB_AUTH, readSetting } from "../../settings";
import { type Git, gitConfig } from "../git";
import type { Jj } from "../jj";
import { GitHubFailed } from "./client";

/** A proxy that requests to api.github.com go through, with the certificate authorities to trust. */
export interface Proxy {
  /** PEM certificates trusted in place of the runtime's own, where there are any. */
  readonly ca: Option.Option<string>;
  readonly url: string;
}

/** How requests reach api.github.com: the token they carry, and the proxy they go through. */
export interface Connection {
  readonly proxy: Option.Option<Proxy>;
  readonly token: Redacted.Redacted;
}

/**
 * The token for api.github.com: `GH_TOKEN` or `GITHUB_TOKEN` where the environment sets one,
 * and otherwise executes `gh auth token` to generate one.
 */
const ownToken = Effect.gen(function* () {
  const fromEnvironment = yield* Config.option(
    Config.Redacted(GH_TOKEN.name).pipe(Config.orElse(() => Config.Redacted(GITHUB_TOKEN.name))),
  );
  if (Option.isSome(fromEnvironment)) {
    return fromEnvironment.value;
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // `gh` prints nothing and exits 1 when it isn't logged in, and the exit code isn't reported.
  const stored = (yield* spawner.string(ChildProcess.make("gh", ["auth", "token"]))).trim();
  return stored === "" ? yield* Effect.fail("no token") : Redacted.make(stored);
}).pipe(
  Effect.mapError(
    () => new GitHubFailed({ message: "no GitHub token: set GH_TOKEN, or run `gh auth login`" }),
  ),
);

/** A git setting for https://github.com, as `git config --get-urlmatch` resolves it. */
const gitSetting = (name: string) =>
  Effect.gen(function* () {
    const value = yield* gitConfig(["--get-urlmatch", name, "https://github.com"]).pipe(
      Effect.mapError(({ message }) => new GitHubFailed({ message })),
    );
    return value === "" ? Option.none<string>() : Option.some(value);
  });

/**
 * Sends requests through the proxy that git uses for github.com, trusting the CA bundle git
 * trusts for it. The proxy replaces the request's token with its own credentials, so the token
 * sent is a placeholder. Git's settings are read on each run, so a proxy that moves to a new port
 * is followed.
 */
const gitProxy = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const url = yield* gitSetting("http.proxy");
  if (Option.isNone(url)) {
    return yield* new GitHubFailed({
      message: `${GITHUB_AUTH.key} is git-proxy, but git has no http.proxy for https://github.com`,
    });
  }
  const caFile = yield* gitSetting("http.sslCAInfo");
  const ca = Option.isNone(caFile)
    ? Option.none<string>()
    : Option.some(
        yield* fs.readFileString(caFile.value).pipe(
          Effect.mapError(
            (error) =>
              new GitHubFailed({
                message: `can't read git's http.sslCAInfo ${caFile.value}: ${error.message}`,
              }),
          ),
        ),
      );
  // Git reads a proxy without a scheme as an HTTP one.
  const withScheme = /^[a-z][\d+.a-z-]*:\/\//iu.test(url.value) ? url.value : `http://${url.value}`;
  const connection: Connection = {
    proxy: Option.some({ ca, url: withScheme }),
    token: Redacted.make("proxy-injected"),
  };
  return connection;
});

/** Reads `jj-octo.github-auth`, which says how requests reach api.github.com. */
export const connection: Effect.Effect<
  Connection,
  GitHubFailed,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  const auth = yield* readSetting(GITHUB_AUTH).pipe(
    Effect.mapError(({ message }) => new GitHubFailed({ message })),
  );
  return yield* Match.value(auth).pipe(
    Match.when("token", () =>
      Effect.map(ownToken, (token): Connection => ({ proxy: Option.none(), token })),
    ),
    Match.when("git-proxy", () => gitProxy),
    Match.exhaustive,
  );
});
