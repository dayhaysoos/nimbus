import type { SandboxClient } from './sandbox.js';
import { executeSandboxCommand, runSandboxCommand, runSandboxCommandWithOutput, shellQuote, WORKSPACE_ROOT } from './sandbox.js';

export async function ensureWorkspaceGitBaseline(sandbox: SandboxClient): Promise<void> {
  const hasHead = await executeSandboxCommand(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && git rev-parse --verify HEAD >/dev/null 2>&1`
  );

  if (hasHead.exitCode === 0) {
    return;
  }

  await runSandboxCommand(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && git init -q && git config user.email ${shellQuote('nimbus@workspace.local')} && git config user.name ${shellQuote('Nimbus Workspace')} && git add -A && git commit -q --allow-empty -m ${shellQuote('workspace baseline')}`
  );
}

export async function workspaceHasGitHead(sandbox: SandboxClient): Promise<boolean> {
  const result = await executeSandboxCommand(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && git rev-parse --verify HEAD >/dev/null 2>&1`
  );

  return result.exitCode === 0;
}

export async function runWorkspaceDiffAgainstHead(
  sandbox: SandboxClient,
  diffArgs: string,
  maxOutputBytes?: number
): Promise<string> {
  const trimmedArgs = diffArgs.trim();
  const diffCommand = `GIT_INDEX_FILE="$tmp_index" git diff --cached -M HEAD${trimmedArgs ? ` ${trimmedArgs}` : ''}`;
  const readDiffCommand =
    typeof maxOutputBytes === 'number' && Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
      ? `head -c ${Math.floor(maxOutputBytes)} "$tmp_diff"`
      : `cat "$tmp_diff"`;

  return runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && tmp_index=$(mktemp /tmp/nimbus-git-index.XXXXXX) && tmp_diff=$(mktemp /tmp/nimbus-git-diff.XXXXXX) && cleanup(){ rm -f "$tmp_index" "$tmp_diff"; } && trap cleanup EXIT && GIT_INDEX_FILE="$tmp_index" git read-tree HEAD && GIT_INDEX_FILE="$tmp_index" git add -A && ${diffCommand} > "$tmp_diff" && ${readDiffCommand}`
  );
}
