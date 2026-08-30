import { randomUUID } from 'crypto';

import { runContainerAgent } from '../src/container-runner.js';
import { getRegisteredGroup, initDatabase } from '../src/db.js';
import { logger } from '../src/logger.js';

interface CliAgentInput {
  prompt: string;
  chatJid: string;
  sessionId?: string;
}

async function readInput(): Promise<CliAgentInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as CliAgentInput;
}

async function main(): Promise<void> {
  const input = await readInput();
  initDatabase();
  const group = getRegisteredGroup(input.chatJid);
  if (!group) {
    throw new Error('CLI agent target is not a registered group');
  }
  const output = await runContainerAgent(group, {
    prompt: input.prompt,
    chatJid: input.chatJid,
    groupFolder: group.folder,
    isMain: group.isMain === true,
    assistantName: group.assistantName,
    sessionId: input.sessionId,
    messageSourceId: `claw:${randomUUID()}`,
  }, () => undefined);

  if (output.status !== 'success') {
    throw new Error(output.error ?? output.result ?? 'Agent execution failed');
  }
  process.stdout.write(`${output.result ?? ''}\n`);
  if (output.newSessionId) {
    process.stderr.write(`\n[session: ${output.newSessionId}]\n`);
  }
}

main().catch((error: unknown) => {
  logger.error({ error }, 'CLI agent execution failed');
  process.exitCode = 1;
});
