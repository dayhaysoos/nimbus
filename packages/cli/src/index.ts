#!/usr/bin/env node

import * as p from '@clack/prompts';
import { loadNimbusEnv } from './bootstrap/load-env.js';
import { normalizeCliArgs } from './cli/argv.js';
import { showHelp, VERSION } from './cli/help.js';
import { parseArgs } from './lib/args.js';

loadNimbusEnv();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const normalized = normalizeCliArgs(args);
  try {
    const { command, flags, positional } = parseArgs(normalized.args);

    if (flags.version || flags.v) {
      console.log(`nimbus v${VERSION}`);
      process.exit(0);
    }

    if (flags.help || flags.h || !command) {
      showHelp();
      process.exit(command ? 0 : 1);
    }

    p.intro('@dayhaysoos/nimbus');

    if (normalized.changed) {
      p.log.warning('Detected smart punctuation in arguments; normalized to ASCII equivalents.');
    }

    const { dispatchCliCommand } = await import('./cli/dispatch.js');
    await dispatchCliCommand({ command, flags, positional });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

main();
