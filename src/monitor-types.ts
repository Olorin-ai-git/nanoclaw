import { Channel, RegisteredGroup } from './types.js';

export type MonitorPriority = 'low' | 'normal' | 'urgent';

/**
 * Per-monitor configuration (declared in each monitor file and
 * merged with overrides from monitors/config.json at load time).
 */
export interface MonitorConfig {
  name: string;
  intervalMinutes: number;
  targetGroup: string; // folder name, e.g. "reddit-scout"
  enabled: boolean;
  /** If true, skip runs during quiet hours. Defaults to true. */
  respectQuietHours?: boolean;
  /** If true, only run Mon-Fri. Defaults to false. */
  weekdaysOnly?: boolean;
  /** If set, only run between these hours in the configured timezone (24h, "HH:MM"). */
  businessHours?: { start: string; end: string };
}

export interface MonitorResult {
  shouldWake: boolean;
  priority: MonitorPriority;
  data: Record<string, unknown>;
  summary: string;
}

/** The default export of every monitor file. */
export interface Monitor {
  config: MonitorConfig;
  check(): Promise<MonitorResult>;
}

/** Dependencies injected into the monitor-runner. */
export interface MonitorDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  channels: () => Channel[];
  /** Called when a monitor triggers and we need to wake an agent for targetGroupFolder. */
  enqueueMonitorCheck: (chatJid: string) => void;
}

/** Global settings read from monitors/config.json. */
export interface MonitorGlobalConfig {
  enabled: boolean;
  defaultIntervalMinutes: number;
  maxConcurrentMonitors: number;
  quietHours: {
    start: string; // "HH:MM"
    end: string; // "HH:MM"
    timezone: string; // IANA, e.g. "America/New_York"
  };
  monitors: Record<string, Partial<MonitorConfig>>;
}
