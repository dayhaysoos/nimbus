import * as p from '@clack/prompts';
import { createReviewPolicy, getWorkerUrl } from '../../lib/api.js';
import { validateReviewCommitCheckpoint, validateReviewEntireIntentContext } from './preflight.js';

function renderPolicyText(policy: {
  goal: string | null;
  prohibitions: string[];
  constraints: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Goal: ${policy.goal ?? 'Not specified'}`);

  const appendList = (title: string, items: string[]): void => {
    lines.push(`${title}:`);
    if (items.length === 0) {
      lines.push('- None');
      return;
    }
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  };

  appendList('Prohibitions', policy.prohibitions);
  appendList('Constraints', policy.constraints);
  return lines.join('\n');
}

export async function reviewPolicyCommand(options?: {
  commitish?: string;
  baseRef?: string;
  model?: string;
  json?: boolean;
}): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const spinner = p.spinner();
  const commitish = options?.commitish?.trim() || 'HEAD';

  spinner.start('Resolving checkpoint...');
  let resolved: ReturnType<typeof validateReviewCommitCheckpoint>;
  try {
    resolved = validateReviewCommitCheckpoint(commitish, process.cwd(), {
      baseRef: options?.baseRef,
    });
    spinner.stop(`Resolved checkpoint ${resolved.checkpointId} from ${resolved.commitSha.slice(0, 12)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Checkpoint resolution failed');
    throw new Error(`Review policy failed at checkpoint resolution: ${message}`);
  }

  spinner.start('Resolving Entire prompt history...');
  let contextResolution: Awaited<ReturnType<typeof validateReviewEntireIntentContext>>;
  try {
    contextResolution = await validateReviewEntireIntentContext(
      {
        commitSha: resolved.commitSha,
        checkpointId: resolved.checkpointId,
      },
      {
        summarizeSession: 'auto',
      },
      process.cwd()
    );
    spinner.stop('Entire prompt history resolved');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Entire prompt history resolution failed');
    throw new Error(`Review policy failed at Entire prompt-history resolution: ${message}`);
  }

  const rawSessionPrompts =
    typeof contextResolution.context.rawSessionPrompts === 'string'
      ? contextResolution.context.rawSessionPrompts.trim()
      : '';
  if (!rawSessionPrompts) {
    throw new Error('Entire prompt history is empty for this checkpoint.');
  }

  spinner.start('Generating review policy...');
  let response: Awaited<ReturnType<typeof createReviewPolicy>>;
  try {
    response = await createReviewPolicy(workerUrl, {
      rawSessionPrompts,
      intentSessionContext: contextResolution.context.intentSessionContext,
      ...(options?.model?.trim() ? { model: options.model.trim() } : {}),
    });
    spinner.stop('Review policy generated');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Review policy generation failed');
    throw new Error(`Review policy failed at policy generation: ${message}`);
  }

  if (options?.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          commitSha: resolved.commitSha,
          checkpointId: contextResolution.resolvedCheckpointId,
          contextResolution: contextResolution.contextResolution,
          source: response.source,
          policy: response.policy,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  p.log.message(`Commit: ${resolved.commitSha}`);
  p.log.message(`Checkpoint: ${contextResolution.resolvedCheckpointId}`);
  p.note(renderPolicyText(response.policy), `Review Policy (${response.source})`);
}
