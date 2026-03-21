import * as p from '@clack/prompts';
import { appendFile } from 'fs/promises';
import { exchangeOidcToken, getWorkerUrl } from '../../lib/api.js';

interface GithubOidcResponse {
  value?: string;
}

async function requestGithubOidcToken(audience: string): Promise<string> {
  const requestUrlRaw = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrlRaw || !requestToken) {
    throw new Error('this command requires a GitHub Actions environment');
  }

  const requestUrl = new URL(requestUrlRaw);
  requestUrl.searchParams.set('audience', audience);

  const response = await fetch(requestUrl.toString(), {
    headers: {
      Authorization: `Bearer ${requestToken}`,
    },
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to request GitHub OIDC token (${response.status}): ${details}`);
  }

  const payload = (await response.json()) as GithubOidcResponse;
  const token = typeof payload.value === 'string' ? payload.value.trim() : '';
  if (!token) {
    throw new Error('GitHub OIDC response did not include a token value');
  }
  return token;
}

export async function authExchangeCommand(options?: { json?: boolean }): Promise<void> {
  const githubOutputPath = typeof process.env.GITHUB_OUTPUT === 'string' ? process.env.GITHUB_OUTPUT.trim() : '';
  const isJson = options?.json === true;
  if (!githubOutputPath && !isJson) {
    throw new Error('GITHUB_OUTPUT is required for nimbus auth exchange output in GitHub Actions');
  }

  const workerUrl = getWorkerUrl();
  const oidcToken = await requestGithubOidcToken('nimbus');
  const exchanged = await exchangeOidcToken(workerUrl, oidcToken);

  let wroteGithubOutput = false;
  if (!isJson && githubOutputPath) {
    await appendFile(githubOutputPath, `token=${exchanged.token}\n`, 'utf8');
    wroteGithubOutput = true;
  }

  if (isJson) {
    console.log(JSON.stringify({ ...exchanged, wroteGithubOutput }));
    return;
  }

  p.log.success('Exchanged GitHub OIDC token for Nimbus token.');
}
