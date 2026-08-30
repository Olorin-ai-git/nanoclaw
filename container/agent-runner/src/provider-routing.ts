import fs from 'fs';
import http, { IncomingHttpHeaders } from 'http';
import { NetConnectOpts, Socket } from 'net';
import path from 'path';
import tls from 'tls';

export interface ProviderRoutingConfig {
  proxyUrl: string;
  proxyCredential: string;
  caCertPath: string;
  taskClass: string;
  anthropicOrigin: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxRequestBodyBytes: number;
  maxResponseBodyBytes: number;
  maxHeaderBytes: number;
  maxConcurrentRequests: number;
}

export interface ProviderCorrelation {
  groupId: string;
  messageId: string;
  runId: string;
}

export interface ProviderBridge {
  origin: string;
  close: () => Promise<void>;
}

export interface ProviderBridgeDependencies {
  requestId: () => string;
  log: (fields: Record<string, unknown>, message: string) => void;
}

export function latestCorrelatedMessageId(
  messages: ReadonlyArray<{ messageId?: string }>,
  required: boolean,
): string | undefined {
  if (required && messages.some((message) => !message.messageId)) {
    throw new Error('TwoGates follow-up message correlation is missing');
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].messageId) return messages[index].messageId;
  }
  return undefined;
}

const LOOPBACK_HOST = '127.0.0.1';
const ROUTED_AUTH_MARKER = 'twogates-managed';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const EREBOR_HEADERS = new Set([
  'x-erebor-request-id',
  'x-erebor-task-class',
  'x-erebor-group-id',
  'x-erebor-message-id',
  'x-erebor-run-id',
]);
const PROVIDER_AUTH_HEADERS = new Set(['authorization', 'x-api-key']);

function requireString(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value: unknown, key: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${key} must be a safe positive integer`);
  }
  return value as number;
}

function requireHttpsOrigin(value: unknown, key: string): string {
  const raw = requireString(value, key);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error(`${key} must be a valid HTTPS origin`, { cause: error });
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${key} must be a credential-free HTTPS origin`);
  }
  return parsed.origin;
}

export function loadProviderRoutingConfig(
  filePath: string,
): ProviderRoutingConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error('Unable to read TwoGates provider routing config', {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TwoGates provider routing config must be an object');
  }
  const value = parsed as Record<string, unknown>;
  const proxyCredential = requireString(
    value.proxyCredential,
    'proxyCredential',
  );
  if (!/^tg_[0-9a-f]{4,}_[0-9a-f]{16,}$/.test(proxyCredential)) {
    throw new Error('proxyCredential must be a valid TwoGates agent token');
  }
  const caCertPath = requireString(value.caCertPath, 'caCertPath');
  if (!path.isAbsolute(caCertPath)) {
    throw new Error('caCertPath must be an absolute path');
  }
  const taskClass = requireString(value.taskClass, 'taskClass');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskClass)) {
    throw new Error('taskClass contains unsafe header characters');
  }

  return {
    proxyUrl: requireHttpsOrigin(value.proxyUrl, 'proxyUrl'),
    proxyCredential,
    caCertPath,
    taskClass,
    anthropicOrigin: requireHttpsOrigin(
      value.anthropicOrigin,
      'anthropicOrigin',
    ),
    connectTimeoutMs: requirePositiveInteger(
      value.connectTimeoutMs,
      'connectTimeoutMs',
    ),
    requestTimeoutMs: requirePositiveInteger(
      value.requestTimeoutMs,
      'requestTimeoutMs',
    ),
    maxRequestBodyBytes: requirePositiveInteger(
      value.maxRequestBodyBytes,
      'maxRequestBodyBytes',
    ),
    maxResponseBodyBytes: requirePositiveInteger(
      value.maxResponseBodyBytes,
      'maxResponseBodyBytes',
    ),
    maxHeaderBytes: requirePositiveInteger(
      value.maxHeaderBytes,
      'maxHeaderBytes',
    ),
    maxConcurrentRequests: requirePositiveInteger(
      value.maxConcurrentRequests,
      'maxConcurrentRequests',
    ),
  };
}

function validateCorrelation(correlation: ProviderCorrelation): void {
  for (const [key, value] of Object.entries(correlation)) {
    const valid =
      key === 'runId'
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value,
          )
        : /^[0-9a-f]{64}$/.test(value);
    if (!valid) throw new Error(`Invalid Erebor ${key} correlation`);
  }
}

