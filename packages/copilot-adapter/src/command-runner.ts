import { spawn } from "node:child_process";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CommandRunOptions {
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly environment?: Readonly<
    Record<string, string | undefined>
  >;
  readonly timeoutMs?: number;
}

export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}

const MAX_OUTPUT_CHARACTERS = 1024 * 1024;

const appendBounded = (
  current: string,
  chunk: Buffer | string,
): string =>
  `${current}${String(chunk)}`.slice(0, MAX_OUTPUT_CHARACTERS);

export class SpawnCommandRunner implements CommandRunner {
  public run(
    executable: string,
    args: readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stderr = "";
      let stdout = "";
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.environment,
        },
        shell: false,
        windowsHide: true,
      });
      const abort = (): void => { child.kill(); };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      let timedOut = false;
      const timeout =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill();
            }, options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.once("error", (error) => {
        options.signal?.removeEventListener("abort", abort);
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        resolve({
          exitCode: 127,
          stderr: error.message,
          stdout,
        });
      });
      child.once("close", (exitCode) => {
        options.signal?.removeEventListener("abort", abort);
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        resolve({
          exitCode: timedOut ? 124 : exitCode ?? 1,
          stderr: timedOut
            ? "Copilot command timed out."
            : stderr,
          stdout,
        });
      });
    });
  }
}
