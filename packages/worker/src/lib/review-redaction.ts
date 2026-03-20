const GITHUB_TOKEN_PATTERN = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/g;
const POLICY_PREFIX_PATTERN = /^(prohibition|risk focus)\s*:/i;
const POLICY_LIST_ITEM_PATTERN = /^(-|\d+[.):-]?)/;
const POLICY_MAX_CHARS = 180;

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

export function extractPolicyItemsFromIntentContext(lines: string[]): string[] {
  return lines
    .map((item) => item.trim())
    .filter((item) => POLICY_PREFIX_PATTERN.test(item))
    .filter((item) => !/[?]\s*$/.test(item))
    .filter((item) => !POLICY_LIST_ITEM_PATTERN.test(item))
    .filter((item) => item.length <= POLICY_MAX_CHARS)
    .map((item) => redactReviewText(item) ?? '')
    .map((item) => item.trim())
    .filter(Boolean);
}
