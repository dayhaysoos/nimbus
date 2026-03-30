import type { ParsedCliArgs } from '../../lib/args.js';

type CliFlags = ParsedCliArgs['flags'];

export function parseSummarizeSessionFlag(flags: CliFlags): 'auto' | 'always' | 'never' | undefined {
  const summarizeSessionFlag = flags['summarize-session'];
  if (typeof summarizeSessionFlag !== 'string') {
    return undefined;
  }
  if (summarizeSessionFlag === 'auto' || summarizeSessionFlag === 'always' || summarizeSessionFlag === 'never') {
    return summarizeSessionFlag;
  }
  throw new Error('Invalid --summarize-session value. Use auto, always, or never.');
}

export function parseDeployProviderFlag(flags: CliFlags): 'simulated' | 'cloudflare_workers_assets' | undefined {
  const providerFlag = flags.provider;
  if (typeof providerFlag !== 'string') {
    return undefined;
  }
  if (providerFlag === 'simulated' || providerFlag === 'cloudflare_workers_assets') {
    return providerFlag;
  }
  throw new Error('Invalid --provider value. Use simulated or cloudflare_workers_assets.');
}
