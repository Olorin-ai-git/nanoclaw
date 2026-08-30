import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import {
  buildRoutedSdkEnvironment,
  latestCorrelatedMessageId,
  prepareRoutedFollowUp,
  loadProviderRoutingConfig,
  startProviderBridge,
} from '../dist/provider-routing.js';

function runOpenSsl(directory, args) {
  execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
}

function createCertificates(directory) {
  for (const name of ['proxy', 'provider']) {
    runOpenSsl(directory, [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}-ca-key.pem`,
      '-out',
      `${name}-ca.pem`,
      '-days',
      '1',
      '-subj',
      `/CN=NanoClaw ${name} routing test CA`,
    ]);
  }

  for (const [name, commonName, subjectAltName] of [
    ['proxy', 'localhost', 'DNS:localhost'],
    ['provider', 'api.anthropic.test', 'DNS:api.anthropic.test'],
  ]) {
    runOpenSsl(directory, [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}-key.pem`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=${commonName}`,
    ]);
    fs.writeFileSync(
      path.join(directory, `${name}.ext`),
      `subjectAltName=${subjectAltName}\nextendedKeyUsage=serverAuth\n`,
    );
    runOpenSsl(directory, [
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      `${name}-ca.pem`,
      '-CAkey',
      `${name}-ca-key.pem`,
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-days',
      '1',
      '-extfile',
      `${name}.ext`,
    ]);
  }
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestBridge(origin, headers) {
  const target = new URL('/v1/messages', origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      target,
      { method: 'POST', headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('aborted', () => reject(new Error('response aborted')));
        response.once('error', reject);
        response.once('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.once('error', reject);
    request.end('{"model":"claude-test","messages":[]}');
  });
}

function requestAbsoluteUri(origin) {
  const bridge = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: bridge.hostname,
        port: bridge.port,
        method: 'GET',
        path: 'http://unrelated.example.test/private',
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function requestConnect(origin) {
  const bridge = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(bridge.port), bridge.hostname);
    const chunks = [];
    socket.once('connect', () => {
      socket.write(
        'CONNECT unrelated.example.test:443 HTTP/1.1\r\nHost: unrelated.example.test:443\r\n\r\n',
      );
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('ascii')));
    socket.once('error', reject);
  });
}

test('provider routing file rejects malformed secrets and unsafe paths', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-routing-config-test-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'routing.json');
  const config = {
    proxyUrl: 'https://proxy.example.test:8443',
    proxyCredential: `tg_${'a'.repeat(16)}_${'1'.repeat(48)}`,
    caCertPath: '/run/nanoclaw/twogates/ca.pem',
    taskClass: 'standard',
    anthropicOrigin: 'https://api.anthropic.test',
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    maxRequestBodyBytes: 1048576,
    maxResponseBodyBytes: 1048576,
    maxHeaderBytes: 16384,
    maxConcurrentRequests: 2,
  };

  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.deepEqual(loadProviderRoutingConfig(configPath), config);

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...config, proxyCredential: 'tg_legacy' }),
  );
  assert.throws(
    () => loadProviderRoutingConfig(configPath),
    /valid TwoGates agent token/,
  );

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...config, taskClass: 'agentic.medium' }),
  );
  assert.throws(
    () => loadProviderRoutingConfig(configPath),
    /approved Erebor task class/,
  );

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...config, caCertPath: 'relative.pem' }),
  );
  assert.throws(() => loadProviderRoutingConfig(configPath), /absolute path/);
});

test('routed follow-up messages require fresh correlation', () => {
  assert.throws(
    () => latestCorrelatedMessageId([{ messageId: undefined }], true),
    /correlation is missing/,
  );
  assert.throws(
    () =>
      latestCorrelatedMessageId(
        [{ messageId: undefined }, { messageId: 'b'.repeat(64) }],
        true,
      ),
    /correlation is missing/,
  );
  assert.equal(
    latestCorrelatedMessageId(
      [{ messageId: 'a'.repeat(64) }, { messageId: 'b'.repeat(64) }],
      true,
    ),
    'b'.repeat(64),
  );
  assert.deepEqual(
    prepareRoutedFollowUp(
      [
        { text: 'first', messageId: 'a'.repeat(64) },
        { text: 'second', messageId: 'b'.repeat(64) },
      ],
      true,
    ),
    { text: 'first\nsecond', messageId: 'b'.repeat(64) },
  );
  assert.equal(
    prepareRoutedFollowUp([{ text: 'direct mode' }], false),
    undefined,
  );
});

test('provider bridge uses dual TLS, Bearer CONNECT auth, and exact correlation headers', async () => {
  const certificateDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-routing-test-'),
  );
  createCertificates(certificateDirectory);
  const read = (name) => fs.readFileSync(path.join(certificateDirectory, name));
  const observed = {
    connectHead: '',
    providerHead: '',
    connectCount: 0,
    responseMode: 'normal',
    slowResponseStarted: false,
  };

  const proxyServer = tls.createServer(
    { key: read('proxy-key.pem'), cert: read('proxy.pem') },
    (outerSocket) => {
      let connectBuffer = Buffer.alloc(0);
      const onConnectData = (chunk) => {
        connectBuffer = Buffer.concat([connectBuffer, chunk]);
        const boundary = connectBuffer.indexOf('\r\n\r\n');
        if (boundary === -1) return;
        outerSocket.off('data', onConnectData);
        observed.connectCount++;
        observed.connectHead = connectBuffer
          .subarray(0, boundary)
          .toString('ascii');
        outerSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

        const innerSocket = new tls.TLSSocket(outerSocket, {
          isServer: true,
          secureContext: tls.createSecureContext({
            key: read('provider-key.pem'),
            cert: read('provider.pem'),
          }),
        });
        let providerBuffer = Buffer.alloc(0);
        let providerResponded = false;
        innerSocket.on('data', (providerChunk) => {
          providerBuffer = Buffer.concat([providerBuffer, providerChunk]);
          const providerBoundary = providerBuffer.indexOf('\r\n\r\n');
          if (providerBoundary === -1 || providerResponded) return;
          providerResponded = true;
          observed.providerHead = providerBuffer
            .subarray(0, providerBoundary)
            .toString('ascii');
          const responseBody = '{"routed":true}';
          if (observed.responseMode === 'large-header') {
            innerSocket.end(
              [
                'HTTP/1.1 200 OK',
                `X-Large: ${'x'.repeat(2048)}`,
                'Content-Length: 0',
                'Connection: close',
                '',
                '',
              ].join('\r\n'),
            );
            return;
          }
          if (observed.responseMode === 'slow') {
            observed.slowResponseStarted = true;
            innerSocket.write(
              [
                'HTTP/1.1 200 OK',
                'Content-Type: application/octet-stream',
                'Content-Length: 1000',
                'Connection: close',
                '',
                '',
              ].join('\r\n'),
            );
            const interval = setInterval(() => innerSocket.write('.'), 20);
            innerSocket.once('close', () => clearInterval(interval));
            return;
          }
          innerSocket.end(
            [
              'HTTP/1.1 200 OK',
              'Content-Type: application/json',
              `Content-Length: ${Buffer.byteLength(responseBody)}`,
              'Connection: close',
              '',
              responseBody,
            ].join('\r\n'),
          );
        });
      };
      outerSocket.on('data', onConnectData);
    },
  );

  const unrelatedServer = http.createServer((_request, response) => {
    response.end('direct');
  });

  const logs = [];
  let bridge;
  try {
    const proxyPort = await listen(proxyServer, 'localhost');
    const unrelatedPort = await listen(unrelatedServer);
    const routingConfig = {
      proxyUrl: `https://localhost:${proxyPort}`,
      proxyCredential: `tg_${'a'.repeat(16)}_${'1'.repeat(48)}`,
      caCertPath: path.join(certificateDirectory, 'proxy-ca.pem'),
      taskClass: 'standard',
      anthropicOrigin: 'https://api.anthropic.test:443',
      connectTimeoutMs: 5000,
      requestTimeoutMs: 5000,
      maxRequestBodyBytes: 1048576,
      maxResponseBodyBytes: 1048576,
      maxHeaderBytes: 16384,
      maxConcurrentRequests: 2,
    };
    const correlation = () => ({
      groupId: 'a'.repeat(64),
      messageId: 'b'.repeat(64),
      runId: '20d3ca62-9995-42d1-b46b-b230854fca24',
    });
    const dependencies = {
      requestId: () => '6ec69f65-a92a-40b8-b6b5-d66d9c740d31',
      log: (fields, message) => logs.push({ fields, message }),
      providerCa: [
        fs.readFileSync(
          path.join(certificateDirectory, 'provider-ca.pem'),
          'utf8',
        ),
      ],
    };
    bridge = await startProviderBridge(
      routingConfig,
      correlation,
      dependencies,
    );

    const routed = await requestBridge(bridge.origin, {
      'content-type': 'application/json',
      'x-api-key': 'twogates-managed',
      'x-erebor-request-id': 'spoofed',
    });
    assert.equal(routed.status, 200, JSON.stringify(logs));
    assert.equal(routed.body, '{"routed":true}');
    assert.match(
      observed.connectHead,
      /^CONNECT api\.anthropic\.test:443 HTTP\/1\.1/m,
    );
    assert.match(
      observed.connectHead,
      new RegExp(
        `^Proxy-Authorization: Bearer tg_${'a'.repeat(16)}_${'1'.repeat(48)}$`,
        'im',
      ),
    );
    assert.match(observed.providerHead, /^Host: api\.anthropic\.test$/im);
    assert.doesNotMatch(
      observed.providerHead,
      /^(?:x-api-key|authorization):/im,
    );
    assert.match(
      observed.providerHead,
      /^x-erebor-request-id: 6ec69f65-a92a-40b8-b6b5-d66d9c740d31$/im,
    );
    assert.match(
      observed.providerHead,
      /^x-erebor-task-class: standard$/im,
    );
    assert.match(
      observed.providerHead,
      new RegExp(`^x-erebor-group-id: ${'a'.repeat(64)}$`, 'im'),
    );
    assert.match(
      observed.providerHead,
      new RegExp(`^x-erebor-message-id: ${'b'.repeat(64)}$`, 'im'),
    );
    assert.match(
      observed.providerHead,
      /^x-erebor-run-id: 20d3ca62-9995-42d1-b46b-b230854fca24$/im,
    );

    const environment = buildRoutedSdkEnvironment(
      {
        HTTPS_PROXY: 'https://must-not-survive.test',
        ALL_PROXY: 'socks://must-not-survive.test',
        CLAUDE_CODE_OAUTH_TOKEN: 'raw-oauth-secret',
        ANTHROPIC_AUTH_TOKEN: 'raw-auth-secret',
        ANTHROPIC_API_KEY: 'raw-api-secret',
      },
      bridge.origin,
    );
    assert.equal(environment.HTTPS_PROXY, undefined);
    assert.equal(environment.ALL_PROXY, undefined);
    assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(environment.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(environment.ANTHROPIC_API_KEY, 'twogates-managed');

    assert.equal(await requestAbsoluteUri(bridge.origin), 400);
    assert.match(await requestConnect(bridge.origin), /^HTTP\/1\.1 405 /);

    const direct = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${unrelatedPort}/health`, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.once('end', () => resolve(Buffer.concat(chunks).toString()));
        })
        .once('error', reject);
    });
    assert.equal(direct, 'direct');
    assert.equal(observed.connectCount, 1);
    assert.ok(
      logs.some(
        (entry) => entry.message === 'TwoGates provider request completed',
      ),
    );

    await bridge.close();
    bridge = undefined;
    observed.responseMode = 'large-header';
    bridge = await startProviderBridge(
      { ...routingConfig, maxHeaderBytes: 1024 },
      correlation,
      dependencies,
    );
    const oversizedHeaders = await requestBridge(bridge.origin, {
      'content-type': 'application/json',
    });
    assert.equal(oversizedHeaders.status, 502);

    await bridge.close();
    bridge = undefined;
    observed.responseMode = 'slow';
    bridge = await startProviderBridge(
      { ...routingConfig, requestTimeoutMs: 500 },
      correlation,
      dependencies,
    );
    const requestStartedAt = Date.now();
    const slowOutcome = await Promise.race([
      requestBridge(bridge.origin, { 'content-type': 'application/json' }).then(
        (response) => ({ response }),
        (error) => ({ error }),
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('bridge exceeded its wall-clock deadline')),
          1500,
        ),
      ),
    ]);
    assert.equal(observed.slowResponseStarted, true);
    assert.ok(
      slowOutcome.error || slowOutcome.response.status === 502,
      `expected fail-closed timeout, received ${JSON.stringify(slowOutcome)}`,
    );
    assert.ok(Date.now() - requestStartedAt < 1500);
    assert.equal(observed.connectCount, 3);
  } finally {
    await bridge?.close();
    if (proxyServer.listening) await close(proxyServer);
    if (unrelatedServer.listening) await close(unrelatedServer);
    fs.rmSync(certificateDirectory, { recursive: true, force: true });
  }
});
