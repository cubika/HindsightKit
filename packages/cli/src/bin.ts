#!/usr/bin/env node

import { runCli } from "./run-cli.js";

process.exitCode = await runCli(process.argv.slice(2));
