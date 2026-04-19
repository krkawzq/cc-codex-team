import { CliClient } from "./cli";
import { runDaemon } from "./daemon";

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "__daemon") {
    return await runDaemon();
  }
  return await new CliClient().run(argv);
}

void main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
