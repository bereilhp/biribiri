#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { CodexRunner } from './codex.js';
import { runTui } from './tui.js';

function help() {
  return `biribiri — a tiny Codex chat TUI

Usage:
  biribiri [options]

Options:
  --cwd <path>    Run Codex in a different working directory
  --help, -h      Show this help
  --version, -v   Show the version
`;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(help()); return; }
  if (argv.includes('--version') || argv.includes('-v')) { console.log('0.0.1'); return; }
  const cwdIndex = argv.indexOf('--cwd');
  const cwd = cwdIndex >= 0 && argv[cwdIndex + 1] ? path.resolve(argv[cwdIndex + 1]) : process.cwd();
  const runner = deps.runner || new CodexRunner();
  await runTui({ ...deps, runner, cwd, force: deps.force });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`biribiri: ${error.message}`);
    process.exitCode = 1;
  });
}
