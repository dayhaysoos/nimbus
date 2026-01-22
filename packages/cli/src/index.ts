#!/usr/bin/env node

import * as p from '@clack/prompts';
import { startCommand } from './commands/start.js';
import { listCommand } from './commands/list.js';
import { watchCommand } from './commands/watch.js';

const VERSION = '0.1.0';

function showHelp(): void {
  console.log(`
nimbus - AI-powered website generator

Usage:
  nimbus <command> [options]

Commands:
  start <prompt>     Create a new website from a prompt
  list               List all past jobs
  watch <job-id>     Watch a job's progress

Options:
  -m, --model <id>   Specify model for start command (skips picker)
  -h, --help         Show this help message
  -v, --version      Show version

Examples:
  nimbus start "Build a landing page for a coffee shop"
  nimbus start -m openai/gpt-4o "Build a portfolio site"
  nimbus list
  nimbus watch job_abc123

Environment Variables:
  NIMBUS_WORKER_URL  Worker URL (required) - Your self-hosted Nimbus worker

Self-hosting: https://github.com/dayhaysoos/nimbus#self-hosting-guide
`);
}

function parseArgs(args: string[]): {
  command: string | null;
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Check if next arg is a value (not another flag)
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      // Handle short flags
      if (key === 'm' && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags['model'] = args[++i];
      } else if (key === 'h') {
        flags['help'] = true;
      } else if (key === 'v') {
        flags['version'] = true;
      } else {
        flags[key] = true;
      }
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, flags, positional } = parseArgs(args);

  // Handle version flag
  if (flags.version || flags.v) {
    console.log(`nimbus v${VERSION}`);
    process.exit(0);
  }

  // Handle help flag
  if (flags.help || flags.h || !command) {
    showHelp();
    process.exit(command ? 0 : 1);
  }

  p.intro('@dayhaysoos/nimbus');

  try {
    switch (command) {
      case 'start': {
        // Get prompt from positional args
        const prompt = positional.join(' ').trim();
        if (!prompt) {
          p.log.error('Missing prompt. Usage: nimbus start "your prompt"');
          process.exit(1);
        }
        await startCommand(prompt, { model: flags.model as string | undefined });
        break;
      }

      case 'list': {
        await listCommand();
        break;
      }

      case 'watch': {
        const jobId = positional[0];
        if (!jobId) {
          p.log.error('Missing job ID. Usage: nimbus watch <job-id>');
          process.exit(1);
        }
        await watchCommand(jobId);
        break;
      }

      default: {
        p.log.error(`Unknown command: ${command}`);
        p.log.info('Run "nimbus --help" for usage information.');
        process.exit(1);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

main();
