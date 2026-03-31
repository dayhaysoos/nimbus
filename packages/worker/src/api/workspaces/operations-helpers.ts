export function sanitizeErrorMessage(input: string): string {
  return input
    .replace(/x-access-token:[^@\s]+@/gi, 'x-access-token:[REDACTED]@')
    .replace(/(authorization:\s*bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/ghs_[a-z0-9_]+/gi, '[REDACTED_TOKEN]');
}
