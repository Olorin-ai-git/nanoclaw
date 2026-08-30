/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
  TWOGATES_ROUTING,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { readEnvFile } from './env.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import {
  createEreborRunCorrelation,
  EreborRunCorrelation,
  TwoGatesRoutingConfig,
} from './twogates-routing.js';

const onecli = new OneCLI({ url: ONECLI_URL });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const CONTAINER_ROUTING_CONFIG_PATH = '/run/nanoclaw/twogates/config.json';
const CONTAINER_ROUTING_CA_PATH = '/run/nanoclaw/twogates/ca.pem';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  messageSourceId?: string;
  routing?: EreborRunCorrelation;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

interface PreparedTwoGatesRouting {
  mounts: VolumeMount[];
  correlation?: EreborRunCorrelation;
  cleanup: () => void;
  enabled: boolean;
}

interface RoutingFileOperations {
  createDirectory: (directory: string) => void;
  writeExclusiveFile: (filePath: string, contents: string) => void;
  removeFile: (filePath: string) => void;
}

interface CredentialRoutingDependencies {
  readProviderCredentials: () => Record<string, string>;
  applyOneCli: (
    args: string[],
    agentIdentifier: string | undefined,
  ) => Promise<boolean>;
}

const credentialRoutingDependencies: CredentialRoutingDependencies = {
  readProviderCredentials: () =>
    readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']),
  applyOneCli: (args, agentIdentifier) =>
    onecli.applyContainerConfig(args, {
      addHostMapping: false,
      agent: agentIdentifier,
    }),
};

const routingFileOperations: RoutingFileOperations = {
  createDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  writeExclusiveFile: (filePath, contents) =>
    fs.writeFileSync(filePath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    }),
  removeFile: (filePath) => fs.rmSync(filePath, { force: true }),
};
const activeRoutingCleanups = new Set<() => void>();

function routingRuntimeDirectory(): string {
  return path.join(os.tmpdir(), 'nanoclaw-routing');
}

export function sourceTreeRequiresSync(
  sourceDirectory: string,
  destinationDirectory: string,
): boolean {
  if (!fs.existsSync(destinationDirectory)) return true;
  for (const entry of fs.readdirSync(sourceDirectory, {
    withFileTypes: true,
  })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      if (
        !fs.existsSync(destinationPath) ||
        !fs.statSync(destinationPath).isDirectory() ||
        sourceTreeRequiresSync(sourcePath, destinationPath)
      ) {
        return true;
      }
    } else if (
      entry.isFile() &&
      (!fs.existsSync(destinationPath) ||
        !fs.statSync(destinationPath).isFile())
    ) {
      return true;
    }
  }
  return false;
}

export function cleanupActiveTwoGatesRoutingFiles(): void {
  for (const cleanup of [...activeRoutingCleanups]) cleanup();
}

export function cleanupStaleTwoGatesRoutingFiles(
  directory = routingRuntimeDirectory(),
): void {
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(
          entry.name,
        )
      ) {
        const routingFile = path.join(directory, entry.name);
        try {
          fs.rmSync(routingFile);
          removed++;
        } catch (err) {
          logger.warn(
            { err, routingFile },
            'Failed to clean stale routing file',
          );
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err, directory }, 'Failed to clean stale routing files');
    }
  }
  if (removed > 0) {
    logger.info({ removed }, 'Cleaned stale TwoGates routing files');
  }
}

export function prepareTwoGatesRouting(
  config: TwoGatesRoutingConfig,
  input: Pick<ContainerInput, 'groupFolder' | 'messageSourceId'>,
  runId: string,
  operations: RoutingFileOperations = routingFileOperations,
): PreparedTwoGatesRouting {
  if (config.mode === 'disabled') {
    return { mounts: [], cleanup: () => undefined, enabled: false };
  }
  if (!input.messageSourceId) {
    throw new Error(
      'messageSourceId is required when TwoGates routing is enabled',
    );
  }

  const correlation = createEreborRunCorrelation({
    groupFolder: input.groupFolder,
    messageSourceId: input.messageSourceId,
    runId,
  });
  // Keep the credential file outside the project tree: main containers receive
  // that tree as a read-only mount, so storing the file under DATA_DIR would
  // expose the proxy token through a second mount path.
  const routingDirectory = routingRuntimeDirectory();
  const routingFile = path.join(routingDirectory, `${runId}.json`);
  operations.createDirectory(routingDirectory);
  operations.writeExclusiveFile(
    routingFile,
    `${JSON.stringify({
      proxyUrl: config.proxyUrl,
      proxyCredential: config.proxyCredential,
      caCertPath: CONTAINER_ROUTING_CA_PATH,
      taskClass: config.taskClass,
      anthropicOrigin: config.anthropicOrigin,
      connectTimeoutMs: config.connectTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRequestBodyBytes: config.maxRequestBodyBytes,
      maxResponseBodyBytes: config.maxResponseBodyBytes,
      maxHeaderBytes: config.maxHeaderBytes,
      maxConcurrentRequests: config.maxConcurrentRequests,
    })}\n`,
  );

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    try {
      operations.removeFile(routingFile);
      cleaned = true;
      activeRoutingCleanups.delete(cleanup);
    } catch (err) {
      logger.warn(
        { err, routingFile },
        'Failed to remove TwoGates routing file',
      );
    }
  };
  activeRoutingCleanups.add(cleanup);
  return {
    enabled: true,
    correlation,
    mounts: [
      {
        hostPath: routingFile,
        containerPath: CONTAINER_ROUTING_CONFIG_PATH,
        readonly: true,
      },
      {
        hostPath: config.caCertPath,
        containerPath: CONTAINER_ROUTING_CA_PATH,
        readonly: true,
      },
    ],
    cleanup,
  };
}