function combinedCa(caCertPath: string): string[] {
  const privateCa = fs.readFileSync(caCertPath, 'utf8');
  if (!privateCa.includes('BEGIN CERTIFICATE')) {
    throw new Error('TwoGates CA file does not contain a PEM certificate');
  }
  return [...tls.rootCertificates, privateCa];
}

function proxyPort(proxy: URL): number {
  return proxy.port ? Number(proxy.port) : 443;
}

function originPort(origin: URL): number {
  return origin.port ? Number(origin.port) : 443;
}

function connectTunnel(
  config: ProviderRoutingConfig,
  ca: string[],
  signal: AbortSignal,
): Promise<tls.TLSSocket> {
  const proxy = new URL(config.proxyUrl);
  const origin = new URL(config.anthropicOrigin);

  return new Promise((resolve, reject) => {
    let inner: tls.TLSSocket | undefined;
    const outer = tls.connect({
      host: proxy.hostname,
      port: proxyPort(proxy),
      servername: proxy.hostname,
      ca,
      rejectUnauthorized: true,
    });
    outer.setTimeout(config.connectTimeoutMs);

    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      inner?.destroy();
      outer.destroy();
      reject(error);
    };
    const abort = () => fail(new Error('Provider request timed out'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });

    outer.once('timeout', () => fail(new Error('TwoGates CONNECT timed out')));
    outer.once('error', fail);
    outer.once('secureConnect', () => {
      outer.write(
        [
          `CONNECT ${origin.hostname}:${originPort(origin)} HTTP/1.1`,
          `Host: ${origin.hostname}:${originPort(origin)}`,
          `Proxy-Authorization: Bearer ${config.proxyCredential}`,
          '',
          '',
        ].join('\r\n'),
      );
    });

    let responseHead = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      responseHead = Buffer.concat([responseHead, chunk]);
      if (responseHead.length > config.maxHeaderBytes) {
        fail(new Error('TwoGates CONNECT response headers exceeded the limit'));
        return;
      }
      const boundary = responseHead.indexOf('\r\n\r\n');
      if (boundary === -1) return;
      outer.off('data', onData);
      const statusLine = responseHead
        .subarray(0, boundary)
        .toString('ascii')
        .split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200(?: |$)/.test(statusLine)) {
        fail(
          new Error(
            `TwoGates CONNECT refused the provider route: ${statusLine}`,
          ),
        );
        return;
      }
      outer.setTimeout(0);

      const providerSocket = tls.connect({
        socket: outer,
        servername: origin.hostname,
        ca,
        rejectUnauthorized: true,
      });
      inner = providerSocket;
      const innerFail = (error: Error) => {
        fail(error);
      };
      providerSocket.setTimeout(config.connectTimeoutMs);
      providerSocket.once('timeout', () =>
        innerFail(
          new Error('Anthropic TLS handshake through TwoGates timed out'),
        ),
      );
      providerSocket.once('error', innerFail);
      providerSocket.once('secureConnect', () => {
        settled = true;
        cleanup();
        providerSocket.setTimeout(0);
        outer.removeListener('error', fail);
        providerSocket.removeListener('error', innerFail);
        resolve(providerSocket);
      });
    };
    outer.on('data', onData);
  });
}

function readBoundedBody(
  request: http.IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', fail);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      fail(new Error('Provider request timed out'));
      request.destroy();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(new Error('Provider request body exceeded the configured limit'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', fail);
  });
}

function forwardedHeaders(
  source: IncomingHttpHeaders,
  origin: URL,
  config: ProviderRoutingConfig,
  correlation: ProviderCorrelation,
  requestId: string,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (
      value === undefined ||
      lower === 'host' ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      PROVIDER_AUTH_HEADERS.has(lower) ||
      EREBOR_HEADERS.has(lower)
    ) {
      continue;
    }
    headers[lower] = value;
  }
  headers.host = origin.host;
  headers['x-erebor-request-id'] = requestId;
  headers['x-erebor-task-class'] = config.taskClass;
  headers['x-erebor-group-id'] = correlation.groupId;
  headers['x-erebor-message-id'] = correlation.messageId;
  headers['x-erebor-run-id'] = correlation.runId;
  return headers;
}

function responseHeaders(
  source: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key.toLowerCase()))
      continue;
    headers[key] = value;
  }
  return headers;
}

class ExistingSocketAgent extends http.Agent {
  constructor(private readonly socket: Socket) {
    super({ keepAlive: false });
  }

  override createConnection(
    _options: NetConnectOpts,
    callback?: (error: Error | null, stream: Socket) => void,
  ): Socket {
    callback?.(null, this.socket);
    return this.socket;
  }
}

