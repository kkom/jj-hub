import { Context, Data, Effect, Layer, Option, Schedule, type Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { Connection } from "./connection";
import { bodyOf } from "./openapi";
import type { Repository } from "./repository";
import {
  AnyPullRequests,
  CreatedPullRequest,
  CreatedStack,
  listedPullRequest,
  MergeResult,
  PullRequests,
  RepositoryDetails,
  Stacks,
  StartedMerge,
} from "./responses";
import type {
  PullRequest,
  ListedPullRequest,
  PullRequestNumber,
  RemoteStack,
  StackNumber,
} from "./types";

export class GitHubFailed extends Data.TaggedError("GitHubFailed")<{ readonly message: string }> {}

/** How a stack merge ended: merged now, or queued to merge once the queue reaches it. */
export type MergeOutcome = "enqueued" | "merged";

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly addToStack: (
      stack: StackNumber,
      pullRequests: readonly PullRequestNumber[],
    ) => Effect.Effect<void, GitHubFailed>;
    readonly createPullRequest: (pullRequest: {
      readonly base: string;
      readonly body: string;
      readonly draft: boolean;
      readonly head: string;
      readonly title: string;
    }) => Effect.Effect<PullRequestNumber, GitHubFailed>;
    readonly createStack: (
      pullRequests: readonly PullRequestNumber[],
    ) => Effect.Effect<StackNumber, GitHubFailed>;
    readonly defaultBranch: Effect.Effect<string, GitHubFailed>;
    /** Merges the pull request through its stack, together with everything below it. */
    readonly mergeStack: (
      pullRequest: PullRequestNumber,
    ) => Effect.Effect<MergeOutcome, GitHubFailed>;
    readonly mergePullRequest: (
      pullRequest: PullRequestNumber,
    ) => Effect.Effect<void, GitHubFailed>;
    readonly openPullRequest: (
      branch: string,
    ) => Effect.Effect<Option.Option<PullRequest>, GitHubFailed>;
    /** The pull requests from the branch in any state, newest first, up to 100. */
    readonly pullRequestsFrom: (
      branch: string,
    ) => Effect.Effect<readonly ListedPullRequest[], GitHubFailed>;
    readonly setBase: (
      pullRequest: PullRequestNumber,
      base: string,
    ) => Effect.Effect<void, GitHubFailed>;
    readonly setDescription: (
      pullRequest: PullRequestNumber,
      description: { readonly body: string; readonly title: string },
    ) => Effect.Effect<void, GitHubFailed>;
    readonly stackOf: (
      pullRequest: PullRequestNumber,
    ) => Effect.Effect<Option.Option<RemoteStack>, GitHubFailed>;
    /** Dissolves the stack. Its pull requests stay open. */
    readonly unstack: (stack: StackNumber) => Effect.Effect<void, GitHubFailed>;
  }
>()("jj-octo/GitHub") {}

