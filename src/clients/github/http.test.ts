import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";
import { HttpClient, HttpClientError } from "effect/http";

import { throughProxy } from "../../testing/intercepting-proxy";
import { removeScratchRepositories } from "../../testing/scratch-repository";
import { GitHubFailed } from "./client";
import { httpClientLayer } from "./http";

afterAll(removeScratchRepositories);

const url = "https://api.github.com/repos/owner/name";

describe("httpClientLayer", () => {
  it("sends requests through the proxy, trusting its certificate authorities", async () => {
    const received = await throughProxy(
      "api.github.com",
      (request) => request,
      (proxy) => {
        const layer = httpClientLayer(Option.some({ ca: Option.some(proxy.ca), url: proxy.url }));
        const body = HttpClient.get(url).pipe(Effect.flatMap((response) => response.json));
        return Effect.runPromise(body.pipe(Effect.provide(layer)));
      },
    );
    expect(received).toStrictEqual({
      log: ["CONNECT api.github.com:443", "GET api.github.com/repos/owner/name"],
      result: { method: "GET", path: "/repos/owner/name" },
    });
  });

  it("fails where the proxy's certificate authority isn't trusted", async () => {
    const received = await throughProxy(
      "api.github.com",
      (request) => request,
      (proxy) => {
        const layer = httpClientLayer(Option.some({ ca: Option.none(), url: proxy.url }));
        const failure = Effect.flip(HttpClient.get(url)).pipe(
          Effect.map((error) => error.reason instanceof HttpClientError.TransportError),
        );
        return Effect.runPromise(failure.pipe(Effect.provide(layer)));
      },
    );
    expect(received).toStrictEqual({
      log: ["CONNECT api.github.com:443"],
      result: true,
    });
  });

  it("fails with GitHubFailed for a proxy URL undici can't parse", async () => {
    const layer = httpClientLayer(Option.some({ ca: Option.none(), url: "http://[proxy" }));
    const error = await Effect.runPromise(
      Effect.flip(HttpClient.get(url).pipe(Effect.provide(layer))),
    );
    expect(error).toStrictEqual(
      new GitHubFailed({
        message: "can't use git's http.proxy http://[proxy: TypeError: Invalid URL",
      }),
    );
  });
});
