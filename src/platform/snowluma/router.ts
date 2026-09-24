import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { type Socket } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import type {
  GuardianHttpRequest,
  GuardianHttpResponse,
  GuardianHttpRouter,
  GuardianPageDefinition,
  GuardianRequestHandler,
  HttpMethod,
  MemoryStaticFile,
} from '../../ports/http.ts';

interface RouteEntry {
  method: string;
  path: string;
  regex: RegExp;
  keys: string[];
  handler: GuardianRequestHandler;
}

interface StaticEntry {
  urlPath: string;
  localRoot: string;
}

interface MemoryStaticEntry {
  urlPath: string;
  files: MemoryStaticFile[];
}

interface ResolvedRouterOptions {
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  shutdownGracePeriodMs: number;
}

class HttpRequestError extends Error {
  statusCode: number;
  closeConnection: boolean;

  constructor(
    statusCode: number,
    message: string,
    closeConnection = false,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.closeConnection = closeConnection;
  }
}

export interface StandalonePluginRouterOptions {
  bodyLimitBytes?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  shutdownGracePeriodMs?: number;
}

const API_BASE = '/plugin/napcat-plugin-qq-guardian/api';
const FILE_BASE = '/plugin/napcat-plugin-qq-guardian/files';
const PAGE_BASE = '/plugin/napcat-plugin-qq-guardian/page';

function positiveInteger(value: number | undefined, fallback: number, minimum = 1): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : fallback;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileRoute(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pieces = path.split('/').filter(Boolean).map((part) => {
    if (part.startsWith(':')) {
      keys.push(part.slice(1));
      return '([^/]+)';
    }
    return escapeRegex(part);
  });
  return { regex: new RegExp(`^/${pieces.join('/')}/?$`), keys };
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

async function readBody(req: IncomingMessage, bodyLimitBytes: number): Promise<unknown> {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > bodyLimitBytes) {
    req.resume();
    throw new HttpRequestError(413, 'Request body too large', true);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > bodyLimitBytes) {
        req.resume();
        throw new HttpRequestError(413, 'Request body too large', true);
      }
      chunks.push(buf);
    }
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    if (req.aborted) throw new HttpRequestError(400, 'Request aborted');
    throw error;
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/json')) {
    try { return JSON.parse(text); }
    catch { throw new HttpRequestError(400, 'Invalid JSON body'); }
  }
  return text;
}

function headersObject(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) out[key] = value;
  return out;
}

