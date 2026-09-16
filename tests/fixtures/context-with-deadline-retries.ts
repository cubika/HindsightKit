const deadlineDetails = new Set([
  "Retrieval deadline expired while resolving repository identity.",
  "Retrieval deadline expired before database initialization.",
  "Retrieval deadline expired during database initialization.",
  "Retrieval deadline expired while waiting for the Session lock.",
  "Retrieval timed out.",
  "Knowledge retrieval timed out.",
  "Knowledge backend read timed out.",
]);

export const contextWithDeadlineRetries = async <T extends Readonly<Record<string, unknown>>>(
  request: () => Promise<T>,
): Promise<T> => {
  // Retry only explicit runtime deadline diagnostics; callers must still assert genuine success.
  for (let attempt = 0; ; attempt += 1) {
    const context = await request();
    if (
      attempt >= 4 ||
      context.status !== "degraded" ||
      typeof context.statusDetail !== "string" ||
      !deadlineDetails.has(context.statusDetail.replace(/^Error: /u, ""))
    ) {
      return context;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
};
