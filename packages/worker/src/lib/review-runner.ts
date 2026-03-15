import type {
  Env,
  ReviewContext,
  ReviewEvidenceItem,
  ReviewFinding,
  ReviewFindingSeverityV2,
  ReviewRecommendation,
  ReviewReport,
  ReviewRunResponse,
  ReviewSeverity,
} from '../types.js';
import {
  appendReviewEvent,
  claimReviewRunForExecution,
  createReviewContextBlobReference,
  generateReviewContextId,
  getReviewRun,
  getReviewCochangeCacheBatch,
  getReviewRunRequestPayload,
  getWorkspace,
  getWorkspaceArtifactById,
  getWorkspaceDeployment,
  getWorkspaceDeploymentRequestPayload,
  getWorkspaceOperation,
  getWorkspaceTask,
  listWorkspaceDeploymentEvents,
  replaceReviewFindings,
  upsertReviewCochangeCacheBatch,
  updateReviewRunStatus,
} from './db.js';
import {
  formatReviewAnalysisError,
  readWorkspaceFilesFromSourceBundle,
  runWorkspaceDeploymentAgentAnalysis,
} from './review-analysis.js';

class QueueRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueRetryError';
  }
}

class ReviewContextAssemblyError extends Error {
  code: string;
  details: string | null;

  constructor(code: string, message: string, details: string | null = null) {
    super(message);
    this.name = 'ReviewContextAssemblyError';
    this.code = code;
    this.details = details;
  }
}

const REVIEW_MAX_RETRIES = 2;
const REVIEW_SEVERITY_RANK: Record<ReviewFindingSeverityV2, number> = {
  info: 0,
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};
const DEFAULT_REVIEW_MODEL = 'sonnet-4.5';
const GITHUB_TOKEN_PATTERN = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_TOKEN_PATTERN_TEST = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/;
const LARGE_DIFF_ADVISORY_THRESHOLD = 30;
const DEFAULT_REVIEW_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
const REVIEW_STALE_GRACE_MS = 60 * 1000;

interface ReviewRunExecutionOptions {
  cochangeGithubToken?: string | null;
  allowRetryScheduling?: boolean;
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return fallback;
}

function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toTimestampMs(value: string | null): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function redactReviewText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const redacted = value
    .replace(/(authorization:\s*bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(GITHUB_TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]')
    .replace(/(token\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]');
  return redacted.length > 600 ? `${redacted.slice(0, 597)}...` : redacted;
}

function transientReviewFailure(message: string): boolean {
  return /(d1|database is locked|sqlite_busy|temporarily unavailable|connection reset)/i.test(message);
}

function isCochangeCacheError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(d1_error|sqlite|sql variables|database|too many sql variables)/i.test(message);
}

function statusFromEventType(eventType: string, payload: Record<string, unknown>): 'passed' | 'failed' | 'warning' | 'info' {
  if (eventType === 'validation_started') {
    return 'info';
  }
  if (eventType === 'deployment_provider_status' || eventType === 'deployment_provider_created') {
    const providerStatus = typeof payload.status === 'string' ? payload.status : null;
    if (providerStatus === 'succeeded') {
      return 'passed';
    }
    if (providerStatus === 'failed' || providerStatus === 'cancelled') {
      return 'failed';
    }
    return 'info';
  }
  if (eventType.includes('failed')) {
    return 'failed';
  }
  if (eventType.includes('skipped') || eventType.includes('missing') || eventType.includes('fallback')) {
    return 'warning';
  }
  if (eventType.includes('succeeded') || eventType.includes('status') || eventType.includes('started')) {
    return 'passed';
  }
  return 'info';
}

function markdownSection(title: string, items: string[]): string[] {
  if (items.length === 0) {
    return [];
  }
  return [`## ${title}`, '', ...items.map((item) => `- ${item}`), ''];
}
function buildReviewMarkdown(report: ReviewReport): string {
  const evidenceLines = report.evidence.map((item) => `${item.label} (${item.status})`);
  const provenanceLines: string[] = [];
  if (report.provenance.promptSummary) {
    provenanceLines.push(report.provenance.promptSummary);
  }
  if (report.provenance.sessionIds.length > 0) {
    provenanceLines.push(`Sessions: ${report.provenance.sessionIds.join(', ')}`);
  }
  if (report.provenance.contextResolution?.contextResolution === 'branch_fallback') {
    provenanceLines.push(
      `Context resolution: branch fallback from checkpoint ${report.provenance.contextResolution.originalCheckpointId} to ${report.provenance.contextResolution.resolvedCheckpointId} (${report.provenance.contextResolution.resolvedCommitSha.slice(0, 12)}).`
    );
  }
  if (report.provenance.coChange) {
    if (report.provenance.coChange.coChangeSkipped) {
      provenanceLines.push(
        `Co-change context skipped (${report.provenance.coChange.coChangeSkipReason ?? 'unknown_reason'}). Baseline review only; set REVIEW_CONTEXT_GITHUB_TOKEN for full quality review context.`
      );
    } else if (report.provenance.coChange.coChangeAvailable) {
      provenanceLines.push(`Co-change context included (${report.provenance.coChange.relatedFileCount} related files).`);
    } else {
      provenanceLines.push('Co-change lookup ran successfully and found no related files.');
    }
  }
  if (Array.isArray(report.provenance.advisories) && report.provenance.advisories.length > 0) {
    provenanceLines.push(...report.provenance.advisories);
  }

  const findingLines =
    report.findings.length === 0
      ? ['No actionable findings were emitted for this deployment review.']
      : report.findings.map((finding) => {
          const location = finding.locations[0]
            ? finding.locations[0].startLine !== null && finding.locations[0].endLine !== null
              ? `${finding.locations[0].filePath}:${finding.locations[0].startLine}-${finding.locations[0].endLine}`
              : finding.locations[0].filePath
            : 'deployment-level';
          return `[${finding.severity}/${finding.category}/${finding.passType}] ${finding.description} (${location})`;
        });

  return [
    '## Review Summary',
    '',
    `- Recommendation: ${report.summary.recommendation}`,
    `- Risk level: ${report.summary.riskLevel}`,
    `- Findings: ${report.findings.length}`,
    '',
    ...markdownSection('Intent', [
      report.intent.goal ?? 'No explicit goal captured.',
      ...report.intent.constraints.map((item) => `Constraint: ${item}`),
      ...report.intent.decisions.map((item) => `Decision: ${item}`),
    ]),
    ...markdownSection('Evidence', evidenceLines),
    ...markdownSection('Findings', findingLines),
    ...markdownSection('Provenance', provenanceLines),
  ]
    .join('\n')
    .trim();
}

function mergeFindings(primary: ReviewFinding[], secondary: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const merged: ReviewFinding[] = [];

  for (const finding of [...primary, ...secondary]) {
    const key = JSON.stringify(finding);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(finding);
  }

  return merged;
}

function buildHeuristicFindings(
  review: ReviewRunResponse,
  deploymentEvents: Array<{ eventType: string; payload: unknown; seq: number }>
): ReviewFinding[] {
  return deploymentEvents.flatMap<ReviewFinding>((event, index) => {
    const eventPayload = asRecord(event.payload);
    if (event.eventType === 'deployment_validation_tool_missing') {
      const step = typeof eventPayload.step === 'string' ? eventPayload.step : 'validation';
      return [
        {
          severity: 'medium',
          category: 'logic',
          passType: 'single',
          locations: [{ filePath: 'deployment', startLine: null, endLine: null }],
          description:
            typeof eventPayload.message === 'string'
              ? eventPayload.message
              : `Validation tool missing for ${step} in runtime.`,
          suggestedFix: `Install the required ${step} validation tool in the deployment runtime or disable that validation step explicitly.`,
        },
      ];
    }
    if (event.eventType === 'validation_skipped') {
      const step = typeof eventPayload.step === 'string' ? eventPayload.step : 'validation';
      return [
        {
          severity: 'low',
          category: 'style',
          passType: 'single',
          locations: [{ filePath: 'deployment', startLine: null, endLine: null }],
          description: `Nimbus skipped ${step} validation while preparing this deployment review.`,
          suggestedFix: `Run the ${step} validation in the deployment path or document why it is intentionally skipped.`,
        },
      ];
    }
    if (event.eventType === 'deployment_toolchain_unknown_fallback') {
      return [
        {
          severity: 'low',
          category: 'style',
          passType: 'single',
          locations: [{ filePath: 'deployment', startLine: null, endLine: null }],
          description: 'Deployment completed after a toolchain fallback, which may hide package-manager-specific issues.',
          suggestedFix: 'Declare an explicit package manager and lockfile so future deploys and reviews use deterministic tooling.',
        },
      ];
    }
    return [];
  });
}

function buildEvidence(
  deploymentEvents: Array<{ eventType: string; payload: unknown; seq: number }>,
  deployment: { deployedUrl: string | null },
  resultArtifact: Record<string, unknown>,
  includeValidationEvidence: boolean,
  agentEvidence?: ReviewEvidenceItem | null
): ReviewEvidenceItem[] {
  const evidence: ReviewEvidenceItem[] = includeValidationEvidence
    ? deploymentEvents
        .filter((event) => {
          return [
            'validation_started',
            'validation_skipped',
            'deployment_validation_tool_missing',
            'deployment_provider_created',
            'deployment_provider_status',
            'deployment_succeeded',
          ].includes(event.eventType);
        })
        .map((event) => ({
          id: `ev_${event.seq}`,
          type: event.eventType,
          label: event.eventType.replaceAll('_', ' '),
          status: statusFromEventType(event.eventType, asRecord(event.payload)),
          metadata: asRecord(event.payload),
        }))
    : [];

  if (includeValidationEvidence && deployment.deployedUrl) {
    evidence.push({
      id: 'ev_deployed_url',
      type: 'deploy_probe',
      label: 'Deployed URL present',
      status: 'passed',
      metadata: { url: deployment.deployedUrl },
    });
  }
  if (
    includeValidationEvidence &&
    (typeof resultArtifact.sourceBundleKey === 'string' || typeof resultArtifact.sourceSnapshotSha256 === 'string')
  ) {
    evidence.push({
      id: 'ev_artifact',
      type: 'artifact',
      label: 'Deployment artifact recorded',
      status: 'info',
      metadata: resultArtifact,
    });
  }
  if (agentEvidence) {
    evidence.push(agentEvidence);
  }

  return evidence;
}

function deriveRiskLevel(findings: ReviewFinding[], fallback: ReviewSeverity = 'low'): ReviewSeverity {
  if (findings.some((finding) => finding.severity === 'critical')) {
    return 'critical';
  }
  if (findings.some((finding) => finding.severity === 'high')) {
    return 'high';
  }
  if (findings.some((finding) => finding.severity === 'medium')) {
    return 'medium';
  }
  if (findings.some((finding) => finding.severity === 'low')) {
    return 'low';
  }
  return fallback;
}

function deriveRecommendation(findings: ReviewFinding[]): ReviewRecommendation {
  const riskLevel = deriveRiskLevel(findings);
  if (riskLevel === 'critical' || riskLevel === 'high') {
    return 'request_changes';
  }
  if (riskLevel === 'medium' || riskLevel === 'low') {
    return findings.length > 0 ? 'comment' : 'approve';
  }
  return 'approve';
}

function sanitizeIntentBlock(intent: {
  goal: string | null;
  constraints: string[];
  decisions: string[];
}): { goal: string | null; constraints: string[]; decisions: string[] } {
  return {
    goal: redactReviewText(intent.goal),
    constraints: intent.constraints.map((item) => redactReviewText(item) ?? '').filter(Boolean),
    decisions: intent.decisions.map((item) => redactReviewText(item) ?? '').filter(Boolean),
  };
}

function parseChangedPathsFromDiff(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+++ ')) {
      continue;
    }
    const raw = line.slice(4).trim();
    if (!raw || raw === '/dev/null') {
      continue;
    }
    const normalized = raw.replace(/^b\//, '').replace(/^\.\//, '').trim();
    if (!normalized || normalized === '/dev/null') {
      continue;
    }
    paths.add(normalized);
  }
  return Array.from(paths);
}

