#!/usr/bin/env bun
// @bun

// src/plugin/init-project.ts
import { execSync } from "child_process";

// src/config-service.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
var DEFAULT_CONFIG = {
  version: "1.0",
  daemon: {
    port: 4500,
    proxyPort: 4501
  },
  agents: {
    claude: {
      role: "Reviewer, Planner",
      mode: "push"
    },
    codex: {
      role: "Implementer, Executor"
    }
  },
  markers: ["IMPORTANT", "STATUS", "FYI"],
  turnCoordination: {
    attentionWindowSeconds: 15,
    busyGuard: true
  },
  idleShutdownSeconds: 30
};
var DEFAULT_COLLABORATION_MD = `# Collaboration Rules

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
var CONFIG_DIR = ".agentbridge";
var CONFIG_FILE = "config.json";
var COLLABORATION_FILE = "collaboration.md";

class ConfigService {
  configDir;
  configPath;
  collaborationPath;
  constructor(projectRoot) {
    const root = projectRoot ?? process.cwd();
    this.configDir = join(root, CONFIG_DIR);
    this.configPath = join(this.configDir, CONFIG_FILE);
    this.collaborationPath = join(this.configDir, COLLABORATION_FILE);
  }
  hasConfig() {
    return existsSync(this.configPath);
  }
  load() {
    try {
      const raw = readFileSync(this.configPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  loadOrDefault() {
    return this.load() ?? { ...DEFAULT_CONFIG };
  }
  save(config) {
    this.ensureConfigDir();
    writeFileSync(this.configPath, JSON.stringify(config, null, 2) + `
`, "utf-8");
  }
  loadCollaboration() {
    try {
      return readFileSync(this.collaborationPath, "utf-8");
    } catch {
      return null;
    }
  }
  saveCollaboration(content) {
    this.ensureConfigDir();
    writeFileSync(this.collaborationPath, content, "utf-8");
  }
  initDefaults() {
    this.ensureConfigDir();
    const created = [];
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
  get configFilePath() {
    return this.configPath;
  }
  get collaborationFilePath() {
    return this.collaborationPath;
  }
  ensureConfigDir() {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }
}

// src/plugin/init-project.ts
function defaultRunCommand(command) {
  return execSync(command, { encoding: "utf-8" }).trim();
}
function requireVersion(name, command, installHint, runCommand) {
  try {
    return runCommand(command);
  } catch {
    throw new Error(`${name} not found in PATH. ${installHint}`);
  }
}
function initProjectDefaults(projectRoot = process.cwd(), runCommand = defaultRunCommand) {
  const bunVersion = requireVersion("bun", "bun --version", "Install Bun: https://bun.sh", runCommand);
  const codexVersion = requireVersion("codex", "codex --version", "Install Codex: https://github.com/openai/codex", runCommand);
  const configService = new ConfigService(projectRoot);
  const created = configService.initDefaults();
  return {
    checked: {
      bun: bunVersion,
      codex: codexVersion
    },
    created,
    files: {
      config: configService.configFilePath,
      collaboration: configService.collaborationFilePath
    }
  };
}
function main() {
  try {
    const projectRoot = process.argv[2] || process.cwd();
    const result = initProjectDefaults(projectRoot);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exit(1);
  }
}
if (import.meta.main) {
  main();
}
export {
  initProjectDefaults
};
