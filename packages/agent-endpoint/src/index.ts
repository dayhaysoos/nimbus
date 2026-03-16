import {
  AgentEndpointError,
  nextAgentActionWithInference,
  type AgentEnv,
  type AgentRequest,
} from './lib/agent.js';

const SENSITIVE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]+\b/gi,
  /\bnmb_live_[A-Za-z0-9_-]+\b/gi,
];

const GENERIC_UPSTREAM_ERROR_MESSAGE = 'upstream error';

function readBearerToken(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const token = match[1]?.trim();
  return token ? token : null;
}

function hasSensitivePattern(value: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function sanitizeErrorMessage(rawMessage: string): string {
  const trimmed = rawMessage.trim();
  if (!trimmed) {
    return GENERIC_UPSTREAM_ERROR_MESSAGE;
  }

  let sanitized = trimmed;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  if (!sanitized || sanitized === '[REDACTED]' || hasSensitivePattern(sanitized)) {
    return GENERIC_UPSTREAM_ERROR_MESSAGE;
  }

  return sanitized;
}

function sanitizeErrorDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!details) {
    return null;
  }

  const message = details.message;
  if (typeof message !== 'string') {
    return details;
  }

  return {
    ...details,
    message: sanitizeErrorMessage(message),
  };
}

export default {
  async fetch(request: Request, env: AgentEnv): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const expectedAuthToken = (env.AGENT_SDK_AUTH_TOKEN ?? '').trim();
    const providedAuthToken = readBearerToken(request.headers.get('Authorization'));
    if (!expectedAuthToken || !providedAuthToken || providedAuthToken !== expectedAuthToken) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let payload: AgentRequest;
    try {
      payload = (await request.json()) as AgentRequest;
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_json' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const openrouterApiKeyHeader = request.headers.get('X-Openrouter-Api-Key');
      const action = await nextAgentActionWithInference(payload, env, {
        openrouterApiKey: typeof openrouterApiKeyHeader === 'string' ? openrouterApiKeyHeader : null,
      });
      return new Response(JSON.stringify({ action }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      if (error instanceof AgentEndpointError) {
        const safeDetails = sanitizeErrorDetails(error.details);
        return new Response(
          JSON.stringify({
            error: error.code,
            details: safeDetails,
          }),
          {
            status: error.status,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      return new Response(
        JSON.stringify({
          error: 'internal_error',
          details: error instanceof Error ? { message: sanitizeErrorMessage(error.message) } : null,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
