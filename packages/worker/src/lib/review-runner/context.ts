import type { Env, ReviewContext, ReviewContextMode, ReviewRunResponse } from '../../types.js';
import {
  appendReviewEvent,
  createReviewContextBlobReference,
  generateReviewContextId,
  getReviewCochangeCacheBatch,
  getWorkspace,
  getWorkspaceDeployment,
  getWorkspaceDeploymentRequestPayload,
  upsertReviewCochangeCacheBatch,
} from '../db.js';
import {
  prepareWorkspaceSourceBundleSandbox,
  readWorkspaceFilesFromSandbox,
} from '../review-analysis.js';
import { resolveReviewSandbox } from '../review-analysis/sandbox.js';
import {
  asRecord,
  discoverConventionCandidates,
  estimateTokenCount,
  mergeProvenance,
  parseChangedPathsFromDiff,
  parseDiffHunks,
  parseLocalCochangeFromProvenance,
  parseStringArray,
  rankAggregatedRelatedPaths,
  readOptionalNumber,
  readOptionalString,
  stripSensitiveTokenFields,
  uniqueStrings,
} from './context-helpers.js';
import {
  classifyCochangeSkipReason,
  fetchCochangeFromCheckpointBranch,
  getCochangeCacheErrorDetails,
  ReviewContextAssemblyError,
} from './cochange.js';
import { loadAuthoritativeDeploymentDiff } from './context-diff.js';
import { captureWorkspaceEnvironmentSnapshot } from './environment.js';
import type { ReviewRunExecutionOptions } from './shared.js';

/**
 * Builds the authoritative review context snapshot used by analysis and provenance.
 * This assembles diff, changed files, conventions, related files, co-change metadata, and stores the serialized context in R2.
 */