function parseDiffHunks(patch: string): Array<{ path: string; patch: string }> {
  const lines = patch.split('\n');
  const hunks: Array<{ path: string; patch: string }> = [];
  let currentPath: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentPath) {
      return;
    }
    hunks.push({
      path: currentPath,
      patch: currentLines.join('\n').trim(),
    });
  };

  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      flush();
      const raw = line.slice(4).trim();
      currentPath = raw.replace(/^b\//, '').replace(/^\.\//, '').trim();
      currentLines = [line];
      continue;
    }
    if (currentPath) {
      currentLines.push(line);
    }
  }

  flush();
  return hunks.filter((hunk) => hunk.path && hunk.path !== '/dev/null');
}

function parentDirectories(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const dirs = [''];
  let current = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index] as string;
    dirs.push(current);
  }
  return dirs;
}

const CONVENTION_PATTERNS = [
  'AGENTS.md',
  'CODE_REVIEW.md',
  'CONTRIBUTING.md',
  '.editorconfig',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'biome.json',
  'biome.jsonc',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'pyproject.toml',
  'ruff.toml',
  'mypy.ini',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
] as const;

function discoverConventionCandidates(changedPaths: string[], maxCount = 10): string[] {
  const candidates = new Set<string>();
  for (const changedPath of changedPaths) {
    const dirs = parentDirectories(changedPath);
    for (const dir of dirs) {
      for (const pattern of CONVENTION_PATTERNS) {
        const candidate = dir ? `${dir}/${pattern}` : pattern;
        candidates.add(candidate);
        if (candidates.size >= maxCount * 6) {
          return Array.from(candidates);
        }
      }
    }
  }
  return Array.from(candidates);
}

function estimateTokenCount(parts: string[]): number {
  const chars = parts.reduce((total, part) => total + part.length, 0);
  return Math.ceil(chars / 4);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stripSensitiveTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSensitiveTokenFields(item));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && GITHUB_TOKEN_PATTERN_TEST.test(value)) {
      return value.replace(GITHUB_TOKEN_PATTERN, '[REDACTED_TOKEN]');
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.entries(record).reduce<Record<string, unknown>>((result, [key, nested]) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'x-review-github-token' ||
      normalizedKey === 'review_context_github_token' ||
      normalizedKey === 'authorization'
    ) {
      return result;
    }
    result[key] = stripSensitiveTokenFields(nested);
    return result;
  }, {});
}

function resolveReviewAnalysisModel(payload: Record<string, unknown>, env: Env): string {
  const requested = readOptionalString(payload.model);
  if (requested) {
    return requested;
  }
  const reviewModel = readOptionalString(env.REVIEW_MODEL);
  if (reviewModel) {
    return reviewModel;
  }
  const agentModel = readOptionalString(env.AGENT_MODEL);
  if (agentModel) {
    return agentModel;
  }
  return DEFAULT_REVIEW_MODEL;
}

function mergeProvenance(
  deploymentProvenance: Record<string, unknown>,
  reviewProvenance: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...deploymentProvenance,
    ...reviewProvenance,
  };

  const deploymentSessionIds = parseStringArray(deploymentProvenance.sessionIds);
  const reviewSessionIds = parseStringArray(reviewProvenance.sessionIds);
  const mergedSessionIds = Array.from(new Set([...deploymentSessionIds, ...reviewSessionIds]));
  if (mergedSessionIds.length > 0) {
    merged.sessionIds = mergedSessionIds;
  }

  const deploymentIntent = parseStringArray(deploymentProvenance.intentSessionContext);
  const reviewIntent = parseStringArray(reviewProvenance.intentSessionContext);
  const mergedIntent = Array.from(new Set([...deploymentIntent, ...reviewIntent]));
  if (mergedIntent.length > 0) {
    merged.intentSessionContext = mergedIntent;
  }

  return merged;
}

function parseTouchedFilesFromMetadata(record: Record<string, unknown>): string[] {
  const candidates = [record.touchedFiles, record.touched_files, record.files_touched, record.changedFiles, record.changed_files, record.files];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const parsed = candidate
      .flatMap((item) => {
        if (typeof item === 'string') {
          return [item.trim()];
        }
        const entry = asRecord(item);
        const path = readOptionalString(entry.path);
        return path ? [path] : [];
      })
      .filter(Boolean);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
}

