import type {
  Env,
  ReviewContext,
  ReviewEvidenceItem,
  ReviewFinding,
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
  getReviewCochangeCache,
  getReviewRunRequestPayload,
  getWorkspace,
  getWorkspaceArtifactById,
  getWorkspaceDeployment,
  getWorkspaceDeploymentRequestPayload,
  getWorkspaceOperation,
  getWorkspaceTask,
  listWorkspaceDeploymentEvents,
  replaceReviewFindings,
  upsertReviewCochangeCache,
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

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReviewContextAssemblyError';
    this.code = code;
  }
}

const REVIEW_MAX_RETRIES = 2;
const REVIEW_SEVERITY_RANK: Record<ReviewSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};
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
  return typeof value === 'boolean' ? value : fallback;
}

function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function redactReviewText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const redacted = value
    .replace(/(authorization:\s*bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/gh[spu]_[a-z0-9_]+/gi, '[REDACTED_TOKEN]')
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]')
    .replace(/(token\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]');
  return redacted.length > 600 ? `${redacted.slice(0, 597)}...` : redacted;
}

function transientReviewFailure(message: string): boolean {
  return /(d1|database is locked|sqlite_busy|temporarily unavailable|connection reset)/i.test(message);
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

  const findingLines =
    report.findings.length === 0
      ? ['No actionable findings were emitted for this deployment review.']
      : report.findings.map((finding) => {
          const location = finding.locations[0] ? `${finding.locations[0].path}:${finding.locations[0].line}` : 'deployment-level';
          return `[${finding.severity}/${finding.confidence}] ${finding.title} (${location})`;
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

function buildFindingId(reviewId: string, index: number): string {
  return `f_${reviewId}_${String(index).padStart(3, '0')}`;
}

function mergeFindings(primary: ReviewFinding[], secondary: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const merged: ReviewFinding[] = [];

  for (const finding of [...primary, ...secondary]) {
    const key = [finding.title.trim().toLowerCase(), finding.locations[0]?.path ?? '', String(finding.locations[0]?.line ?? 0)].join('::');
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
          id: buildFindingId(review.id, index + 1),
          severity: 'medium',
          confidence: 'high',
          title: `Validation tool missing for ${step}`,
          description: typeof eventPayload.message === 'string' ? eventPayload.message : 'Validation tool missing in runtime.',
          conditions: `Observed during ${step} validation for deployment ${review.deploymentId}.`,
          locations: [],
          suggestedFix: {
            kind: 'text',
            value: `Install the required ${step} validation tool in the deployment runtime or disable that validation step explicitly.`,
          },
          evidenceRefs: [`ev_${event.seq}`],
        },
      ];
    }
    if (event.eventType === 'validation_skipped') {
      const step = typeof eventPayload.step === 'string' ? eventPayload.step : 'validation';
      return [
        {
          id: buildFindingId(review.id, index + 1),
          severity: 'low',
          confidence: 'medium',
          title: `Validation skipped for ${step}`,
          description: `Nimbus skipped ${step} validation while preparing this deployment review.`,
          conditions: typeof eventPayload.reason === 'string' ? eventPayload.reason : 'skip reason not recorded',
          locations: [],
          suggestedFix: {
            kind: 'text',
            value: `Run the ${step} validation in the deployment path or document why it is intentionally skipped.`,
          },
          evidenceRefs: [`ev_${event.seq}`],
        },
      ];
    }
    if (event.eventType === 'deployment_toolchain_unknown_fallback') {
      return [
        {
          id: buildFindingId(review.id, index + 1),
          severity: 'low',
          confidence: 'medium',
          title: 'Toolchain detection fell back to unknown defaults',
          description: 'Deployment completed after a toolchain fallback, which may hide package-manager-specific issues.',
          conditions: `Observed while reviewing deployment ${review.deploymentId}.`,
          locations: [],
          suggestedFix: {
            kind: 'text',
            value: 'Declare an explicit package manager and lockfile so future deploys and reviews use deterministic tooling.',
          },
          evidenceRefs: [`ev_${event.seq}`],
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

function parseTouchedFilesFromMetadata(record: Record<string, unknown>): string[] {
  const candidates = [record.touchedFiles, record.touched_files, record.changedFiles, record.changed_files, record.files];
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

function buildGitHubHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = readOptionalString(env.REVIEW_CONTEXT_GITHUB_TOKEN);
  if (token) {
    headers.Authorization = token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
  }
  return headers;
}

async function fetchGitHubJson(env: Env, url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: buildGitHubHeaders(env),
  });

  if (!response.ok) {
    throw new ReviewContextAssemblyError(
      'review_context_github_api_error',
      `GitHub API request failed (${response.status}) for ${url}`
    );
  }

  const data = (await response.json()) as unknown;
  return asRecord(data);
}

async function fetchGitHubArray(env: Env, url: string): Promise<unknown[]> {
  const response = await fetch(url, {
    headers: buildGitHubHeaders(env),
  });

  if (!response.ok) {
    throw new ReviewContextAssemblyError(
      'review_context_github_api_error',
      `GitHub API request failed (${response.status}) for ${url}`
    );
  }

  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? data : [];
}

async function fetchCochangeFromCheckpointBranch(
  env: Env,
  repo: string,
  changedPaths: string[],
  lookbackSessions: number
): Promise<{
  relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
  sessionsScanned: number;
}> {
  const commits = await fetchGitHubArray(
    env,
    `https://api.github.com/repos/${repo}/commits?sha=entire/checkpoints/v1&per_page=${lookbackSessions}`
  );

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

    const detail = await fetchGitHubJson(env, `https://api.github.com/repos/${repo}/commits/${sha}`);
    const files = Array.isArray(detail.files) ? detail.files : [];
    const metadataPaths = files
      .map((entry) => readOptionalString(asRecord(entry).filename))
      .filter((path): path is string => Boolean(path && path.endsWith('/metadata.json')))
      .slice(0, 3);

    const touchedFiles = new Set<string>();
    for (const metadataPath of metadataPaths) {
      const file = await fetchGitHubJson(env, `https://api.github.com/repos/${repo}/contents/${metadataPath}?ref=${sha}`);
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
  review: ReviewRunResponse
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
  const requestProvenance = asRecord(deploymentRequest.provenance);
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
  const tokenBudget =
    readOptionalNumber(requestProvenance.reviewContextTokenBudget) ??
    readOptionalNumber(requestProvenance.contextTokenBudget) ??
    null;

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
  const diffPatch = authoritativeDiff?.patch ?? null;
  const changedPaths = diffPatch ? parseChangedPathsFromDiff(diffPatch) : [];
  const diffHunks = diffPatch ? parseDiffHunks(diffPatch) : [];

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_diff_collected',
    payload: {
      source: authoritativeDiff?.source ?? null,
      artifactId: authoritativeDiff?.artifactId ?? null,
      hasDiff: Boolean(diffPatch),
      patchBytes: diffPatch ? new TextEncoder().encode(diffPatch).byteLength : 0,
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
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_cochange_lookup_started',
    payload: {
      repo: repoSlug,
      lookbackSessions: COCHANGE_LOOKBACK_SESSIONS,
    },
  });

  const relatedFrequency = new Map<string, { frequency: number; sessionIds: string[] }>();
  const entriesByChangedPath = new Map<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>();
  const changedPathsMissingCache: string[] = [];
  for (const changedPath of changedPaths) {
    const cached = await getReviewCochangeCache(env.DB, {
      filePath: changedPath,
      repo: repoSlug,
    });
    const entries = cached?.cochange;
    const cachedLookbackSessions = cached?.lookbackSessions ?? null;
    if (entries && cachedLookbackSessions === COCHANGE_LOOKBACK_SESSIONS) {
      entriesByChangedPath.set(changedPath, entries);
    } else {
      changedPathsMissingCache.push(changedPath);
    }
  }

  if (changedPathsMissingCache.length > 0) {
    const fetched = await fetchCochangeFromCheckpointBranch(
      env,
      repoSlug,
      changedPathsMissingCache,
      COCHANGE_LOOKBACK_SESSIONS
    );
    sessionsScanned += fetched.sessionsScanned;
    for (const changedPath of changedPathsMissingCache) {
      const entries = fetched.relatedByChangedPath[changedPath] ?? [];
      entriesByChangedPath.set(changedPath, entries);
      await upsertReviewCochangeCache(env.DB, {
        filePath: changedPath,
        repo: repoSlug,
        branch: 'entire/checkpoints/v1',
        cochange: entries,
        lookbackSessions: COCHANGE_LOOKBACK_SESSIONS,
      });
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
    .slice(0, COCHANGE_TOP_N);

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

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_cochange_lookup_completed',
    payload: {
      repo: repoSlug,
      relatedFileCount: relatedFiles.length,
      topN: COCHANGE_TOP_N,
    },
  });

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
        source: 'entire/checkpoints/v1',
        lookbackSessions: COCHANGE_LOOKBACK_SESSIONS,
        sessionsScanned,
        filesConsidered: changedPaths.length,
        topN: COCHANGE_TOP_N,
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
  const serialized = JSON.stringify(contextPayload);
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
  const result = asRecord(deployment.result);
  const resultProvenance = asRecord(result.provenance);
  const resultArtifact = asRecord(result.artifact);
  const requestValidation = asRecord(deploymentRequest.validation);
  const requestProvenance = asRecord(deploymentRequest.provenance);
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
  try {
    const promptGoal = provenanceTask?.prompt?.trim() || baseGoal;
    if (reviewAgentEnabled && deploymentSourceBundleKey) {
      await appendReviewEvent(env.DB, {
        reviewId: review.id,
        eventType: 'review_analysis_agent_started',
        payload: {
          provider: 'cloudflare_agents_sdk',
          model: (env.AGENT_MODEL ?? 'claude-3-7-sonnet').trim() || 'claude-3-7-sonnet',
        },
      });
    }
    if (reviewAgentEnabled && deploymentSourceBundleKey) {
      agentAnalysis = await runWorkspaceDeploymentAgentAnalysis(env, {
        reviewId: review.id,
        workspaceId: review.workspaceId,
        deploymentId: review.deploymentId,
        deploymentSandboxId: `review-snapshot-${review.id}`,
        sourceBundleKey: deploymentSourceBundleKey,
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
        rootListing: {},
        diffSnapshot: {},
      });
    }
    if (agentAnalysis) {
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
    } else if (reviewAgentEnabled && !deploymentSourceBundleKey) {
      await appendReviewEvent(env.DB, {
        reviewId: review.id,
        eventType: 'review_analysis_fallback',
        payload: {
          message: 'Deployment snapshot unavailable; skipping agent analysis',
        },
      });
    }
  } catch (error) {
    const message = formatReviewAnalysisError(error);
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_analysis_fallback',
      payload: {
        message,
      },
    });
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
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const findings = mergedFindings.map((finding) => ({
    ...finding,
    evidenceRefs: finding.evidenceRefs.filter((reference) => evidenceIds.has(reference)),
  }));

  const riskLevel = deriveRiskLevel(findings, 'low');
  const recommendation = deriveRecommendation(findings);
  const summary = {
    riskLevel,
    findingCounts: {
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

  const report: ReviewReport = {
    summary,
    findings,
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
        findingId: finding.id,
        severity: finding.severity,
        confidence: finding.confidence,
        title: finding.title,
      },
    });
  }

  return report;
}

export async function processReviewRun(env: Env, reviewId: string): Promise<void> {
  const claimed = await claimReviewRunForExecution(env.DB, reviewId);
  if (!claimed) {
    const existing = await getReviewRun(env.DB, reviewId);
    if (existing?.status === 'running') {
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

    const reviewContext = await assembleReviewContextBootstrap(env, review);
    const report = await executeReviewRun(env, review, payload, reviewContext);
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_finalize_started',
      payload: {
        findingCount: report.findings.length,
      },
    });
    await replaceReviewFindings(env.DB, reviewId, report.findings);
    await updateReviewRunStatus(env.DB, reviewId, 'succeeded', {
      report,
      markdownSummary: report.markdownSummary,
      errorCode: null,
      errorMessage: null,
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
    const message = error instanceof Error ? error.message : String(error);
    const latest = await getReviewRun(env.DB, reviewId);
    const attemptCount = latest?.attemptCount ?? review?.attemptCount ?? 0;

    if ((error instanceof QueueRetryError || transientReviewFailure(message)) && attemptCount <= REVIEW_MAX_RETRIES) {
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

export async function runReviewInlineWithRetries(env: Env, reviewId: string, maxCycles = 4): Promise<void> {
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    try {
      await processReviewRun(env, reviewId);
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
}

export function shouldRetryReviewError(error: unknown): boolean {
  if (error instanceof QueueRetryError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return transientReviewFailure(message);
}
