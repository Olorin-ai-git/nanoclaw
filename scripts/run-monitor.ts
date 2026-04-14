/**
 * One-shot monitor runner. Invoked via tsx by `scripts/claw --run-now`.
 *
 *   tsx scripts/run-monitor.ts <monitor-name>
 */
import { getAllRegisteredGroups, initDatabase } from '../src/db.js';
import { logger } from '../src/logger.js';
import { loadMonitorConfig, runMonitorOnce } from '../src/monitor-runner.js';
import type { Monitor, MonitorDependencies } from '../src/monitor-types.js';
import { monitors } from '../monitors/index.js';

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: tsx scripts/run-monitor.ts <monitor-name>');
    process.exit(2);
  }
  const monitor: Monitor | undefined = monitors.find(
    (m) => m.config.name === name,
  );
  if (!monitor) {
    console.error(
      `error: monitor '${name}' not registered in monitors/index.ts`,
    );
    console.error(
      `available: ${monitors.map((m) => m.config.name).join(', ')}`,
    );
    process.exit(1);
  }

  initDatabase();
  const global = loadMonitorConfig();

  const deps: MonitorDependencies = {
    registeredGroups: () => getAllRegisteredGroups(),
    channels: () => [],
    enqueueMonitorCheck: (chatJid) => {
      logger.info(
        { chatJid, monitor: name },
        '[run-now] enqueueMonitorCheck: a live NanoClaw would pick up the new message from SQLite',
      );
    },
  };

  logger.info({ monitor: name }, '[run-now] starting one-shot monitor run');
  await runMonitorOnce(monitor, global, deps);
  logger.info({ monitor: name }, '[run-now] complete');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, '[run-now] failed');
  process.exit(1);
});
