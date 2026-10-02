/** Ignore repeated submissions until the current operation has finished. */
export function singleFlight<Args extends unknown[], T>(
  operation: (...args: Args) => Promise<T>
): (...args: Args) => Promise<T | undefined> {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    try {
      return await operation(...args);
    } finally {
      running = false;
    }
  };
}
