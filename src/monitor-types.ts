import { Channel, RegisteredGroup } from './types.js';

export type MonitorPriority = 'low' | 'normal' | 'urgent';

/** A 24-hour HH:MM time window, exclusive at `end`. */
export interface TimeRange {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

/**
 * Extra per-monitor values that live in monitors/config.json and are
 * read at runtime by individual monitor files (e.g. keyword lists).
 */
export interface MonitorConfigExtras {
  keywords?: string[];
  buyingSignals?: string[];
}

/**
 * Per-monitor configuration (declared in each monitor file and
 * merged with overrides from monitors/config.json at load time).
 */
export interface MonitorConfig {
  /** Stable identifier. Must be kebab-case and match the key used in monitors/config.json and the DB. */
  name: string;
  intervalMinutes: number;
  targetGroup: string; // folder name, e.g. "reddit-scout"
  enabled: boolean;
  /** If true, skip runs during quiet hours. Defaults to true. */
  respectQuietHours?: boolean;
  /** If true, only run Mon-Fri. Defaults to false. */
  weekdaysOnly?: boolean;
  /** If set, only run between these hours in the configured timezone. */
  businessHours?: TimeRange;
  /** Runtime-tunable extras (keyword lists, signal lists) sourced from monitors/config.json. */
  extras?: MonitorConfigExtras;
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
  /**
   * Called when a monitor triggers and we need to wake an agent.
   * `chatJid` must be the resolved chat JID for the target group,
   * NOT the folder name from `MonitorConfig.targetGroup`.
   */
  enqueueMonitorCheck: (chatJid: string) => void;
}

/** Global settings read from monitors/config.json. */
export interface MonitorGlobalConfig {
  enabled: boolean;
  defaultIntervalMinutes: number;
  maxConcurrentMonitors: number;
  quietHours: TimeRange & {
    timezone: string; // IANA, e.g. "America/New_York"
  };
  monitors: Record<string, Partial<MonitorConfig>>;
}
