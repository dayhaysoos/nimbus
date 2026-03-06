import { strict as assert } from 'assert';
import {
  parseGitLogOutput,
  parseGitLsTreeNameOnlyOutput,
  treeOutputHasSubmodule,
} from './git.js';

export function runCheckpointGitTests(): void {
  {
    const parsed = parseGitLogOutput(
      'sha_one\u001ffeat: one\\n\\nBody\u001esha_two\u001ffix: two\u001e'
    );

    assert.deepEqual(parsed, [
      { sha: 'sha_one', message: 'feat: one\\n\\nBody' },
      { sha: 'sha_two', message: 'fix: two' },
    ]);
  }

  {
    const parsed = parseGitLsTreeNameOnlyOutput('package.json\napps/web/package.json\n\n');
    assert.deepEqual(parsed, ['package.json', 'apps/web/package.json']);
  }

  {
    const hasSubmodule = treeOutputHasSubmodule(
      '100644 blob abc123\tREADME.md\n160000 commit deadbeef\tvendor/lib\n'
    );
    assert.equal(hasSubmodule, true);
  }

  {
    const hasSubmodule = treeOutputHasSubmodule('100644 blob abc123\tREADME.md\n');
    assert.equal(hasSubmodule, false);
  }
}
