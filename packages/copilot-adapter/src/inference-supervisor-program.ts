// Self-contained JavaScript: bundler helpers cannot cross the process boundary.
export const INFERENCE_SUPERVISOR_PROGRAM = String.raw`async function supervisorMain() {
    const { spawn: launch } = await import("node:child_process");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    let started = false;
    let closing = false;
    let child;
    let directory;
    let nonce = "";
    let output = "";
    let errorOutput = "";
    let poll;
    let deadline;
    let finished;
    let initializing;
    const finish = (code, terminate = false) => {
        finished ??= (async () => {
            closing = true;
            clearInterval(poll);
            clearTimeout(deadline);
            await initializing?.catch(() => undefined);
            if (terminate && child?.pid && child.exitCode === null) {
                if (process.platform === "win32") {
                    await new Promise((done) => {
                        const killer = launch("taskkill.exe", ["/PID", String(child?.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
                        const timer = setTimeout(() => { killer.kill(); done(); }, 3000);
                        killer.once("error", () => { clearTimeout(timer); done(); });
                        killer.once("close", () => { clearTimeout(timer); done(); });
                    });
                }
                else {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch { /* Already exited. */ }
                }
                try { child.kill("SIGKILL"); } catch {} await new Promise((done) => { if (child?.exitCode !== null)
                    done();
                else {
                    child?.once("close", () => done());
                    setTimeout(done, 2000).unref();
                } });
            }
            let cleanup = true;
            if (directory) {
                try {
                    const marker = JSON.parse(await fs.readFile(path.join(directory, ".provenloop-inference.json"), "utf8"));
                    if (marker.nonce !== nonce)
                        throw new Error("Ownership changed.");
                    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
                }
                catch {
                    cleanup = false;
                }
            }
            if (process.connected)
                await new Promise((done) => { process.send?.({ type: "result", exitCode: cleanup ? code : 125, stdout: cleanup ? output : "", stderr: cleanup ? errorOutput : "Inference scratch cleanup failed." }, () => done()); });
            process.exit(cleanup ? 0 : 1);
        })();
        return finished;
    };
    process.on("disconnect", () => { void finish(130, true); });
    process.on("SIGTERM", () => { void finish(130, true); });
    process.on("message", (input) => {
        if (input === null || typeof input !== "object")
            return;
        const message = input;
        if (message.type === "cancel") {
            void finish(130, true);
            return;
        }
        if (message.type !== "start" || started || closing)
            return;
        started = true;
        initializing = (async () => {
            const root = path.resolve(message.root ?? "");
            const target = path.resolve(message.directory ?? "");
            if (!target.startsWith(root + path.sep) || !/^learning-[A-Za-z0-9]+$/u.test(path.basename(target)) || typeof message.nonce !== "string" || !message.executable || !Array.isArray(message.args))
                throw new Error("Invalid supervisor request.");
            await fs.mkdir(target);
            directory = target;
            nonce = message.nonce;
            await fs.writeFile(path.join(target, ".provenloop-inference.json"), JSON.stringify({ schemaVersion: 1, product: "ProvenLoop", nonce, supervisorPid: process.pid, root, directory: target }), { flag: "wx" });
            if (closing)
                return;
            child = launch(message.executable, message.args, { cwd: target, env: { ...process.env, ...message.environment }, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
            child.stdout?.on("data", (data) => { output = (output + data.toString()).slice(0, 32768); });
            child.stderr?.on("data", (data) => { errorOutput = (errorOutput + data.toString()).slice(0, 8192); });
            child.once("error", () => { errorOutput = "Inference child could not start."; void finish(127); });
            child.once("close", (code) => { void finish(code ?? 1); });
            poll = setInterval(() => { void fs.readFile(path.join(target, ".cancel-inference"), "utf8").then((value) => value === nonce ? finish(130, true) : undefined).catch(() => undefined); }, 100);
            deadline = setTimeout(() => { void finish(124, true); }, Math.min(message.timeoutMs ?? 45000, 60000));
        })();
        void initializing.catch(() => { errorOutput = "Inference supervisor initialization failed."; void finish(127, true); });
    });
    setTimeout(() => { if (!started)
        void finish(124); }, 5000).unref();
}
;supervisorMain();`;
