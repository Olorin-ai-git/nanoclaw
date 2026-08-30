import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';

import { TWOGATES_ENV_KEYS } from './twogates-routing.js';

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(entryPath);
    return entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
      ? [entryPath]
      : [];
  });
}

function source(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

interface ContainerAgentInvocation {
  filePath: string;
  line: number;
  hasMessageSourceId: boolean;
}

function containerAgentInvocations(filePath: string): ContainerAgentInvocation[] {
  const contents = source(filePath);
  const syntax = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const calls: ContainerAgentInvocation[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'runContainerAgent'
    ) {
      const input = node.arguments[1];
      const hasMessageSourceId =
        input !== undefined &&
        ts.isObjectLiteralExpression(input) &&
        input.properties.some(
          (property) =>
            (ts.isShorthandPropertyAssignment(property) &&
              property.name.text === 'messageSourceId') ||
            (ts.isPropertyAssignment(property) &&
              ((ts.isIdentifier(property.name) && property.name.text === 'messageSourceId') ||
                (ts.isStringLiteral(property.name) &&
                  property.name.text === 'messageSourceId'))),
        );
      calls.push({
        filePath,
        line: syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1,
        hasMessageSourceId,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return calls;
}

const projectRoot = process.cwd();
const hostSourceRoot = path.join(projectRoot, 'src');
const scriptSourceRoot = path.join(projectRoot, 'scripts');
const runnerSourceRoot = path.join(
  projectRoot,
  'container',
  'agent-runner',
  'src',
);
const executableScripts = [
  path.join(projectRoot, 'scripts', 'claw'),
  path.join(projectRoot, 'scripts', 'run-agent.ts'),
];

describe('TwoGates production source inventory', () => {
  it('keeps every typed routing key on the inactive environment surface without values', () => {
    const exampleLines = new Set(
      source(path.join(projectRoot, '.env.example')).trim().split('\n'),
    );
    for (const key of TWOGATES_ENV_KEYS) {
      expect(exampleLines).toContain(`${key}=`);
    }
  });

  it('keeps every container launch correlated to a source message', () => {
    const invocations = [
      ...productionTypeScriptFiles(hostSourceRoot),
      ...productionTypeScriptFiles(scriptSourceRoot),
    ].flatMap(containerAgentInvocations);

    expect(
      invocations
        .map((call) => path.relative(projectRoot, call.filePath))
        .sort(),
    ).toEqual(['scripts/run-agent.ts', 'src/index.ts', 'src/task-scheduler.ts']);
    expect(
      invocations.filter((call) => !call.hasMessageSourceId).map((call) => ({
        file: path.relative(projectRoot, call.filePath),
        line: call.line,
      })),
    ).toEqual([]);

    expect(source(path.join(hostSourceRoot, 'index.ts'))).toMatch(
      /queue\.sendMessage\([\s\S]*?messagesToSend\[messagesToSend\.length - 1\]\.id/,
    );
  });

  it('limits provider base URL and process proxy handling to the loopback bridge', () => {
    const allSources = [
      ...productionTypeScriptFiles(hostSourceRoot),
      ...productionTypeScriptFiles(runnerSourceRoot),
    ];
    const filesContaining = (pattern: RegExp) =>
      allSources
        .filter((filePath) => pattern.test(source(filePath)))
        .map((filePath) => path.relative(projectRoot, filePath))
        .sort();

    expect(filesContaining(/ANTHROPIC_BASE_URL/)).toEqual([
      'container/agent-runner/src/provider-routing.ts',
    ]);
    expect(
      filesContaining(/(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/),
    ).toEqual(['container/agent-runner/src/provider-routing.ts']);
  });

  it('keeps exact required headers in the fixed-origin provider bridge', () => {
    const bridgeSource = source(
      path.join(runnerSourceRoot, 'provider-routing.ts'),
    );
    expect(bridgeSource).toContain(
      "headers['x-erebor-request-id'] = requestId",
    );
    expect(bridgeSource).toContain(
      "headers['x-erebor-task-class'] = config.taskClass",
    );
    expect(bridgeSource).toContain(
      '`Proxy-Authorization: Bearer ${config.proxyCredential}`',
    );
    expect(bridgeSource).toContain('server.listen(0, LOOPBACK_HOST');
  });

  it('confines raw provider credential names to the legacy dev boundary and bridge scrubber', () => {
    const allSources = [
      ...productionTypeScriptFiles(hostSourceRoot),
      ...productionTypeScriptFiles(runnerSourceRoot),
    ];
    const credentialFiles = allSources
      .filter((filePath) =>
        /(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)/.test(
          source(filePath),
        ),
      )
      .map((filePath) => path.relative(projectRoot, filePath))
      .sort();

    expect(credentialFiles).toEqual([
      'container/agent-runner/src/provider-routing.ts',
      'src/container-runner.ts',
    ]);
  });

  it('routes command-line agent execution through the trusted host runner', () => {
    const clawSource = source(executableScripts[0]);
    const agentScriptSource = source(executableScripts[1]);

    expect(clawSource).toContain('scripts" / "run-agent.ts"');
    expect(clawSource).not.toMatch(
      /(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)/,
    );
    expect(clawSource).not.toMatch(/\b(?:docker|container)\s+["']?run\b/);
    expect(agentScriptSource).toContain('runContainerAgent(group,');
    expect(agentScriptSource).toContain(
      'messageSourceId: `claw:${randomUUID()}`',
    );
  });
});
