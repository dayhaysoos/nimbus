export function sessionRoute(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}
