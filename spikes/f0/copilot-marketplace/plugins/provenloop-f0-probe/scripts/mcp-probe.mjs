import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const logPath =
  process.env.PROVENLOOP_F0_MCP_LOG ??
  join(tmpdir(), "provenloop-f0-mcp.jsonl");

function log(record) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ timestamp: Date.now(), ...record })}\n`,
    "utf8",
  );
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

log({ event: "processStart", pid: process.pid });

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  log({ event: "message", method: message.method, id: message.id });

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: {
          name: "provenloop-f0-probe",
          version: "0.0.1",
        },
      });
      break;
    case "ping":
      respond(message.id, {});
      break;
    case "tools/list":
      respond(message.id, {
        tools: [
          {
            name: "echo",
            description: "Echo a value for the ProvenLoop F0 MCP probe.",
            inputSchema: {
              type: "object",
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      });
      break;
    case "tools/call":
      respond(message.id, {
        content: [
          {
            type: "text",
            text: String(message.params?.arguments?.value ?? ""),
          },
        ],
      });
      break;
    default:
      if (message.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
  }
});

input.on("close", () => {
  log({ event: "stdinClosed", pid: process.pid });
});

process.on("exit", (code) => {
  log({ event: "processExit", pid: process.pid, code });
});
