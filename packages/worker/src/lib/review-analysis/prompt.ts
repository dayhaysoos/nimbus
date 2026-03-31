import type { ReviewContext, ReviewSessionIntentSummary } from '../../types.js';
import { redactReviewText } from '../review-redaction.js';
import { asRecord, boundedJson } from './helpers.js';

const PROMPT_DIFF_HUNKS_MAX_BYTES = 48_000;
const PROMPT_CHANGED_FILES_MAX_BYTES = 80_000;
const PROMPT_RELATED_FILES_MAX_BYTES = 36_000;
const PROMPT_CONVENTION_FILES_MAX_BYTES = 20_000;

export interface ReviewAgentPromptInput {
  reviewId: string;
  workspaceId: string;
  deploymentId: string;
  sourceBundleKey: string;
  authoritativeDiffSnapshot?: unknown;
  goal: string;
  constraints: string[];
  decisions: string[];
  intentSessionContext: string[];
  intentSummary?: ReviewSessionIntentSummary | null;
  evidenceCatalog: Array<{ id: string; type: string; label: string; status: string }>;
  deploymentSummary: {
    provider: string;
    deployedUrl: string | null;
    validationSummary: string;
  };
  reviewContext: ReviewContext;
  rootListing: unknown;
  diffSnapshot: unknown;
  onLifecycleEvent?: (eventType: string, payload: Record<string, unknown>) => Promise<void> | void;
  openrouterApiKey?: string | null;
}

function clampText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }
  const sliced = bytes.slice(0, Math.max(0, maxBytes - 3));
  return { text: new TextDecoder().decode(sliced) + '...', truncated: true };
}

export function clampAuthoritativeDiffSnapshot(value: unknown, maxBytes: number): unknown {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return value;
  }

  const patch = typeof record.patch === 'string' ? record.patch : null;
  if (!patch) {
    return value;
  }

  const clamped = clampText(patch, maxBytes);
  return {
    ...record,
    patch: clamped.text,
    truncated: clamped.truncated || Boolean(record.truncated),
  };
}

export function sanitizePromptInput(input: ReviewAgentPromptInput): ReviewAgentPromptInput {
  const rawIntentSummary = input.intentSummary;
  const sanitizedIntentSummary = rawIntentSummary
    ? {
        goal: rawIntentSummary.goal ? redactReviewText(rawIntentSummary.goal) : null,
        prohibitions: rawIntentSummary.prohibitions.map((item) => redactReviewText(item) ?? '').filter(Boolean),
        constraints: rawIntentSummary.constraints.map((item) => redactReviewText(item) ?? '').filter(Boolean),
      }
    : null;

  return {
    ...input,
    goal: redactReviewText(input.goal) ?? input.goal,
    constraints: input.constraints.map((item) => redactReviewText(item) ?? '').filter(Boolean),
    decisions: input.decisions.map((item) => redactReviewText(item) ?? '').filter(Boolean),
    intentSessionContext: input.intentSessionContext.map((item) => redactReviewText(item) ?? '').filter(Boolean),
    intentSummary: sanitizedIntentSummary,
  };
}

