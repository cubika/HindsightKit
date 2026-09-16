import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { joinSession } from "@github/copilot-sdk/extension";

const logPath =
  process.env.PROVENLOOP_F0_EXTENSION_LOG ??
  join(tmpdir(), "provenloop-f0-extension-events.jsonl");
const mode = process.env.PROVENLOOP_F0_EXTENSION_MODE ?? "baseline";
const delayMs = Number.parseInt(
  process.env.PROVENLOOP_F0_EXTENSION_DELAY_MS ?? "500",
  10,
);

const pending = [];
let drainScheduled = false;
let writeChain = Promise.resolve();
let faultInjected = false;

function queueRecord(record) {
  pending.push(record);
  if (!drainScheduled) {
    drainScheduled = true;
    setImmediate(drain);
  }
}

function drain() {
  drainScheduled = false;
  if (pending.length === 0) {
    return;
  }

  const batch = pending.splice(0, pending.length);
  const body = `${batch.map((record) => JSON.stringify(record)).join("\n")}\n`;
  writeChain = writeChain.then(async () => {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, body, "utf8");
  });

  if (pending.length > 0 && !drainScheduled) {
    drainScheduled = true;
    setImmediate(drain);
  }
}

async function flush() {
  while (pending.length > 0 || drainScheduled) {
    if (drainScheduled) {
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      drain();
    }
  }
  await writeChain;
}

function summarizeData(data) {
  const value = data ?? {};
  return {
    dataKeys: Object.keys(value).sort(),
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    success: value.success,
    messageId: value.messageId,
    turnId: value.turnId,
    reason: value.reason,
  };
}

function injectFault(event) {
  const eventType = event.type;
  if (mode === "baseline" || faultInjected || eventType !== "user.message") {
    return;
  }

  faultInjected = true;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `${JSON.stringify({
      kind: "probe.fault_injected",
      mode,
      eventId: event.id,
      eventType,
      configuredDelayMs: mode === "delay" ? delayMs : null,
      timestamp: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  if (mode === "delay") {
    const startedAt = performance.now();
    const deadline = startedAt + delayMs;
    while (performance.now() < deadline) {
      // The failure mode intentionally blocks only the Extension process.
    }
    appendFileSync(
      logPath,
      `${JSON.stringify({
        kind: "probe.fault_completed",
        mode,
        eventId: event.id,
        eventType,
        elapsedMs: performance.now() - startedAt,
        timestamp: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
  } else if (mode === "throw") {
    throw new Error("intentional ProvenLoop F0 Extension callback failure");
  } else if (mode === "exit") {
    process.exit(42);
  }
}

async function loadInternalSessionIds() {
  const registryPath = process.env.PROVENLOOP_F0_INTERNAL_REGISTRY;
  if (!registryPath) {
    return new Set();
  }

  const content = await readFile(registryPath, "utf8");
  const sessionIds = JSON.parse(content);
  if (!Array.isArray(sessionIds) || sessionIds.some((id) => typeof id !== "string")) {
    throw new TypeError("Internal Session registry must be an array of strings.");
  }

  return new Set(sessionIds);
}

const sessionId = process.env.SESSION_ID ?? null;
const internalSessionIds = await loadInternalSessionIds();
const internal = sessionId !== null && internalSessionIds.has(sessionId);

queueRecord({
  kind: "probe.started",
  timestamp: new Date().toISOString(),
  mode,
  processId: process.pid,
  parentProcessId: process.ppid,
  sessionId,
  internal,
  internalEnvironmentMarker: process.env.PROVENLOOP_INTERNAL ?? null,
});

const session = await joinSession();

session.on((event) => {
  const callbackStartedAt = performance.now();
  try {
    if (internal) {
      queueRecord({
        kind: "probe.internal_skipped",
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
      });
      return;
    }

    const receivedAtMs = Date.now();
    const sourceTimestampMs = Date.parse(event.timestamp);
    const summary = summarizeData(event.data);

    queueRecord({
      kind: "session.event",
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      parentId: event.parentId,
      agentId: event.agentId ?? null,
      ephemeral: event.ephemeral ?? false,
      receivedAtMs,
      deliveryLatencyMs: Number.isNaN(sourceTimestampMs)
        ? null
        : Math.max(0, receivedAtMs - sourceTimestampMs),
      ...summary,
    });

    injectFault(event);
  } finally {
    queueRecord({
      kind: "probe.callback_metric",
      eventId: event.id,
      eventType: event.type,
      callbackWorkDurationMs: performance.now() - callbackStartedAt,
    });
  }
});

session.on("session.shutdown", () => {
  void flush();
});

process.on("SIGTERM", () => {
  void flush().finally(() => process.exit(0));
});