export async function appendContainerCredentialRouting(
  args: string[],
  routingEnabled: boolean,
  containerName: string,
  agentIdentifier: string | undefined,
  dependencies: CredentialRoutingDependencies = credentialRoutingDependencies,
): Promise<void> {
  if (routingEnabled) {
    args.push(
      '-e',
      `NANOCLAW_TWOGATES_CONFIG_PATH=${CONTAINER_ROUTING_CONFIG_PATH}`,
    );
    logger.info({ containerName }, 'TwoGates provider routing configured');
    return;
  }

  // Local/development compatibility: subscription OAuth can still be passed
  // directly, or OneCLI can inject an API key at its gateway. Production
  // never reaches this branch because its config requires TwoGates routing.
  const envVars = dependencies.readProviderCredentials();
  if (envVars.CLAUDE_CODE_OAUTH_TOKEN) {
    args.push(
      '-e',
      `CLAUDE_CODE_OAUTH_TOKEN=${envVars.CLAUDE_CODE_OAUTH_TOKEN}`,
    );
    logger.info({ containerName }, 'Injected OAuth token directly');
  } else if (envVars.ANTHROPIC_API_KEY) {
    const onecliApplied = await dependencies.applyOneCli(args, agentIdentifier);
    if (onecliApplied) {
      logger.info({ containerName }, 'OneCLI gateway config applied');
    } else {
      logger.warn(
        { containerName },
        'OneCLI gateway not reachable — container will have no credentials',
      );
    }
  } else {
    logger.warn({ containerName }, 'No credentials found in .env');
  }
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  routingEnabled: boolean,
  runIpcInputDir: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (store, group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });
  fs.mkdirSync(runIpcInputDir, { recursive: true });
  mounts.push({
    hostPath: runIpcInputDir,
    containerPath: '/workspace/ipc/input',
    readonly: false,
  });

  // Routed runs execute the trusted bridge source read-only. Local/development
  // runs retain NanoClaw's per-group customization behavior.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  if (routingEnabled) {
    mounts.push({
      hostPath: agentRunnerSrc,
      containerPath: '/app/src',
      readonly: true,
    });
  } else {
    const groupAgentRunnerDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'agent-runner-src',
    );
    if (fs.existsSync(agentRunnerSrc)) {
      const needsCopy = sourceTreeRequiresSync(
        agentRunnerSrc,
        groupAgentRunnerDir,
      );
      if (needsCopy) {
        fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
      }
    }
    mounts.push({
      hostPath: groupAgentRunnerDir,
      containerPath: '/app/src',
      readonly: false,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier?: string,
  routingEnabled = false,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  await appendContainerCredentialRouting(
    args,
    routingEnabled,
    containerName,
    agentIdentifier,
  );

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (
    proc: ChildProcess,
    containerName: string,
    ipcInputDir: string,
  ) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const runIpcDir = resolveGroupIpcPath(`run-${randomUUID()}`);
  const runIpcInputDir = path.join(runIpcDir, 'input');
  const cleanupRunIpc = () => {
    fs.rmSync(runIpcDir, { recursive: true, force: true });
  };

  const mounts = buildVolumeMounts(
    group,
    input.isMain,
    TWOGATES_ROUTING.mode === 'enabled',
    runIpcInputDir,
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const routingRun = prepareTwoGatesRouting(
    TWOGATES_ROUTING,
    input,
    randomUUID(),
  );
  mounts.push(...routingRun.mounts);
  const { messageSourceId: _messageSourceId, ...containerVisibleInput } = input;
  const effectiveInput: ContainerInput = routingRun.correlation
    ? { ...containerVisibleInput, routing: routingRun.correlation }
    : containerVisibleInput;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  let containerArgs: string[];
  try {
    containerArgs = await buildContainerArgs(
      mounts,
      containerName,
      agentIdentifier,
      routingRun.enabled,
    );
  } catch (err) {
    routingRun.cleanup();
    cleanupRunIpc();
    throw err;
  }

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    routingRun.cleanup();
    cleanupRunIpc();
    throw err;
  }

  return new Promise((resolve, reject) => {
    let container: ChildProcess | undefined;
    try {
      container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      onProcess(container, containerName, runIpcInputDir);
      container.stdin?.once('error', (err) => {
        routingRun.cleanup();
        cleanupRunIpc();
        container?.kill('SIGKILL');
        reject(err);
      });
      container.stdin?.write(JSON.stringify(effectiveInput));
      container.stdin?.end();
    } catch (err) {
      routingRun.cleanup();
      cleanupRunIpc();
      container?.kill('SIGKILL');
      reject(err);
      return;
    }
    if (!container) {
      routingRun.cleanup();
      cleanupRunIpc();
      reject(new Error('Container runtime did not return a child process'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout!.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr!.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      routingRun.cleanup();
      cleanupRunIpc();
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          }, reject);
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        }, reject);
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      routingRun.cleanup();
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
