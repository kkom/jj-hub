import { Console, Effect } from "effect";

/** What a fake console printed, in order, with the stream each line went to. */
export interface Printed {
  readonly stream: "stderr" | "stdout";
  readonly text: string;
}

export interface FakeConsole {
  readonly printed: readonly Printed[];
  /** Runs the effect with this console in place of the real one. */
  readonly provide: <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** A console that keeps what is printed to stdout and stderr. */
export const fakeConsole = (): FakeConsole => {
  const printed: Printed[] = [];
  const console: Console.Console = {
    ...globalThis.console,
    error: (...args) => {
      printed.push({ stream: "stderr", text: args.join(" ") });
    },
    log: (...args) => {
      printed.push({ stream: "stdout", text: args.join(" ") });
    },
  };
  return {
    printed,
    provide: (self) => Effect.provideService(self, Console.Console, console),
  };
};
