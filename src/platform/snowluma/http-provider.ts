import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { assertSecureProviderListener, BaseProvider, unwrapOneBotResponse, type OneBotEnvelope } from './provider.ts';

export interface SnowLumaHttpProviderOptions {
  baseUrl: string;
  accessToken?: string;
  webhookHost?: string;
  webhookPort: number;
  webhookPath?: string;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

/** OneBot HTTP action client paired with an authenticated event webhook. */
export class SnowLumaHttpProvider extends BaseProvider {
  private readonly options: Required<Omit<SnowLumaHttpProviderOptions, 'accessToken'>> & { accessToken?: string };
  private server: Server | null = null;

  constructor(options: SnowLumaHttpProviderOptions) {
    super();
    this.options = {
      ...options,
      webhookHost: options.webhookHost ?? '127.0.0.1',
      webhookPath: options.webhookPath ?? '/onebot/events',
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      maxBodyBytes: options.maxBodyBytes ?? 1_048_576,
      maxResponseBytes: options.maxResponseBytes ?? 1_048_576,
      fetch: options.fetch ?? fetch,
    };
  }

  async connect(): Promise<void> {
    if (this.server) return;
    assertSecureProviderListener(this.options.webhookHost, this.options.accessToken);
    const server = createServer((request, response) => {
      void this.handleWebhook(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.webhookPort, this.options.webhookHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  disconnect(): void {
    const server = this.server;
    this.server = null;
    server?.close();
  }

  isConnected(): boolean {
    return Boolean(this.server?.listening);
  }

  async send(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const url = new URL(encodeURIComponent(action), this.ensureTrailingSlash(this.options.baseUrl));
      const response = await this.options.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.accessToken ? { authorization: `Bearer ${this.options.accessToken}` } : {}),
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.options.maxResponseBytes) {
        throw new Error('SnowLuma HTTP response exceeded the configured size limit');
      }
      const raw = await response.arrayBuffer();
      if (raw.byteLength > this.options.maxResponseBytes) {
        throw new Error('SnowLuma HTTP response exceeded the configured size limit');
      }
      if (!response.ok) throw new Error(`SnowLuma HTTP action failed (${response.status})`);
      let envelope: unknown;
      try {
        envelope = JSON.parse(Buffer.from(raw).toString('utf8'));
      } catch {
        throw new Error('SnowLuma HTTP action returned malformed JSON');
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new Error('SnowLuma HTTP action returned an invalid response');
      }
      return unwrapOneBotResponse(envelope as OneBotEnvelope);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || new URL(request.url ?? '/', 'http://localhost').pathname !== this.options.webhookPath) {
      response.writeHead(404).end();
      return;
    }
    if (!this.authorized(request.headers.authorization)) {
      response.writeHead(401).end();
      return;
    }
    try {
      const declaredSize = Number(request.headers['content-length']);
      if (Number.isFinite(declaredSize) && declaredSize > this.options.maxBodyBytes) {
        response.writeHead(413).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > this.options.maxBodyBytes) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      const event = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid OneBot event');
      this.emitEvent(event as Record<string, unknown>);
      response.writeHead(204).end();
    } catch (error) {
      this.emitError(error);
      if (!response.headersSent) response.writeHead(400).end();
      else response.end();
    }
  }

  private ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
  }

  private authorized(header: string | undefined): boolean {
    if (!this.options.accessToken) return true;
    const expected = Buffer.from(`Bearer ${this.options.accessToken}`);
    const actual = Buffer.from(header ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
