import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  join,
  resolve,
} from "node:path";
import { isRecordsResetPending } from "./record-reset.js";

import {
  WindowsNamedPipeLeaseProvider,
  type ProcessLease,
} from "./process-lease.js";
import {
  resolveWindowsProvenLoopLeaseName,
} from "./operational-paths.js";

const REGISTRY_LEASE_TIMEOUT_MS = 5_000;
const REGISTRY_RETRY_DELAY_MS = 25;
const markerSchemaVersion = 1;

export class ExtensionShutdownRequestedError extends Error {
  public override readonly name =
    "ExtensionShutdownRequestedError";

  public constructor() {
    super("ProvenLoop Extension shutdown is in progress.");
  }
}

export class ExtensionShutdownTimeoutError extends Error {
  public override readonly name =
    "ExtensionShutdownTimeoutError";

  public constructor() {
    super(
      "A ProvenLoop extension process has not stopped. Retry owned-plugin cleanup; the Copilot session does not need to be closed.",
    );
  }
}

interface ExtensionMarker {
  readonly leaseName: string;
  readonly schemaVersion: 1;
  readonly sessionDigest: string;
}

export interface ActiveExtensionRegistration {
  release(): Promise<void>;
}

export interface ExtensionShutdownBarrier {
  cancel(): Promise<void>;
}

export interface RegisterActiveExtensionOptions {
  readonly assertDataRoot?: () => Promise<void>;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });

const extensionRoot = (dataRoot: string): string =>
  join(resolve(dataRoot), "data", "extension-sessions");

const shutdownRequestPath = (dataRoot: string): string =>
  join(resolve(dataRoot), "data", "extension-shutdown-request.json");

const markerPath = (
  dataRoot: string,
  sessionDigest: string,
): string =>
  join(extensionRoot(dataRoot), `${sessionDigest}.json`);

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

const acquireRegistryLease = async (
  dataRoot: string,
): Promise<ProcessLease> => {
  const provider = new WindowsNamedPipeLeaseProvider(
    await resolveWindowsProvenLoopLeaseName(
      dataRoot,
      "extension-registry",
    ),
  );
  const deadline = Date.now() + REGISTRY_LEASE_TIMEOUT_MS;
  let lease = await provider.tryAcquire();
  while (lease === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Timed out waiting for the ProvenLoop Extension registry.",
      );
    }
    await delay(REGISTRY_RETRY_DELAY_MS);
    lease = await provider.tryAcquire();
  }
  return lease;
};

const withRegistryLease = async <T>(
  dataRoot: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const lease = await acquireRegistryLease(dataRoot);
  try {
    return await operation();
  } finally {
    await lease.release();
  }
};

