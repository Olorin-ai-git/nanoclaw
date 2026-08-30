import { describe, expect, it } from 'vitest';

import {
  createEreborMessageCorrelation,
  createEreborRunCorrelation,
  loadTwoGatesRoutingConfig,
  RoutingConfigDependencies,
} from './twogates-routing.js';

const readableCa: RoutingConfigDependencies = {
  isAbsolutePath: (value) => value.startsWith('/'),
  isReadableFile: (value) => value === '/secrets/twogates-ca.pem',
};

const enabledEnvironment = {
  NANOCLAW_ENV: 'production',
  TWOGATES_PROXY_URL: 'https://proxy.example.test:8443',
  TWOGATES_PROXY_CREDENTIAL: `tg_${'a'.repeat(16)}_${'1'.repeat(48)}`,
  TWOGATES_CA_CERT_PATH: '/secrets/twogates-ca.pem',
  TWOGATES_TASK_CLASS: 'standard',
  TWOGATES_ANTHROPIC_ORIGIN: 'https://anthropic.example.test',
  TWOGATES_CONNECT_TIMEOUT_MS: '5000',
  TWOGATES_REQUEST_TIMEOUT_MS: '120000',
  TWOGATES_MAX_REQUEST_BODY_BYTES: '10485760',
  TWOGATES_MAX_RESPONSE_BODY_BYTES: '52428800',
  TWOGATES_MAX_HEADER_BYTES: '32768',
  TWOGATES_MAX_CONCURRENT_REQUESTS: '4',
};

describe('loadTwoGatesRoutingConfig', () => {
  it('leaves local development routing disabled when no values are configured', () => {
    expect(loadTwoGatesRoutingConfig({}, readableCa)).toEqual({
      mode: 'disabled',
      environment: 'development',
    });
  });

  it('fails closed when the standard Node environment marks production', () => {
    expect(() =>
      loadTwoGatesRoutingConfig({ NODE_ENV: 'production' }, readableCa),
    ).toThrow('TWOGATES_PROXY_URL is required');
  });

  it('loads a complete production routing contract', () => {
    expect(loadTwoGatesRoutingConfig(enabledEnvironment, readableCa)).toEqual({
      mode: 'enabled',
      environment: 'production',
      proxyUrl: 'https://proxy.example.test:8443',
      proxyCredential: enabledEnvironment.TWOGATES_PROXY_CREDENTIAL,
      caCertPath: '/secrets/twogates-ca.pem',
      taskClass: 'standard',
      anthropicOrigin: 'https://anthropic.example.test',
      connectTimeoutMs: 5000,
      requestTimeoutMs: 120000,
      maxRequestBodyBytes: 10485760,
      maxResponseBodyBytes: 52428800,
      maxHeaderBytes: 32768,
      maxConcurrentRequests: 4,
    });
  });

  it.each([
    'TWOGATES_PROXY_URL',
    'TWOGATES_PROXY_CREDENTIAL',
    'TWOGATES_CA_CERT_PATH',
    'TWOGATES_TASK_CLASS',
    'TWOGATES_ANTHROPIC_ORIGIN',
    'TWOGATES_CONNECT_TIMEOUT_MS',
    'TWOGATES_REQUEST_TIMEOUT_MS',
    'TWOGATES_MAX_REQUEST_BODY_BYTES',
    'TWOGATES_MAX_RESPONSE_BODY_BYTES',
    'TWOGATES_MAX_HEADER_BYTES',
    'TWOGATES_MAX_CONCURRENT_REQUESTS',
  ])('fails closed when production omits %s', (key) => {
    expect(() =>
      loadTwoGatesRoutingConfig(
        { ...enabledEnvironment, [key]: undefined },
        readableCa,
      ),
    ).toThrow(`${key} is required`);
  });

  it('rejects plaintext and credential-bearing proxy endpoints', () => {
    expect(() =>
      loadTwoGatesRoutingConfig(
        { ...enabledEnvironment, TWOGATES_PROXY_URL: 'http://proxy.test' },
        readableCa,
      ),
    ).toThrow('must use HTTPS');
    expect(() =>
      loadTwoGatesRoutingConfig(
        {
          ...enabledEnvironment,
          TWOGATES_PROXY_URL: 'https://token@proxy.test',
        },
        readableCa,
      ),
    ).toThrow('must not contain credentials');
  });

  it('rejects invalid credentials, task classes, and CA paths', () => {
    expect(() =>
      loadTwoGatesRoutingConfig(
        { ...enabledEnvironment, TWOGATES_PROXY_CREDENTIAL: 'secret\r\nvalue' },
        readableCa,
      ),
    ).toThrow('valid TwoGates agent token');
    expect(() =>
      loadTwoGatesRoutingConfig(
        { ...enabledEnvironment, TWOGATES_PROXY_CREDENTIAL: 'tg_legacy' },
        readableCa,
      ),
    ).toThrow('valid TwoGates agent token');
    expect(() =>
      loadTwoGatesRoutingConfig(
        { ...enabledEnvironment, TWOGATES_TASK_CLASS: 'agentic.medium' },
        readableCa,
      ),
    ).toThrow('approved Erebor task class');
    expect(() =>
      loadTwoGatesRoutingConfig(
        { ...enabledEnvironment, TWOGATES_CA_CERT_PATH: 'relative.pem' },
        readableCa,
      ),
    ).toThrow('absolute path');
    expect(() =>
      loadTwoGatesRoutingConfig(
        { ...enabledEnvironment, TWOGATES_CA_CERT_PATH: '/missing.pem' },
        readableCa,
      ),
    ).toThrow('readable file');
  });

  it('rejects partial local routing instead of silently falling back', () => {
    expect(() =>
      loadTwoGatesRoutingConfig(
        { TWOGATES_PROXY_URL: enabledEnvironment.TWOGATES_PROXY_URL },
        readableCa,
      ),
    ).toThrow('TWOGATES_PROXY_CREDENTIAL is required');
  });

  it('rejects non-positive and non-numeric transport bounds', () => {
    expect(() =>
      loadTwoGatesRoutingConfig(
        { ...enabledEnvironment, TWOGATES_CONNECT_TIMEOUT_MS: '0' },
        readableCa,
      ),
    ).toThrow('must be a positive integer');
    expect(() =>
      loadTwoGatesRoutingConfig(
        { ...enabledEnvironment, TWOGATES_MAX_HEADER_BYTES: 'many' },
        readableCa,
      ),
    ).toThrow('must be a positive integer');
  });
});

describe('Erebor correlation', () => {
  it('creates stable, domain-separated, header-safe pseudonyms', () => {
    const correlation = createEreborRunCorrelation({
      groupFolder: 'private-group',
      messageSourceId: 'platform-message-42',
      runId: '20D3CA62-9995-42D1-B46B-B230854FCA24',
    });

    expect(correlation.groupId).toMatch(/^[0-9a-f]{64}$/);
    expect(correlation.messageId).toMatch(/^[0-9a-f]{64}$/);
    expect(correlation.groupId).not.toBe(correlation.messageId);
    expect(correlation.runId).toBe('20d3ca62-9995-42d1-b46b-b230854fca24');
    expect(createEreborMessageCorrelation('platform-message-42')).toBe(
      correlation.messageId,
    );
  });

  it('rejects empty source identifiers and malformed run identifiers', () => {
    expect(() => createEreborMessageCorrelation('  ')).toThrow(
      'message correlation is required',
    );
    expect(() =>
      createEreborRunCorrelation({
        groupFolder: 'group',
        messageSourceId: 'message',
        runId: 'predictable-run',
      }),
    ).toThrow('must be a UUID');
  });
});
