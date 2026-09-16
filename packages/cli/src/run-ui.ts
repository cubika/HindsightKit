import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, readdir, stat } from "node:fs/promises";
import { readCopilotAdapterState, resolveAutomaticLearning } from "@provenloop/copilot-adapter";
import { createServer, type IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import {
  isRecordsResetPending, isUpgradeMaintenanceActive, resolveWindowsProvenLoopPaths,
  resolveWindowsProvenLoopLeaseName, WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import { readInspection } from "@provenloop/storage-sqlite";
import { redactPotentialSecrets } from "@provenloop/domain";
import { escapeHtml, recordsResetControl, renderUiPage, uiCss, uiLayout } from "./ui-page.js";
import { applyUiKnowledgeAction, UiActionError } from "./ui-actions.js";
import { resetAllRecords } from "./reset-records.js";
import { readLearningReadiness, type LearningReadiness } from "./run-learning.js";

export interface UiServerOptions { readonly dataRoot: string; readonly port?: number }
export interface UiServer { readonly url: string; readonly close: () => Promise<void> }

const readForm = async (request: IncomingMessage): Promise<URLSearchParams> => {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) throw new UiActionError("Use an action form from this explorer.", 415);
  if (Number(request.headers["content-length"] ?? 0) > 32_768) throw new UiActionError("The form is too large.", 413);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length; if (bytes > 32_768) throw new UiActionError("The form is too large.", 413); chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
};

const storageBytes = async (path: string): Promise<number> => {
  let total = 0;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try { total += (await stat(file)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return total;
};

const installationSummary = async (path: string, dataRoot: string, includeReadiness: boolean): Promise<{ summary: string; readiness?: LearningReadiness }> => {
  try {
    await access(path);
    const state = await readCopilotAdapterState(path, new Date());
    const capabilities = (["capture", "worker", "retrieval", "correction_learning"] as const).map((name) =>
      `${name.replaceAll("_", " ")}: ${state.capabilities?.[name]?.enabled === true ? "on" : state.capabilities?.[name]?.enabled === false ? "off" : "unknown"}`);
    const learning = resolveAutomaticLearning(state);
    capabilities.push(`automatic learning: ${learning.enabled ? `on (${learning.mode})` : `off (${learning.blockedBy.join(", ")})`}`);
    return { summary: capabilities.join(" · "), ...(includeReadiness ? { readiness: await readLearningReadiness(state, { dataRoot }) } : {}) };
  } catch { return { summary: "Installation state could not be read. Check provenloop status." }; }
};

export const startUiServer = async (options: UiServerOptions): Promise<UiServer> => {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("UI port must be between 0 and 65535.");
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  const base = `/${randomBytes(32).toString("hex")}/`;
  const csrfToken = randomBytes(32).toString("hex");
  let origin = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status: number, body: string, contentType = "text/html; charset=utf-8"): void => {
      response.statusCode = status; response.setHeader("Content-Type", contentType);
      response.end(request.method === "HEAD" ? undefined : body);
    };
    const handle = async (): Promise<void> => {
      if (request.headers.host !== new URL(origin).host ||
        (request.headers.origin !== undefined && request.headers.origin !== origin) ||
        request.headers["sec-fetch-site"] === "cross-site") { send(403, "Forbidden"); return; }
      if (!request.url?.startsWith(base) || request.url.length > 4096) { send(404, "Not found"); return; }
      const url = new URL(request.url, origin);
      if (!url.pathname.startsWith(base)) { send(404, "Not found"); return; }
      const actionRoute = url.pathname.slice(base.length).match(/^knowledge\/([^/]+)\/actions$/u);
      const resetRoute = url.pathname === `${base}records/reset`;
      if (request.method !== "GET" && request.method !== "HEAD" && !(request.method === "POST" && (actionRoute || resetRoute))) {
        response.setHeader("Allow", "GET, HEAD"); send(405, "Use an explicit action form from this explorer."); return;
      }
      const context = { base, dataRoot: paths.root, url, csrfToken };
      if (url.pathname === `${base}style.css`) { send(200, uiCss, "text/css; charset=utf-8"); return; }
      const leases = [];
      try {
        let form: URLSearchParams | undefined;
        if (request.method === "POST") {
          if (request.headers.origin !== origin || (request.headers["sec-fetch-site"] !== undefined && request.headers["sec-fetch-site"] !== "same-origin")) { send(403, "Forbidden"); return; }
          form = await readForm(request);
          const supplied = Buffer.from(form.get("csrf") ?? ""); const expected = Buffer.from(csrfToken);
          if (form.getAll("csrf").length !== 1 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(403, "Invalid form token. Reload the page."); return; }
        }
        await access(paths.rootMarker);
        if (form && resetRoute) {
          const allowed = new Set(["csrf", "confirmed", "confirmationText"]);
          for (const key of form.keys()) if (!allowed.has(key) || form.getAll(key).length !== 1) throw new UiActionError("Unexpected or duplicate reset form field.");
          if (form.get("confirmed") !== "clear" || form.get("confirmationText") !== "CLEAR") throw new UiActionError("Type CLEAR and select the confirmation checkbox before clearing all records.");
          // Reset owns its worker drain and storage leases, including recovery of a pending reset.
          const result = await resetAllRecords({ dataRoot: paths.root, confirmed: true, confirmationText: "CLEAR" });
          if (result.status !== "cleared") throw new Error("Record cleanup has not completed. Retry the reset.");
          response.setHeader("Location", `${base}?notice=cleared`); send(303, "All ProvenLoop records were cleared."); return;
        }
        if (await isRecordsResetPending(paths.root)) {
          send(503, uiLayout(context, "Record cleanup pending", `<h1>Record cleanup pending</h1><p>Records are unavailable until the pending cleanup completes. Retry the same reset to finish it.</p>${recordsResetControl(context)}`)); return;
        }
        if (await isUpgradeMaintenanceActive(paths.root)) throw new Error("An upgrade is in progress. Refresh when it finishes.");
        // Use existing maintenance leases; never keep a database handle between requests.
        for (const [root, purpose] of [[paths.root, "knowledge-projection"], [dirname(paths.database), "canonical-restore"]] as const) {
          const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(root, purpose)).tryAcquire();
          if (!lease) throw new Error("Storage is busy with another operation. Refresh in a moment.");
          leases.push(lease);
        }
        if (await isRecordsResetPending(paths.root)) throw new Error("Record cleanup started. Refresh after it finishes.");
        if (await isUpgradeMaintenanceActive(paths.root)) throw new Error("An upgrade is in progress. Refresh when it finishes.");
        if (form && actionRoute?.[1]) {
          // Validate storage without migrations before opening the write service.
          readInspection(paths.database, () => undefined);
          const location = await applyUiKnowledgeAction(paths, decodeURIComponent(actionRoute[1]), form);
          response.setHeader("Location", `${base}${location}`); send(303, "Knowledge action saved."); return;
        }
        const installation = await installationSummary(paths.adapterState, paths.root, url.pathname === base);
        let queueDepth: number | undefined;
        try { queueDepth = (await readdir(join(paths.queue, ".active"), { withFileTypes: true })).filter((entry) => entry.isFile()).length; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const runtime = { databaseBytes: await storageBytes(paths.database), knowledgeBytes: await storageBytes(paths.knowledgeDatabase), ...(queueDepth === undefined ? {} : { queueDepth }) };
        const page = readInspection(paths.database, (reader) => renderUiPage(reader, { ...context, runtime,
          ...(installation.readiness === undefined ? {} : { readiness: installation.readiness }) }, installation.summary));
        send(page.status, page.html);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to read local records.";
        const friendly = message.includes("ENOENT") ? "No ProvenLoop installation found at this data location. Check --data-root." : message;
        const actionError = request.method === "POST";
        const status = error instanceof UiActionError ? error.status : actionError ? 409 : 503;
        const title = actionError ? "Action could not be completed" : "Data unavailable";
        send(status, uiLayout(context, title, `<h1>${title}</h1><section class="panel error-panel"><p>${escapeHtml(redactPotentialSecrets(friendly))}</p><p class="mono">${escapeHtml(paths.root)}</p>${actionRoute?.[1] ? `<a href="${base}knowledge/${encodeURIComponent(decodeURIComponent(actionRoute[1]))}">Reload knowledge review</a> · ` : ""}<a href="${base}">Retry overview</a></section>${resetRoute ? recordsResetControl(context) : ""}`));
      } finally { for (const lease of leases.reverse()) await lease.release(); }
    };
    void handle().catch(() => { if (!response.headersSent) send(500, "Unable to display this page."); else response.destroy(); });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { reject(error); };
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", failed); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve UI address.");
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}${base}`, close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
};

const openBrowser = async (url: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === "win32"
      ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("The browser could not be opened.")));
  });
};

export const runUi = async (options: UiServerOptions & { readonly open: boolean }, io: { log(message: string): void; error(message: string): void }): Promise<void> => {
  const viewer = await startUiServer(options);
  io.log(`ProvenLoop local explorer: ${viewer.url}\nEvidence is read only. Knowledge actions require review and confirmation. Press Ctrl+C to stop.`);
  const stopped = new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
      void viewer.close().then(resolve, (error: unknown) => { io.error(String(error)); resolve(); });
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
  if (options.open) {
    try { await openBrowser(viewer.url); } catch { io.error("Open the viewer URL above in your browser."); }
  }
  await stopped;
};
