import { createServer } from "node:http";
import { performance } from "node:perf_hooks";

const sampleCount = Number.parseInt(process.argv[2] ?? "200", 10);
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const samples = [];

try {
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const startedAt = performance.now();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/hooks/sessionStart`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    await response.text();
    samples.push(performance.now() - startedAt);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

samples.sort((left, right) => left - right);
const percentile = (value) =>
  samples[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)];

const result = {
  sampleCount,
  medianMs: Number(percentile(0.5).toFixed(2)),
  p95Ms: Number(percentile(0.95).toFixed(2)),
  p99Ms: Number(percentile(0.99).toFixed(2)),
  meetsTenMillisecondBudget: percentile(0.95) <= 10,
};

if (!result.meetsTenMillisecondBudget) {
  throw new Error(`HTTP Hook benchmark failed: ${JSON.stringify(result)}`);
}

console.log(JSON.stringify(result, null, 2));
