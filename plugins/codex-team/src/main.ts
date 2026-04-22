import { runCli } from "./cli/run";
import { runDaemon } from "./daemon/run";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const daemonIdx = argv.indexOf("--daemon-internal");
  if (daemonIdx >= 0) {
    argv.splice(daemonIdx, 1);
    const code = await runDaemon();
    process.exit(code);
  }

  const code = await runCli(argv);
  process.exit(code);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message ?? e}\n`);
  process.exit(1);
});