function parseLocalCochangeFromProvenance(value: unknown): {
  source: 'local_git';
  checkpointsRef: string;
  lookbackSessions: number;
  topN: number;
  sessionsScanned: number;
  relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
} | null {
  const record = asRecord(value);
  const source = readOptionalString(record.source);
  if (source !== 'local_git') {
    return null;
  }

  const checkpointsRef = readOptionalString(record.checkpointsRef) ?? 'entire/checkpoints/v1';
  const lookbackSessions = readOptionalNumber(record.lookbackSessions);
  const topN = readOptionalNumber(record.topN);
  const sessionsScanned = readOptionalNumber(record.sessionsScanned);
  const relatedByChangedPathRaw = asRecord(record.relatedByChangedPath);

  const relatedByChangedPath = Object.entries(relatedByChangedPathRaw).reduce<
    Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>
  >((acc, [changedPath, entries]) => {
    const key = changedPath.trim();
    if (!key || !Array.isArray(entries)) {
      return acc;
    }

    const normalized = entries
      .flatMap((entry) => {
        const item = asRecord(entry);
        const path = readOptionalString(item.path);
        const frequency = readOptionalNumber(item.frequency);
        const sessionIds = uniqueStrings(parseStringArray(item.sessionIds));
        if (!path || frequency === null || frequency <= 0) {
          return [];
        }
        return [
          {
            path,
            frequency: Math.max(1, Math.floor(frequency)),
            sessionIds,
          },
        ];
      })
      .sort((left, right) => right.frequency - left.frequency)
      .slice(0, Math.max(1, Math.min(100, Math.floor(topN ?? 20))));

    acc[key] = normalized;
    return acc;
  }, {});

  return {
    source: 'local_git',
    checkpointsRef,
    lookbackSessions: Math.max(1, Math.min(50, Math.floor(lookbackSessions ?? 5))),
    topN: Math.max(1, Math.min(100, Math.floor(topN ?? 20))),
    sessionsScanned: Math.max(0, Math.floor(sessionsScanned ?? 0)),
    relatedByChangedPath,
  };
}

function buildGitHubHeaders(githubToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nimbus-worker/1.0',
  };
  headers.Authorization = githubToken.toLowerCase().startsWith('bearer ') ? githubToken : `Bearer ${githubToken}`;
  return headers;
}

async function fetchGitHubJson(url: string, githubToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: buildGitHubHeaders(githubToken),
  });

  if (!response.ok) {
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 && (response.headers.get('x-ratelimit-remaining') ?? '').trim() === '0');
    const responseBody = redactReviewText(await response.text());
    throw new ReviewContextAssemblyError(
      'review_context_github_api_error',
      `GitHub API request failed (${response.status}) for ${url}${rateLimited ? ' [rate_limited]' : ''}`,
      responseBody
    );
  }

  const data = (await response.json()) as unknown;
  return asRecord(data);
}

async function fetchGitHubArray(url: string, githubToken: string): Promise<unknown[]> {
  const response = await fetch(url, {
    headers: buildGitHubHeaders(githubToken),
  });

  if (!response.ok) {
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 && (response.headers.get('x-ratelimit-remaining') ?? '').trim() === '0');
    const responseBody = redactReviewText(await response.text());
    throw new ReviewContextAssemblyError(
      'review_context_github_api_error',
      `GitHub API request failed (${response.status}) for ${url}${rateLimited ? ' [rate_limited]' : ''}`,
      responseBody
    );
  }

  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? data : [];
}

function classifyCochangeSkipReason(error: unknown): 'rate_limited' | 'github_api_error' | 'cache_error' {
  if (error instanceof ReviewContextAssemblyError && error.code === 'review_context_cache_error') {
    return 'cache_error';
  }
  if (error instanceof ReviewContextAssemblyError && /\[rate_limited\]/.test(error.message)) {
    return 'rate_limited';
  }
  if (isCochangeCacheError(error)) {
    return 'cache_error';
  }
  return 'github_api_error';
}

async function fetchCochangeFromCheckpointBranch(
  repo: string,
  changedPaths: string[],
  lookbackSessions: number,
  githubToken: string
): Promise<{
  relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
  sessionsScanned: number;
}> {
  const commits = await fetchGitHubArray(`https://api.github.com/repos/${repo}/commits?sha=entire/checkpoints/v1&per_page=${lookbackSessions}`, githubToken);

  const frequencyByChangedPath = new Map<string, Map<string, { count: number; sessions: Set<string> }>>();
  for (const changedPath of changedPaths) {
    frequencyByChangedPath.set(changedPath, new Map());
  }
  let sessionsScanned = 0;

  for (const commit of commits.slice(0, lookbackSessions)) {
    const commitRecord = asRecord(commit);
    const sha = readOptionalString(commitRecord.sha);
    if (!sha) {
      continue;
    }

    const detail = await fetchGitHubJson(`https://api.github.com/repos/${repo}/commits/${sha}`, githubToken);
    const files = Array.isArray(detail.files) ? detail.files : [];
    const metadataPaths = files
      .map((entry) => readOptionalString(asRecord(entry).filename))
      .filter((path): path is string => Boolean(path && path.endsWith('/metadata.json')))
      .slice(0, 3);

    const touchedFiles = new Set<string>();
    for (const metadataPath of metadataPaths) {
      const file = await fetchGitHubJson(`https://api.github.com/repos/${repo}/contents/${metadataPath}?ref=${sha}`, githubToken);
      const content = readOptionalString(file.content);
      if (!content) {
        continue;
      }
      let decoded = '';
      try {
        decoded = atob(content.replace(/\n/g, ''));
      } catch {
        continue;
      }
      try {
        const metadata = JSON.parse(decoded) as unknown;
        for (const path of parseTouchedFilesFromMetadata(asRecord(metadata))) {
          touchedFiles.add(path);
        }
      } catch {
        continue;
      }
    }

    if (touchedFiles.size === 0) {
      continue;
    }

    sessionsScanned += 1;
    for (const changedPath of changedPaths) {
      if (!touchedFiles.has(changedPath)) {
        continue;
      }
      const frequency = frequencyByChangedPath.get(changedPath);
      if (!frequency) {
        continue;
      }
      for (const path of touchedFiles) {
        if (path === changedPath) {
          continue;
        }
        const next = frequency.get(path) ?? { count: 0, sessions: new Set<string>() };
        next.count += 1;
        next.sessions.add(sha);
        frequency.set(path, next);
      }
    }
  }

  const relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>> = {};
  for (const changedPath of changedPaths) {
    const frequency =
      frequencyByChangedPath.get(changedPath) ?? new Map<string, { count: number; sessions: Set<string> }>();
    relatedByChangedPath[changedPath] = Array.from(frequency.entries())
      .map(([path, value]) => ({
        path,
        frequency: value.count,
        sessionIds: Array.from(value.sessions),
      }))
      .sort((left, right) => right.frequency - left.frequency);
  }

  return {
    relatedByChangedPath,
    sessionsScanned,
  };
}

