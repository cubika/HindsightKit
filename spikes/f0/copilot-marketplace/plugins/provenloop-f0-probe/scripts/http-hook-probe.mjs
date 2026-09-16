import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = "127.0.0.1";
const port = 43119;
const logPath =
  process.env.PROVENLOOP_F0_HTTP_HOOK_LOG ??
  join(tmpdir(), "provenloop-f0-http-hooks.jsonl");

function log(record) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ timestamp: Date.now(), ...record })}\n`,
    "utf8",
  );
}

function validatePayload(path, payload) {
  const errors = [];
  const requireType = (field, type) => {
    if (typeof payload?.[field] !== type) {
      errors.push(`${field}:${type}`);
    }
  };
  const requireField = (field) => {
    if (!Object.hasOwn(payload ?? {}, field)) {
      errors.push(`${field}:present`);
    }
  };

  requireType("sessionId", "string");
  requireType("timestamp", "number");
  requireType("cwd", "string");

  switch (path) {
    case "/hooks/sessionStart":
      requireType("source", "string");
      if (
        payload?.initialPrompt !== undefined &&
        typeof payload.initialPrompt !== "string"
      ) {
        errors.push("initialPrompt:string");
      }
      break;
    case "/hooks/userPromptSubmitted":
      requireType("prompt", "string");
      break;
    case "/hooks/preToolUse":
      requireType("toolName", "string");
      requireField("toolArgs");
      break;
    case "/hooks/postToolUse":
      requireType("toolName", "string");
      requireField("toolArgs");
      if (
        payload?.toolResult?.resultType !== "success" ||
        typeof payload?.toolResult?.textResultForLlm !== "string"
      ) {
        errors.push("toolResult:success");
      }
      break;
    case "/hooks/postToolUseFailure":
      requireType("toolName", "string");
      requireField("toolArgs");
      requireType("error", "string");
      break;
    case "/hooks/agentStop":
      requireType("transcriptPath", "string");
      requireType("stopReason", "string");
      requireType("stop_hook_active", "boolean");
      break;
    case "/hooks/sessionEnd":
      requireType("reason", "string");
      break;
    default:
      errors.push("path:supported");
  }

  return errors;
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const payload = body ? JSON.parse(body) : null;
    const internal = request.headers["x-provenloop-internal"] ?? null;
    const validationErrors = validatePayload(request.url, payload);

    if (internal === "1") {
      log({
        event: "discardedInternal",
        method: request.method,
        path: request.url,
        internal,
        payloadTimestamp: payload?.timestamp ?? null,
        valid: validationErrors.length === 0,
        validationErrors,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }

    log({
      event: "hook",
      method: request.method,
      path: request.url,
      internal,
      payload,
      valid: validationErrors.length === 0,
      validationErrors,
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ ready: true, host, port, pid: process.pid }));
});

function shutdown(signal) {
  log({ event: "shutdown", signal, pid: process.pid });
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