export function buildReviewAgentPrompt(input: ReviewAgentPromptInput): string {
  const promptDiffSnapshot = input.authoritativeDiffSnapshot !== undefined
    ? clampAuthoritativeDiffSnapshot(input.authoritativeDiffSnapshot, 32_000)
    : undefined;
  const context = input.reviewContext;

  const changedFiles = context.retrieval.changedFiles.map((file) => ({
    path: file.path,
    content: file.content,
    byteSize: file.byteSize,
  }));
  const relatedFiles = context.retrieval.relatedFiles.map((file) => ({
    path: file.path,
    content: file.content,
    byteSize: file.byteSize,
    coChangeFrequency: file.coChangeFrequency,
    supportingSessionIds: file.supportingSessionIds,
  }));
  const conventionFiles = context.retrieval.conventionFiles.map((file) => ({
    path: file.path,
    content: file.content,
    byteSize: file.byteSize,
  }));
  const intentSummaryBlock = input.intentSummary
    ? [
        'Developer intent summary (derived from session context):',
        `Goal: ${input.intentSummary.goal ?? 'Not specified'}`,
        input.intentSummary.prohibitions.length > 0
          ? `Prohibitions:\n${input.intentSummary.prohibitions.map((item) => `- ${item}`).join('\n')}`
          : 'Prohibitions: None stated',
        input.intentSummary.constraints.length > 0
          ? `Constraints:\n${input.intentSummary.constraints.map((item) => `- ${item}`).join('\n')}`
          : 'Constraints: None stated',
      ].join('\n')
    : `Intent session context excerpts: ${JSON.stringify(input.intentSessionContext)}`;

  return [
    'You are a Senior Software Engineer conducting a pre-merge code review.',
    'Your job is to identify concrete implementation defects that matter before code ships.',
    'You are thorough, direct, and conservative — you do not invent problems.',
    '',
    'Scope rules (strict):',
    '- Review implementation correctness in changed code paths.',
    '- Do NOT critique or relitigate product decisions, policy choices, or intentional behavior changes',
    '  explicitly stated in the goal/constraints/decisions/intent context.',
    '- Treat stated constraints and decisions as requirements, not bugs.',
    '',
    'Evidence rules (required for every finding):',
    '- A concrete failing scenario must exist (specific input/state/environment).',
    '- The changed code path must actually be reachable for that scenario.',
    '- Existing guards/validation must not already prevent the issue.',
    '- State observed behavior from current code and expected behavior from requirements.',
    '- For regex/normalization/validation findings, include at least one concrete sample input and outcome.',
    '- For timeout/retry/boundary findings, include exact boundary values and resulting status.',
    '- If any of the above cannot be proven, omit the finding.',
    '- Prefer an empty findings array over speculative findings.',
    '',
    'Severity rules:',
    '- high/critical only for confirmed, material correctness/security defects in supported paths.',
    '- medium for confirmed correctness issues with constrained conditions.',
    '- low for minor confirmed edge-case correctness issues.',
    '- Do not escalate severity for hypothetical impact.',
    '',
    'Non-goals (do not file as findings):',
    '- disagreements with intentional strictness (e.g., fail-fast behavior),',
    '- disagreements with intentional backward-compatibility removal,',
    '- product-format decisions explicitly requested (e.g., display format choices),',
    '- generic hardening suggestions without a concrete failing scenario.',
    '- design-contract ambiguities unless they clearly violate an explicit Goal/Policy requirement.',
    '',
    'Use only these tools when needed: list_files, read_file, diff_summary.',
    'Never propose edits or run mutating commands.',
    '',
    'Return your final answer as raw JSON with this shape and no surrounding prose:',
    '{',
    '  "findings": [',
    '    {',
    '      "severity": "info|low|medium|high|critical",',
    '      "category": "security|logic|style|breaking-change",',
    '      "passType": "single",',
    '      "locations": [{ "filePath": string, "startLine": number|null, "endLine": number|null }],',
    '      "description": string,',
    '      "suggestedFix": string,',
    '      "failingScenario": string,',
    '      "evidence": string,',
    '      "guardGap": string',
    '    }',
    '  ],',
    '  "summary": string,',
    '  "furtherPassesLowYield": boolean',
    '}',
    '',
    'Field requirements:',
    '- summary must be a plain string. State what the diff does, the overall',
    '  risk level in one word (none/low/medium/high), and whether further',
    '  review is warranted. Do not return summary as an object or nested structure.',
    '- furtherPassesLowYield must be exactly true or false. No strings, no null.',
    '- passType must be "single" on every finding.',
    '- category must be one of: security, logic, style, breaking-change.',
    '- locations must contain at least one entry. Line numbers may be null',
    '  if the issue is file-level rather than line-level.',
    '- findings must be self-contained and actionable without rereading the diff.',
    '- each finding must include failingScenario, evidence, and guardGap as non-empty strings.',
    '- evidence should include concrete sample inputs or boundary values whenever applicable.',
    '',
    'Context weighting rules:',
    '- Changed files are directly modified in this diff. Weight them highest.',
    '- Related files are historical co-change context. Use them to understand',
    '  coupling and downstream impact, not as direct evidence of a defect.',
    '- Intent context describes the developer\'s stated goals, constraints,',
    '  prohibitions, and risk areas from session history. Use it to prioritize',
    '  review attention, not to generate findings by itself.',
    '',
    `Review Context ID: ${context.id}`,
    `Review ID: ${input.reviewId}`,
    `Workspace ID: ${input.workspaceId}`,
    `Deployment ID: ${input.deploymentId}`,
    `Checkpoint: ${context.checkpoint.checkpointId} (${context.checkpoint.branch})`,
    `Checkpoint Session ID: ${context.checkpoint.session.sessionId}`,
    `Goal: ${input.goal}`,
    `Constraints: ${JSON.stringify(input.constraints)}`,
    `Decisions: ${JSON.stringify(input.decisions)}`,
    intentSummaryBlock,
    `Deployment summary: ${JSON.stringify(input.deploymentSummary)}`,
    `Evidence catalog: ${JSON.stringify(input.evidenceCatalog)}`,
    '',
    `Diff hunks (direct changes): ${boundedJson(context.retrieval.diffHunks, PROMPT_DIFF_HUNKS_MAX_BYTES)}`,
    `Changed files (directly modified): ${boundedJson(changedFiles, PROMPT_CHANGED_FILES_MAX_BYTES)}`,
    `Related files (historical co-change context only): ${boundedJson(relatedFiles, PROMPT_RELATED_FILES_MAX_BYTES)}`,
    `Convention/config files: ${boundedJson(conventionFiles, PROMPT_CONVENTION_FILES_MAX_BYTES)}`,
    `Co-change retrieval stats: ${JSON.stringify(context.retrieval.coChange)}`,
    `Review context stats: ${JSON.stringify(context.stats)}`,
    `Authoritative deployed diff snapshot: ${JSON.stringify(promptDiffSnapshot)}`,
    `Initial root listing: ${JSON.stringify(input.rootListing)}`,
    `Initial diff snapshot: ${JSON.stringify(input.diffSnapshot)}`,
    '',
    'If you cannot justify a concrete issue, return an empty findings array',
    'with a concise summary.',
  ].join('\n');
}
