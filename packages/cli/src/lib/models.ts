/**
 * Extract short model name for display (e.g., "claude-sonnet-4" from "anthropic/claude-sonnet-4")
 */
export function getShortModelName(model: string): string {
  return model.split('/').pop() || model;
}
