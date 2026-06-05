import { appendRotatingLog } from "./rotating-log";

export interface ProcessLogger {
  log: (message: string) => void;
  fatal: (label: string, error: unknown) => void;
}

interface StderrLike {
  write: (line: string) => unknown;
  on?: (event: "error", listener: (error: NodeJS.ErrnoException) => void) => unknown;
}

interface StderrState {
  enabled: boolean;
}

const stderrStates = new WeakMap<object, StderrState>();

export function createProcessLogger(options: {
  component: string;
  logFile?: string;
  stderr?: StderrLike;
}): ProcessLogger {
  let fatalInProgress = false;
  const stderr = options.stderr ?? process.stderr;
  const stderrState = stateForStderr(stderr);

  const write = (message: string) => {
    const line = `[${new Date().toISOString()}] [${options.component}] ${message}\n`;
    if (options.logFile) {
      try {
        appendRotatingLog(options.logFile, line);
      } catch {}
    }
    if (!stderrState.enabled) return;
    try {
      stderr.write(line);
    } catch (error: any) {
      if (error?.code === "EPIPE") stderrState.enabled = false;
    }
  };

  return {
    log: write,
    fatal(label: string, error: unknown) {
      if (fatalInProgress) return;
      fatalInProgress = true;
      try {
        write(`${label}: ${safeFormatError(error)}`);
      } finally {
        fatalInProgress = false;
      }
    },
  };
}

function stateForStderr(stderr: StderrLike): StderrState {
  const key = stderr as object;
  let state = stderrStates.get(key);
  if (state) return state;

  state = { enabled: true };
  stderrStates.set(key, state);
  if (typeof stderr.on === "function") {
    stderr.on("error", (error: NodeJS.ErrnoException) => {
      if (error?.code === "EPIPE") {
        state!.enabled = false;
        return;
      }
      setTimeout(() => {
        throw error;
      }, 0);
    });
  }
  return state;
}

function safeFormatError(error: unknown): string {
  try {
    return formatError(error);
  } catch {
    return "<failed to format error>";
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "object" && error !== null && "stack" in error) {
    return String((error as { stack?: unknown }).stack);
  }
  return String(error);
}
