export interface ParsedCliArgs {
  command: string | null;
  flags: Record<string, string | boolean | string[]>;
  positional: string[];
}

const LONG_VALUE_FLAGS = new Set([
  'ref',
  'project-root',
  'env-file',
  'env',
  'max-bytes',
  'idempotency-key',
  'poll-interval-ms',
  'provider',
  'output-dir',
  'workspace',
  'deployment',
  'format',
  'out',
  'severity-threshold',
  'max-findings',
  'summarize-session',
  'intent-token-budget',
  'model',
]);
const OPTIONAL_VALUE_FLAGS = new Set([
  'commit',
]);
const SHORT_VALUE_FLAGS = new Set<string>();

function appendFlagValue(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  value: string | boolean
): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
    return;
  }

  if (typeof value === 'boolean') {
    flags[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(value);
    flags[key] = existing;
    return;
  }

  if (typeof existing === 'string') {
    flags[key] = [existing, value];
    return;
  }

  flags[key] = value;
}

export function parseArgs(args: string[]): ParsedCliArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);

      if (LONG_VALUE_FLAGS.has(key)) {
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          appendFlagValue(flags, key, args[++i]);
          continue;
        }

        throw new Error(`Missing value for --${key}`);
      } else if (OPTIONAL_VALUE_FLAGS.has(key)) {
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          appendFlagValue(flags, key, args[++i]);
        } else {
          appendFlagValue(flags, key, true);
        }
      } else {
        appendFlagValue(flags, key, true);
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);

      if (SHORT_VALUE_FLAGS.has(key)) {
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          appendFlagValue(flags, key, args[++i]);

          continue;
        }

        throw new Error(`Missing value for -${key}`);
      } else if (key === 'h') {
        appendFlagValue(flags, 'help', true);
      } else if (key === 'v') {
        appendFlagValue(flags, 'version', true);
      } else {
        appendFlagValue(flags, key, true);
      }
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}
