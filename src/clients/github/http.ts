import { NodeHttpClient } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import type { HttpClient } from "effect/http";

import { GitHubFailed } from "./client";
import type { Proxy } from "./connection";

// Bun answers a bare `undici` import with stubs of its own, whose `ProxyAgent` ignores its
// options. The file path reaches the real package on Bun, as on Node. It loads on first use, since
// loading it takes half the start-up time of a command that doesn't call GitHub.
const loadUndici = Effect.promise(() => import("undici/index.js"));

/**
 * An HTTP client that sends every request with undici. A given proxy is used with its certificate
 * authorities trusted in place of the runtime's own. Otherwise `https_proxy` or `HTTPS_PROXY`, and
 * where both are unset `http_proxy` or `HTTP_PROXY`, names the proxy, and `NO_PROXY` the hosts
 * reached directly. Node's fetch ignores Bun's proxy option, and Bun's fetch ignores undici's,
 * while undici itself behaves the same on both.
 */
export const httpClientLayer = (
  proxy: Option.Option<Proxy>,
): Layer.Layer<HttpClient.HttpClient, GitHubFailed> =>
  NodeHttpClient.layerUndiciNoDispatcher.pipe(
    Layer.provide(
      Layer.effect(
        NodeHttpClient.Dispatcher,
        Effect.acquireRelease(
          Effect.flatMap(loadUndici, ({ EnvHttpProxyAgent, ProxyAgent }) =>
            // Undici throws for a proxy URL it can't parse.
            Effect.try({
              catch: (error) =>
                new GitHubFailed({
                  message: Option.match(proxy, {
                    onNone: () =>
                      `can't use the proxy that https_proxy, HTTPS_PROXY, http_proxy or HTTP_PROXY names: ${String(error)}`,
                    onSome: ({ url }) => `can't use git's http.proxy ${url}: ${String(error)}`,
                  }),
                }),
              try: () =>
                Option.match(proxy, {
                  onNone: () => new EnvHttpProxyAgent(),
                  onSome: ({ ca, url }) =>
                    new ProxyAgent({
                      ...Option.match(ca, {
                        onNone: () => ({}),
                        onSome: (certificates) => ({ requestTls: { ca: certificates } }),
                      }),
                      uri: url,
                    }),
                }),
            }),
          ),
          (dispatcher) => Effect.promise(() => dispatcher.destroy()),
        ),
      ),
    ),
  );
