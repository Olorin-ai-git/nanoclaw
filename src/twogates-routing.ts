import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export const TWOGATES_ENV_KEYS = [
  'NANOCLAW_ENV',
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
] as const;

export type NanoClawEnvironment = 'development' | 'test' | 'production';

export interface DisabledTwoGatesRouting {
  mode: 'disabled';
  environment: Exclude<NanoClawEnvironment, 'production'>;
}

export interface EnabledTwoGatesRouting {
  mode: 'enabled';
  environment: NanoClawEnvironment;
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

export type TwoGatesRoutingConfig =
  | DisabledTwoGatesRouting
  | EnabledTwoGatesRouting;

export interface EreborRunCorrelation {
  groupId: string;
  messageId: string;
  runId: string;
}

type EnvironmentSource = Record<string, string | undefined>;

export interface RoutingConfigDependencies {
  isAbsolutePath: (value: string) => boolean;
  isReadableFile: (value: string) => boolean;
}

const defaultDependencies: RoutingConfigDependencies = {
  isAbsolutePath: path.isAbsolute,
  isReadableFile: (value) => {
    try {
      return (
        fs.statSync(value).isFile() &&
        fs.accessSync(value, fs.constants.R_OK) === undefined
      );
    } catch {
      return false;
    }
  },
};

function requiredValue(env: EnvironmentSource, key: string): string {
  const value = env[key]?.trim();
  if (!value)
    throw new Error(`${key} is required when TwoGates routing is enabled`);
  return value;
}

function parseEnvironment(env: EnvironmentSource): NanoClawEnvironment {
  const explicitEnvironment = env.NANOCLAW_ENV?.trim();
  const environment =
    explicitEnvironment ||
    (env.NODE_ENV?.trim() === 'production'
      ? 'production'
      : env.NODE_ENV?.trim() === 'test'
        ? 'test'
        : 'development');
  if (
    environment !== 'development' &&
    environment !== 'test' &&
    environment !== 'production'
  ) {
    throw new Error(
      'NANOCLAW_ENV must be one of development, test, or production',
    );
  }
  return environment;
}

function parseHttpsUrl(value: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${key} must be a valid HTTPS URL`, { cause: error });
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${key} must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${key} must not contain credentials`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${key} must contain only an HTTPS origin`);
  }
  return parsed.origin;
}

function parseHeaderValue(value: string, key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${key} contains characters that are unsafe in a header`);
  }
  return value;
}

function parsePositiveInteger(env: EnvironmentSource, key: string): number {
  const value = requiredValue(env, key);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${key} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${key} must be a safe positive integer`);
  }
  return parsed;
}

export function loadTwoGatesRoutingConfig(
  env: EnvironmentSource,
  dependencies: RoutingConfigDependencies = defaultDependencies,
): TwoGatesRoutingConfig {
  const environment = parseEnvironment(env);
  const routingValuesPresent = TWOGATES_ENV_KEYS.slice(1).some((key) =>
    Boolean(env[key]?.trim()),
  );

  if (!routingValuesPresent && environment !== 'production') {
    return { mode: 'disabled', environment };
  }

  const proxyUrl = parseHttpsUrl(
    requiredValue(env, 'TWOGATES_PROXY_URL'),
    'TWOGATES_PROXY_URL',
  );
  const proxyCredential = requiredValue(env, 'TWOGATES_PROXY_CREDENTIAL');
  if (!/^tg_[0-9a-f]{4,}_[0-9a-f]{16,}$/.test(proxyCredential)) {
    throw new Error(
      'TWOGATES_PROXY_CREDENTIAL must be a valid TwoGates agent token',
    );
  }

  const caCertPath = requiredValue(env, 'TWOGATES_CA_CERT_PATH');
  if (!dependencies.isAbsolutePath(caCertPath)) {
    throw new Error('TWOGATES_CA_CERT_PATH must be an absolute path');
  }
  if (!dependencies.isReadableFile(caCertPath)) {
    throw new Error('TWOGATES_CA_CERT_PATH must reference a readable file');
  }

  const taskClass = parseHeaderValue(
    requiredValue(env, 'TWOGATES_TASK_CLASS'),
    'TWOGATES_TASK_CLASS',
  );
  const anthropicOrigin = parseHttpsUrl(
    requiredValue(env, 'TWOGATES_ANTHROPIC_ORIGIN'),
    'TWOGATES_ANTHROPIC_ORIGIN',
  );

  return {
    mode: 'enabled',
    environment,
    proxyUrl,
    proxyCredential,
    caCertPath,
    taskClass,
    anthropicOrigin,
    connectTimeoutMs: parsePositiveInteger(env, 'TWOGATES_CONNECT_TIMEOUT_MS'),
    requestTimeoutMs: parsePositiveInteger(env, 'TWOGATES_REQUEST_TIMEOUT_MS'),
    maxRequestBodyBytes: parsePositiveInteger(
      env,
      'TWOGATES_MAX_REQUEST_BODY_BYTES',
    ),
    maxResponseBodyBytes: parsePositiveInteger(
      env,
      'TWOGATES_MAX_RESPONSE_BODY_BYTES',
    ),
    maxHeaderBytes: parsePositiveInteger(env, 'TWOGATES_MAX_HEADER_BYTES'),
    maxConcurrentRequests: parsePositiveInteger(
      env,
      'TWOGATES_MAX_CONCURRENT_REQUESTS',
    ),
  };
}

function hashCorrelationValue(
  kind: 'group' | 'message',
  value: string,
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Erebor ${kind} correlation is required`);
  return createHash('sha256')
    .update(`nanoclaw:${kind}:`)
    .update(normalized)
    .digest('hex');
}

export function createEreborRunCorrelation(input: {
  groupFolder: string;
  messageSourceId: string;
  runId: string;
}): EreborRunCorrelation {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.runId,
    )
  ) {
    throw new Error('Erebor run correlation must be a UUID');
  }
  return {
    groupId: hashCorrelationValue('group', input.groupFolder),
    messageId: hashCorrelationValue('message', input.messageSourceId),
    runId: input.runId.toLowerCase(),
  };
}

export function createEreborMessageCorrelation(
  messageSourceId: string,
): string {
  return hashCorrelationValue('message', messageSourceId);
}
