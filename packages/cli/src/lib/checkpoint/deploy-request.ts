export interface CheckpointCreateMetadata {
  source: {
    type: 'checkpoint';
    checkpointId: string | null;
    commitSha: string;
    ref?: string;
    projectRoot?: string;
  };
  build: {
    runTestsIfPresent: boolean;
    runLintIfPresent: boolean;
  };
}

export interface BuildCheckpointCreateMetadataInput {
  checkpointId: string | null;
  commitSha: string;
  ref?: string;
  projectRoot?: string;
  runTestsIfPresent: boolean;
  runLintIfPresent: boolean;
}

export function buildCheckpointCreateMetadata(
  input: BuildCheckpointCreateMetadataInput
): CheckpointCreateMetadata {
  return {
    source: {
      type: 'checkpoint',
      checkpointId: input.checkpointId,
      commitSha: input.commitSha,
      ref: input.ref,
      projectRoot: input.projectRoot,
    },
    build: {
      runTestsIfPresent: input.runTestsIfPresent,
      runLintIfPresent: input.runLintIfPresent,
    },
  };
}

export function buildCheckpointCreateFormData(
  metadata: CheckpointCreateMetadata,
  bundle: ArrayBuffer,
  bundleFilename: string
): FormData {
  const formData = new FormData();
  formData.set('metadata', JSON.stringify(metadata));
  const blob = new Blob([new Uint8Array(bundle)], { type: 'application/gzip' });
  formData.set('bundle', blob, bundleFilename);
  return formData;
}
