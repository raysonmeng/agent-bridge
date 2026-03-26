import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/** Machine-readable project config schema. */
export interface AgentBridgeConfig {
  version: string;
  daemon: {
    port: number;
    proxyPort: number;
  };
  agents: Record<
    string,
    {
      role: string;
      mode?: string;
    }
  >;
  markers: string[];
  turnCoordination: {
    attentionWindowSeconds: number;
    busyGuard: boolean;
  };
  idleShutdownSeconds: number;
}

const DEFAULT_CONFIG: AgentBridgeConfig = {
  version: "1.0",
  daemon: {
    port: 4500,
    proxyPort: 4501,
  },
  agents: {
    claude: {
      role: "Reviewer, Planner",
      mode: "push",
    },
    codex: {
      role: "Implementer, Executor",
    },
  },
  markers: ["IMPORTANT", "STATUS", "FYI"],
  turnCoordination: {
    attentionWindowSeconds: 15,
    busyGuard: true,
  },
  idleShutdownSeconds: 30,
};

const DEFAULT_COLLABORATION_MD = `# Collaboration Rules

## Roles
- Claude: Reviewer, Planner, Hypothesis Challenger
- Codex: Implementer, Executor, Reproducer/Verifier

## Thinking Patterns
- Analytical/review tasks: Independent Analysis & Convergence
- Implementation tasks: Architect -> Builder -> Critic
- Debugging tasks: Hypothesis -> Experiment -> Interpretation

## Communication
- Use explicit phrases: "My independent view is:", "I agree on:", "I disagree on:", "Current consensus:"
- Tag messages with [IMPORTANT], [STATUS], or [FYI]

## Review Process
- Cross-review: author never reviews their own code
- All changes go through feature/fix branches + PR
- Merge via squash merge

## Custom Rules
<!-- Add your project-specific collaboration rules here -->
`;

const CONFIG_DIR = ".agentbridge";
const CONFIG_FILE = "config.json";
const COLLABORATION_FILE = "collaboration.md";

export class ConfigService {
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly collaborationPath: string;

  constructor(projectRoot?: string) {
    const root = projectRoot ?? process.cwd();
    this.configDir = join(root, CONFIG_DIR);
    this.configPath = join(this.configDir, CONFIG_FILE);
    this.collaborationPath = join(this.configDir, COLLABORATION_FILE);
  }

  /** Check if project config exists. */
  hasConfig(): boolean {
    return existsSync(this.configPath);
  }

  /** Load project config, returns null if not found. */
  load(): AgentBridgeConfig | null {
    try {
      const raw = readFileSync(this.configPath, "utf-8");
      return JSON.parse(raw) as AgentBridgeConfig;
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

  /** Load collaboration rules markdown. */
  loadCollaboration(): string | null {
    try {
      return readFileSync(this.collaborationPath, "utf-8");
    } catch {
      return null;
    }
  }

  /** Save collaboration rules markdown. */
  saveCollaboration(content: string): void {
    this.ensureConfigDir();
    writeFileSync(this.collaborationPath, content, "utf-8");
  }

  /** Generate default config files if they don't exist. Returns list of created files. */
  initDefaults(): string[] {
    this.ensureConfigDir();
    const created: string[] = [];

    if (!existsSync(this.configPath)) {
      this.save(DEFAULT_CONFIG);
      created.push(this.configPath);
    }

    if (!existsSync(this.collaborationPath)) {
      this.saveCollaboration(DEFAULT_COLLABORATION_MD);
      created.push(this.collaborationPath);
    }

    return created;
  }

  get configFilePath(): string {
    return this.configPath;
  }

  get collaborationFilePath(): string {
    return this.collaborationPath;
  }

  private ensureConfigDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }
}

export { DEFAULT_CONFIG, DEFAULT_COLLABORATION_MD };