export const GitHubLive = (
  repository: Repository,
  connection: Connection,
): Layer.Layer<GitHub, never, HttpClient.HttpClient> => {
  // A cloud session's proxy only allows paths under the repository, so every call starts there.
  const repo = (path: string): string => `/repos/${repository.owner}/${repository.name}${path}`;
  return Layer.effect(
    GitHub,
    Effect.gen(function* () {
      // Bun's fetch takes a proxy, and certificate authorities to trust in place of its own.
      const requestInit: BunFetchRequestInit = Option.match(connection.proxy, {
        onNone: () => ({}),
        onSome: ({ ca, url }) =>
          Option.match(ca, {
            onNone: () => ({ proxy: url }),
            onSome: (certificates) => ({ proxy: url, tls: { ca: certificates } }),
          }),
      });
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl("https://api.github.com"),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(connection.token),
            HttpClientRequest.setHeaders({
              "user-agent": "jj-octo",
              "x-github-api-version": "2022-11-28",
            }),
          ),
        ),
      );

      // An error response keeps GitHub's own words, since they say what to change: a 422 naming
      // the field it rejected, or the proxy naming a route a cloud session can't use.
      const send = (request: HttpClientRequest.HttpClientRequest) =>
        client.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, requestInit),
          Effect.flatMap((response) =>
            response.status < 400
              ? Effect.succeed(response)
              : response.text.pipe(
                  Effect.orElseSucceed(() => ""),
                  Effect.flatMap((text) =>
                    Effect.fail(
                      new GitHubFailed({
                        message: `${request.method} ${request.url} returned ${response.status}: ${text}`,
                      }),
                    ),
                  ),
                ),
          ),
          Effect.catchTag("HttpClientError", (error) =>
            Effect.fail(new GitHubFailed({ message: error.message })),
          ),
        );

      const json =
        <S extends Schema.Top>(schema: S) =>
        (request: HttpClientRequest.HttpClientRequest) =>
          send(request).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.catchTags({
              HttpClientError: (error) => Effect.fail(new GitHubFailed({ message: error.message })),
              SchemaError: (error) =>
                Effect.fail(
                  new GitHubFailed({
                    message: `unexpected response to ${request.url}: ${error.message}`,
                  }),
                ),
            }),
          );

      const stackOf = (pullRequest: PullRequestNumber) =>
        json(Stacks)(HttpClientRequest.get(repo(`/stacks?pull_request=${pullRequest}`))).pipe(
          Effect.map((stacks) =>
            Option.map(Option.fromNullishOr(stacks[0]), (stack) => ({
              number: stack.number,
              open: stack.pull_requests
                .filter(({ state }) => state === "open")
                .map(({ number }) => number),
            })),
          ),
        );

      const mergeRequest = (path: string) => json(MergeResult)(HttpClientRequest.get(repo(path)));

      const fromBranch = (branch: string, state: "all" | "open") =>
        repo(`/pulls?state=${state}&head=${repository.owner}:${encodeURIComponent(branch)}`);

      return {
        addToStack: (stack, pullRequests) =>
          send(
            HttpClientRequest.post(repo(`/stacks/${stack}/add`)).pipe(
              bodyOf<"pull-request-stacks/add">({ pull_requests: [...pullRequests] }),
            ),
          ).pipe(Effect.asVoid),
        createPullRequest: ({ base, body, draft, head, title }) =>
          json(CreatedPullRequest)(
            HttpClientRequest.post(repo("/pulls")).pipe(
              bodyOf<"pulls/create">({ base, body, draft, head, title }),
            ),
          ).pipe(Effect.map(({ number }) => number)),
        createStack: (pullRequests) =>
          json(CreatedStack)(
            HttpClientRequest.post(repo("/stacks")).pipe(
              bodyOf<"pull-request-stacks/create">({ pull_requests: [...pullRequests] }),
            ),
          ).pipe(Effect.map(({ number }) => number)),
        defaultBranch: json(RepositoryDetails)(HttpClientRequest.get(repo(""))).pipe(
          Effect.map(({ default_branch }) => default_branch),
        ),
        mergePullRequest: (pullRequest) =>
          send(
            HttpClientRequest.put(repo(`/pulls/${pullRequest}/merge`)).pipe(
              bodyOf<"pulls/merge">({ merge_method: "squash" }),
            ),
          ).pipe(Effect.asVoid),
        mergeStack: (pullRequest) =>
          Effect.gen(function* () {
            const started = yield* json(StartedMerge)(
              HttpClientRequest.put(repo(`/pulls/${pullRequest}/merge-async`)).pipe(
                bodyOf<"pulls/merge-async">({
                  merge_action: "default",
                  merge_method: "squash",
                }),
              ),
            );
            const { uuid } = started.details;
            if (uuid === undefined) {
              return yield* new GitHubFailed({
                message: `merging #${pullRequest} returned no request to follow`,
              });
            }
            const settled = yield* mergeRequest(`/pulls/${pullRequest}/merge-async/${uuid}`).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: ({ status }) => status !== "pending",
              }),
            );
            if (settled.status === "merged" || settled.status === "enqueued") {
              return settled.status;
            }
            return yield* new GitHubFailed({
              message: `merging #${pullRequest} ended ${settled.status}: ${settled.details.message}`,
            });
          }),
        openPullRequest: (branch) =>
          json(PullRequests)(HttpClientRequest.get(fromBranch(branch, "open"))).pipe(
            Effect.map((found) =>
              Option.map(
                Option.fromNullishOr(found[0]),
                ({ base, body, draft, number, title }) => ({
                  base: base.ref,
                  body: body ?? "",
                  draft: draft ?? false,
                  number,
                  title,
                }),
              ),
            ),
          ),
        pullRequestsFrom: (branch) =>
          json(AnyPullRequests)(
            HttpClientRequest.get(`${fromBranch(branch, "all")}&per_page=100`),
          ).pipe(Effect.map((found) => found.map((listed) => listedPullRequest(listed)))),
        setBase: (pullRequest, base) =>
          send(
            HttpClientRequest.patch(repo(`/pulls/${pullRequest}`)).pipe(
              bodyOf<"pulls/update">({ base }),
            ),
          ).pipe(Effect.asVoid),
        setDescription: (pullRequest, { body, title }) =>
          send(
            HttpClientRequest.patch(repo(`/pulls/${pullRequest}`)).pipe(
              bodyOf<"pulls/update">({ body, title }),
            ),
          ).pipe(Effect.asVoid),
        stackOf,
        unstack: (stack) =>
          send(HttpClientRequest.post(repo(`/stacks/${stack}/unstack`))).pipe(Effect.asVoid),
      };
    }),
  );
};