function streamFile(res: ServerResponse, filePath: string): void {
  const stream = createReadStream(filePath);
  res.once('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.once('error', () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Unable to read file');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function responseAdapter(res: ServerResponse): GuardianHttpResponse {
  const adapter: GuardianHttpResponse = {
    raw: res,
    status(code) { res.statusCode = code; return adapter; },
    json(data) {
      if (!res.headersSent) res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
    },
    send(data) {
      res.end(data);
    },
    setHeader(name, value) { res.setHeader(name, value); return adapter; },
    sendFile(filePath) {
      try {
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        if (!res.headersSent) res.setHeader('content-type', contentType(filePath));
        streamFile(res, filePath);
      } catch {
        res.statusCode = 500;
        res.end('Unable to read file');
      }
    },
    redirect(url) {
      res.statusCode = 302;
      res.setHeader('location', url);
      res.end();
    },
  };
  return adapter;
}

/**
 * Small standalone HTTP host that mirrors NapCat's plugin URL layout. The
 * existing WebUI and REST layer can therefore run unchanged when Guardian is
 * attached to SnowLuma instead of loaded as an in-process NapCat plugin.
 */
export class StandalonePluginRouter implements GuardianHttpRouter {
  private routes: RouteEntry[] = [];
  private statics: StaticEntry[] = [];
  private memoryStatics: MemoryStaticEntry[] = [];
  private pagesMap = new Map<string, GuardianPageDefinition>();
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private readonly pluginPath: string;
  private readonly options: ResolvedRouterOptions;

  constructor(pluginPath: string, options: StandalonePluginRouterOptions = {}) {
    const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 30_000);
    this.pluginPath = pluginPath;
    this.options = {
      bodyLimitBytes: positiveInteger(options.bodyLimitBytes, 1024 * 1024),
      requestTimeoutMs,
      headersTimeoutMs: Math.min(
        requestTimeoutMs,
        positiveInteger(options.headersTimeoutMs, 15_000),
      ),
      keepAliveTimeoutMs: positiveInteger(options.keepAliveTimeoutMs, 5_000),
      shutdownGracePeriodMs: positiveInteger(options.shutdownGracePeriodMs, 5_000),
    };
  }

  private register(method: HttpMethod, path: string, handler: GuardianRequestHandler): void {
    const fullPath = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
    const compiled = compileRoute(fullPath);
    this.routes.push({ method: method.toUpperCase(), path: fullPath, ...compiled, handler });
  }

  api(method: HttpMethod, path: string, handler: GuardianRequestHandler): void { this.register(method, path, handler); }
  apiNoAuth(method: HttpMethod, path: string, handler: GuardianRequestHandler): void { this.register(method, path, handler); }
  get(path: string, handler: GuardianRequestHandler): void { this.register('get', path, handler); }
  post(path: string, handler: GuardianRequestHandler): void { this.register('post', path, handler); }
  put(path: string, handler: GuardianRequestHandler): void { this.register('put', path, handler); }
  delete(path: string, handler: GuardianRequestHandler): void { this.register('delete', path, handler); }
  getNoAuth(path: string, handler: GuardianRequestHandler): void { this.register('get', path, handler); }
  postNoAuth(path: string, handler: GuardianRequestHandler): void { this.register('post', path, handler); }
  putNoAuth(path: string, handler: GuardianRequestHandler): void { this.register('put', path, handler); }
  deleteNoAuth(path: string, handler: GuardianRequestHandler): void { this.register('delete', path, handler); }

  static(urlPath: string, localPath: string): void {
    const normalized = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    this.statics.push({ urlPath: `${FILE_BASE}${normalized}`.replace(/\/$/, ''), localRoot: resolve(this.pluginPath, localPath) });
  }

  staticOnMem(urlPath: string, files: MemoryStaticFile[]): void {
    const normalized = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    this.memoryStatics.push({ urlPath: `${FILE_BASE}${normalized}`.replace(/\/$/, ''), files });
  }

  page(page: GuardianPageDefinition): void { this.pagesMap.set(page.path, page); }
  pages(pages: GuardianPageDefinition[]): void { for (const page of pages) this.page(page); }

  async listen(host: string, port: number): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = this.options.requestTimeoutMs;
    server.headersTimeout = this.options.headersTimeoutMs;
    server.keepAliveTimeout = this.options.keepAliveTimeoutMs;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    this.server = server;
    try {
      await new Promise<void>((resolveReady, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolveReady();
        });
      });
    } catch (error) {
      if (this.server === server) this.server = null;
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      server.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;

    server.closeIdleConnections?.();
    await new Promise<void>((resolveClose) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(forceClose);
        resolveClose();
      };
      const forceClose = setTimeout(() => {
        server.closeAllConnections?.();
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        finish();
      }, this.options.shutdownGracePeriodMs);
      forceClose.unref();
      server.close(() => finish());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The standalone management plane deliberately has no cross-origin API.
    // Keep browser interpretation and framing constrained even when an
    // operator places it behind a reverse proxy.
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    );
    res.setTimeout(this.options.requestTimeoutMs, () => {
      if (res.writableEnded || res.destroyed) return;
      if (!res.headersSent) res.statusCode = 408;
      res.setHeader('connection', 'close');
      res.end('Request timeout');
    });

    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === API_BASE || pathname.startsWith(`${API_BASE}/`)) {
        res.setHeader('cache-control', 'no-store');
      }

      if (pathname === '/') {
        res.statusCode = 302;
        res.setHeader('location', `${PAGE_BASE}/guardian`);
        res.end();
        return;
      }

      for (const [pagePath, page] of this.pagesMap) {
        if (pathname === `${PAGE_BASE}/${pagePath}` || pathname === `${PAGE_BASE}/${pagePath}/`) {
          const file = resolve(this.pluginPath, page.htmlFile);
          if (!existsSync(file)) { res.statusCode = 404; res.end('Page not found'); return; }
          res.setHeader('content-type', 'text/html; charset=utf-8');
          streamFile(res, file);
          return;
        }
      }

      for (const entry of this.memoryStatics) {
        const prefix = `${entry.urlPath}/`;
        if (!pathname.startsWith(prefix)) continue;
        const relative = pathname.slice(prefix.length);
        const file = entry.files.find((candidate) => candidate.path.replace(/^\//, '') === relative);
        if (!file) { res.statusCode = 404; res.end('Not found'); return; }
        const content = typeof file.content === 'function' ? await file.content() : file.content;
        if (file.contentType) res.setHeader('content-type', file.contentType);
        res.end(content);
        return;
      }

      for (const entry of this.statics) {
        const prefix = `${entry.urlPath}/`;
        if (!pathname.startsWith(prefix)) continue;
        const relative = pathname.slice(prefix.length);
        const target = resolve(entry.localRoot, relative);
        const rootWithSep = entry.localRoot.endsWith(sep) ? entry.localRoot : entry.localRoot + sep;
        if (target !== entry.localRoot && !target.startsWith(rootWithSep)) {
          res.statusCode = 403; res.end('Forbidden'); return;
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          res.statusCode = 404; res.end('Not found'); return;
        }
        res.setHeader('content-type', contentType(target));
        streamFile(res, target);
        return;
      }

      const method = (req.method ?? 'GET').toUpperCase();
      for (const route of this.routes) {
        if (route.method !== 'ALL' && route.method !== method) continue;
        const match = route.regex.exec(pathname);
        if (!match) continue;

        const params: Record<string, string> = {};
        route.keys.forEach((key, index) => { params[key] = decodeURIComponent(match[index + 1] ?? ''); });
        const query: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of url.searchParams) {
          const prior = query[key];
          if (prior === undefined) query[key] = value;
          else if (Array.isArray(prior)) prior.push(value);
          else query[key] = [prior, value];
        }

        const request: GuardianHttpRequest = {
          path: pathname,
          method,
          query,
          body: await readBody(req, this.options.bodyLimitBytes),
          headers: headersObject(req),
          params,
          raw: req,
        };
        const response = responseAdapter(res);
        await route.handler(request, response, () => {});
        if (!res.writableEnded && !res.headersSent) res.end();
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    } catch (error) {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      const requestError = error instanceof HttpRequestError ? error : null;
      res.statusCode = requestError?.statusCode ?? 500;
      if (requestError?.closeConnection) res.setHeader('connection', 'close');
      res.end(requestError?.message ?? 'Internal server error');
    }
  }
}