async function assembleReviewContextBootstrap(
  env: Env,
  review: ReviewRunResponse,
  reviewPayload: Record<string, unknown>,
  options?: ReviewRunExecutionOptions
): Promise<ReviewContext> {
  const COCHANGE_LOOKBACK_SESSIONS = 5;
  const COCHANGE_TOP_N = 20;
  const CONVENTION_FILE_MAX_COUNT = 10;

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_assembly_started',
    payload: {
      source: 'entire/checkpoints/v1',
    },
  });

  const workspace = await getWorkspace(env.DB, review.workspaceId);
  const checkpointId = workspace?.checkpointId?.trim() ?? '';
  if (!checkpointId) {
    throw new ReviewContextAssemblyError(
      'unsupported_without_entire_checkpoint_context',
      'Review context assembly requires an Entire checkpoint-backed workspace with a checkpointId.'
    );
  }

  const deployment = await getWorkspaceDeployment(env.DB, review.workspaceId, review.deploymentId);
  if (!deployment) {
    throw new ReviewContextAssemblyError('review_context_deployment_not_found', `Deployment ${review.deploymentId} was not found.`);
  }

  const deploymentRequest = (await getWorkspaceDeploymentRequestPayload(env.DB, review.deploymentId)) ?? {};
  const deploymentRequestProvenance = asRecord(deploymentRequest.provenance);
  const reviewRequestProvenance = asRecord(reviewPayload.provenance);
  const requestProvenance = mergeProvenance(deploymentRequestProvenance, reviewRequestProvenance);
  const sessionIds = uniqueStrings(parseStringArray(requestProvenance.sessionIds));
  if (sessionIds.length === 0) {
    throw new ReviewContextAssemblyError(
      'unsupported_without_entire_checkpoint_context',
      'Review context assembly requires at least one Entire sessionId in deployment provenance.'
    );
  }

  const sessionId = sessionIds[0] ?? '';
  const sessionIntentCandidates = uniqueStrings(parseStringArray(requestProvenance.intentSessionContext));
  const sessionIntent = sessionIntentCandidates[0] ?? null;
  const attributionTrailer = readOptionalString(requestProvenance.attributionTrailer);
  const agentType = readOptionalString(requestProvenance.agentType);
  const requestedTokenBudget =
    readOptionalNumber(requestProvenance.reviewContextTokenBudget) ??
    readOptionalNumber(requestProvenance.contextTokenBudget) ??
    null;
  const configuredTokenBudget = readOptionalNumber(env.REVIEW_CONTEXT_DEFAULT_TOKEN_BUDGET);
  const tokenBudget = requestedTokenBudget ?? configuredTokenBudget ?? null;

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_checkpoint_context_collected',
    payload: {
      checkpointId,
      sessionId,
      sessionCount: sessionIds.length,
      hasSessionIntent: Boolean(sessionIntent),
    },
  });

  const result = asRecord(deployment.result);
  const resultProvenance = asRecord(result.provenance);
  const resultArtifact = asRecord(result.artifact);
  const provenanceOperationId = typeof resultProvenance.operationId === 'string'
    ? resultProvenance.operationId
    : typeof requestProvenance.operationId === 'string'
      ? requestProvenance.operationId
      : null;
  const reviewDiffArtifactId = typeof resultArtifact.reviewDiffArtifactId === 'string'
    ? resultArtifact.reviewDiffArtifactId
    : typeof resultProvenance.reviewDiffArtifactId === 'string'
      ? resultProvenance.reviewDiffArtifactId
      : typeof requestProvenance.reviewDiffArtifactId === 'string'
        ? requestProvenance.reviewDiffArtifactId
        : null;

  const authoritativeDiff = await loadAuthoritativeDeploymentDiff(
    env,
    review.workspaceId,
    provenanceOperationId,
    reviewDiffArtifactId
  );
  const commitDiffPatch = readOptionalString(requestProvenance.commitDiffPatch);
  const authoritativeDiffPatch = readOptionalString(authoritativeDiff?.patch);
  const diffPatch = authoritativeDiffPatch ?? commitDiffPatch ?? null;
  if (!diffPatch) {
    throw new ReviewContextAssemblyError(
      'review_context_diff_missing',
      'Review context assembly requires non-empty diff patch context. Ensure deployment provenance includes review diff artifact or commit diff patch.'
    );
  }
  const changedPaths = diffPatch ? parseChangedPathsFromDiff(diffPatch) : [];
  const diffHunks = diffPatch ? parseDiffHunks(diffPatch) : [];

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_diff_collected',
    payload: {
      source: authoritativeDiffPatch ? authoritativeDiff?.source ?? null : commitDiffPatch ? 'commit_patch' : null,
      artifactId: authoritativeDiffPatch ? authoritativeDiff?.artifactId ?? null : null,
      hasDiff: Boolean(diffPatch),
      patchBytes: diffPatch ? new TextEncoder().encode(diffPatch).byteLength : 0,
      fallbackUsed: !authoritativeDiffPatch && Boolean(commitDiffPatch),
    },
  });

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_changed_files_collected',
    payload: {
      changedFileCount: changedPaths.length,
    },
  });

  const deploymentSourceBundleKey =
    typeof resultArtifact.sourceBundleKey === 'string' && resultArtifact.sourceBundleKey.trim()
      ? resultArtifact.sourceBundleKey.trim()
      : deployment.sourceBundleKey ?? null;
  if (!deploymentSourceBundleKey) {
    throw new ReviewContextAssemblyError(
      'review_context_source_bundle_missing',
      'Review context assembly requires deployment source bundle key.'
    );
  }

  const changedFileReads = changedPaths.length
    ? await readWorkspaceFilesFromSourceBundle(env, {
        sourceBundleKey: deploymentSourceBundleKey,
        sandboxId: `review-context-${review.id}-changed`,
        paths: changedPaths,
      })
    : [];
  const changedFiles = changedFileReads
    .filter((item) => item.content !== null && !item.error)
    .map((item) => ({
      path: item.path,
      content: item.content ?? '',
      byteSize: item.bytes,
      source: 'changed' as const,
    }));

  const conventionCandidates = discoverConventionCandidates(changedPaths, CONVENTION_FILE_MAX_COUNT);
  const conventionReads = conventionCandidates.length
    ? await readWorkspaceFilesFromSourceBundle(env, {
        sourceBundleKey: deploymentSourceBundleKey,
        sandboxId: `review-context-${review.id}-conventions`,
        paths: conventionCandidates,
      })
    : [];
  const conventionFiles = conventionReads
    .filter((item) => item.content !== null && !item.error)
    .slice(0, CONVENTION_FILE_MAX_COUNT)
    .map((item) => ({
      path: item.path,
      content: item.content ?? '',
      byteSize: item.bytes,
      source: 'convention' as const,
    }));

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_conventions_collected',
    payload: {
      candidateCount: conventionCandidates.length,
      conventionFileCount: conventionFiles.length,
      maxCount: CONVENTION_FILE_MAX_COUNT,
    },
  });

  const repoSlug =
    readOptionalString(requestProvenance.repo) ??
    readOptionalString(requestProvenance.repository) ??
    readOptionalString(env.REVIEW_CONTEXT_REPO);
  if (!repoSlug) {
    throw new ReviewContextAssemblyError(
      'unsupported_without_entire_checkpoint_context',
      'Review context assembly requires repository slug in deployment provenance (provenance.repo).'
    );
  }
  let relatedFiles: Array<{
    path: string;
    content: string;
    byteSize: number;
    source: 'related';
    score: number;
    coChangeFrequency: number;
    supportingSessionIds: string[];
  }> = [];
  let sessionsScanned = 0;
  let coChangeSkipped = false;
  let coChangeSkipReason: string | null = null;
  let coChangeAvailable = false;
  let coChangeSource: 'entire/checkpoints/v1' | 'local_git' = 'entire/checkpoints/v1';
  let coChangeLookbackSessions = COCHANGE_LOOKBACK_SESSIONS;
  let coChangeTopN = COCHANGE_TOP_N;
  const localCochange = parseLocalCochangeFromProvenance(requestProvenance.localCochange);
  const githubToken = readOptionalString(options?.cochangeGithubToken) ?? readOptionalString(env.REVIEW_CONTEXT_GITHUB_TOKEN);

  try {
    const effectiveLookback = localCochange?.lookbackSessions ?? COCHANGE_LOOKBACK_SESSIONS;
    const effectiveTopN = localCochange?.topN ?? COCHANGE_TOP_N;
    coChangeLookbackSessions = effectiveLookback;
    coChangeTopN = effectiveTopN;
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_context_cochange_lookup_started',
      payload: {
        repo: repoSlug,
        lookbackSessions: effectiveLookback,
        source: localCochange ? 'local_git' : 'github_api',
      },
    });

    const relatedFrequency = new Map<string, { frequency: number; sessionIds: string[] }>();
    const entriesByChangedPath = new Map<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>();

    if (localCochange) {
      coChangeSource = 'local_git';
      sessionsScanned = localCochange.sessionsScanned;
      for (const changedPath of changedPaths) {
        entriesByChangedPath.set(changedPath, localCochange.relatedByChangedPath[changedPath] ?? []);
      }
    } else {
      if (!githubToken) {
        throw new ReviewContextAssemblyError(
          'review_context_github_token_missing',
          'co-change retrieval requires a GitHub token - set REVIEW_CONTEXT_GITHUB_TOKEN in your local .env'
        );
      }

      const changedPathsMissingCache: string[] = [];
      const cachedRows = await getReviewCochangeCacheBatch(env.DB, {
        repo: repoSlug,
        filePaths: changedPaths,
      });
      const cacheByPath = new Map(cachedRows.map((row) => [row.filePath, row]));

      for (const changedPath of changedPaths) {
        const cached = cacheByPath.get(changedPath);
        const entries = cached?.cochange;
        const cachedLookbackSessions = cached?.lookbackSessions ?? null;
        if (entries && cachedLookbackSessions === COCHANGE_LOOKBACK_SESSIONS) {
          entriesByChangedPath.set(changedPath, entries);
        } else {
          changedPathsMissingCache.push(changedPath);
        }
      }

      if (changedPathsMissingCache.length > 0) {
        const fetched = await fetchCochangeFromCheckpointBranch(repoSlug, changedPathsMissingCache, COCHANGE_LOOKBACK_SESSIONS, githubToken);
        sessionsScanned += fetched.sessionsScanned;
        const cacheUpserts: Array<{
          filePath: string;
          repo: string;
          branch: string;
          cochange: Array<{ path: string; frequency: number; sessionIds: string[] }>;
          lookbackSessions: number;
        }> = [];
        for (const changedPath of changedPathsMissingCache) {
          const entries = fetched.relatedByChangedPath[changedPath] ?? [];
          entriesByChangedPath.set(changedPath, entries);
          cacheUpserts.push({
            filePath: changedPath,
            repo: repoSlug,
            branch: 'entire/checkpoints/v1',
            cochange: entries,
            lookbackSessions: COCHANGE_LOOKBACK_SESSIONS,
          });
        }
        await upsertReviewCochangeCacheBatch(env.DB, cacheUpserts);
      }
    }

    for (const changedPath of changedPaths) {
      const entries = entriesByChangedPath.get(changedPath) ?? [];
      for (const entry of entries) {
        const existing = relatedFrequency.get(entry.path) ?? { frequency: 0, sessionIds: [] };
        existing.frequency += entry.frequency;
        existing.sessionIds = Array.from(new Set([...existing.sessionIds, ...entry.sessionIds]));
        relatedFrequency.set(entry.path, existing);
      }
    }

    const changedPathSet = new Set(changedPaths);
    const rankedRelated = Array.from(relatedFrequency.entries())
      .map(([path, value]) => ({ path, ...value }))
      .filter((item) => !changedPathSet.has(item.path))
      .sort((left, right) => right.frequency - left.frequency)
      .slice(0, effectiveTopN);

    const relatedReads = rankedRelated.length
      ? await readWorkspaceFilesFromSourceBundle(env, {
          sourceBundleKey: deploymentSourceBundleKey,
          sandboxId: `review-context-${review.id}-related`,
          paths: rankedRelated.map((item) => item.path),
        })
      : [];
    const readByPath = new Map(relatedReads.map((item) => [item.path, item]));
    relatedFiles = rankedRelated
      .flatMap((item) => {
        const read = readByPath.get(item.path);
        if (!read || read.content === null || read.error) {
          return [];
        }
        return [
          {
            path: item.path,
            content: read.content,
            byteSize: read.bytes,
            source: 'related' as const,
            score: item.frequency,
            coChangeFrequency: item.frequency,
            supportingSessionIds: item.sessionIds,
          },
        ];
      });
    coChangeAvailable = relatedFiles.length > 0;

    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_context_cochange_lookup_completed',
      payload: {
        repo: repoSlug,
        relatedFileCount: relatedFiles.length,
        topN: effectiveTopN,
        source: localCochange ? 'local_git' : 'github_api',
      },
    });
  } catch (error) {
    const reason = classifyCochangeSkipReason(error);
    const sanitizedErrorDetails = redactReviewText(error instanceof Error ? error.message : String(error));
    const cacheErrorDetails = isCochangeCacheError(error) ? sanitizedErrorDetails : null;
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_context_cochange_failed',
      payload: {
        reason,
        repo: repoSlug,
        lookbackSessions: localCochange?.lookbackSessions ?? COCHANGE_LOOKBACK_SESSIONS,
        source: localCochange ? 'local_git' : 'github_api',
        githubResponseBody: error instanceof ReviewContextAssemblyError ? error.details : sanitizedErrorDetails,
      },
    });
    if (error instanceof ReviewContextAssemblyError) {
      throw error;
    }
    if (reason === 'cache_error') {
      throw new ReviewContextAssemblyError(
        'review_context_cache_error',
        'Co-change context cache read/write failed (cache_error).',
        cacheErrorDetails
      );
    }
    throw new ReviewContextAssemblyError(
      'review_context_github_api_error',
      `Co-change context retrieval failed (${reason}).`
    );
  }

  const assembledAt = new Date().toISOString();
  const contextId = generateReviewContextId();
  const contextPayload: ReviewContext = {
    id: contextId,
    reviewId: review.id,
    workspaceId: review.workspaceId,
    deploymentId: review.deploymentId,
    commitSha: workspace?.commitSha ?? '',
    assembledAt,
    checkpoint: {
      checkpointId,
      branch: 'entire/checkpoints/v1',
      attributionTrailer,
      session: {
        sessionId,
        agentType,
        sessionIntent,
      },
    },
    retrieval: {
      changedFiles,
      diffHunks,
      relatedFiles,
      conventionFiles,
      coChange: {
        source: coChangeSource,
        lookbackSessions: coChangeLookbackSessions,
        sessionsScanned,
        filesConsidered: changedPaths.length,
        topN: coChangeTopN,
        coChangeSkipped,
        coChangeSkipReason,
        coChangeAvailable,
      },
    },
    stats: {
      totalFilesIncluded: changedFiles.length + relatedFiles.length + conventionFiles.length,
      totalBytesIncluded:
        changedFiles.reduce((total, item) => total + item.byteSize, 0) +
        relatedFiles.reduce((total, item) => total + item.byteSize, 0) +
        conventionFiles.reduce((total, item) => total + item.byteSize, 0),
      estimatedTokens: estimateTokenCount([
        diffPatch ?? '',
        ...changedFiles.map((item) => item.content),
        ...relatedFiles.map((item) => item.content),
        ...conventionFiles.map((item) => item.content),
      ]),
      tokenBudget,
    },
  };

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_budget_checked',
    payload: {
      estimatedTokens: contextPayload.stats.estimatedTokens,
      tokenBudget,
      tokenBudgetSource:
        requestedTokenBudget !== null
          ? 'request_provenance'
          : configuredTokenBudget !== null
            ? 'configured_env'
            : 'unconfigured',
      exceeded: tokenBudget !== null && contextPayload.stats.estimatedTokens > tokenBudget,
    },
  });

  if (tokenBudget !== null && contextPayload.stats.estimatedTokens > tokenBudget) {
    throw new ReviewContextAssemblyError(
      'review_context_budget_exceeded',
      `ReviewContext estimated token usage (${contextPayload.stats.estimatedTokens}) exceeds configured budget (${tokenBudget}). Increase the budget and retry.`
    );
  }

  const storageBucketCandidates = [env.REVIEW_CONTEXTS, env.WORKSPACE_ARTIFACTS, env.SOURCE_BUNDLES];
  const storageBucket = storageBucketCandidates.find(
    (bucket): bucket is R2Bucket => Boolean(bucket && typeof bucket.put === 'function')
  );
  if (!storageBucket) {
    throw new ReviewContextAssemblyError(
      'review_context_storage_unavailable',
      'REVIEW_CONTEXTS, WORKSPACE_ARTIFACTS, or SOURCE_BUNDLES R2 binding is required for review context assembly.'
    );
  }

  const r2Key = `review-context/${review.id}/${contextId}.json`;
  const serialized = JSON.stringify(stripSensitiveTokenFields(contextPayload));
  await storageBucket.put(r2Key, serialized, {
    httpMetadata: {
      contentType: 'application/json',
    },
  });
  const ref = await createReviewContextBlobReference(env.DB, {
    id: contextId,
    reviewId: review.id,
    workspaceId: review.workspaceId,
    deploymentId: review.deploymentId,
    r2Key,
    byteSize: new TextEncoder().encode(serialized).byteLength,
    estimatedTokens: contextPayload.stats.estimatedTokens,
  });

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_stored',
    payload: {
      contextId: ref.id,
      r2Key: ref.r2Key,
      totalFilesIncluded: contextPayload.stats.totalFilesIncluded,
      totalBytesIncluded: contextPayload.stats.totalBytesIncluded,
      estimatedTokens: contextPayload.stats.estimatedTokens,
    },
  });

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_assembly_succeeded',
    payload: {
      checkpointId,
      sessionId,
      changedFileCount: changedPaths.length,
      contextId: ref.id,
    },
  });

  return contextPayload;
}

