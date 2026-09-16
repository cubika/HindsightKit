import {
  readFile,
} from "node:fs/promises";
import {
  isAbsolute,
  resolve,
} from "node:path";
import {
  joinSession,
} from "@github/copilot-sdk/extension";

const localAppData = process.env.LOCALAPPDATA?.trim();
if (!localAppData) {
  throw new Error("LOCALAPPDATA is required to run ProvenLoop.");
}

const locatorPath = resolve(
  localAppData,
  "ProvenLoopIntegration",
  "runtime.json",
);
const runtime = JSON.parse(
  await readFile(locatorPath, "utf8"),
);
if (
  runtime.product !== "ProvenLoopRuntime" ||
  runtime.schemaVersion !== 1 ||
  runtime.version !== "0.1.0-alpha.0.16" ||
  typeof runtime.dataRoot !== "string" ||
  !isAbsolute(runtime.dataRoot) ||
  typeof runtime.extensionModuleUrl !== "string" ||
  !runtime.extensionModuleUrl.startsWith("file:")
) {
  throw new Error(
    "The installed ProvenLoop runtime locator is invalid.",
  );
}
const {
  runProvenLoopCopilotExtension,
} = await import(runtime.extensionModuleUrl);

await runProvenLoopCopilotExtension({
  dataRoot: runtime.dataRoot,
  joinSession,
  onStopped: () => { process.exit(0); },
});
