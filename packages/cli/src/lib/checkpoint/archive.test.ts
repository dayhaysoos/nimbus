import { strict as assert } from 'assert';
import {
  buildGitArchiveArgs,
  buildSourceBundleFilename,
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

  assert.equal(MAX_SOURCE_BUNDLE_BYTES, 100 * 1024 * 1024);
}