async function loadAuthoritativeDeploymentDiff(
  env: Env,
  workspaceId: string,
  operationId: string | null,
  reviewDiffArtifactId: string | null
): Promise<{ source: 'artifact_patch'; artifactId: string; patch: string } | null> {
  const getArtifactObject = async (objectKey: string): Promise<R2ObjectBody | null> => {
    const fromArtifacts = env.WORKSPACE_ARTIFACTS ? await env.WORKSPACE_ARTIFACTS.get(objectKey) : null;
    if (fromArtifacts) {
      return fromArtifacts;
    }
    return env.SOURCE_BUNDLES ? await env.SOURCE_BUNDLES.get(objectKey) : null;
  };

  if (reviewDiffArtifactId) {
    const reviewArtifact = await getWorkspaceArtifactById(env.DB, workspaceId, reviewDiffArtifactId);
    if (reviewArtifact && reviewArtifact.artifact.type === 'patch') {
      const object = await getArtifactObject(reviewArtifact.objectKey);
      if (!object) {
        return null;
      }
      return {
        source: 'artifact_patch',
        artifactId: reviewDiffArtifactId,
        patch: await object.text(),
      };
    }
  }

  if (!operationId) {
    return null;
  }

  const operation = await getWorkspaceOperation(env.DB, workspaceId, operationId);
  if (!operation || operation.type !== 'export_patch' || operation.status !== 'succeeded') {
    return null;
  }

  const result = asRecord(operation.result);
  const artifactId = typeof result.artifactId === 'string' ? result.artifactId.trim() : '';
  if (!artifactId) {
    return null;
  }

  const artifact = await getWorkspaceArtifactById(env.DB, workspaceId, artifactId);
  if (!artifact || artifact.artifact.type !== 'patch') {
    return null;
  }

  const object = await getArtifactObject(artifact.objectKey);
  if (!object) {
    return null;
  }

  return {
    source: 'artifact_patch',
    artifactId,
    patch: await object.text(),
  };
}

