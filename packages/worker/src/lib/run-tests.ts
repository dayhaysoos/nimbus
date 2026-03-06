import { runFlagsTests } from './flags.test.js';
import { runStateMachineTests } from './state-machine.test.js';

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const TEST_CASES: TestCase[] = [
  { name: 'state-machine', run: runStateMachineTests },
  { name: 'runtime-flags', run: runFlagsTests },
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
