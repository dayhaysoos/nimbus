import { strict as assert } from 'assert';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { validateReviewCommitCheckpoint } from '../../../src/commands/review/preflight.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function writeAndCommit(
  repoDir: string,
  input: {
    filePath: string;
    content: string;
    message: string;
  }
): Promise<string> {
  await writeFile(join(repoDir, input.filePath), input.content, 'utf8');
  git(repoDir, ['add', input.filePath]);
  git(repoDir, ['commit', '-m', input.message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

export async function runReviewPreflightSelectionTests(): Promise<void> {
  const repoDir = await mkdtemp(join(tmpdir(), 'nimbus-review-preflight-'));
  try {
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.name', 'Nimbus Tests']);
    git(repoDir, ['config', 'user.email', 'nimbus-tests@example.com']);

    await writeAndCommit(repoDir, {
      filePath: 'app.txt',
      content: 'one\n',
      message: 'feat: checkpoint one\n\nEntire-Checkpoint: aaaaaaaaaaaa',
    });
    const secondCheckpointSha = await writeAndCommit(repoDir, {
      filePath: 'app.txt',
      content: 'one\ntwo\n',
      message: 'feat: checkpoint two\n\nEntire-Checkpoint: bbbbbbbbbbbb',
    });
    const nonCheckpointHeadSha = await writeAndCommit(repoDir, {
      filePath: 'app.txt',
      content: 'one\ntwo\nthree\n',
      message: 'feat: plain head commit',
    });

    assert.throws(
      () => validateReviewCommitCheckpoint('HEAD', repoDir, { lastCheckpoints: 2 }),
      /This commit has no Entire-Checkpoint trailer\. The last commit on this branch with valid checkpoint context was/
    );

    const checkpointedHeadSha = await writeAndCommit(repoDir, {
      filePath: 'app.txt',
      content: 'one\ntwo\nthree\nfour\n',
      message: 'feat: checkpoint three\n\nEntire-Checkpoint: cccccccccccc',
    });

    const resolved = validateReviewCommitCheckpoint('HEAD', repoDir, { lastCheckpoints: 2 });
    assert.equal(resolved.commitSha, checkpointedHeadSha);
    assert.equal(resolved.checkpointId, 'cccccccccccc');
    assert.equal(resolved.checkpointSelectionMode, 'last_n');
    assert.deepEqual(
      resolved.includedCheckpoints?.map((checkpoint) => checkpoint.commitSha),
      [secondCheckpointSha, checkpointedHeadSha]
    );
    assert.equal(resolved.commitDiffPatch.includes('three'), true);
    assert.equal(resolved.commitDiffPatch.includes('four'), true);
    assert.equal(resolved.commitDiffPatch.includes(nonCheckpointHeadSha.slice(0, 7)), false);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}