async function buildWorkspaceDeploymentReport(
  env: Env,
  review: ReviewRunResponse,
  payload: Record<string, unknown>,
  reviewContext: ReviewContext
): Promise<ReviewReport> {
  const deployment = await getWorkspaceDeployment(env.DB, review.workspaceId, review.deploymentId);
  if (!deployment) {
    throw new Error(`Deployment not found for review target ${review.deploymentId}`);
  }

  const deploymentRequest = (await getWorkspaceDeploymentRequestPayload(env.DB, review.deploymentId)) ?? {};
  const deploymentEvents = await listWorkspaceDeploymentEvents(env.DB, review.workspaceId, review.deploymentId, 0, 500);
  const reviewPolicy = asRecord(payload.policy);
  const reviewFormat = asRecord(payload.format);
  const reviewAnalysisModel = resolveReviewAnalysisModel(payload, env);
  const result = asRecord(deployment.result);
  const resultProvenance = asRecord(result.provenance);
  const resultArtifact = asRecord(result.artifact);
  const requestValidation = asRecord(deploymentRequest.validation);
  const requestProvenance = mergeProvenance(asRecord(deploymentRequest.provenance), asRecord(payload.provenance));
  const intentSessionContext = uniqueStrings(parseStringArray(requestProvenance.intentSessionContext)).slice(0, 8);
  const provenanceTaskId = typeof resultProvenance.taskId === 'string'
    ? resultProvenance.taskId
    : typeof requestProvenance.taskId === 'string'
      ? requestProvenance.taskId
      : null;
  const provenanceTask = provenanceTaskId ? await getWorkspaceTask(env.DB, review.workspaceId, provenanceTaskId) : null;
  const taskResult = asRecord(provenanceTask?.result);
  const severityThreshold = typeof reviewPolicy.severityThreshold === 'string' ? reviewPolicy.severityThreshold : 'low';
  const maxFindings = parsePositiveInteger(reviewPolicy.maxFindings, 100, 500);
  const includeProvenance = parseBoolean(reviewPolicy.includeProvenance, true);
  const includeValidationEvidence = parseBoolean(reviewPolicy.includeValidationEvidence, true);
  const includeMarkdownSummary = parseBoolean(reviewFormat.includeMarkdownSummary, true);
  const changedFileCount = reviewContext.retrieval.coChange.filesConsidered;
  const advisories =
    changedFileCount > LARGE_DIFF_ADVISORY_THRESHOLD
      ? [
          `Large diff detected (${changedFileCount} files). Consider smaller, focused commits for higher quality reviews.`,
        ]
      : [];

  const baseGoal =
    typeof provenanceTask?.prompt === 'string' && provenanceTask.prompt.trim()
      ? provenanceTask.prompt.trim()
      : typeof requestProvenance.note === 'string' && requestProvenance.note.trim()
        ? requestProvenance.note.trim()
      : `Assess workspace deployment ${review.deploymentId} for review-first handoff readiness.`;
  const baseConstraints = [
    'Non-mutating review only.',
    `Target limited to ${review.target.type}.`,
    requestValidation.runTestsIfPresent === false
      ? 'Tests were not required during deployment validation.'
      : 'Tests were eligible during deployment validation.',
    requestValidation.runBuildIfPresent === false
      ? 'Build validation was not required during deployment validation.'
      : 'Build validation was eligible during deployment validation.',
  ];
  const baseDecisions = [
    `Deployment provider: ${deployment.provider}.`,
    `Review mode: ${review.mode}.`,
    provenanceTask ? `Source task model: ${provenanceTask.model}.` : '',
    typeof taskResult.summary === 'string' && taskResult.summary.trim() ? `Source task summary: ${taskResult.summary.trim()}.` : '',
    typeof resultProvenance.trigger === 'string'
      ? `Deployment trigger: ${resultProvenance.trigger}.`
      : typeof requestProvenance.trigger === 'string'
        ? `Deployment trigger: ${requestProvenance.trigger}.`
        : 'Deployment trigger was not recorded.',
    parseStringArray(requestProvenance.sessionIds).length > 0
      ? `Related Entire sessions: ${parseStringArray(requestProvenance.sessionIds).join(', ')}.`
      : '',
    intentSessionContext.length > 0 ? `Prompt-history context excerpts provided: ${intentSessionContext.length}.` : '',
  ];

  const heuristicFindings = buildHeuristicFindings(review, deploymentEvents);
  const analysisEvidence = buildEvidence(deploymentEvents, deployment, resultArtifact, true);
  const provenanceOperationId = typeof resultProvenance.operationId === 'string'
    ? resultProvenance.operationId
    : typeof requestProvenance.operationId === 'string'
      ? requestProvenance.operationId
      : null;
  const reviewDiffArtifactId = typeof resultArtifact.reviewDiffArtifactId === 'string'
    ? resultArtifact.reviewDiffArtifactId
    : typeof resultProvenance.reviewDiffArtifactId === 'string'
      ? resultProvenance.reviewDiffArtifactId
      : typeof requestProvenance.reviewDiffArtifactId === 'string'
        ? requestProvenance.reviewDiffArtifactId
        : null;
  const authoritativeDiff = await loadAuthoritativeDeploymentDiff(
    env,
    review.workspaceId,
    provenanceOperationId,
    reviewDiffArtifactId
  );
  let agentAnalysis: Awaited<ReturnType<typeof runWorkspaceDeploymentAgentAnalysis>> = null;
  const reviewAgentEnabled = Boolean((env.AGENT_SDK_URL ?? '').trim());
  const deploymentSourceBundleKey =
    typeof resultArtifact.sourceBundleKey === 'string' && resultArtifact.sourceBundleKey.trim()
      ? resultArtifact.sourceBundleKey.trim()
      : deployment.sourceBundleKey ?? null;
  const promptGoal = provenanceTask?.prompt?.trim() || baseGoal;
  if (reviewAgentEnabled && deploymentSourceBundleKey) {
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_analysis_agent_started',
      payload: {
        provider: 'cloudflare_agents_sdk',
        model: reviewAnalysisModel,
      },
    });

    agentAnalysis = await runWorkspaceDeploymentAgentAnalysis(env, {
      reviewId: review.id,
      workspaceId: review.workspaceId,
      deploymentId: review.deploymentId,
      deploymentSandboxId: `review-snapshot-${review.id}`,
      sourceBundleKey: deploymentSourceBundleKey,
      modelOverride: reviewAnalysisModel,
      authoritativeDiffSnapshot: authoritativeDiff
        ? {
            source: authoritativeDiff.source,
            artifactId: authoritativeDiff.artifactId,
            patch: authoritativeDiff.patch,
          }
        : undefined,
      goal: promptGoal,
      constraints: baseConstraints,
      decisions: baseDecisions.filter(Boolean),
      intentSessionContext,
      evidenceCatalog: analysisEvidence.map((item) => ({
        id: item.id,
        type: item.type,
        label: item.label,
        status: item.status,
      })),
      deploymentSummary: {
        provider: deployment.provider,
        deployedUrl: deployment.deployedUrl,
        validationSummary: JSON.stringify(requestValidation),
      },
      reviewContext,
      rootListing: {},
      diffSnapshot: {},
      onLifecycleEvent: async (eventType, eventPayload) => {
        await appendReviewEvent(env.DB, {
          reviewId: review.id,
          eventType,
          payload: eventPayload,
        });
      },
    });

    if (!agentAnalysis) {
      throw new Error('Review analysis did not produce output.');
    }

    if (agentAnalysis.validation.fallbackApplied) {
      throw new Error(
        `Review analysis produced non-authoritative fallback output (${agentAnalysis.validation.fallbackReason ?? 'unknown'}).`
      );
    }

    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_analysis_agent_completed',
      payload: {
        provider: agentAnalysis.provider,
        model: agentAnalysis.model,
        stepsExecuted: agentAnalysis.stepsExecuted,
        findingCount: agentAnalysis.findings.length,
      },
    });
  }

  if (reviewAgentEnabled && !deploymentSourceBundleKey) {
    throw new Error('Deployment snapshot unavailable; review analysis cannot proceed without source bundle.');
  }

  if (reviewAgentEnabled && !agentAnalysis) {
    throw new Error('Review analysis did not produce output.');
  }

  const severityFloor = REVIEW_SEVERITY_RANK[severityThreshold as ReviewSeverity] ?? REVIEW_SEVERITY_RANK.low;
  const mergedFindings = mergeFindings(agentAnalysis?.findings ?? [], heuristicFindings)
    .filter((finding) => REVIEW_SEVERITY_RANK[finding.severity] >= severityFloor)
    .sort((left, right) => REVIEW_SEVERITY_RANK[right.severity] - REVIEW_SEVERITY_RANK[left.severity])
    .slice(0, maxFindings);
  const agentEvidence = agentAnalysis
    ? {
        id: 'ev_review_agent',
        type: 'analysis_agent',
        label: `AI review analysis via ${agentAnalysis.provider}`,
        status: 'info' as const,
        metadata: {
          model: agentAnalysis.model,
          stepsExecuted: agentAnalysis.stepsExecuted,
          usedTools: agentAnalysis.usedTools,
        },
      }
    : null;
  const evidence = buildEvidence(deploymentEvents, deployment, resultArtifact, includeValidationEvidence, agentEvidence);
  const findings = mergedFindings;

  const riskLevel = deriveRiskLevel(findings, 'low');
  const recommendation = deriveRecommendation(findings);
  const summary = {
    riskLevel,
    findingCounts: {
      info: findings.filter((finding) => finding.severity === 'info').length,
      critical: findings.filter((finding) => finding.severity === 'critical').length,
      high: findings.filter((finding) => finding.severity === 'high').length,
      medium: findings.filter((finding) => finding.severity === 'medium').length,
      low: findings.filter((finding) => finding.severity === 'low').length,
    },
    recommendation,
  };

  const intent = sanitizeIntentBlock({
    goal: agentAnalysis?.intent?.goal ?? baseGoal,
    constraints: Array.from(new Set([...(agentAnalysis?.intent?.constraints ?? []), ...baseConstraints])),
    decisions: Array.from(new Set([...(agentAnalysis?.intent?.decisions ?? []), ...baseDecisions])),
  });

  const promptSummary = redactReviewText(
    (typeof requestProvenance.note === 'string' ? requestProvenance.note.trim() : null) ||
      `Review generated in ${review.mode} mode for deployment ${review.deploymentId}.`
  );
  const transcriptUrl =
    typeof requestProvenance.transcriptUrl === 'string' && requestProvenance.transcriptUrl.trim()
      ? requestProvenance.transcriptUrl.trim()
      : null;
  const contextResolutionMode =
    requestProvenance.contextResolution === 'branch_fallback' || requestProvenance.contextResolution === 'direct'
      ? requestProvenance.contextResolution
      : 'direct';
  const contextResolutionOriginalCheckpointId =
    typeof requestProvenance.contextResolutionOriginalCheckpointId === 'string' &&
    requestProvenance.contextResolutionOriginalCheckpointId.trim()
      ? requestProvenance.contextResolutionOriginalCheckpointId.trim()
      : null;
  const contextResolutionResolvedCheckpointId =
    typeof requestProvenance.contextResolutionResolvedCheckpointId === 'string' &&
    requestProvenance.contextResolutionResolvedCheckpointId.trim()
      ? requestProvenance.contextResolutionResolvedCheckpointId.trim()
      : null;
  const contextResolutionResolvedCommitSha =
    typeof requestProvenance.contextResolutionResolvedCommitSha === 'string' &&
    requestProvenance.contextResolutionResolvedCommitSha.trim()
      ? requestProvenance.contextResolutionResolvedCommitSha.trim()
      : null;
  const contextResolutionResolvedCommitMessage =
    typeof requestProvenance.contextResolutionResolvedCommitMessage === 'string' &&
    requestProvenance.contextResolutionResolvedCommitMessage.trim()
      ? requestProvenance.contextResolutionResolvedCommitMessage.trim()
      : null;

  const report: ReviewReport = {
    summary,
    findings,
    summaryText: agentAnalysis?.summary,
    furtherPassesLowYield: agentAnalysis?.furtherPassesLowYield,
    intent,
    evidence,
    provenance: includeProvenance
      ? {
          sessionIds: parseStringArray(requestProvenance.sessionIds),
          promptSummary,
          transcriptUrl,
          reviewContextRef: {
            id: reviewContext.id,
            r2Key: `review-context/${review.id}/${reviewContext.id}.json`,
          },
          reviewContextStats: {
            totalFilesIncluded: reviewContext.stats.totalFilesIncluded,
            totalBytesIncluded: reviewContext.stats.totalBytesIncluded,
            estimatedTokens: reviewContext.stats.estimatedTokens,
            tokenBudget: reviewContext.stats.tokenBudget,
          },
          coChange: {
            coChangeSkipped: reviewContext.retrieval.coChange.coChangeSkipped,
            coChangeSkipReason: reviewContext.retrieval.coChange.coChangeSkipReason,
            coChangeAvailable: reviewContext.retrieval.coChange.coChangeAvailable,
            relatedFileCount: reviewContext.retrieval.relatedFiles.length,
          },
          contextResolution:
            contextResolutionMode === 'branch_fallback' &&
            contextResolutionOriginalCheckpointId &&
            contextResolutionResolvedCheckpointId &&
            contextResolutionResolvedCommitSha
              ? {
                  contextResolution: 'branch_fallback',
                  originalCheckpointId: contextResolutionOriginalCheckpointId,
                  resolvedCheckpointId: contextResolutionResolvedCheckpointId,
                  resolvedCommitSha: contextResolutionResolvedCommitSha,
                  resolvedCommitMessage: contextResolutionResolvedCommitMessage,
                }
              : undefined,
          outputSchemaVersion: 'v2',
          passArchitecture: 'single',
          validation: agentAnalysis?.validation,
          furtherPassesLowYield:
            typeof agentAnalysis?.furtherPassesLowYield === 'boolean'
              ? {
                  value: agentAnalysis.furtherPassesLowYield,
                  source: 'model-self-assessment' as const,
                  reliability: 'weak-signal-phase2' as const,
                }
              : undefined,
          advisories: advisories.length > 0 ? advisories : undefined,
        }
      : {
          sessionIds: [],
          promptSummary: null,
          transcriptUrl: null,
        },
    markdownSummary: null,
  };
  if (includeMarkdownSummary) {
    report.markdownSummary = buildReviewMarkdown(report);
  }
  return report;
}

