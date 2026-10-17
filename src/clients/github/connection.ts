import { Config, Effect, FileSystem, Option, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Git } from "../git";
import { Jj } from "../jj";
import { GitHubFailed } from "./client";

/** A proxy that requests to api.github.com go through, with the certificate authorities to trust. */
export interface Proxy {
  /** PEM certificates trusted in place of the system's, where there are any. */
  readonly ca: Option.Option<string>;
  readonly url: string;
}

/** How requests reach api.github.com: the token they carry, and the proxy they go through. */
export interface Connection {
  readonly proxy: Option.Option<Proxy>;
  readonly token: Redacted.Redacted;
}

/** The jj config key that says where the token comes from. */
export const authKey = "jj-octo.github-auth";

/**
 * The token for api.github.com: `GH_TOKEN` or `GITHUB_TOKEN` where the environment sets one,
 * and otherwise executes `gh auth token` to generate one.
 */
const ownToken = Effect.gen(function* () {
  const fromEnvironment = yield* Config.option(
    Config.Redacted("GH_TOKEN").pipe(Config.orElse(() => Config.Redacted("GITHUB_TOKEN"))),
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
    const git = yield* Git;
    // Git exits 1 for a setting it has no value for.
    const value = (yield* git
      .read(["config", "--get-urlmatch", name, "https://github.com"])
      .pipe(Effect.orElseSucceed(() => ""))).trim();
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
      message: `${authKey} is git-proxy, but git has no http.proxy for https://github.com`,
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
  const connection: Connection = {
    proxy: Option.some({ ca, url: url.value }),
    token: Redacted.make("proxy-injected"),
  };
  return connection;
});

/**
 * Reads `jj-octo.github-auth` from the jj config. `token`, the default, sends the user's own
 * token. `git-proxy` sends requests through git's proxy for github.com, which adds the
 * credentials, as in a sandbox that keeps the token outside it.
 */
export const connection: Effect.Effect<
  Connection,
  GitHubFailed,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  const jj = yield* Jj;
  // Jj fails for a key that has no value.
  const auth = (yield* jj
    .read(["config", "get", authKey])
    .pipe(Effect.orElseSucceed(() => ""))).trim();
  switch (auth) {
    case "":
    case "token": {
      const own: Connection = { proxy: Option.none(), token: yield* ownToken };
      return own;
    }
    case "git-proxy": {
      return yield* gitProxy;
    }
    default: {
      return yield* new GitHubFailed({
        message: `${authKey} is ${JSON.stringify(auth)}; set it to token or git-proxy`,
      });
    }
  }
});
