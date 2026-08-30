import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  appendContainerCredentialRouting,
  cleanupActiveTwoGatesRoutingFiles,
  cleanupStaleTwoGatesRoutingFiles,
  prepareTwoGatesRouting,
  sourceTreeRequiresSync,
} from './container-runner.js';
import type { EnabledTwoGatesRouting } from './twogates-routing.js';

const routingConfig: EnabledTwoGatesRouting = {
  mode: 'enabled',
  environment: 'production',
  proxyUrl: 'https://proxy.example.test:8443',
  proxyCredential: `tg_abcd_${'1'.repeat(16)}`,
  caCertPath: '/secrets/twogates-ca.pem',
  taskClass: 'agentic.medium',
  anthropicOrigin: 'https://anthropic.example.test',
  connectTimeoutMs: 5000,
  requestTimeoutMs: 120000,
  maxRequestBodyBytes: 10485760,
  maxResponseBodyBytes: 52428800,
  maxHeaderBytes: 32768,
  maxConcurrentRequests: 4,
};

describe('production container routing boundary', () => {
  it('refreshes cached runner sources when the bridge module is absent', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-runner-sync-test-'),
    );
    const sourceDirectory = path.join(directory, 'source');
    const destinationDirectory = path.join(directory, 'destination');
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(sourceDirectory, 'index.ts'), 'entry');
    fs.writeFileSync(path.join(destinationDirectory, 'index.ts'), 'entry');
    fs.writeFileSync(
      path.join(sourceDirectory, 'provider-routing.ts'),
      'bridge',
    );

    try {
      expect(
        sourceTreeRequiresSync(sourceDirectory, destinationDirectory),
      ).toBe(true);
      fs.copyFileSync(
        path.join(sourceDirectory, 'provider-routing.ts'),
        path.join(destinationDirectory, 'provider-routing.ts'),
      );
      expect(
        sourceTreeRequiresSync(sourceDirectory, destinationDirectory),
      ).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates the secret-bearing routing file with owner-only permissions', () => {
    const prepared = prepareTwoGatesRouting(
      routingConfig,
      { groupFolder: 'private-group', messageSourceId: 'message-42' },
      randomUUID(),
    );
    const routingFile = prepared.mounts[0].hostPath;

    try {
      expect(fs.statSync(routingFile).mode & 0o777).toBe(0o600);
      expect(routingFile.startsWith(process.cwd())).toBe(false);
    } finally {
      prepared.cleanup();
    }
    expect(fs.existsSync(routingFile)).toBe(false);
  });

  it('writes the proxy secret only to the protected routing file', () => {
    let routingFile = '';
    let routingContents = '';
    const removed: string[] = [];
    const prepared = prepareTwoGatesRouting(
      routingConfig,
      { groupFolder: 'private-group', messageSourceId: 'message-42' },
      '20d3ca62-9995-42d1-b46b-b230854fca24',
      {
        createDirectory: () => undefined,
        writeExclusiveFile: (filePath, contents) => {
          routingFile = filePath;
          routingContents = contents;
        },
        removeFile: (filePath) => removed.push(filePath),
      },
    );

    expect(routingContents).toContain(routingConfig.proxyCredential);
    expect(routingFile.startsWith(process.cwd())).toBe(false);
    expect(prepared.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostPath: routingFile, readonly: true }),
        expect.objectContaining({
          hostPath: routingConfig.caCertPath,
          readonly: true,
        }),
      ]),
    );
    expect(JSON.stringify(prepared.correlation)).not.toContain('private-group');
    expect(JSON.stringify(prepared.correlation)).not.toContain('message-42');

    prepared.cleanup();
    prepared.cleanup();
    expect(removed).toEqual([routingFile]);
  });

  it('cleans active routing files during host shutdown', () => {
    const removed: string[] = [];
    const prepared = prepareTwoGatesRouting(
      routingConfig,
      { groupFolder: 'private-group', messageSourceId: 'message-42' },
      randomUUID(),
      {
        createDirectory: () => undefined,
        writeExclusiveFile: () => undefined,
        removeFile: (filePath) => removed.push(filePath),
      },
    );

    cleanupActiveTwoGatesRoutingFiles();
    expect(removed).toEqual([prepared.mounts[0].hostPath]);
  });

  it('removes crash residue without touching unrelated runtime files', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-routing-cleanup-test-'),
    );
    const staleFile = path.join(directory, `${randomUUID()}.json`);
    const unrelatedFile = path.join(directory, 'unrelated.json');
    fs.writeFileSync(staleFile, 'secret');
    fs.writeFileSync(unrelatedFile, 'keep');

    try {
      cleanupStaleTwoGatesRoutingFiles(directory);
      expect(fs.existsSync(staleFile)).toBe(false);
      expect(fs.existsSync(unrelatedFile)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never reads or injects raw provider credentials when TwoGates is enabled', async () => {
    const args: string[] = [];
    const readProviderCredentials = vi.fn(() => ({
      CLAUDE_CODE_OAUTH_TOKEN: 'raw-oauth-secret',
      ANTHROPIC_API_KEY: 'raw-api-secret',
      ANTHROPIC_AUTH_TOKEN: 'raw-auth-secret',
    }));
    const applyOneCli = vi.fn(async () => true);

    await appendContainerCredentialRouting(
      args,
      true,
      'container-name',
      'agent-name',
      { readProviderCredentials, applyOneCli },
    );

    expect(readProviderCredentials).not.toHaveBeenCalled();
    expect(applyOneCli).not.toHaveBeenCalled();
    expect(args.join(' ')).toContain('NANOCLAW_TWOGATES_CONFIG_PATH=');
    expect(args.join(' ')).not.toMatch(
      /raw-oauth-secret|raw-api-secret|raw-auth-secret/,
    );
  });
});
