import { runSessionEndHook } from "./sessionEnd";
import { runSessionStartHook } from "./sessionStart";

export async function runHook(argv: string[]): Promise<number> {
  const action = argv[0] || "";
  if (action === "session-start") {
    return await runSessionStartHook();
  }
  if (action === "session-end") {
    return await runSessionEndHook();
  }
  process.stderr.write("usage: codex-team hook <session-start|session-end>\n");
  return 2;
}