export async function assembleReviewContextBootstrap(
  env: Env,
  review: ReviewRunResponse,
  reviewPayload: Record<string, unknown>,
  options?: ReviewRunExecutionOptions
): Promise<ReviewContext> {
  const COCHANGE_LOOKBACK_SESSIONS = 5;
  const COCHANGE_TOP_N = 20;
  const CONVENTION_FILE_MAX_COUNT = 10;
  const reviewBasis = review.reviewBasis ?? 'checkpoint';

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_assembly_started',
    payload: {
      source: 'review_context_bootstrap',
      reviewBasis,
    },
  });

  const workspace = await getWorkspace(env.DB, review.workspaceId);
  if (!workspace) {
    throw new ReviewContextAssemblyError('review_context_workspace_not_found', `Workspace ${review.workspaceId} was not found.`);
  }
  const checkpointId = workspace.checkpointId?.trim() || null;

  const deployment = await getWorkspaceDeployment(env.DB, review.workspaceId, review.deploymentId);
  if (!deployment) {
    throw new ReviewContextAssemblyError('review_context_deployment_not_found', `Deployment ${review.deploymentId} was not found.`);
  }

  const deploymentRequest = (await getWorkspaceDeploymentRequestPayload(env.DB, review.deploymentId)) ?? {};
  const deploymentRequestProvenance = asRecord(deploymentRequest.provenance);
  const reviewRequestProvenance = asRecord(reviewPayload.provenance);
  const requestProvenance = mergeProvenance(deploymentRequestProvenance, reviewRequestProvenance);
  const sessionIds = uniqueStrings(parseStringArray(requestProvenance.sessionIds));
  const sessionIntentCandidates = uniqueStrings(parseStringArray(requestProvenance.intentSessionContext));
  const hasRawSessionPrompts = typeof requestProvenance.rawSessionPrompts === 'string' && requestProvenance.rawSessionPrompts.trim().length > 0;
  const requestedReviewContextMode = readOptionalString(requestProvenance.reviewContextMode);
  const reviewContextMode: ReviewContextMode =
    requestedReviewContextMode === 'basic'
      ? 'basic'
      : requestedReviewContextMode === 'intent_aware'
        ? 'intent_aware'
        : sessionIds.length > 0 || sessionIntentCandidates.length > 0 || hasRawSessionPrompts
          ? 'intent_aware'
          : 'basic';
  if (reviewContextMode === 'intent_aware' && sessionIds.length === 0) {
    throw new ReviewContextAssemblyError(
      'unsupported_without_entire_checkpoint_context',
      'Review context assembly requires at least one Entire sessionId in deployment provenance.'
    );
  }

  const sessionId = reviewContextMode === 'intent_aware' ? (sessionIds[0] ?? null) : null;
  const sessionIntent = reviewContextMode === 'intent_aware' ? (sessionIntentCandidates[0] ?? null) : null;
  const attributionTrailer = readOptionalString(requestProvenance.attributionTrailer);
  const agentType = reviewContextMode === 'intent_aware' ? readOptionalString(requestProvenance.agentType) : null;
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
      reviewContextMode,
    },
  });

  const result = asRecord(deployment.result);
  const resultProvenance = asRecord(result.provenance);
  const resultArtifact = asRecord(result.artifact);
  const environmentRevision = asRecord(requestProvenance.environmentRevision);
  const expectedEnvironmentDiffSha256 = readOptionalString(environmentRevision.diffSha256);
  const deploymentSourceBundleKey =
    typeof resultArtifact.sourceBundleKey === 'string' && resultArtifact.sourceBundleKey.trim()
      ? resultArtifact.sourceBundleKey.trim()
      : deployment.sourceBundleKey ?? null;

  let diffPatch: string | null = null;
  let changedPaths: string[] = [];
  let diffHunks: ReviewContext['retrieval']['diffHunks'] = [];
  let diffSource: string | null = null;
  let diffArtifactId: string | null = null;
  let diffFallbackUsed = false;

  if (reviewBasis === 'environment') {
    const environmentSnapshot = await captureWorkspaceEnvironmentSnapshot(env, {
      id: review.workspaceId,
      status: workspace?.status ?? 'ready',
      sandboxId: workspace?.sandboxId ?? '',
      baselineReady: workspace?.baselineReady ?? false,
      sourceBundleKey: workspace?.sourceBundleKey ?? '',
      sourceBundleSha256: workspace?.sourceBundleSha256 ?? '',
    });
    if (expectedEnvironmentDiffSha256 && expectedEnvironmentDiffSha256 !== environmentSnapshot.revision.diffSha256) {
      throw new ReviewContextAssemblyError(
        'review_context_environment_drift',
        'Workspace environment changed after this review pass was requested. Start a new environment review pass.'
      );
    }
    diffPatch = environmentSnapshot.patch;
    changedPaths = environmentSnapshot.changedPaths;
    diffHunks = environmentSnapshot.diffHunks;
    diffSource = environmentSnapshot.revision.source;
  } else {
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
    diffPatch = authoritativeDiffPatch ?? commitDiffPatch ?? null;
    if (!diffPatch) {
      throw new ReviewContextAssemblyError(
        'review_context_diff_missing',
        'Review context assembly requires non-empty diff patch context. Ensure deployment provenance includes review diff artifact or commit diff patch.'
      );
    }
    changedPaths = parseChangedPathsFromDiff(diffPatch);
    diffHunks = parseDiffHunks(diffPatch);
    diffSource = authoritativeDiffPatch ? authoritativeDiff?.source ?? null : commitDiffPatch ? 'commit_patch' : null;
    diffArtifactId = authoritativeDiffPatch ? authoritativeDiff?.artifactId ?? null : null;
    diffFallbackUsed = !authoritativeDiffPatch && Boolean(commitDiffPatch);
  }

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_diff_collected',
    payload: {
      source: diffSource,
      artifactId: diffArtifactId,
      hasDiff: Boolean(diffPatch),
      patchBytes: diffPatch ? new TextEncoder().encode(diffPatch).byteLength : 0,
      fallbackUsed: diffFallbackUsed,
      reviewBasis,
    },
  });

  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_context_changed_files_collected',
    payload: {
      changedFileCount: changedPaths.length,
    },
  });

  if (!deploymentSourceBundleKey && reviewBasis !== 'environment') {
    throw new ReviewContextAssemblyError(
      'review_context_source_bundle_missing',
      'Review context assembly requires deployment source bundle key.'
    );
  }

  const checkpointSnapshotSandboxId = reviewBasis === 'checkpoint' ? `review-context-${review.id}` : null;
  if (checkpointSnapshotSandboxId && deploymentSourceBundleKey && changedPaths.length > 0) {
    // Reuse one hydrated snapshot sandbox across all checkpoint context reads. Immediate destroy on
    // per-read temp sandboxes has proven flaky against @cloudflare/sandbox in live execution.
    await prepareWorkspaceSourceBundleSandbox(env, {
      sourceBundleKey: deploymentSourceBundleKey,
      sandboxId: checkpointSnapshotSandboxId,
    });
  }

  const shouldDestroyCheckpointSnapshotSandbox = Boolean(
    checkpointSnapshotSandboxId && deploymentSourceBundleKey && changedPaths.length > 0
  );

  try {
    const changedFileReads = changedPaths.length
      ? reviewBasis === 'environment'
        ? await readWorkspaceFilesFromSandbox(env, {
            sandboxId: workspace?.sandboxId ?? '',
            paths: changedPaths,
          })
        : await readWorkspaceFilesFromSandbox(env, {
            sandboxId: checkpointSnapshotSandboxId ?? '',
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
      ? reviewBasis === 'environment'
        ? await readWorkspaceFilesFromSandbox(env, {
            sandboxId: workspace?.sandboxId ?? '',
            paths: conventionCandidates,
          })
        : await readWorkspaceFilesFromSandbox(env, {
            sandboxId: checkpointSnapshotSandboxId ?? '',
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
    if (reviewContextMode === 'intent_aware') {
      throw new ReviewContextAssemblyError(
        'unsupported_without_entire_checkpoint_context',
        'Review context assembly requires repository slug in deployment provenance (provenance.repo).'
      );
    }
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
  let coChangeSource: 'entire/checkpoints/v1' | 'local_git' | 'none' =
    reviewContextMode === 'basic' ? 'none' : 'entire/checkpoints/v1';
  let coChangeLookbackSessions = COCHANGE_LOOKBACK_SESSIONS;
  let coChangeTopN = COCHANGE_TOP_N;
  const localCochange = parseLocalCochangeFromProvenance(requestProvenance.localCochange);
  const githubToken = readOptionalString(options?.cochangeGithubToken);

  if (reviewContextMode === 'basic') {
    coChangeSkipped = true;
    coChangeSkipReason = 'basic_review_mode';
  } else try {
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
          'co-change retrieval requires a scoped GitHub token - provide X-Review-Github-Token (CLI: set REVIEW_CONTEXT_GITHUB_TOKEN) when creating the review request.'
        );
      }

      const changedPathsMissingCache: string[] = [];
      const cachedRows: Array<{
        filePath: string;
        cochange: Array<{ path: string; frequency: number; sessionIds: string[] }>;
        lastUpdated: string;
        lookbackSessions: number;
      }> = await getReviewCochangeCacheBatch(env.DB, {
        repo: repoSlug ?? '',
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
        const fetched = await fetchCochangeFromCheckpointBranch(
          repoSlug ?? '',
          changedPathsMissingCache,
          COCHANGE_LOOKBACK_SESSIONS,
          githubToken
        );
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
            repo: repoSlug ?? '',
            branch: 'entire/checkpoints/v1',
            cochange: entries,
            lookbackSessions: COCHANGE_LOOKBACK_SESSIONS,
          });
        }
        await upsertReviewCochangeCacheBatch(env.DB, cacheUpserts);
      }
    }

    const rankedRelated = rankAggregatedRelatedPaths(changedPaths, entriesByChangedPath, effectiveTopN);

    const relatedReads = rankedRelated.length
      ? reviewBasis === 'environment'
        ? await readWorkspaceFilesFromSandbox(env, {
            sandboxId: workspace?.sandboxId ?? '',
            paths: rankedRelated.map((item) => item.path),
          })
        : await readWorkspaceFilesFromSandbox(env, {
            sandboxId: checkpointSnapshotSandboxId ?? '',
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
    const sanitizedErrorDetails = error instanceof Error ? error.message : String(error);
    const cacheErrorDetails = getCochangeCacheErrorDetails(error) ?? sanitizedErrorDetails;
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
    contextMode: reviewContextMode,
    checkpoint: {
      checkpointId,
      branch: reviewContextMode === 'intent_aware' ? 'entire/checkpoints/v1' : null,
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
      reviewBasis,
      reviewContextMode,
    },
  });

    return contextPayload;
  } finally {
    if (shouldDestroyCheckpointSnapshotSandbox && checkpointSnapshotSandboxId) {
      try {
        const checkpointSandbox = await resolveReviewSandbox(env, checkpointSnapshotSandboxId);
        if (typeof checkpointSandbox.destroy === 'function') {
          await checkpointSandbox.destroy();
        }
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
