import { Sandbox } from '@cloudflare/sandbox';
import { handleGetJob, handleListJobs } from './api/jobs.js';
import { handleGetJobEvents } from './api/job-events.js';
import { handleCreateCheckpointJob } from './api/checkpoint-jobs.js';
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
      let payload;

      try {
        payload = parseCheckpointJobQueueMessage(message.body);
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        console.error(`[checkpoint-queue] invalid message dropped: ${details}`);
        continue;
      }

      try {
        await processCheckpointJob(env, payload.jobId);
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        console.error(`[checkpoint-queue] message handling failed: ${details}`);
        message.retry();
      }
    }
  },
};
