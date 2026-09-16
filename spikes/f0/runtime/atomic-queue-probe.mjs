import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const itemCount = Number.parseInt(process.argv[2] ?? "1000", 10);
const root = mkdtempSync(join(tmpdir(), "provenloop-queue-"));

function persistItem(sequence) {
  const id = randomUUID();
  const target = join(root, `${sequence.toString().padStart(6, "0")}-${id}.json`);
  const temporary = `${target}.tmp`;
  const body = JSON.stringify({ id, sequence, state: "pending" });

  const handle = openSync(temporary, "wx");
  try {
    writeFileSync(handle, body, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, target);

  return { target, body };
}

try {
  const replacementTarget = join(root, "replacement.json");
  writeFileSync(replacementTarget, '{"state":"pending"}', "utf8");
  const replacementTemporary = `${replacementTarget}.tmp`;
  writeFileSync(replacementTemporary, '{"state":"claimed"}', "utf8");
  renameSync(replacementTemporary, replacementTarget);

  const startedAt = performance.now();
  let finalItem;
  for (let sequence = 0; sequence < itemCount; sequence += 1) {
    finalItem = persistItem(sequence);
  }
  const elapsedMs = performance.now() - startedAt;
  const files = readdirSync(root);

  const result = {
    atomicReplacement: readFileSync(replacementTarget, "utf8"),
    itemCount,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    itemsPerSecond: Number(((itemCount * 1000) / elapsedMs).toFixed(2)),
    finalItemVerified:
      existsSync(finalItem.target) &&
      readFileSync(finalItem.target, "utf8") === finalItem.body,
    temporaryFiles: files.filter((file) => file.endsWith(".tmp")).length,
    finalFile: basename(finalItem.target),
  };

  if (
    result.atomicReplacement !== '{"state":"claimed"}' ||
    !result.finalItemVerified ||
    result.temporaryFiles !== 0
  ) {
    throw new Error(`Atomic queue probe failed: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify(result, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
