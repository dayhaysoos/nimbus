export function buildWorkerName(jobId: string): string {
  return `nimbus-${jobId}`.replace(/_/g, '-');
}
