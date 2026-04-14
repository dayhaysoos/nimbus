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
} from '../../../src/lib/checkpoint/archive.js';

function runGitForArchiveTest(cwd: string, args: string[]): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return execFileSync('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      })
        .toString()
        .trim();
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        ((('code' in error) && (error as { code?: string }).code === 'EAGAIN') ||
          (('message' in error) &&
            typeof (error as { message?: string }).message === 'string' &&
            ((error as { message: string }).message.includes('EAGAIN') ||
              (error as { message: string }).message.includes('Resource temporarily unavailable') ||
              (error as { message: string }).message.includes('cannot fork()')))) &&
        attempt < 9
      ) {
        const end = Date.now() + 50 * (attempt + 1);
        while (Date.now() < end) {
          // short synchronous retry backoff for spawnSync git EAGAIN
        }
        continue;
      }
      throw error;
    }
  }

  throw new Error(`git ${args.join(' ')} failed: exhausted retry attempts`);
}

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
    const repoRoot = runGitForArchiveTest(process.cwd(), ['rev-parse', '--show-toplevel']);
    const headCommit = runGitForArchiveTest(repoRoot, ['rev-parse', 'HEAD']);

    const archive = createSourceArchiveFromCommit(headCommit, {
      cwd: resolve(repoRoot, 'packages/cli'),
    });
    const tarBytes = gunzipSync(Buffer.from(new Uint8Array(archive)));

    assert.equal(tarBytes.includes(Buffer.from('packages/worker/package.json')), true);
  }

  assert.equal(MAX_SOURCE_BUNDLE_BYTES, 100 * 1024 * 1024);
}
