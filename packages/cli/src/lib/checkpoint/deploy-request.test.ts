import { strict as assert } from 'assert';
import {
  buildCheckpointCreateFormData,
  buildCheckpointCreateMetadata,
  type CheckpointCreateMetadata,
} from './deploy-request.js';

function sampleMetadata(): CheckpointCreateMetadata {
  return {
    source: {
      type: 'checkpoint',
      checkpointId: '8a513f56ed70',
      commitSha: 'a'.repeat(40),
      ref: 'main',
      projectRoot: 'apps/web',
    },
    build: {
      runTestsIfPresent: true,
      runLintIfPresent: false,
    },
  };
}

export async function runCheckpointDeployRequestTests(): Promise<void> {
  {
    const metadata = buildCheckpointCreateMetadata({
      checkpointId: '8a513f56ed70',
      commitSha: 'a'.repeat(40),
      ref: 'main',
      projectRoot: 'apps/web',
      runTestsIfPresent: true,
      runLintIfPresent: false,
    });

    assert.deepEqual(metadata, sampleMetadata());
  }

  {
    const bundle = new Uint8Array([1, 2, 3, 4]).buffer;
    const formData = buildCheckpointCreateFormData(sampleMetadata(), bundle, 'source.tar.gz');

    const metadataField = formData.get('metadata');
    assert.equal(typeof metadataField, 'string');

    const parsedMetadata = JSON.parse(metadataField as string) as CheckpointCreateMetadata;
    assert.equal(parsedMetadata.source.commitSha, 'a'.repeat(40));
    assert.equal(parsedMetadata.build.runLintIfPresent, false);

    const bundleField = formData.get('bundle');
    assert.ok(bundleField);
    assert.equal(typeof bundleField, 'object');
  }
}
