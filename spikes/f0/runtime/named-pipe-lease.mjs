import { createServer } from "node:net";

const pipeName = process.argv[2];
const mode = process.argv[3] ?? "hold";

if (!pipeName) {
  console.error("A named pipe path is required.");
  process.exit(2);
}

const server = createServer();

server.once("error", (error) => {
  console.error(
    JSON.stringify({
      acquired: false,
      code: error.code,
      pipeName,
    }),
  );
  process.exit(10);
});

server.listen(pipeName, () => {
  console.log(
    JSON.stringify({
      acquired: true,
      pid: process.pid,
      pipeName,
      rssBytes: process.memoryUsage().rss,
    }),
  );

  if (mode === "once") {
    server.close();
  }
});
