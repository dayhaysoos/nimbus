import { strict as assert } from 'assert';
import {
  collectEnvTemplates,
  computeEnvFingerprint,
  isEnvTemplatePath,
  isLocalEnvPath,
  parseEnvFileContent,
  parseEnvTemplateContent,
  resolveEnvPreflight,
} from './env.js';

export function runCheckpointEnvTests(): void {
  {
    const parsed = parseEnvTemplateContent(`
# comment
API_BASE_URL=
PUBLIC_ANALYTICS_KEY=abc123 # optional
export SESSION_SECRET=
INVALID LINE
`);

    assert.deepEqual(parsed.requiredKeys, ['API_BASE_URL', 'SESSION_SECRET']);
    assert.deepEqual(parsed.optionalKeys, ['PUBLIC_ANALYTICS_KEY']);
  }

  {
    const parsed = parseEnvFileContent(`
API_BASE_URL=https://api.example.com
SESSION_SECRET="shhh"
EMPTY=
# ignored
`);

    assert.equal(parsed.get('API_BASE_URL'), 'https://api.example.com');
    assert.equal(parsed.get('SESSION_SECRET'), 'shhh');
    assert.equal(parsed.get('EMPTY'), '');
  }

  {
    const parsed = parseEnvFileContent(`
SECRET="abc#123"
INLINE=value # comment
HASH_LITERAL=foo#bar
`);

    assert.equal(parsed.get('SECRET'), 'abc#123');
    assert.equal(parsed.get('INLINE'), 'value');
    assert.equal(parsed.get('HASH_LITERAL'), 'foo#bar');
  }

  {
    const templates = collectEnvTemplates([
      {
        path: '.env.example',
        content: 'API_BASE_URL=\nSESSION_SECRET=\n',
      },
      {
        path: '.env.production.example',
        content: 'PUBLIC_ANALYTICS_KEY= # optional\nSESSION_SECRET=\n',
      },
      {
        path: '.dev.vars.example',
        content: 'CF_ACCOUNT_ID=\n',
      },
    ]);

    assert.deepEqual(templates.requiredKeys, ['API_BASE_URL', 'CF_ACCOUNT_ID', 'SESSION_SECRET']);
    assert.deepEqual(templates.optionalKeys, ['PUBLIC_ANALYTICS_KEY']);
  }

  {
    const preflight = resolveEnvPreflight({
      requiredKeys: ['API_BASE_URL', 'SESSION_SECRET', 'CF_ACCOUNT_ID'],
      optionalKeys: ['PUBLIC_ANALYTICS_KEY'],
      explicitEnv: new Map([
        ['API_BASE_URL', 'https://override.example.com'],
        ['SESSION_SECRET', 'explicit-secret'],
      ]),
      localEnv: new Map([
        ['API_BASE_URL', 'https://local.example.com'],
        ['CF_ACCOUNT_ID', 'acc_123'],
      ]),
      processEnv: new Map([
        ['SESSION_SECRET', 'process-secret'],
        ['PUBLIC_ANALYTICS_KEY', 'analytics_123'],
      ]),
    });

    assert.deepEqual(preflight.missingRequiredKeys, []);
    assert.equal(preflight.values.get('API_BASE_URL')?.value, 'https://override.example.com');
    assert.equal(preflight.values.get('API_BASE_URL')?.source, 'explicit');
    assert.equal(preflight.values.get('SESSION_SECRET')?.source, 'explicit');
    assert.equal(preflight.values.get('CF_ACCOUNT_ID')?.source, 'local');
    assert.equal(preflight.values.get('PUBLIC_ANALYTICS_KEY')?.source, 'process');
  }

  {
    const preflight = resolveEnvPreflight({
      requiredKeys: ['API_BASE_URL'],
      optionalKeys: [],
      explicitEnv: new Map(),
      localEnv: new Map(),
      processEnv: new Map(),
    });

    assert.deepEqual(preflight.missingRequiredKeys, ['API_BASE_URL']);
  }

  {
    const fingerprintA = computeEnvFingerprint(
      new Map([
        ['A', '1'],
        ['B', '2'],
      ])
    );

    const fingerprintB = computeEnvFingerprint(
      new Map([
        ['B', '2'],
        ['A', '1'],
      ])
    );

    const fingerprintC = computeEnvFingerprint(
      new Map([
        ['A', '1'],
        ['B', '3'],
      ])
    );

    assert.equal(fingerprintA, fingerprintB);
    assert.notEqual(fingerprintA, fingerprintC);
  }

  {
    assert.equal(isEnvTemplatePath('.env.example'), true);
    assert.equal(isEnvTemplatePath('apps/web/.env.production.example'), true);
    assert.equal(isEnvTemplatePath('.dev.vars.example'), true);
    assert.equal(isEnvTemplatePath('.env.local'), false);
    assert.equal(isEnvTemplatePath('README.md'), false);
  }

  {
    assert.equal(isLocalEnvPath('.env'), true);
    assert.equal(isLocalEnvPath('.env.local'), true);
    assert.equal(isLocalEnvPath('apps/web/.env.development'), true);
    assert.equal(isLocalEnvPath('.dev.vars'), true);
    assert.equal(isLocalEnvPath('.env.example'), false);
    assert.equal(isLocalEnvPath('.dev.vars.example'), false);
  }
}