export function buildRoutedSdkEnvironment(
  source: NodeJS.ProcessEnv,
  bridgeOrigin: string,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...source };
  for (const key of [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    delete environment[key];
  }
  environment.ANTHROPIC_BASE_URL = bridgeOrigin;
  environment.ANTHROPIC_API_KEY = ROUTED_AUTH_MARKER;
  return environment;
}

export async function startProviderBridge(
  config: ProviderRoutingConfig,
  currentCorrelation: () => ProviderCorrelation,
  dependencies: ProviderBridgeDependencies,
): Promise<ProviderBridge> {
  const ca = combinedCa(config.caCertPath);
  const origin = new URL(config.anthropicOrigin);
  let activeRequests = 0;
  const sockets = new Set<import('net').Socket>();

  const server = http.createServer(
    {
      maxHeaderSize: config.maxHeaderBytes,
      headersTimeout: config.requestTimeoutMs,
      requestTimeout: config.requestTimeoutMs,
    },
    (request, response) => {
      if (activeRequests >= config.maxConcurrentRequests) {
        response.writeHead(503, { connection: 'close' });
        response.end();
        return;
      }
      activeRequests++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeRequests--;
      };

      const handle = async () => {
        if (
          request.method === 'CONNECT' ||
          !request.url ||
          !request.url.startsWith('/') ||
          request.url.startsWith('//')
        ) {
          response.writeHead(400, { connection: 'close' });
          response.end();
          return;
        }

        const correlation = { ...currentCorrelation() };
        validateCorrelation(correlation);
        const requestId = dependencies.requestId();
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            requestId,
          )
        ) {
          throw new Error('Provider request identifier must be a UUID');
        }
        const requestAbortController = new AbortController();
        const requestDeadline = setTimeout(
          () => requestAbortController.abort(),
          config.requestTimeoutMs,
        );
        let tunnel: tls.TLSSocket | undefined;
        try {
          const body = await readBoundedBody(
            request,
            config.maxRequestBodyBytes,
            requestAbortController.signal,
          );
          tunnel = await connectTunnel(
            config,
            ca,
            requestAbortController.signal,
          );

          await new Promise<void>((resolve, reject) => {
            const tunnelAgent = new ExistingSocketAgent(tunnel!);
            const upstream = http.request(
              {
                host: origin.hostname,
                port: originPort(origin),
                method: request.method,
                path: request.url,
                headers: forwardedHeaders(
                  request.headers,
                  origin,
                  config,
                  correlation,
                  requestId,
                ),
                agent: tunnelAgent,
                maxHeaderSize: config.maxHeaderBytes,
                signal: requestAbortController.signal,
              },
              (upstreamResponse) => {
                response.writeHead(
                  upstreamResponse.statusCode ?? 502,
                  responseHeaders(upstreamResponse.headers),
                );
                let responseBytes = 0;
                upstreamResponse.on('data', (chunk: Buffer) => {
                  responseBytes += chunk.length;
                  if (responseBytes > config.maxResponseBodyBytes) {
                    reject(
                      new Error(
                        'Provider response body exceeded the configured limit',
                      ),
                    );
                    upstreamResponse.destroy();
                    response.destroy();
                    return;
                  }
                  response.write(chunk);
                });
                upstreamResponse.once('end', () => {
                  response.end();
                  dependencies.log(
                    {
                      requestId,
                      runId: correlation.runId,
                      status: upstreamResponse.statusCode,
                    },
                    'TwoGates provider request completed',
                  );
                  resolve();
                });
                upstreamResponse.once('error', reject);
              },
            );
            upstream.once('error', reject);
            upstream.end(body);
          });
        } finally {
          clearTimeout(requestDeadline);
          tunnel?.destroy();
        }
      };

      handle()
        .catch((error) => {
          dependencies.log(
            { error: error instanceof Error ? error.message : String(error) },
            'TwoGates provider request failed',
          );
          if (!response.headersSent) {
            response.writeHead(502, { connection: 'close' });
            response.end();
          } else {
            response.destroy();
          }
        })
        .finally(release);
    },
  );

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_request, socket) => {
    socket.end(
      'HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
  });
  server.maxRequestsPerSocket = 1;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (
    !address ||
    typeof address === 'string' ||
    address.address !== LOOPBACK_HOST
  ) {
    server.close();
    throw new Error(
      'Provider bridge did not bind to the required loopback address',
    );
  }

  return {
    origin: `http://${LOOPBACK_HOST}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
