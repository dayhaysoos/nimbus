import { strict as assert } from 'assert';
import { enforceRequestBodySizeCap } from './request-size.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Review-Github-Token, X-Openrouter-Api-Key, X-Nimbus-Api-Key',
};

export async function runRequestSizeTests(): Promise<void> {
  {
    const response = enforceRequestBodySizeCap(
      new Request('https://example.com/api/workspaces', {
        method: 'POST',
        headers: {
          'Content-Length': String(100 * 1024 * 1024 - 1),
        },
      }),
      corsHeaders
    );

    assert.equal(response, null);
  }

  {
    const response = enforceRequestBodySizeCap(
      new Request('https://example.com/api/workspaces', {
        method: 'POST',
        headers: {
          'Content-Length': String(100 * 1024 * 1024 + 1),
        },
      }),
      corsHeaders
    );

    assert.notEqual(response, null);
    assert.equal(response?.status, 413);
    const payload = (await response?.json()) as Record<string, unknown>;
    assert.equal(payload.error, 'Request body too large');
    assert.equal(payload.code, 'request_too_large');
  }

  {
    const response = enforceRequestBodySizeCap(
      new Request('https://example.com/api/reviews', {
        method: 'POST',
        headers: {
          'Content-Length': String(5 * 1024 * 1024 - 1),
        },
      }),
      corsHeaders
    );

    assert.equal(response, null);
  }

  {
    const response = enforceRequestBodySizeCap(
      new Request('https://example.com/api/reviews', {
        method: 'POST',
        headers: {
          'Content-Length': String(5 * 1024 * 1024 + 1),
        },
      }),
      corsHeaders
    );

    assert.notEqual(response, null);
    assert.equal(response?.status, 413);
    const payload = (await response?.json()) as Record<string, unknown>;
    assert.equal(payload.error, 'Request body too large');
    assert.equal(payload.code, 'request_too_large');
  }

  {
    const response = enforceRequestBodySizeCap(
      new Request('https://example.com/api/reviews', {
        method: 'POST',
      }),
      corsHeaders
    );

    assert.equal(response, null);
  }
}
