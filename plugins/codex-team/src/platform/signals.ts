export function installShutdownSignalHandlers(onSignal: (name: string) => void): () => void {
  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const signal of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
    const handler = () => onSignal(signal);
    process.once(signal, handler);
    handlers.push([signal, handler]);
  }
  if (process.platform !== "win32") {
    const handler = () => onSignal("SIGHUP");
    process.once("SIGHUP", handler);
    handlers.push(["SIGHUP", handler]);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}
