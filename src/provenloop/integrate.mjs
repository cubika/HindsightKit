// Preserve comments and unrelated settings when connecting the official integrations.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, basename, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [runtime, action, ...args] = process.argv.slice(2);
const require = createRequire(join(runtime, 'package.json'));
const { parse, modify, applyEdits } = require('jsonc-parser');

function read(path) {
  const text = existsSync(path) ? readFileSync(path, 'utf8').replace(/^\uFEFF/, '') : '{}\n';
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid configuration: ' + path);
  }
  return { text, value };
}
function edit(path, changes) {
  const original = read(path).text;
  let text = original;
  for (const [keys, value] of changes) {
    text = applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  if (text === original) return;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !existsSync(path + '.provenloop-backup')) copyFileSync(path, path + '.provenloop-backup');
  writeFileSync(path, text, 'utf8');
}

if (action === 'preflight') {
  const [mcpPath, cliPath, configPath, apiUrl, project, bank] = args;
  for (const path of [mcpPath, cliPath, configPath]) read(path);
  const vs = read(mcpPath).value.servers?.hindsight;
  if (vs && (vs.url !== apiUrl + '/mcp/' + bank + '/' || vs.type !== 'http' || vs.headers)) {
    throw new Error('Existing Hindsight endpoint differs in ' + mcpPath);
  }
  const cli = read(cliPath).value.mcpServers?.hindsight;
  if (cli && !cli.args?.some(a => typeof a === 'string' && /(?:coding-agents|hindsight-coding-agents)[\\/]dist[\\/]mcp-server\.js$/.test(a))) {
    throw new Error('Existing server named hindsight is not the official coding-agents integration: ' + cliPath);
  }
  const cfg = read(configPath).value;
  if (existsSync(configPath)) {
    try { JSON.parse(readFileSync(configPath, 'utf8')); }
    catch { throw new Error('Official coding-agents requires strict JSON in ' + configPath + '. Remove comments/trailing commas/BOM before setup.'); }
  }
  if (cfg.apiUrl && cfg.apiUrl.replace(/\/$/, '') !== apiUrl) throw new Error('Hindsight already uses another endpoint in ' + configPath);
  if (cfg.serverMode && cfg.serverMode !== 'self-hosted') throw new Error('Existing Hindsight serverMode conflicts in ' + configPath);
  if (cfg.mapPathToBank?.[project] && cfg.mapPathToBank[project] !== bank) throw new Error('Existing project bank differs in ' + configPath);
  const harness = cfg.harnesses?.['copilot-cli'] ?? {};
  if (harness.mapPathToBank) throw new Error('A Copilot-specific path map overrides the shared map in ' + configPath + '. Use the top-level mapPathToBank.');
  const effective = { ...cfg, ...harness, ...(harness.banks?.[bank] ?? cfg.banks?.[bank]) };
  if (effective.disabled || effective.retainSessions === false || effective.apiToken || effective.bank) {
    throw new Error('Existing Hindsight overrides disable learning or change routing/authentication in ' + configPath);
  }
  if (effective.apiUrl && effective.apiUrl.replace(/\/$/, '') !== apiUrl) throw new Error('A harness/bank override changes the endpoint in ' + configPath);
  if (effective.serverMode && effective.serverMode !== 'self-hosted') throw new Error('A harness/bank override changes serverMode in ' + configPath);
  if (effective.autoReflect === false) throw new Error('Automatic memory injection is disabled in ' + configPath);
  for (const layer of [cfg, cfg.harnesses?.['copilot-cli']]) {
    for (const [mapped, target] of Object.entries(layer?.mapPathToBank ?? {})) {
      const suffix = relative(project, mapped);
      if ((!suffix || (!suffix.startsWith('..') && !isAbsolute(suffix))) && target !== bank) {
        throw new Error('A more specific project mapping uses another bank in ' + configPath);
      }
    }
  }
} else if (action === 'vscode') {
  const [path, apiUrl, bank] = args;
  edit(path, [[['servers', 'hindsight'], { type: 'http', url: apiUrl + '/mcp/' + encodeURIComponent(bank) + '/' }]]);
} else if (action === 'config') {
  const [path, project, bank, apiUrl] = args;
  const cfg = read(path).value;
  const defaults = { serverMode: 'self-hosted', apiUrl, autoUpdate: false, autoSeed: false, codebaseSurvey: false, optInOnly: true, maxParallelRetains: 2 };
  const changes = Object.entries(defaults).filter(([key]) => !(key in cfg)).map(([key, value]) => [[key], value]);
  changes.push([['mapPathToBank', project], bank]);
  edit(path, changes);
} else if (action === 'install-cli') {
  const [userHome, configPath, apiUrl, nodePath] = args;
  const packageRoot = join(runtime, 'node_modules/@vectorize-io/hindsight-coding-agents');
  const stage = mkdtempSync(join(runtime, 'integration-'));
  // Run the official installer in staging: it owns the hook protocol and skill.
  // Merge only its entries into user config because upstream JSON.parse loses JSONC.
  process.env.HINDSIGHT_CONFIG = join(stage, '.hindsight/coding-agent.json');
  const { run } = await import(pathToFileURL(join(packageRoot, 'dist/installer.js')).href);
  const code = run(['install', 'copilot-cli', '--server', 'self-hosted', '--api-url', apiUrl], {
    home: stage, pkgRoot: packageRoot, dist: join(packageRoot, 'dist'), interactive: false,
  });
  if (code) throw new Error('Official Copilot installer failed: ' + code);
  const entry = read(join(stage, '.copilot/mcp-config.json')).value.mcpServers.hindsight;
  entry.command = nodePath;
  entry.args = [join(packageRoot, 'dist/mcp-server.js')];
  entry.env = { ...entry.env, HINDSIGHT_CONFIG: configPath };
  const hooksPath = join(stage, '.copilot/hooks/hindsight-coding-agents.json');
  const hooks = read(hooksPath).value;
  const installedHookPath = join(userHome, '.copilot/hooks/hindsight-coding-agents.json');
  const oldHooks = read(installedHookPath).value.hooks ?? {};
  for (const entries of Object.values(hooks.hooks)) {
    for (const hook of entries) {
      const match = /^node "(.+)"$/.exec(hook.command);
      if (!match) throw new Error('Unexpected official Copilot hook command.');
      hook.type = 'command';
      hook.exec = nodePath;
      hook.args = [join(packageRoot, 'dist', basename(match[1]))];
      hook.timeoutSec = hook.timeout;
      hook.env = { ...hook.env, HINDSIGHT_CONFIG: configPath };
      delete hook.command;
      delete hook.timeout;
    }
  }
  // Keep any user additions in the same hook file while replacing only our scripts.
  const mergedHooks = { ...oldHooks };
  for (const [event, additions] of Object.entries(hooks.hooks)) {
    const keep = (oldHooks[event] ?? []).filter(hook => {
      const script = hook.args?.[0] ?? hook.command ?? '';
      return !/copilot-(?:sessionstart-|stop-)?hook\.js/.test(script);
    });
    mergedHooks[event] = [...keep, ...additions];
  }
  edit(join(userHome, '.copilot/mcp-config.json'), [[['mcpServers', 'hindsight'], entry]]);
  edit(installedHookPath, [[['version'], hooks.version], [['hooks'], mergedHooks]]);
  const skill = join(userHome, '.copilot/skills/hindsight-coding-agent');
  mkdirSync(dirname(skill), { recursive: true });
  cpSync(join(packageRoot, 'skill'), skill, { recursive: true });
  const within = relative(runtime, stage);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Invalid staging directory.');
  rmSync(stage, { recursive: true });
} else if (action === 'check') {
  const [mcpPath, configPath, project, bank, apiUrl] = args;
  const vs = read(mcpPath).value.servers?.hindsight;
  const cfg = read(configPath).value;
  if (vs?.url !== apiUrl + '/mcp/' + encodeURIComponent(bank) + '/' || cfg.mapPathToBank?.[project] !== bank) {
    throw new Error('Copilot Chat and CLI are not configured for the same project bank.');
  }
} else {
  throw new Error('Unknown integration operation: ' + action);
}
