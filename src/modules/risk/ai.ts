/** OpenAI-compatible AI risk-analysis provider. */
import { configManager } from '../../core/config/index.ts';
import { fetchRemote, readResponseJson, releaseRemoteResponse, validateRemoteUrl, type RemoteFetchPolicy } from '../../runtime/safe-fetch.ts';

const MAX_AI_RESPONSE_BYTES = 1024 * 1024;
export const PRIVATE_AI_ENDPOINTS_ENV = 'QQ_GUARDIAN_ALLOW_PRIVATE_AI_ENDPOINTS';

export interface ProviderResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AIProvider {
  analyzeRisk(text: string): Promise<ProviderResult<{ score: number; reason: string; tags: string[] }>>;
}

/** Preserve the historical opt-in contract exactly: only the literal string
 * `true` enables private-network and plaintext HTTP access. */
export function privateAIEndpointOverrideEnabled(value = process.env[PRIVATE_AI_ENDPOINTS_ENV]): boolean {
  return value === 'true';
}

/** A stable startup warning for the one setting that deliberately relaxes the
 * default SSRF and transport policy. No endpoint, key, or message data is
 * included so the warning is safe to emit in ordinary production logs. */
export function privateAIEndpointStartupWarning(value = process.env[PRIVATE_AI_ENDPOINTS_ENV]): string | null {
  if (!privateAIEndpointOverrideEnabled(value)) return null;
  return `${PRIVATE_AI_ENDPOINTS_ENV} is active. AI requests may reach private network addresses over HTTP. Only use with a trusted local AI endpoint.`;
}

function localProviderPolicy(): RemoteFetchPolicy {
  return privateAIEndpointOverrideEnabled()
    ? { allowPrivateNetwork: true, allowHttp: true }
    : {};
}

function completionUrl(baseUrl: string): URL {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('chat/completions', normalized);
}

class DisabledAI implements AIProvider {
  async analyzeRisk(): Promise<ProviderResult<{ score: number; reason: string; tags: string[] }>> {
    return { ok: false, error: 'AI provider is disabled' };
  }
}

class OpenAICompatibleAI implements AIProvider {
  async analyzeRisk(text: string): Promise<ProviderResult<{ score: number; reason: string; tags: string[] }>> {
    const cfg = configManager.get().ai;
    const policy = cfg.provider === 'custom' ? localProviderPolicy() : {};
    let endpoint: URL;
    try {
      endpoint = completionUrl(cfg.baseUrl);
      // Validate before consuming any message content or API key. fetchRemote
      // repeats this at every redirect hop.
      await validateRemoteUrl(endpoint, policy);
    } catch {
      return { ok: false, error: 'AI provider endpoint is not permitted' };
    }

    try {
      const response = await fetchRemote(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: cfg.riskPrompt },
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 200,
        }),
      }, {
        ...policy,
        timeoutMs: Math.max(1_000, Math.min(cfg.timeoutMs, 120_000)),
      });
      if (!response.ok) {
        await releaseRemoteResponse(response);
        return { ok: false, error: `AI HTTP ${response.status}` };
      }

      const json = await readResponseJson(response, MAX_AI_RESPONSE_BYTES) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(content) as { score?: number; reason?: string; tags?: unknown };
      return {
        ok: true,
        data: {
          score: Math.min(100, Math.max(0, Number(parsed.score) || 0)),
          reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 2_000) : '',
          tags: Array.isArray(parsed.tags)
            ? parsed.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
            : [],
        },
      };
    } catch {
      // Network errors may include implementation-specific endpoint details;
      // callers receive a stable message while server logs stay clean too.
      return { ok: false, error: 'AI request failed' };
    }
  }
}

export function createAIProvider(): AIProvider {
  switch (configManager.get().ai.provider) {
    case 'openai':
    case 'anthropic':
    case 'custom':
      return new OpenAICompatibleAI();
    default:
      return new DisabledAI();
  }
}
