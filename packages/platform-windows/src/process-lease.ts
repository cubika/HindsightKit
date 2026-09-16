import { createServer, type Server } from "node:net";

export interface ProcessLease {
  release(): Promise<void>;
}

export interface ProcessLeaseProvider {
  tryAcquire(): Promise<ProcessLease | undefined>;
}

export const windowsNamedPipePath = (name: string): string => {
  const safeName = name.replaceAll(/[^A-Za-z0-9_-]/gu, "-");
  if (safeName.length === 0) {
    throw new Error("Named pipe lease name must be non-empty.");
  }
  return `\\\\.\\pipe\\provenloop-${safeName}`;
};

export class WindowsNamedPipeLeaseProvider
implements ProcessLeaseProvider {
  readonly #path: string;

  public constructor(name: string) {
    this.#path = windowsNamedPipePath(name);
  }

  public tryAcquire(): Promise<ProcessLease | undefined> {
    const server = createServer();
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        if (error.code === "EADDRINUSE") {
          resolve(undefined);
          return;
        }
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve(new WindowsNamedPipeLease(server));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#path);
    });
  }
}

class WindowsNamedPipeLease implements ProcessLease {
  #released = false;
  readonly #server: Server;

  public constructor(server: Server) {
    this.#server = server;
  }

  public release(): Promise<void> {
    if (this.#released) {
      return Promise.resolve();
    }
    this.#released = true;
    return new Promise((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
