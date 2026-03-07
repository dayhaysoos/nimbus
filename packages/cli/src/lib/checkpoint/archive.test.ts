import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { gunzipSync } from 'zlib';
import {
  buildGitArchiveArgs,
  buildSourceBundleFilename,
  createSourceArchiveFromCommit,
  estimateBundleSize,
  MAX_SOURCE_BUNDLE_BYTES,
} from './archive.js';

export function runCheckpointArchiveTests(): void {
  {
    const args = buildGitArchiveArgs('a'.repeat(40));
    assert.deepEqual(args, ['archive', '--format=tar.gz', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  }

  {
    const filename = buildSourceBundleFilename('b'.repeat(40));
    assert.equal(filename, 'checkpoint-bbbbbbbbbbbb.tar.gz');
  }

  {
    const size = estimateBundleSize(new Uint8Array([1, 2, 3]).buffer);
    assert.equal(size, 3);
  }

  {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
      .toString()
      .trim();
    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
      .toString()
      .trim();

    const archive = createSourceArchiveFromCommit(headCommit, {
      cwd: resolve(repoRoot, 'packages/cli'),
    });
    const tarBytes = gunzipSync(Buffer.from(new Uint8Array(archive)));

    assert.equal(tarBytes.includes(Buffer.from('packages/worker/package.json')), true);
  }

  assert.equal(MAX_SOURCE_BUNDLE_BYTES, 100 * 1024 * 1024);
}
