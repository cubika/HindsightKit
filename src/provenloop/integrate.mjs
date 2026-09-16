// Preserve comments and unrelated settings when connecting the official integrations.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
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
  const [mcpPath, cliPath, configPath, apiUrl, replace] = args;
  for (const path of [mcpPath, cliPath, configPath]) read(path);
  const vs = read(mcpPath).value.servers?.hindsight;
  if (vs && !vs.args?.includes('provenloop.cli')) {
    throw new Error('Existing Hindsight endpoint differs in ' + mcpPath);
  }
  const cli = read(cliPath).value.mcpServers?.hindsight;
  if (cli && !cli.args?.includes('provenloop.cli') && !cli.args?.some(a => typeof a === 'string' && /(?:coding-agents|hindsight-coding-agents)[\\/]dist[\\/]mcp-server\.js$/.test(a))) {
    throw new Error('Existing server named hindsight is not the official coding-agents integration: ' + cliPath);
  }
  const cfg = read(configPath).value;
  if (existsSync(configPath)) {
    try { JSON.parse(readFileSync(configPath, 'utf8')); }
    catch { throw new Error('Official coding-agents requires strict JSON in ' + configPath + '. Remove comments/trailing commas/BOM before setup.'); }
  }
  if (cfg.apiUrl && cfg.apiUrl.replace(/\/$/, '') !== apiUrl && !(replace === 'replace' && cfg.provenloop)) throw new Error('Hindsight already uses another endpoint in ' + configPath);
  if (cfg.serverMode && cfg.serverMode !== 'self-hosted') throw new Error('Existing Hindsight serverMode conflicts in ' + configPath);
  if (cfg.disabled || cfg.retainSessions === false || (cfg.apiToken && !cfg.provenloop) || cfg.bankId ||
      Object.keys(cfg.harnesses ?? {}).length || Object.keys(cfg.banks ?? {}).length) {
    throw new Error('Existing Hindsight overrides disable learning or change routing/authentication in ' + configPath);
  }
  for (const bank of Object.values(cfg.mapPathToBank ?? {})) {
    if (!/^provenloop-[0-9a-f]{12}$/.test(bank)) throw new Error('An unrelated memory mapping exists in ' + configPath);
  }
} else if (action === 'vscode') {
  const [path, python, configPath] = args;
  edit(path, [[['servers', 'hindsight'], { type: 'stdio', command: python,
    args: ['-m', 'provenloop.cli', 'mcp', '--context', 'vscode'],
    ...(configPath ? { env: { HINDSIGHT_CONFIG: configPath } } : {}) }]]);
} else if (action === 'config') {
  const [path, apiUrl] = args;
  const input = readFileSync(0, 'utf8').trim();
  const settings = input ? JSON.parse(input) : {};
  const cfg = read(path).value;
  const defaults = { serverMode: 'self-hosted', apiUrl, autoUpdate: false, autoSeed: false, codebaseSurvey: false, maxParallelRetains: 2 };
  const changes = Object.entries(defaults).filter(([key]) => !(key in cfg)).map(([key, value]) => [[key], value]);
  changes.push([['optInOnly'], false], [['mapPathToBank'], undefined], [['optInPaths'], undefined]);
  changes.push([['apiUrl'], apiUrl]);
  for (const key of ['apiToken', 'provenloop']) if (key in settings) changes.push([[key], settings[key]]);
  edit(path, changes);
} else if (action === 'remove-project') {
  const [path, apiUrl, bank] = args;
  if (existsSync(path)) {
    const entry = read(path).value.servers?.hindsight;
    if (entry?.type === 'http' && entry.url === apiUrl + '/mcp/' + bank + '/' && !entry.headers) {
      edit(path, [[['servers', 'hindsight'], undefined]]);
    }
  }
} else if (action === 'install-cli') {
  const [userHome, configPath, apiUrl, nodePath, python] = args;
  const packageRoot = join(runtime, 'node_modules/@vectorize-io/hindsight-coding-agents');
  const stage = mkdtempSync(join(runtime, 'integration-'));
  // Run the official installer in staging to obtain the supported hook event wiring.
  // Merge only its entries into user config because upstream JSON.parse loses JSONC.
  process.env.HINDSIGHT_CONFIG = join(stage, '.hindsight/coding-agent.json');
  const { run } = await import(pathToFileURL(join(packageRoot, 'dist/installer.js')).href);
  const code = run(['install', 'copilot-cli', '--server', 'self-hosted', '--api-url', apiUrl], {
    home: stage, pkgRoot: packageRoot, dist: join(packageRoot, 'dist'), interactive: false,
  });
  if (code) throw new Error('Official Copilot installer failed: ' + code);
  const entry = read(join(stage, '.copilot/mcp-config.json')).value.mcpServers.hindsight;
  entry.command = python;
  entry.args = ['-m', 'provenloop.cli', 'mcp', '--context', 'cli'];
  entry.env = { ...entry.env, HINDSIGHT_CONFIG: configPath };
  const hooksPath = join(stage, '.copilot/hooks/hindsight-coding-agents.json');
  const hooks = read(hooksPath).value;
  const installedHookPath = join(userHome, '.copilot/hooks/hindsight-coding-agents.json');
  const oldHooks = read(installedHookPath).value.hooks ?? {};
  for (const [event, entries] of Object.entries(hooks.hooks)) {
    for (const hook of entries) {
      const match = /^node "(.+)"$/.exec(hook.command);
      if (!match) throw new Error('Unexpected official Copilot hook command.');
      hook.type = 'command';
      hook.exec = python;
      hook.args = ['-m', 'provenloop.cli', 'hook', event];
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
      return !/copilot-(?:sessionstart-|stop-)?hook\.js/.test(script) && !hook.args?.includes('provenloop.cli');
    });
    mergedHooks[event] = [...keep, ...additions];
  }
  edit(join(userHome, '.copilot/mcp-config.json'), [[['mcpServers', 'hindsight'], entry]]);
  edit(installedHookPath, [[['version'], hooks.version], [['hooks'], mergedHooks]]);
  // Retire only our unchanged copy of the upstream skill: its old tool names no longer apply.
  const skill = join(userHome, '.copilot/skills/hindsight-coding-agent/SKILL.md');
  const originalSkill = join(packageRoot, 'skill/SKILL.md');
  if (existsSync(skill) && readFileSync(skill).equals(readFileSync(originalSkill))) rmSync(skill);
  const within = relative(runtime, stage);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Invalid staging directory.');
  rmSync(stage, { recursive: true });
} else if (action === 'check') {
  const [mcpPath, configPath, python] = args;
  const vs = read(mcpPath).value.servers?.hindsight;
  const cfg = read(configPath).value;
  if (vs?.command !== python || !vs.args?.includes('provenloop.cli') ||
      cfg.optInOnly !== false || cfg.bankId || cfg.mapPathToBank) {
    throw new Error('Copilot is not configured for automatic repository routing.');
  }
} else {
  throw new Error('Unknown integration operation: ' + action);
}
