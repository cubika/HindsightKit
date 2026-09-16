import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CanonicalSqliteStore } from "../../packages/storage-sqlite/dist/index.js";

describe("bundled UI command", () => {
  it("serves an installed data root through the built CLI and shuts down cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-ui-cli-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(join(root, "data"));
      await writeFile(join(root, ".provenloop-root.json"), "{}");
      new CanonicalSqliteStore(join(root, "data", "provenloop.db")).close();
      child = spawn(process.execPath, [resolve("packages/cli/dist/bin.js"), "ui", "--no-open", "--port", "0", "--data-root", root], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const processHandle = child;
      const exited = once(processHandle, "exit");
      const url = await new Promise<string>((resolveReady, reject) => {
        let output = ""; let errorOutput = "";
        const timeout = setTimeout(() => reject(new Error(`UI startup timed out: ${errorOutput}`)), 10_000);
        processHandle.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const match = /http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\//u.exec(output);
          if (match) { clearTimeout(timeout); resolveReady(match[0]); }
        });
        processHandle.stderr?.on("data", (chunk: Buffer) => { errorOutput += chunk.toString(); });
        processHandle.once("error", (error) => { clearTimeout(timeout); reject(error); });
        processHandle.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`UI exited before startup (${code}): ${errorOutput}`)); });
      });
      const response = await fetch(url);
      expect(response.status).toBe(200); expect(await response.text()).toContain("Knowledge cards");
      const style = await fetch(`${url}style.css`);
      expect(style.status).toBe(200); expect(await style.text()).toContain("grid-template-columns");
      processHandle.kill("SIGTERM");
      await exited;
      await expect(fetch(url)).rejects.toThrow();
      child = undefined;
    } finally {
      if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
      const relativeRoot = relative(resolve(tmpdir()), resolve(root));
      assert(relativeRoot && !relativeRoot.startsWith("..") && !resolve(root).endsWith(".."));
      await rm(root, { recursive: true, force: true });
    }
  });
});
