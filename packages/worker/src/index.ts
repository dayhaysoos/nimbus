import { Sandbox } from '@cloudflare/sandbox';
import { handleGetJob, handleListJobs } from './api/jobs.js';
import { handleGetJobEvents } from './api/job-events.js';
import { handleCreateCheckpointJob } from './api/checkpoint-jobs.js';
import {
  handleCancelWorkspaceTask,
  handleCreateWorkspaceTask,
  handleGetWorkspaceTask,
  handleGetWorkspaceTaskEvents,
} from './api/workspace-tasks.js';
import {
  handleCancelWorkspaceDeployment,
  handleCreateWorkspaceDeployment,
  handleGetWorkspaceDeployment,
  handleGetWorkspaceDeploymentEvents,
  handleWorkspaceDeploymentPreflight,
} from './api/workspace-deployments.js';
import {
  handleCreateWorkspace,
  handleCreateWorkspaceGithubFork,
  handleCreateWorkspacePatchExport,
  handleCreateWorkspaceZipExport,
  handleDownloadWorkspaceArtifact,
  handleDeleteWorkspace,
  handleGetWorkspaceDiff,
  handleGetWorkspaceFile,
  handleGetWorkspace,
  handleGetWorkspaceEvents,
  handleGetWorkspaceOperation,
  handleListWorkspaceArtifacts,
  handleListWorkspaceFiles,
  handleResetWorkspace,
} from './api/workspaces.js';
import { parseCheckpointJobQueueMessage } from './lib/checkpoint-queue.js';
import { processCheckpointJob } from './lib/checkpoint-runner.js';
import { parseWorkspaceTaskQueueMessage } from './lib/workspace-task-queue.js';
import { processWorkspaceTask, shouldRetryWorkspaceTaskError } from './lib/workspace-task-runner.js';
import { parseWorkspaceDeploymentQueueMessage } from './lib/workspace-deployment-queue.js';
import {
  processWorkspaceDeployment,
  shouldRetryWorkspaceDeploymentError,
} from './lib/workspace-deployment-runner.js';
import type { Env } from './types.js';

// Re-export Sandbox for Durable Object binding
export { Sandbox };

