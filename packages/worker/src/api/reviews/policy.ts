import type { AuthContext, Env } from '../../types.js';
import {
  appendReviewEvent,
  createReviewRun,
  generateReviewRunId,
  getReviewRun,
  getWorkspace,
  getWorkspaceAccountId,
  getWorkspaceDeployment,
  updateReviewRunPolicy,
  updateReviewRunStatus,
} from '../../lib/db.js';
import { createReviewQueueMessage } from '../../lib/review-queue.js';
import { summarizeReviewIntentPolicy } from '../../lib/review-runner.js';
import {
  fallbackDerivedPolicy,
  isRecord,
  jsonResponse,
  normalizeBranchRef,
  normalizeIntentSummaryModel,
  normalizeRepoSlug,
  normalizeReviewPolicy,
  policyFromIntentSummary,
  readOpenrouterApiKeyHeader,
  readReviewGithubTokenHeader,
  requireReviewAccess,
  requireWorkspaceAccess,
  sha256Hex,
  withSortedKeys,
} from './shared.js';

export async function handleDeriveReviewPolicy(
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);

  if (!env.REVIEWS_QUEUE || !env.ReviewRunner) {
    return jsonResponse(
      {
        error: 'Review runner is unavailable',
        code: 'review_runner_unavailable',
      },
      503
    );
  }

  let createdReviewId: string | null = null;
  try {
    const payloadRaw = await request.text();
    const payload = payloadRaw.trim() ? (JSON.parse(payloadRaw) as unknown) : {};
    if (!isRecord(payload)) {
      return jsonResponse({ error: 'Request body must be a JSON object' }, 400);
    }

    const target = isRecord(payload.target) ? payload.target : {};
    const workspaceId =
      typeof payload.workspaceId === 'string' && payload.workspaceId.trim()
        ? payload.workspaceId.trim()
        : typeof target.workspaceId === 'string' && target.workspaceId.trim()
          ? target.workspaceId.trim()
          : '';
    const deploymentId =
      typeof payload.deploymentId === 'string' && payload.deploymentId.trim()
        ? payload.deploymentId.trim()
        : typeof target.deploymentId === 'string' && target.deploymentId.trim()
          ? target.deploymentId.trim()
          : '';

    if (!workspaceId || !deploymentId) {
      return jsonResponse({ error: 'workspaceId and deploymentId are required' }, 400);
    }

    const workspaceAccessResponse = await requireWorkspaceAccess(env, workspaceId, effectiveAuthContext);
    if (workspaceAccessResponse) {
      return workspaceAccessResponse;
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace || workspace.status === 'deleted') {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
    if (!deployment) {
      return jsonResponse({ error: 'Deployment not found' }, 404);
    }
    if (deployment.status !== 'succeeded') {
      return jsonResponse(
        {
          error: 'Review target deployment must be succeeded',
          code: 'deployment_not_reviewable',
        },
        409
      );
    }

    const workspaceAccountId = await getWorkspaceAccountId(env.DB, workspaceId);
    if (workspaceAccountId === undefined) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const provenance = isRecord(payload.provenance) ? payload.provenance : {};
    const reviewRepo = normalizeRepoSlug(provenance.repo);
    const reviewBranch = normalizeBranchRef(provenance.branch);
    if (!reviewRepo || !reviewBranch) {
      return jsonResponse(
        {
          error: 'Missing required provenance.repo or provenance.branch',
          code: 'invalid_review_provenance',
        },
        400
      );
    }
    const rawSessionPrompts =
      typeof provenance.rawSessionPrompts === 'string' && provenance.rawSessionPrompts.trim()
        ? provenance.rawSessionPrompts.trim().slice(0, 24000)
        : null;
    const intentSessionContext = Array.isArray(provenance.intentSessionContext)
      ? provenance.intentSessionContext
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 50)
      : [];
    const intentSummaryModel = normalizeIntentSummaryModel(provenance.intentSummaryModel);

    const requestPayload = {
      target: {
        type: 'workspace_deployment' as const,
        workspaceId,
        deploymentId,
      },
      mode: 'report_only' as const,
      provenance,
    };
    const requestPayloadSha256 = await sha256Hex(JSON.stringify(withSortedKeys(requestPayload)));
    const reviewId = generateReviewRunId();
    createdReviewId = reviewId;

    const created = await createReviewRun(env.DB, {
      id: reviewId,
      workspaceId,
      deploymentId,
      targetType: 'workspace_deployment',
      mode: 'report_only',
      status: 'policy_pending',
      idempotencyKey: `policy-derive-${reviewId}`,
      requestPayload,
      requestPayloadSha256,
      accountId: workspaceAccountId,
      provenance: {
        promptSummary: `Policy derivation for deployment ${deploymentId} in workspace ${workspaceId}`,
      },
      repo: reviewRepo,
      branch: reviewBranch,
    });

    await appendReviewEvent(env.DB, {
      reviewId: created.review.id,
      eventType: 'review_created',
      payload: {
        workspaceId,
        deploymentId,
        mode: 'report_only',
      },
    });
    await appendReviewEvent(env.DB, {
      reviewId: created.review.id,
      eventType: 'review_policy_derivation_started',
      payload: {
        hasRawSessionPrompts: Boolean(rawSessionPrompts),
      },
    });

    const derivedIntentSummary = rawSessionPrompts
      ? await summarizeReviewIntentPolicy(env, {
          rawSessionPrompts,
          intentSessionContext,
          openrouterApiKey: readOpenrouterApiKeyHeader(request),
          intentSummaryModel,
        })
      : null;
    const derivedPolicy =
      policyFromIntentSummary(derivedIntentSummary) ??
      fallbackDerivedPolicy({
        workspaceId,
        deploymentId,
        provenance,
      });

    await updateReviewRunPolicy(env.DB, created.review.id, {
      derivedPolicy,
    });
    await updateReviewRunStatus(env.DB, created.review.id, 'policy_ready', {
      errorCode: null,
      errorMessage: null,
    });
    await appendReviewEvent(env.DB, {
      reviewId: created.review.id,
      eventType: 'review_policy_derivation_completed',
      payload: {
        policyReady: true,
      },
    });

    return jsonResponse(
      {
        reviewId: created.review.id,
        status: 'policy_ready',
        derivedPolicy,
      },
      202
    );
  } catch (error) {
    if (createdReviewId) {
      const message = error instanceof Error ? error.message : String(error);
      await updateReviewRunStatus(env.DB, createdReviewId, 'failed', {
        errorCode: 'policy_derivation_failed',
        errorMessage: message,
      });
      await appendReviewEvent(env.DB, {
        reviewId: createdReviewId,
        eventType: 'review_failed',
        payload: {
          code: 'policy_derivation_failed',
          message,
        },
      }).catch(() => undefined);
    }

    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to derive review policy: ${message}` }, 500);
  }
}

export async function handleApproveReviewPolicy(
  reviewId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);

  if (!env.REVIEWS_QUEUE || !env.ReviewRunner) {
    return jsonResponse(
      {
        error: 'Review runner is unavailable',
        code: 'review_runner_unavailable',
      },
      503
    );
  }

  try {
    const reviewAccessResponse = await requireReviewAccess(env, reviewId, effectiveAuthContext);
    if (reviewAccessResponse) {
      return reviewAccessResponse;
    }

    const review = await getReviewRun(env.DB, reviewId);
    if (!review) {
      return jsonResponse({ error: 'Review not found' }, 404);
    }

    if (review.status !== 'policy_ready') {
      return jsonResponse(
        {
          error: 'Review policy is not ready for approval',
          code: 'invalid_policy_state',
          expectedStatus: 'policy_ready',
          currentStatus: review.status,
        },
        409
      );
    }

    const payloadRaw = await request.text();
    const payload = payloadRaw.trim() ? (JSON.parse(payloadRaw) as unknown) : {};
    if (!isRecord(payload)) {
      return jsonResponse({ error: 'Request body must be a JSON object' }, 400);
    }

    const approvedPolicy = normalizeReviewPolicy(payload.approvedPolicy);
    if (!approvedPolicy) {
      return jsonResponse(
        {
          error: 'approvedPolicy must include at least one non-empty policy field',
          code: 'invalid_review_policy',
        },
        400
      );
    }

    const approvedPolicySha256 = await sha256Hex(JSON.stringify(withSortedKeys(approvedPolicy)));
    await updateReviewRunPolicy(env.DB, reviewId, {
      approvedPolicy,
      approvedPolicySha256,
    });
    await updateReviewRunStatus(env.DB, reviewId, 'policy_approved', {
      errorCode: null,
      errorMessage: null,
    });

    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_policy_approved',
      payload: {
        approvedPolicySha256,
      },
    });

    const openrouterApiKey = readOpenrouterApiKeyHeader(request);
    await env.REVIEWS_QUEUE.send(
      createReviewQueueMessage(reviewId, readReviewGithubTokenHeader(request), openrouterApiKey)
    );
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_enqueued',
      payload: {
        mode: 'queue',
        policyApproved: true,
      },
    });

    return jsonResponse(
      {
        reviewId,
        approvedPolicySha256,
      },
      202
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to approve review policy: ${message}` }, 500);
  }
}

