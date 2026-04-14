import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Machine-readable project config schema. */
export interface AgentBridgeConfig {
  version: string;
  codex: {
    appPort: number;
    proxyPort: number;
  };
  turnCoordination: {
    attentionWindowSeconds: number;
  };
  idleShutdownSeconds: number;
}

const DEFAULT_CONFIG: AgentBridgeConfig = {
  version: "1.0",
  codex: {
    appPort: 4500,
    proxyPort: 4501,
  },
  turnCoordination: {
    attentionWindowSeconds: 15,
  },
  idleShutdownSeconds: 30,
};

const CONFIG_DIR = ".agentbridge";
const CONFIG_FILE = "config.json";

interface LegacyAgentBridgeConfig {
  version?: unknown;
  daemon?: {
    port?: unknown;
    proxyPort?: unknown;
  };
  codex?: {
    appPort?: unknown;
    proxyPort?: unknown;
  };
  turnCoordination?: {
    attentionWindowSeconds?: unknown;
  };
  idleShutdownSeconds?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeConfig(raw: unknown): AgentBridgeConfig | null {
  if (!isRecord(raw)) return null;

  const config = raw as LegacyAgentBridgeConfig;
  const codex = isRecord(config.codex) ? config.codex : {};
  const daemon = isRecord(config.daemon) ? config.daemon : {};
  const turnCoordination = isRecord(config.turnCoordination) ? config.turnCoordination : {};

  return {
    version: typeof config.version === "string" ? config.version : DEFAULT_CONFIG.version,
    codex: {
      appPort: normalizeInteger(
        codex.appPort ?? daemon.port,
        DEFAULT_CONFIG.codex.appPort,
      ),
      proxyPort: normalizeInteger(
        codex.proxyPort ?? daemon.proxyPort,
        DEFAULT_CONFIG.codex.proxyPort,
      ),
    },
    turnCoordination: {
      attentionWindowSeconds: normalizeInteger(
        turnCoordination.attentionWindowSeconds,
        DEFAULT_CONFIG.turnCoordination.attentionWindowSeconds,
      ),
    },
    idleShutdownSeconds: normalizeInteger(
      config.idleShutdownSeconds,
      DEFAULT_CONFIG.idleShutdownSeconds,
    ),
  };
}

export class ConfigService {
  private readonly configDir: string;
  private readonly configPath: string;

  constructor(projectRoot?: string) {
    const root = projectRoot ?? process.cwd();
    this.configDir = join(root, CONFIG_DIR);
    this.configPath = join(this.configDir, CONFIG_FILE);
  }

  /** Check if project config exists. */
  hasConfig(): boolean {
    return existsSync(this.configPath);
  }

  /** Load project config, returns null if not found. */
  load(): AgentBridgeConfig | null {
    try {
      const raw = readFileSync(this.configPath, "utf-8");
      return normalizeConfig(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Load project config, falling back to defaults. */
  loadOrDefault(): AgentBridgeConfig {
    return this.load() ?? structuredClone(DEFAULT_CONFIG);
  }

  /** Save project config. */
  save(config: AgentBridgeConfig): void {
    this.ensureConfigDir();
    writeFileSync(this.configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }

  /** Generate default config files if they don't exist. Returns list of created files. */
  initDefaults(): string[] {
    this.ensureConfigDir();
    const created: string[] = [];

    if (!existsSync(this.configPath)) {
      this.save(DEFAULT_CONFIG);
      created.push(this.configPath);
    }

    return created;
  }

  get configFilePath(): string {
    return this.configPath;
  }

  private ensureConfigDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }
}

export { DEFAULT_CONFIG };