async function executeReviewRun(
  env: Env,
  review: ReviewRunResponse,
  payload: Record<string, unknown>,
  reviewContext: ReviewContext
): Promise<ReviewReport> {
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_preflight_started',
    payload: {
      targetType: review.target.type,
      mode: review.mode,
    },
  });
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_preflight_completed',
    payload: {
      ok: true,
    },
  });
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_analysis_started',
    payload: {
      deploymentId: review.deploymentId,
      workspaceId: review.workspaceId,
    },
  });

  const target = asRecord(payload.target);
  const targetType = typeof target.type === 'string' ? target.type : review.target.type;
  if (targetType !== 'workspace_deployment') {
    throw new Error(`Unsupported review target type: ${targetType}`);
  }

  const report = await buildWorkspaceDeploymentReport(env, review, payload, reviewContext);
  for (const finding of report.findings) {
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_finding_emitted',
      payload: {
        severity: finding.severity,
        category: finding.category,
        passType: finding.passType,
        description: finding.description,
      },
    });
  }

  return report;
}

export async function processReviewRun(env: Env, reviewId: string, options?: ReviewRunExecutionOptions): Promise<void> {
  const claimed = await claimReviewRunForExecution(env.DB, reviewId);
  if (!claimed) {
    const existing = await getReviewRun(env.DB, reviewId);
    if (existing?.status === 'running') {
      const attemptTimeoutMs = parseTimeoutMs(env.ATTEMPT_TIMEOUT_MS, DEFAULT_REVIEW_ATTEMPT_TIMEOUT_MS);
      const staleThresholdMs = attemptTimeoutMs + REVIEW_STALE_GRACE_MS;
      const startedAtMs = toTimestampMs(existing.startedAt) ?? toTimestampMs(existing.updatedAt) ?? toTimestampMs(existing.createdAt);
      const staleForMs = startedAtMs === null ? null : Date.now() - startedAtMs;
      const isStale = typeof staleForMs === 'number' && staleForMs >= staleThresholdMs;
      if (isStale) {
        const staleForSeconds = Math.floor(staleForMs / 1000);
        const message = `Review execution stalled in running state for ${staleForSeconds}s (timeout threshold ${Math.floor(staleThresholdMs / 1000)}s).`;
        const attemptCount = existing.attemptCount ?? 0;
        if ((options?.allowRetryScheduling ?? true) && attemptCount <= REVIEW_MAX_RETRIES) {
          await replaceReviewFindings(env.DB, reviewId, []);
          await updateReviewRunStatus(env.DB, reviewId, 'queued', {
            report: null,
            markdownSummary: null,
            startedAt: null,
            finishedAt: null,
            errorCode: 'retry_scheduled',
            errorMessage: message,
          });
          await appendReviewEvent(env.DB, {
            reviewId,
            eventType: 'review_retry_scheduled',
            payload: {
              attemptCount,
              maxRetries: REVIEW_MAX_RETRIES,
              reason: 'stale_running_timeout',
              staleForSeconds,
            },
          });
          throw new QueueRetryError('Review stale-running recovery requested');
        }

        await replaceReviewFindings(env.DB, reviewId, []);
        await updateReviewRunStatus(env.DB, reviewId, 'failed', {
          report: null,
          markdownSummary: null,
          errorCode: 'review_execution_timeout',
          errorMessage: message,
        });
        await appendReviewEvent(env.DB, {
          reviewId,
          eventType: 'review_failed',
          payload: {
            code: 'review_execution_timeout',
            message,
          },
        });
        return;
      }
      throw new QueueRetryError('Review run is already running; defer redelivery');
    }
    return;
  }

  let review: ReviewRunResponse | null = null;
  try {
    review = await getReviewRun(env.DB, reviewId);
    if (!review) {
      return;
    }

    const payload = await getReviewRunRequestPayload(env.DB, reviewId);
    if (!payload) {
      await updateReviewRunStatus(env.DB, reviewId, 'failed', {
        errorCode: 'review_not_found',
        errorMessage: 'Review request payload no longer exists',
      });
      await appendReviewEvent(env.DB, {
        reviewId,
        eventType: 'review_failed',
        payload: {
          code: 'review_not_found',
          message: 'Review request payload no longer exists',
        },
      });
      return;
    }

    const reviewContext = await assembleReviewContextBootstrap(env, review, payload, options);
    const report = await executeReviewRun(env, review, payload, reviewContext);
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_finalize_started',
      payload: {
        findingCount: report.findings.length,
      },
    });
    await replaceReviewFindings(env.DB, reviewId, report.findings);
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_analysis_findings_persisted',
      payload: {
        findingCount: report.findings.length,
      },
    });
    await updateReviewRunStatus(env.DB, reviewId, 'succeeded', {
      report,
      markdownSummary: report.markdownSummary,
      errorCode: null,
      errorMessage: null,
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_analysis_succeeded',
      payload: {
        findingCount: report.findings.length,
      },
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_succeeded',
      payload: {
        recommendation: report.summary.recommendation,
        findingCount: report.findings.length,
      },
    });
  } catch (error) {
    const message = formatReviewAnalysisError(error);
    const latest = await getReviewRun(env.DB, reviewId);
    const attemptCount = latest?.attemptCount ?? review?.attemptCount ?? 0;

    const allowRetryScheduling = options?.allowRetryScheduling !== false;
    if (allowRetryScheduling && (error instanceof QueueRetryError || transientReviewFailure(message)) && attemptCount <= REVIEW_MAX_RETRIES) {
      await replaceReviewFindings(env.DB, reviewId, []);
      await updateReviewRunStatus(env.DB, reviewId, 'queued', {
        report: null,
        markdownSummary: null,
        startedAt: null,
        finishedAt: null,
        errorCode: 'retry_scheduled',
        errorMessage: message,
      });
      await appendReviewEvent(env.DB, {
        reviewId,
        eventType: 'review_retry_scheduled',
        payload: {
          attemptCount,
          maxRetries: REVIEW_MAX_RETRIES,
        },
      });
      throw new QueueRetryError('Review transient failure; retry requested');
    }

    const contextAssemblyErrorCode = error instanceof ReviewContextAssemblyError ? error.code : null;
    const finalErrorCode = contextAssemblyErrorCode ?? 'review_execution_failed';
    await updateReviewRunStatus(env.DB, reviewId, 'failed', {
      errorCode: finalErrorCode,
      errorMessage: message,
    });
    try {
      if (contextAssemblyErrorCode) {
        await appendReviewEvent(env.DB, {
          reviewId,
          eventType: 'review_context_assembly_failed',
          payload: {
            code: contextAssemblyErrorCode,
            message,
          },
        });
      }
      await appendReviewEvent(env.DB, {
        reviewId,
        eventType: 'review_failed',
        payload: {
          code: finalErrorCode,
          message,
        },
      });
    } catch {
      // Best-effort terminal event.
    }
  }
}

export async function runReviewInlineWithRetries(
  env: Env,
  reviewId: string,
  maxCycles = 4,
  options?: ReviewRunExecutionOptions
): Promise<void> {
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    try {
      await processReviewRun(env, reviewId, options);
    } catch {
      // Retry scheduling is inferred from persisted status.
    }

    const latest = await getReviewRun(env.DB, reviewId);
    if (!latest) {
      return;
    }
    if (latest.status !== 'queued') {
      return;
    }
    if (latest.error?.code !== 'retry_scheduled') {
      return;
    }
  }

  const latest = await getReviewRun(env.DB, reviewId);
  if (latest?.status === 'queued' && latest.error?.code === 'retry_scheduled') {
    const message = `Review ${reviewId} remained queued after inline retries`;
    await replaceReviewFindings(env.DB, reviewId, []);
    await updateReviewRunStatus(env.DB, reviewId, 'failed', {
      report: null,
      markdownSummary: null,
      errorCode: 'review_execution_failed',
      errorMessage: message,
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_failed',
      payload: {
        code: 'review_execution_failed',
        message,
      },
    });
  }
}

export function shouldRetryReviewError(error: unknown): boolean {
  if (error instanceof QueueRetryError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return transientReviewFailure(message);
}
