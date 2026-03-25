#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { ConfigService } from "../config-service";

type RunCommand = (command: string) => string;

export interface InitProjectResult {
  checked: {
    bun: string;
    codex: string;
  };
  created: string[];
  files: {
    config: string;
    collaboration: string;
  };
}

function defaultRunCommand(command: string): string {
  return execSync(command, { encoding: "utf-8" }).trim();
}

function requireVersion(
  name: string,
  command: string,
  installHint: string,
  runCommand: RunCommand,
): string {
  try {
    return runCommand(command);
  } catch {
    throw new Error(`${name} not found in PATH. ${installHint}`);
  }
}

export function initProjectDefaults(
  projectRoot = process.cwd(),
  runCommand: RunCommand = defaultRunCommand,
): InitProjectResult {
  const bunVersion = requireVersion("bun", "bun --version", "Install Bun: https://bun.sh", runCommand);
  const codexVersion = requireVersion("codex", "codex --version", "Install Codex: https://github.com/openai/codex", runCommand);

  const configService = new ConfigService(projectRoot);
  const created = configService.initDefaults();

  return {
    checked: {
      bun: bunVersion,
      codex: codexVersion,
    },
    created,
    files: {
      config: configService.configFilePath,
      collaboration: configService.collaborationFilePath,
    },
  };
}

function main() {
  try {
    const projectRoot = process.argv[2] || process.cwd();
    const result = initProjectDefaults(projectRoot);
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error(err.message ?? String(err));
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
