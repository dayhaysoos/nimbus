import {
  type SandboxClient,
  runSandboxCommandWithOutput,
  shellQuote,
  WORKSPACE_ROOT,
} from './sandbox.js';
import { OperationPreflightError } from './github.js';

export async function executeForkCommitAndPushInSandbox(
  sandbox: SandboxClient,
  input: {
    owner: string;
    repo: string;
    token: string;
    baselineSha: string;
    branch: string;
    commitMessage: string;
  }
): Promise<string> {
  const remoteUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  const suffix = Math.random().toString(36).slice(2, 10);
  const tokenPath = `/tmp/nimbus-gh-token-${suffix}`;
  const askpassPath = `/tmp/nimbus-gh-askpass-${suffix}.sh`;

  await sandbox.writeFile(tokenPath, `${input.token}\n`);
  await sandbox.writeFile(
    askpassPath,
    `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'x-access-token' ;;\n  *) cat ${shellQuote(tokenPath)} ;;\nesac\n`
  );

  const output = await runSandboxCommandWithOutput(
    sandbox,
    `tmp_repo=$(mktemp -d /tmp/nimbus-fork.XXXXXX) && cleanup(){ rm -rf "$tmp_repo" ${shellQuote(
      tokenPath
    )} ${shellQuote(askpassPath)}; } && trap cleanup EXIT && chmod 700 ${shellQuote(
      askpassPath
    )} && export GIT_ASKPASS=${shellQuote(
      askpassPath
    )} GIT_TERMINAL_PROMPT=0 && git init -q "$tmp_repo" && cd "$tmp_repo" && git remote add origin ${shellQuote(
      remoteUrl
    )} && git fetch -q origin ${shellQuote(input.baselineSha)} && git checkout -q -b ${shellQuote(
      input.branch
    )} ${shellQuote(input.baselineSha)} && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + && tar -C ${shellQuote(
      WORKSPACE_ROOT
    )} --exclude='.git' -cf - . | tar -C "$tmp_repo" -xf - && git config user.email ${shellQuote(
      'nimbus@app.local'
    )} && git config user.name ${shellQuote(
      'Nimbus'
    )} && git add -A && if git diff --cached --quiet; then echo __NIMBUS_NO_CHANGES__; exit 0; fi && git commit -q -m ${shellQuote(
      input.commitMessage
    )} && git rev-parse HEAD && git push -q origin ${shellQuote(`HEAD:refs/heads/${input.branch}`)}`,
    { timeout: 10 * 60 * 1000 }
  );

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.includes('__NIMBUS_NO_CHANGES__')) {
    throw new OperationPreflightError('no_changes', 'Workspace has no changes to fork');
  }

  const commitSha = lines.find((line) => /^[0-9a-f]{40}$/i.test(line));
  if (!commitSha) {
    throw new Error('Unable to determine commit SHA after push');
  }

  return commitSha;
}