// CORS headers for local development
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Route: POST /api/checkpoint/jobs - Create new checkpoint-based deployment job
    if (url.pathname === '/api/checkpoint/jobs' && request.method === 'POST') {
      return handleCreateCheckpointJob(request, env);
    }

    // Route: POST /api/workspaces - Create workspace from checkpoint source bundle
    if (url.pathname === '/api/workspaces' && request.method === 'POST') {
      return handleCreateWorkspace(request, env);
    }

    // Route: GET /api/workspaces/:id/events - List workspace events
    const workspaceEventsMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/events$/);
    if (workspaceEventsMatch && request.method === 'GET') {
      return handleGetWorkspaceEvents(workspaceEventsMatch[1], request, env);
    }

    // Route: POST /api/workspaces/:id/export/zip - Queue zip export operation
    const workspaceZipExportMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/export\/zip$/);
    if (workspaceZipExportMatch && request.method === 'POST') {
      return handleCreateWorkspaceZipExport(workspaceZipExportMatch[1], request, env, ctx);
    }

    // Route: POST /api/workspaces/:id/export/patch - Queue patch export operation
    const workspacePatchExportMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/export\/patch$/);
    if (workspacePatchExportMatch && request.method === 'POST') {
      return handleCreateWorkspacePatchExport(workspacePatchExportMatch[1], request, env, ctx);
    }

    // Route: POST /api/workspaces/:id/fork/github - Queue GitHub fork operation
    const workspaceForkGithubMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/fork\/github$/);
    if (workspaceForkGithubMatch && request.method === 'POST') {
      return handleCreateWorkspaceGithubFork(workspaceForkGithubMatch[1], request, env, ctx);
    }

    // Route: GET /api/workspaces/:id/operations/:operationId - Poll workspace operation status
    const workspaceOperationMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/operations\/([a-z0-9_]+)$/);
    if (workspaceOperationMatch && request.method === 'GET') {
      return handleGetWorkspaceOperation(workspaceOperationMatch[1], workspaceOperationMatch[2], env);
    }

    // Route: GET /api/workspaces/:id/artifacts - List workspace artifacts
    const workspaceArtifactsMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/artifacts$/);
    if (workspaceArtifactsMatch && request.method === 'GET') {
      return handleListWorkspaceArtifacts(workspaceArtifactsMatch[1], env);
    }

    // Route: GET /api/workspaces/:id/artifacts/:artifactId/download - Download artifact bytes
    const workspaceArtifactDownloadMatch = url.pathname.match(
      /^\/api\/workspaces\/([a-z0-9_]+)\/artifacts\/([a-z0-9_]+)\/download$/
    );
    if (workspaceArtifactDownloadMatch && request.method === 'GET') {
      return handleDownloadWorkspaceArtifact(
        workspaceArtifactDownloadMatch[1],
        workspaceArtifactDownloadMatch[2],
        request,
        env
      );
    }

    // Route: POST /api/workspaces/:id/tasks - Queue agentic workspace task
    const workspaceTasksCreateMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/tasks$/);
    if (workspaceTasksCreateMatch && request.method === 'POST') {
      return handleCreateWorkspaceTask(workspaceTasksCreateMatch[1], request, env, ctx);
    }

    // Route: GET /api/workspaces/:id/tasks/:taskId - Poll workspace task status
    const workspaceTaskGetMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/tasks\/([a-z0-9_]+)$/);
    if (workspaceTaskGetMatch && request.method === 'GET') {
      return handleGetWorkspaceTask(workspaceTaskGetMatch[1], workspaceTaskGetMatch[2], env);
    }

    // Route: GET /api/workspaces/:id/tasks/:taskId/events - Poll workspace task events
    const workspaceTaskEventsMatch = url.pathname.match(
      /^\/api\/workspaces\/([a-z0-9_]+)\/tasks\/([a-z0-9_]+)\/events$/
    );
    if (workspaceTaskEventsMatch && request.method === 'GET') {
      return handleGetWorkspaceTaskEvents(workspaceTaskEventsMatch[1], workspaceTaskEventsMatch[2], request, env);
    }

    // Route: POST /api/workspaces/:id/tasks/:taskId/cancel - Request task cancellation
    const workspaceTaskCancelMatch = url.pathname.match(
      /^\/api\/workspaces\/([a-z0-9_]+)\/tasks\/([a-z0-9_]+)\/cancel$/
    );
    if (workspaceTaskCancelMatch && request.method === 'POST') {
      return handleCancelWorkspaceTask(workspaceTaskCancelMatch[1], workspaceTaskCancelMatch[2], env);
    }

    // Route: POST /api/workspaces/:id/deploy - Queue workspace deployment
    const workspaceDeployCreateMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/deploy$/);
    if (workspaceDeployCreateMatch && request.method === 'POST') {
      return handleCreateWorkspaceDeployment(workspaceDeployCreateMatch[1], request, env, ctx);
    }

    // Route: POST /api/workspaces/:id/deploy/preflight - Validate deploy readiness
    const workspaceDeployPreflightMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/deploy\/preflight$/);
    if (workspaceDeployPreflightMatch && request.method === 'POST') {
      return handleWorkspaceDeploymentPreflight(workspaceDeployPreflightMatch[1], request, env);
    }

    // Route: GET /api/workspaces/:id/deployments/:deploymentId - Poll deployment status
    const workspaceDeploymentGetMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/deployments\/([a-z0-9_]+)$/);
    if (workspaceDeploymentGetMatch && request.method === 'GET') {
      return handleGetWorkspaceDeployment(workspaceDeploymentGetMatch[1], workspaceDeploymentGetMatch[2], env);
    }

    // Route: GET /api/workspaces/:id/deployments/:deploymentId/events - Poll deployment events
    const workspaceDeploymentEventsMatch = url.pathname.match(
      /^\/api\/workspaces\/([a-z0-9_]+)\/deployments\/([a-z0-9_]+)\/events$/
    );
    if (workspaceDeploymentEventsMatch && request.method === 'GET') {
      return handleGetWorkspaceDeploymentEvents(
        workspaceDeploymentEventsMatch[1],
        workspaceDeploymentEventsMatch[2],
        request,
        env
      );
    }

    // Route: POST /api/workspaces/:id/deployments/:deploymentId/cancel - Cancel deployment
    const workspaceDeploymentCancelMatch = url.pathname.match(
      /^\/api\/workspaces\/([a-z0-9_]+)\/deployments\/([a-z0-9_]+)\/cancel$/
    );
    if (workspaceDeploymentCancelMatch && request.method === 'POST') {
      return handleCancelWorkspaceDeployment(
        workspaceDeploymentCancelMatch[1],
        workspaceDeploymentCancelMatch[2],
        env,
        ctx
      );
    }

    // Route: GET /api/workspaces/:id/files - List files for a path
    const workspaceFilesMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/files$/);
    if (workspaceFilesMatch && request.method === 'GET') {
      return handleListWorkspaceFiles(workspaceFilesMatch[1], request, env);
    }

    // Route: GET /api/workspaces/:id/file - Read a single file
    const workspaceFileMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/file$/);
    if (workspaceFileMatch && request.method === 'GET') {
      return handleGetWorkspaceFile(workspaceFileMatch[1], request, env);
    }

    // Route: GET /api/workspaces/:id/diff - View workspace diff metadata/patch
    const workspaceDiffMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/diff$/);
    if (workspaceDiffMatch && request.method === 'GET') {
      return handleGetWorkspaceDiff(workspaceDiffMatch[1], request, env);
    }

    // Route: POST /api/workspaces/:id/reset - Reset workspace to baseline source snapshot
    const workspaceResetMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)\/reset$/);
    if (workspaceResetMatch && request.method === 'POST') {
      return handleResetWorkspace(workspaceResetMatch[1], env);
    }

    // Route: GET /api/workspaces/:id - Get workspace
    // Route: DELETE /api/workspaces/:id - Delete workspace
    const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9_]+)$/);
    if (workspaceMatch && request.method === 'GET') {
      return handleGetWorkspace(workspaceMatch[1], env);
    }
    if (workspaceMatch && request.method === 'DELETE') {
      return handleDeleteWorkspace(workspaceMatch[1], env);
    }

    // Route: GET /api/jobs - List all jobs
    if (url.pathname === '/api/jobs' && request.method === 'GET') {
      return handleListJobs(env);
    }

    // Route: GET /api/jobs/:id - Get job by ID
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9_]+)$/);
    if (jobMatch && request.method === 'GET') {
      return handleGetJob(jobMatch[1], env);
    }

    // Route: GET /api/jobs/:id/events - Event stream placeholder
    const jobEventsMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9_]+)\/events$/);
    if (jobEventsMatch && request.method === 'GET') {
      return handleGetJobEvents(jobEventsMatch[1], request, env);
    }

    // Route: GET /health
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 404 for unknown routes
    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body as Record<string, unknown> | null;
      const type = typeof body?.type === 'string' ? body.type : '';

      if (type === 'workspace_task_created') {
        let payload;
        try {
          payload = parseWorkspaceTaskQueueMessage(message.body);
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          console.error(`[workspace-task-queue] invalid message dropped: ${details}`);
          continue;
        }

        try {
          await processWorkspaceTask(env, payload.workspaceId, payload.taskId);
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          console.error(`[workspace-task-queue] message handling failed: ${details}`);
          if (shouldRetryWorkspaceTaskError(error)) {
            message.retry();
          }
        }
        continue;
      }

      if (type === 'workspace_deployment_requested') {
        let payload;
        try {
          payload = parseWorkspaceDeploymentQueueMessage(message.body);
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          console.error(`[workspace-deploy-queue] invalid message dropped: ${details}`);
          continue;
        }

        try {
          await processWorkspaceDeployment(env, payload.workspaceId, payload.deploymentId);
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          console.error(`[workspace-deploy-queue] message handling failed: ${details}`);
          if (shouldRetryWorkspaceDeploymentError(error)) {
            message.retry();
          }
        }
        continue;
      }

      let checkpointPayload;
      try {
        checkpointPayload = parseCheckpointJobQueueMessage(message.body);
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        console.error(`[checkpoint-queue] invalid message dropped: ${details}`);
        continue;
      }

      try {
        await processCheckpointJob(env, checkpointPayload.jobId);
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        console.error(`[checkpoint-queue] message handling failed: ${details}`);
        message.retry();
      }
    }
  },
};
