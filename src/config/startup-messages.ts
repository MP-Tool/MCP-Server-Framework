/**
 * Startup Message Buffer
 *
 * Collects warnings and errors that occur during config loading, before
 * the framework logger is initialized. After logger initialization,
 * the buffer is flushed to the real logger, in the order they occurred.
 *
 * This solves the chicken-and-egg problem where config loading
 * (which runs before the logger) may produce messages (e.g.,
 * a discarded config file, wildcard origins in production)
 * that should appear in structured logs, not just on stderr.
 *
 * Every message is also written to the console right away: if the server
 * never reaches logger initialization (crash, validation error), it is
 * still visible on stderr.
 *
 * @module config/startup-messages
 */

type StartupMessageLevel = "warn" | "error";

/** Buffered messages, oldest first */
const messages: Array<{ readonly level: StartupMessageLevel; readonly message: string }> = [];

function addStartupMessage(level: StartupMessageLevel, message: string): void {
  console[level](message);
  messages.push({ level, message });
}

/** Buffer a startup warning for later logger replay. */
export function addStartupWarning(message: string): void {
  addStartupMessage("warn", message);
}

/** Buffer a startup error the server continues after, for later logger replay. */
export function addStartupError(message: string): void {
  addStartupMessage("error", message);
}

/**
 * Replay all buffered messages through the provided logger functions, then clear the buffer.
 *
 * Typically called once during server startup after the logger is configured.
 *
 * @param log - One logger function per level
 */
export function flushStartupMessages(log: Readonly<Record<StartupMessageLevel, (message: string) => void>>): void {
  for (const { level, message } of messages) {
    log[level](message);
  }
  messages.length = 0;
}
