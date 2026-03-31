export function parsePositiveIntegerFlag(value: string | boolean | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof raw !== 'string') {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.floor(parsed);
}

function normalizeCliToken(token: string): { value: string; changed: boolean } {
  let value = token;
  value = value.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  if (/^[\u2013\u2014]/.test(value)) {
    value = `--${value.slice(1)}`;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { value, changed: value !== token };
}

export function normalizeCliArgs(rawArgs: string[]): { args: string[]; changed: boolean } {
  const normalized: string[] = [];
  let changed = false;

  for (const token of rawArgs) {
    const next = normalizeCliToken(token);
    normalized.push(next.value);
    if (next.changed) {
      changed = true;
    }
  }

  return { args: normalized, changed };
}
