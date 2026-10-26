import { ConfigProvider, type Layer } from "effect";

/**
 * An environment holding only `env`, so whatever the tests run in can't change what the code
 * reads through `Config`.
 */
export const environment = (env: Readonly<Record<string, string>> = {}): Layer.Layer<never> =>
  // `fromEnv` takes a mutable record.
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...env } }));
