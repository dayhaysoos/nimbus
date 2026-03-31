import { strict as assert } from 'assert';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { contentTypeFor, resolveStaticEntry } from '../../../src/app/reviews/ui-static.js';

export async function runReviewUiStaticTests(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'nimbus-ui-static-'));
  try {
    await writeFile(join(tempDir, 'index.html'), '<html></html>', 'utf8');
    await mkdir(join(tempDir, 'assets'), { recursive: true });
    await writeFile(join(tempDir, 'assets', 'app.js'), 'console.log("ok")', 'utf8');

    assert.equal(resolveStaticEntry(tempDir, '/'), join(tempDir, 'index.html'));
    assert.equal(resolveStaticEntry(tempDir, '/reports/rev_123'), join(tempDir, 'index.html'));
    assert.equal(resolveStaticEntry(tempDir, '/assets/app.js'), join(tempDir, 'assets', 'app.js'));
    assert.equal(resolveStaticEntry(tempDir, '/nonexistent'), join(tempDir, 'index.html'));
    assert.equal(resolveStaticEntry(tempDir, '/../secret.txt'), null);

    assert.equal(contentTypeFor('/tmp/index.html'), 'text/html; charset=utf-8');
    assert.equal(contentTypeFor('/tmp/app.js'), 'application/javascript; charset=utf-8');
    assert.equal(contentTypeFor('/tmp/archive.bin'), 'application/octet-stream');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
