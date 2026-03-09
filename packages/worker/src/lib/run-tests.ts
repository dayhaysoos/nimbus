import { runFlagsTests } from './flags.test.js';
import { runStateMachineTests } from './state-machine.test.js';
import { runCheckpointJobsApiTests } from '../api/checkpoint-jobs.test.js';
import { runCheckpointDbTests } from './db.checkpoint.test.js';
import { runJobEventsApiTests } from '../api/job-events.test.js';
import { runCheckpointQueueTests } from './checkpoint-queue.test.js';
import { runCheckpointPlanTests } from './checkpoint-plan.test.js';
import { runCheckpointRunnerTests } from './checkpoint-runner.test.js';
import { runDbEventsTests } from './db.events.test.js';
import { runWorkspaceDbTests } from './db.workspace.test.js';
import { runWorkspaceApiTests } from '../api/workspaces.test.js';
import { runWorkspaceTaskApiTests } from '../api/workspace-tasks.test.js';
import { runWorkspaceTaskQueueTests } from './workspace-task-queue.test.js';
import { runWorkspaceTaskRunnerTests } from './workspace-task-runner.test.js';
import { runWorkspaceDeploymentApiTests } from '../api/workspace-deployments.test.js';
import { runWorkspaceDeploymentQueueTests } from './workspace-deployment-queue.test.js';
import { runWorkspaceDeploymentRunnerTests } from './workspace-deployment-runner.test.js';
import { runWorkspaceToolchainTests } from './workspace-toolchain.test.js';

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const TEST_CASES: TestCase[] = [
  { name: 'state-machine', run: runStateMachineTests },
  { name: 'runtime-flags', run: runFlagsTests },
  { name: 'checkpoint-queue', run: runCheckpointQueueTests },
  { name: 'checkpoint-plan', run: runCheckpointPlanTests },
  { name: 'checkpoint-runner', run: runCheckpointRunnerTests },
  { name: 'db-events', run: runDbEventsTests },
  { name: 'workspace-db', run: runWorkspaceDbTests },
  { name: 'workspace-api', run: runWorkspaceApiTests },
  { name: 'workspace-task-queue', run: runWorkspaceTaskQueueTests },
  { name: 'workspace-task-runner', run: runWorkspaceTaskRunnerTests },
  { name: 'workspace-task-api', run: runWorkspaceTaskApiTests },
  { name: 'workspace-deployment-queue', run: runWorkspaceDeploymentQueueTests },
  { name: 'workspace-deployment-runner', run: runWorkspaceDeploymentRunnerTests },
  { name: 'workspace-deployment-api', run: runWorkspaceDeploymentApiTests },
  { name: 'workspace-toolchain', run: runWorkspaceToolchainTests },
  { name: 'job-events-api', run: runJobEventsApiTests },
  { name: 'checkpoint-db', run: runCheckpointDbTests },
  { name: 'checkpoint-jobs-api', run: runCheckpointJobsApiTests },
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
