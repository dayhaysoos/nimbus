import type { SandboxClient } from './sandbox.js';
import { runWorkspaceDiffAgainstHead } from './sandbox-git.js';
import { runSandboxCommandWithOutput, shellQuote, WORKSPACE_ROOT } from './sandbox.js';

export async function listOversizedWorkspaceFiles(
  sandbox: SandboxClient,
  maxBytes: number
): Promise<Array<{ path: string; size: number }>> {
  const output = await runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && python3 - ${Math.floor(maxBytes)} <<'PY'
import json
import os
import sys

limit = int(sys.argv[1])
root = os.getcwd()
oversized = []
for dirpath, dirnames, filenames in os.walk(root):
    rel_dir = os.path.relpath(dirpath, root)
    if rel_dir == '.git' or rel_dir.startswith('.git' + os.sep):
        continue
    dirnames[:] = [d for d in dirnames if d != '.git']
    for name in filenames:
        absolute = os.path.join(dirpath, name)
        try:
            size = os.path.getsize(absolute)
        except OSError:
            continue
        if size > limit:
            rel = os.path.relpath(absolute, root)
            oversized.append({'path': rel, 'size': int(size)})
print(json.dumps(oversized))
PY`
  );

  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter((item): item is { path: string; size: number } => {
      return Boolean(
        item &&
          typeof item === 'object' &&
          typeof (item as { path?: unknown }).path === 'string' &&
          typeof (item as { size?: unknown }).size === 'number'
      );
    })
    .slice(0, 200);
}

export async function detectPotentialSecrets(sandbox: SandboxClient): Promise<string[]> {
  const output = await runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && python3 - <<'PY'
import json
import os
import re

pattern = re.compile(r'(^|/)(\\.env(\\.|$)|id_rsa|id_dsa|.*\\.pem$|.*\\.p12$|.*\\.key$)', re.IGNORECASE)
root = os.getcwd()
matches = []
for dirpath, dirnames, filenames in os.walk(root):
    rel_dir = os.path.relpath(dirpath, root)
    if rel_dir == '.git' or rel_dir.startswith('.git' + os.sep):
        continue
    dirnames[:] = [d for d in dirnames if d != '.git']
    for name in filenames:
        absolute = os.path.join(dirpath, name)
        rel = os.path.relpath(absolute, root).replace('\\\\', '/')
        if pattern.search(rel):
            matches.append(rel)
print(json.dumps(matches))
PY`
  );

  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((value): value is string => typeof value === 'string').slice(0, 25);
}

export async function workspaceHasChanges(sandbox: SandboxClient): Promise<boolean> {
  const output = await runWorkspaceDiffAgainstHead(sandbox, '--name-only');
  return output.trim().length > 0;
}
