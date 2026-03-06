export interface DeployCheckpointOptions {
  ref?: string;
  projectRoot?: string;
  runTestsIfPresent: boolean;
  runLintIfPresent: boolean;
  watch: boolean;
  dryRun: boolean;
  envFiles: string[];
  explicitEnv: Map<string, string>;
}

type FlagValue = string | boolean | string[];
type FlagRecord = Record<string, FlagValue>;

function readStringFlag(flags: FlagRecord, key: string): string | undefined {
  const raw = flags[key];
  if (typeof raw === 'string') {
    const value = raw.trim();
    return value ? value : undefined;
  }

  if (Array.isArray(raw)) {
    for (let index = raw.length - 1; index >= 0; index--) {
      const value = raw[index].trim();
      if (value) {
        return value;
      }
    }

    return undefined;
  }

  return undefined;
}

function toFlagEntries(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => entry.trim()).filter(Boolean);
}

function splitCommaEntries(entries: string[]): string[] {
  return entries.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
}

function parseExplicitEnvValues(entries: string[]): Map<string, string> {
  const values = new Map<string, string>();

  for (const entry of entries) {
    const splitIndex = entry.indexOf('=');
    if (splitIndex <= 0) {
      throw new Error(`Invalid --env entry "${entry}". Expected KEY=VALUE.`);
    }

    const key = entry.slice(0, splitIndex).trim();
    const value = entry.slice(splitIndex + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid --env key "${key}" in entry "${entry}".`);
    }

    values.set(key, value);
  }

  return values;
}

export function resolveDeployCheckpointOptions(flags: FlagRecord): DeployCheckpointOptions {
  const envFlag = flags.env;
  const envEntries = toFlagEntries(
    Array.isArray(envFlag) ? envFlag : typeof envFlag === 'string' ? envFlag : undefined
  );

  const envFileFlag = flags['env-file'];
  const envFiles = splitCommaEntries(
    toFlagEntries(
    Array.isArray(envFileFlag) ? envFileFlag : typeof envFileFlag === 'string' ? envFileFlag : undefined
    )
  );

  return {
    ref: readStringFlag(flags, 'ref'),
    projectRoot: readStringFlag(flags, 'project-root'),
    runTestsIfPresent: !Boolean(flags['no-tests']),
    runLintIfPresent: !Boolean(flags['no-lint']),
    watch: !Boolean(flags['no-watch']),
    dryRun: !Boolean(flags['no-dry-run']),
    envFiles,
    explicitEnv: parseExplicitEnvValues(envEntries),
  };
}
