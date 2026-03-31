export const DEFAULT_DIFF_MAX_BYTES = 128 * 1024;
export const MAX_DIFF_MAX_BYTES = 2 * 1024 * 1024;

export interface WorkspaceDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
}

export interface TruncatedChangedFiles {
  files: WorkspaceDiffFile[];
  truncated: boolean;
  bytes: number;
  totalBytes: number;
}

export function parseBooleanQueryParam(url: URL, key: string): boolean {
  const value = url.searchParams.get(key);
  return value === 'true' || value === '1';
}

export function parseDiffNameStatus(output: string): WorkspaceDiffFile[] {
  const tokens = output.split('\u0000').filter((token) => token.length > 0);

  const files: WorkspaceDiffFile[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let code = token;
    let firstPath: string | null = null;

    const tabIndex = token.indexOf('\t');
    if (tabIndex >= 0) {
      code = token.slice(0, tabIndex);
      const candidatePath = token.slice(tabIndex + 1);
      if (candidatePath.length > 0) {
        firstPath = candidatePath;
      }
    }

    if (firstPath === null) {
      firstPath = tokens[index + 1] ?? null;
      if (firstPath !== null) {
        index += 1;
      }
    }

    if (!firstPath) {
      continue;
    }

    if (code.startsWith('R') || code.startsWith('C')) {
      let secondPath: string | null = tokens[index + 1] ?? null;
      if (secondPath !== null) {
        index += 1;
      }

      if (!secondPath && firstPath.includes('\t')) {
        const renameSplit = firstPath.indexOf('\t');
        secondPath = firstPath.slice(renameSplit + 1);
        firstPath = firstPath.slice(0, renameSplit);
      }

      if (!secondPath) {
        continue;
      }

      files.push({ status: 'renamed', previousPath: firstPath, path: secondPath });
      continue;
    }

    if (code.startsWith('A')) {
      files.push({ status: 'added', path: firstPath });
      continue;
    }

    if (code.startsWith('D')) {
      files.push({ status: 'deleted', path: firstPath });
      continue;
    }

    files.push({ status: 'modified', path: firstPath });
  }

  return files;
}

export function trimNameStatusToCompleteRecords(output: string): string {
  if (!output) {
    return output;
  }

  const hasTrailingNull = output.endsWith('\u0000');
  const splitTokens = output.split('\u0000');
  const tokens = hasTrailingNull ? splitTokens.slice(0, -1) : splitTokens.slice(0, -1);
  const kept: string[] = [];

  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index];
    if (!statusToken) {
      index += 1;
      continue;
    }

    const tabIndex = statusToken.indexOf('\t');
    if (tabIndex >= 0) {
      const code = statusToken.slice(0, tabIndex);
      const inlinePath = statusToken.slice(tabIndex + 1);

      if (code.startsWith('R') || code.startsWith('C')) {
        if (inlinePath.includes('\t')) {
          kept.push(statusToken);
          index += 1;
          continue;
        }

        if (index + 1 < tokens.length) {
          kept.push(statusToken, tokens[index + 1]);
          index += 2;
          continue;
        }

        break;
      }

      if (inlinePath.length > 0) {
        kept.push(statusToken);
        index += 1;
        continue;
      }

      if (index + 1 < tokens.length) {
        kept.push(statusToken, tokens[index + 1]);
        index += 2;
        continue;
      }

      break;
    }

    if (statusToken.startsWith('R') || statusToken.startsWith('C')) {
      if (index + 2 < tokens.length) {
        kept.push(statusToken, tokens[index + 1], tokens[index + 2]);
        index += 3;
        continue;
      }

      break;
    }

    if (index + 1 < tokens.length) {
      kept.push(statusToken, tokens[index + 1]);
      index += 2;
      continue;
    }

    break;
  }

  if (kept.length === 0) {
    return '';
  }

  return `${kept.join('\u0000')}\u0000`;
}

export function truncateChangedFilesByBytes(changedFiles: WorkspaceDiffFile[], maxBytes: number): TruncatedChangedFiles {
  const encoder = new TextEncoder();
  const fullJson = JSON.stringify(changedFiles);
  const fullBytes = encoder.encode(fullJson).byteLength;

  if (fullBytes <= maxBytes) {
    return {
      files: changedFiles,
      truncated: false,
      bytes: fullBytes,
      totalBytes: fullBytes,
    };
  }

  const kept: WorkspaceDiffFile[] = [];
  for (const file of changedFiles) {
    kept.push(file);
    const candidateBytes = encoder.encode(JSON.stringify(kept)).byteLength;
    if (candidateBytes > maxBytes) {
      kept.pop();
      break;
    }
  }

  return {
    files: kept,
    truncated: true,
    bytes: encoder.encode(JSON.stringify(kept)).byteLength,
    totalBytes: fullBytes,
  };
}

export function truncateUtf8(
  input: string,
  maxBytes: number
): { content: string; truncated: boolean; totalBytes: number; returnedBytes: number } {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(input);

  if (bytes.byteLength <= maxBytes) {
    return { content: input, truncated: false, totalBytes: bytes.byteLength, returnedBytes: bytes.byteLength };
  }

  const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let end = maxBytes;
  while (end > 0) {
    try {
      strictDecoder.decode(bytes.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }

  return {
    content: decoder.decode(bytes.subarray(0, end)),
    truncated: true,
    totalBytes: bytes.byteLength,
    returnedBytes: end,
  };
}
