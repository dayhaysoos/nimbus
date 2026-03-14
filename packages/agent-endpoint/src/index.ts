import {
  AgentEndpointError,
  nextAgentActionWithInference,
  type AgentEnv,
  type AgentRequest,
} from './lib/agent.js';

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
      const action = await nextAgentActionWithInference(payload, env);
      return new Response(JSON.stringify({ action }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      if (error instanceof AgentEndpointError) {
        return new Response(
          JSON.stringify({
            error: error.code,
            details: error.details ?? null,
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
          details: error instanceof Error ? { message: error.message } : null,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
