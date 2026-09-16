import { rename } from "node:fs/promises";

// Windows readers and scanners can briefly deny replacement of a closed file.
// Retry the atomic replacement itself; never remove the destination first.
export const replaceFileAtomically = async (source: string, destination: string): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
};
