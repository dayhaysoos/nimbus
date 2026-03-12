import { runCheckpointResolverTests } from './checkpoint/resolver.test.js';
import { runCheckpointEnvTests } from './checkpoint/env.test.js';
import { runCheckpointOptionsTests } from '../commands/deploy/checkpoint-options.test.js';
import { runCheckpointGitTests } from './checkpoint/git.test.js';
import { runCheckpointArchiveTests } from './checkpoint/archive.test.js';
import { runCheckpointDeployRequestTests } from './checkpoint/deploy-request.test.js';
import { runCheckpointApiTests } from './api.checkpoint.test.js';
import { runWorkspaceApiTests } from './api.workspace.test.js';
import { runCheckpointCommandTests } from '../commands/deploy/checkpoint.test.js';
import { runArgsParsingTests } from './args.test.js';
import { runReviewPolicyTests } from './review-policy.test.js';
import { runWorkspaceDeployCommandTests } from '../commands/workspace/deploy.test.js';
import { runReviewCommandTests } from '../commands/review/review.test.js';

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const TEST_CASES: TestCase[] = [
  { name: 'checkpoint-resolver', run: runCheckpointResolverTests },
  { name: 'checkpoint-env', run: runCheckpointEnvTests },
  { name: 'checkpoint-git', run: runCheckpointGitTests },
  { name: 'checkpoint-archive', run: runCheckpointArchiveTests },
  { name: 'checkpoint-deploy-request', run: runCheckpointDeployRequestTests },
  { name: 'checkpoint-api', run: runCheckpointApiTests },
  { name: 'workspace-api', run: runWorkspaceApiTests },
  { name: 'checkpoint-command', run: runCheckpointCommandTests },
  { name: 'args-parsing', run: runArgsParsingTests },
  { name: 'review-policy', run: runReviewPolicyTests },
  { name: 'workspace-deploy-command', run: runWorkspaceDeployCommandTests },
  { name: 'review-command', run: runReviewCommandTests },
  { name: 'checkpoint-options', run: runCheckpointOptionsTests },
];

async function main(): Promise<void> {
  let failed = 0;

  for (const testCase of TEST_CASES) {
    try {
      await testCase.run();
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`FAIL ${testCase.name}`);
      console.error(message);
    }
  }

  if (failed > 0) {
    process.exit(1);
  }

  console.log(`All tests passed (${TEST_CASES.length})`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error('Test runner crashed');
  console.error(message);
  process.exit(1);
});