export async function handleCreateReviewPolicy(
  request: Request,
  env: Env,
  authContext: AuthContext
): Promise<Response> {
  if (authContext.isHostedMode && !authContext.isAuthenticated) {
    return jsonResponse({ error: 'Authentication required' }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!isRecord(payload)) {
    return jsonResponse({ error: 'Request body must be an object' }, 400);
  }

  const rawSessionPrompts =
    typeof payload.rawSessionPrompts === 'string' && payload.rawSessionPrompts.trim()
      ? payload.rawSessionPrompts.trim().slice(0, 24000)
      : '';
  if (!rawSessionPrompts) {
    return jsonResponse({ error: 'rawSessionPrompts is required', code: 'invalid_review_policy_input' }, 400);
  }

  const intentSessionContext = Array.isArray(payload.intentSessionContext)
    ? payload.intentSessionContext
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 50)
    : [];
  const intentSummaryModel = normalizeIntentSummaryModel(payload.model) ?? normalizeIntentSummaryModel(payload.intentSummaryModel);
  const openrouterApiKey = readOpenrouterApiKeyHeader(request);

  const summary = await summarizeReviewIntentPolicy(env, {
    rawSessionPrompts,
    intentSessionContext,
    openrouterApiKey,
    intentSummaryModel,
  });

  return jsonResponse({
    policy: summary ?? {
      goal: null,
      prohibitions: [],
      constraints: [],
    },
    source: summary ? 'model_or_fallback' : 'empty',
  });
}
