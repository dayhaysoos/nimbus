import { createHash } from 'crypto';

export interface ParsedEnvTemplate {
  requiredKeys: string[];
  optionalKeys: string[];
}

export interface EnvTemplateFile {
  path: string;
  content: string;
}

export type EnvValueSource = 'explicit' | 'local' | 'process';

export interface ResolvedEnvValue {
  value: string;
  source: EnvValueSource;
}

export interface EnvPreflightResult {
  values: ReadonlyMap<string, ResolvedEnvValue>;
  missingRequiredKeys: string[];
}

export interface ResolveEnvPreflightInput {
  requiredKeys: string[];
  optionalKeys: string[];
  explicitEnv: ReadonlyMap<string, string>;
  localEnv: ReadonlyMap<string, string>;
  processEnv: ReadonlyMap<string, string>;
}

const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ENV_TEMPLATE_BASENAME_REGEX = /^(\.env(\.[A-Za-z0-9_-]+)?\.example|\.dev\.vars\.example)$/;
const LOCAL_ENV_BASENAME_REGEX = /^(\.env(\.[A-Za-z0-9_-]+)?|\.dev\.vars(\.[A-Za-z0-9_-]+)?)$/;

function getBaseName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function parseKeyValueLine(line: string): { key: string; value: string; comment: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
  const equalIndex = withoutExport.indexOf('=');
  if (equalIndex < 0) {
    return null;
  }

  const key = withoutExport.slice(0, equalIndex).trim();
  if (!ENV_KEY_REGEX.test(key)) {
    return null;
  }

  const { value, comment } = splitValueAndComment(withoutExport.slice(equalIndex + 1));
  return {
    key,
    value,
    comment,
  };
}

function splitValueAndComment(rawValue: string): { value: string; comment: string } {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (let index = 0; index < rawValue.length; index++) {
    const char = rawValue[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inDoubleQuote) {
      escapeNext = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === '#' && !inSingleQuote && !inDoubleQuote) {
      const previous = index > 0 ? rawValue[index - 1] : '';
      if (index === 0 || /\s/.test(previous)) {
        return {
          value: rawValue.slice(0, index).trim(),
          comment: rawValue.slice(index + 1).trim(),
        };
      }
    }
  }

  return {
    value: rawValue.trim(),
    comment: '',
  };
}

function parseValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function parseEnvTemplateContent(content: string): ParsedEnvTemplate {
  const required = new Set<string>();
  const optional = new Set<string>();

  for (const line of content.split(/\r?\n/)) {
    const parsed = parseKeyValueLine(line);
    if (!parsed) {
      continue;
    }

    if (parsed.comment.toLowerCase().includes('optional')) {
      optional.add(parsed.key);
      required.delete(parsed.key);
    } else {
      required.add(parsed.key);
      optional.delete(parsed.key);
    }
  }

  return {
    requiredKeys: uniqueSorted(required),
    optionalKeys: uniqueSorted(optional),
  };
}

export function isEnvTemplatePath(path: string): boolean {
  return ENV_TEMPLATE_BASENAME_REGEX.test(getBaseName(path));
}

export function isLocalEnvPath(path: string): boolean {
  const baseName = getBaseName(path);
  if (!LOCAL_ENV_BASENAME_REGEX.test(baseName)) {
    return false;
  }

  return !baseName.endsWith('.example');
}

export function parseEnvFileContent(content: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const line of content.split(/\r?\n/)) {
    const parsed = parseKeyValueLine(line);
    if (!parsed) {
      continue;
    }

    values.set(parsed.key, parseValue(parsed.value));
  }

  return values;
}

export function collectEnvTemplates(templateFiles: EnvTemplateFile[]): ParsedEnvTemplate {
  const required = new Set<string>();
  const optional = new Set<string>();

  for (const templateFile of templateFiles) {
    const parsed = parseEnvTemplateContent(templateFile.content);

    for (const key of parsed.requiredKeys) {
      required.add(key);
      optional.delete(key);
    }

    for (const key of parsed.optionalKeys) {
      if (!required.has(key)) {
        optional.add(key);
      }
    }
  }

  return {
    requiredKeys: uniqueSorted(required),
    optionalKeys: uniqueSorted(optional),
  };
}

export function resolveEnvPreflight(input: ResolveEnvPreflightInput): EnvPreflightResult {
  const values = new Map<string, ResolvedEnvValue>();
  const allKeys = uniqueSorted([...input.requiredKeys, ...input.optionalKeys]);

  for (const key of allKeys) {
    if (input.explicitEnv.has(key)) {
      values.set(key, {
        value: input.explicitEnv.get(key) ?? '',
        source: 'explicit',
      });
      continue;
    }

    if (input.localEnv.has(key)) {
      values.set(key, {
        value: input.localEnv.get(key) ?? '',
        source: 'local',
      });
      continue;
    }

    if (input.processEnv.has(key)) {
      values.set(key, {
        value: input.processEnv.get(key) ?? '',
        source: 'process',
      });
    }
  }

  const missingRequiredKeys = input.requiredKeys.filter((key) => !values.has(key)).sort((a, b) => a.localeCompare(b));

  return {
    values,
    missingRequiredKeys,
  };
}

export function computeEnvFingerprint(values: ReadonlyMap<string, string>): string {
  const normalized = Array.from(values.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}\u0000${value}`)
    .join('\u0001');

  return createHash('sha256').update(normalized).digest('hex');
}
