export interface ReviewRunExecutionOptions {
  cochangeGithubToken?: string | null;
  providerApiKey?: string | null;
  openrouterApiKey?: string | null;
  allowRetryScheduling?: boolean;
  abortSignal?: AbortSignal;
}
