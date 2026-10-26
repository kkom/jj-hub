import { Config, Effect } from "effect";

/** Whether this runs in a Claude Code cloud session, which sets `CLAUDE_CODE_REMOTE` to `true`. */
export const claudeCodeCloudSession: Effect.Effect<boolean> = Effect.orDie(
  // The variable defaults to empty, and any string is valid, so reading it can't fail.
  Config.String("CLAUDE_CODE_REMOTE").pipe(
    Config.withDefault(""),
    Config.map((value) => value === "true"),
  ),
);