const writeNewMarker = async (
  path: string,
  marker: ExtensionMarker,
): Promise<void> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(
      `${JSON.stringify(marker)}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

const readMarker = async (
  path: string,
): Promise<ExtensionMarker> => {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("schemaVersion" in parsed) ||
    !("sessionDigest" in parsed) ||
    !("leaseName" in parsed) ||
    parsed.schemaVersion !== markerSchemaVersion ||
    typeof parsed.sessionDigest !== "string" ||
    !/^[a-f0-9]{24}$/u.test(parsed.sessionDigest) ||
    typeof parsed.leaseName !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(parsed.leaseName)
  ) {
    throw new Error(
      `ProvenLoop Extension lifecycle marker is invalid: ${path}.`,
    );
  }
  return {
    leaseName: parsed.leaseName,
    schemaVersion: markerSchemaVersion,
    sessionDigest: parsed.sessionDigest,
  };
};

const activeMarkers = async (
  dataRoot: string,
): Promise<readonly {
  readonly marker: ExtensionMarker;
  readonly path: string;
}[]> => {
  const root = extensionRoot(dataRoot);
  const names = (await readdir(root))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const active: {
    readonly marker: ExtensionMarker;
    readonly path: string;
  }[] = [];
  for (const name of names) {
    const path = join(root, name);
    let marker: ExtensionMarker;
    try {
      marker = await readMarker(path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    const lease = await new WindowsNamedPipeLeaseProvider(
      marker.leaseName,
    ).tryAcquire();
    if (lease === undefined) {
      active.push({
        marker,
        path,
      });
      continue;
    }
    await lease.release();
    await unlink(path).catch((error: unknown) => {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    });
  }
  return active;
};

export const isExtensionShutdownRequested = (
  dataRoot: string,
): Promise<boolean> =>
  Promise.all([pathExists(shutdownRequestPath(dataRoot)), isRecordsResetPending(dataRoot)])
    .then(([shutdown, reset]) => shutdown || reset);

export const registerActiveExtension = async (
  dataRoot: string,
  sessionId: string,
  options: RegisterActiveExtensionOptions = {},
): Promise<ActiveExtensionRegistration> => {
  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId.length === 0) {
    throw new Error("ProvenLoop Extension session ID is required.");
  }
  const sessionDigest = createHash("sha256")
    .update(normalizedSessionId)
    .digest("hex")
    .slice(0, 24);
  const root = resolve(dataRoot);
  const path = markerPath(root, sessionDigest);
  let extensionLease: ProcessLease | undefined;
  await withRegistryLease(root, async () => {
    await options.assertDataRoot?.();
    if (await isExtensionShutdownRequested(root)) {
      throw new ExtensionShutdownRequestedError();
    }
    await mkdir(extensionRoot(root), {
      recursive: true,
    });
    const leaseName = await resolveWindowsProvenLoopLeaseName(
      root,
      `extension-session-${sessionDigest}`,
    );
    extensionLease = await new WindowsNamedPipeLeaseProvider(
      leaseName,
    ).tryAcquire();
    if (extensionLease === undefined) {
      throw new Error(
        "ProvenLoop Extension is already active for this Session.",
      );
    }
    try {
      await unlink(path).catch((error: unknown) => {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      });
      await writeNewMarker(path, {
        leaseName,
        schemaVersion: markerSchemaVersion,
        sessionDigest,
      });
      if (await isExtensionShutdownRequested(root)) {
        await unlink(path);
        await extensionLease?.release();
        extensionLease = undefined;
        throw new ExtensionShutdownRequestedError();
      }
    } catch (error) {
      await extensionLease?.release();
      extensionLease = undefined;
      throw error;
    }
  });
  let released = false;
  return {
    release: async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      await unlink(path).catch((error: unknown) => {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      });
      await extensionLease?.release();
      extensionLease = undefined;
    },
  };
};

export const beginExtensionShutdown = async (
  dataRoot: string,
): Promise<ExtensionShutdownBarrier> => {
  const root = resolve(dataRoot);
  const path = shutdownRequestPath(root);
  const registryLease = await acquireRegistryLease(root);
  try {
    await mkdir(extensionRoot(root), {
      recursive: true,
    });
    await writeFile(
      path,
      `${JSON.stringify({
        requestedAt: new Date().toISOString(),
        schemaVersion: markerSchemaVersion,
      })}\n`,
      "utf8",
    );
  } catch (error) {
    await registryLease.release();
    throw error;
  }
  let cancelled = false;
  return {
    cancel: async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      try {
        await unlink(path).catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          ) {
            throw error;
          }
        });
      } finally {
        await registryLease.release();
      }
    },
  };
};

export const waitForActiveExtensionsToStop = async (
  dataRoot: string,
  timeoutMs: number,
): Promise<void> => {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      "ProvenLoop Extension shutdown timeout must be positive.",
    );
  }
  if (!await isExtensionShutdownRequested(dataRoot)) {
    throw new Error(
      "ProvenLoop Extension shutdown was not requested.",
    );
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if ((await activeMarkers(dataRoot)).length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new ExtensionShutdownTimeoutError();
    }
    await delay(
      Math.min(
        REGISTRY_RETRY_DELAY_MS,
        Math.max(1, deadline - Date.now()),
      ),
    );
  }
};
