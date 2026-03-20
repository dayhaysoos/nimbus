const GITHUB_TOKEN_PATTERN = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/g;

export function redactReviewText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const redacted = value
    .replace(/(authorization:\s*bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(GITHUB_TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(/((?:"|')?api[_-]?key(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]')
    .replace(/((?:"|')?token(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]');
  return redacted.length > 600 ? `${redacted.slice(0, 597)}...` : redacted;
}
