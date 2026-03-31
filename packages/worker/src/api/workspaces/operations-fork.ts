import { claimWorkspaceOperationForExecution, updateWorkspaceOperationStatus } from '../../lib/db.js';
import type { Env, WorkspaceResponse } from '../../types.js';
import {
  detectPotentialSecrets,
  getWorkspaceSandbox,
  listOversizedWorkspaceFiles,
  workspaceHasChanges,
  workspaceHasGitHead,
} from './sandbox.js';
import {
  createGitHubAppJwt,
  createInstallationToken,
  enforceForkTargetPolicy,
  executeForkCommitAndPushInSandbox,
  githubRequest,
  OperationPreflightError,
  parseForkGithubPayload,
  resolveBranchForFork,
  resolveGitHubInstallationId,
} from './github.js';
import { sanitizeErrorMessage } from './operations-helpers.js';

export async function executeForkGithubWorkspaceOperation(
  env: Env,
  workspace: WorkspaceResponse,
  operationId: string,
  requestPayload: Record<string, unknown>
): Promise<void> {
  const claimed = await claimWorkspaceOperationForExecution(env.DB, workspace.id, operationId);
  if (!claimed) {
    return;
  }

  let partialForkContext: Record<string, unknown> | null = null;

  try {
    const payload = parseForkGithubPayload(requestPayload);
    enforceForkTargetPolicy(env, payload.target.owner);

    const appJwt = await createGitHubAppJwt(env);
    const installationId = await resolveGitHubInstallationId(
      env,
      appJwt,
      payload.target.owner,
      payload.target.repo,
      payload.installationId
    );
    const installationToken = await createInstallationToken(env, appJwt, installationId);

    const repoInfo = await githubRequest<{ default_branch: string }>(
      env,
      `/repos/${payload.target.owner}/${payload.target.repo}`,
      { token: installationToken }
    );

    await githubRequest(env, `/repos/${payload.target.owner}/${payload.target.repo}/git/commits/${workspace.commitSha}`, {
      token: installationToken,
    });

    const defaultRef = await githubRequest<{ object: { sha: string } }>(
      env,
      `/repos/${payload.target.owner}/${payload.target.repo}/git/ref/heads/${encodeURIComponent(repoInfo.default_branch)}`,
      { token: installationToken }
    );

    const warnings: Array<Record<string, unknown>> = [];
    if (defaultRef.object.sha !== workspace.commitSha) {
      warnings.push({
        code: 'baseline_stale',
        message: 'Forked from workspace baseline while target default branch has moved',
        details: {
          baselineSha: workspace.commitSha,
          defaultBranch: repoInfo.default_branch,
          defaultBranchHeadSha: defaultRef.object.sha,
        },
      });
    }

    const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
    if (!(await workspaceHasGitHead(sandbox))) {
      throw new OperationPreflightError('baseline_missing', 'Workspace git baseline is missing');
    }

    const oversizedFiles = await listOversizedWorkspaceFiles(sandbox, 100 * 1024 * 1024);
    if (oversizedFiles.length > 0) {
      throw new OperationPreflightError('file_too_large_for_github', 'Workspace contains files over GitHub blob limit', {
        files: oversizedFiles,
      });
    }

    const secretMatches = await detectPotentialSecrets(sandbox);
    if (secretMatches.length > 0) {
      const shouldBlock = (env.BLOCK_ON_SECRET_MATCH ?? 'false').toLowerCase() === 'true';
      if (shouldBlock) {
        throw new OperationPreflightError('secret_match_blocked', 'Potential secrets detected in workspace', {
          files: secretMatches,
        });
      }
      warnings.push({
        code: 'secret_match',
        message: `Potential secret patterns detected in ${secretMatches.length} files`,
        details: { files: secretMatches },
      });
    }

    const hasChanges = await workspaceHasChanges(sandbox);
    if (!hasChanges) {
      throw new OperationPreflightError('no_changes', 'Workspace has no changes to fork');
    }

    const resolvedBranch = await resolveBranchForFork(
      env,
      installationToken,
      payload.target.owner,
      payload.target.repo,
      payload.target.branch,
      workspace.id
    );

    partialForkContext = {
      target: {
        owner: payload.target.owner,
        repo: payload.target.repo,
        branch: resolvedBranch.branch,
      },
    };

    await githubRequest(env, `/repos/${payload.target.owner}/${payload.target.repo}/git/refs`, {
      method: 'POST',
      token: installationToken,
      body: {
        ref: `refs/heads/${resolvedBranch.branch}`,
        sha: workspace.commitSha,
      },
    });

    partialForkContext = {
      ...partialForkContext,
      branchCreated: true,
      branchRef: `refs/heads/${resolvedBranch.branch}`,
    };

    const commitMessage = payload.commit?.message?.trim() || `Apply Nimbus workspace ${workspace.id} changes from ${workspace.commitSha}`;
    const commitSha = await executeForkCommitAndPushInSandbox(sandbox, {
      owner: payload.target.owner,
      repo: payload.target.repo,
      token: installationToken,
      baselineSha: workspace.commitSha,
      branch: resolvedBranch.branch,
      commitMessage,
    });

    await updateWorkspaceOperationStatus(env.DB, operationId, 'succeeded', {
      warnings,
      result: {
        target: {
          owner: payload.target.owner,
          repo: payload.target.repo,
          branch: resolvedBranch.branch,
        },
        branchRef: `refs/heads/${resolvedBranch.branch}`,
        commitSha,
        repoUrl: `https://github.com/${payload.target.owner}/${payload.target.repo}`,
        compareUrl: `https://github.com/${payload.target.owner}/${payload.target.repo}/compare/${encodeURIComponent(
          repoInfo.default_branch
        )}...${encodeURIComponent(resolvedBranch.branch)}`,
      },
    });
  } catch (error) {
    if (error instanceof OperationPreflightError) {
      await updateWorkspaceOperationStatus(env.DB, operationId, 'failed', {
        errorCode: error.code,
        errorClass: 'preflight_error',
        errorMessage: error.message,
        errorDetails: {
          ...(error.details ?? {}),
          ...(partialForkContext ? { partial: partialForkContext } : {}),
        },
      });
      return;
    }

    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    await updateWorkspaceOperationStatus(env.DB, operationId, 'failed', {
      errorCode: 'operation_failed',
      errorClass: 'runtime_error',
      errorMessage: message,
      errorDetails: {
        operationType: 'fork_github',
        ...(partialForkContext ? { partial: partialForkContext } : {}),
      },
    });
  }
}
