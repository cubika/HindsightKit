import { open, lstat } from "node:fs/promises";
import { basename, join, resolve, isAbsolute } from "node:path";
import type { CopilotSessionEvent } from "./event-mapper.js";

export async function recoverPermissionBridges(workspacePath: string | undefined, sessionId: string, receive: (event: CopilotSessionEvent) => void): Promise<void> {
  if (!workspacePath || !isAbsolute(workspacePath) || basename(resolve(workspacePath)).toLowerCase() !== sessionId.toLowerCase()) return;
  const path = join(resolve(workspacePath), "events.jsonl");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return;
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size; const start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8",0,bytesRead).split("\n");
    if (start > 0) lines.shift();
    for (const line of lines.slice(-128)) {
      try {
        const event = JSON.parse(line) as CopilotSessionEvent;
        if (["permission.requested","permission.completed","hook.start","hook.end"].includes(String(event.type)) &&
          typeof event.id === "string" && typeof event.parentId === "string" && typeof event.timestamp === "string")
          receive({id:event.id,type:event.type,parentId:event.parentId,timestamp:event.timestamp,data:{}});
      } catch { /* A partial final line will be revisited on the next bounded read. */ }
    }
  } finally { await handle.close(); }
}
