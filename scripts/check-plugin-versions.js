#!/usr/bin/env bun

import { readFileSync } from "node:fs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const packageJson = readJson(new URL("../package.json", import.meta.url));
const pluginJson = readJson(new URL("../plugins/agentbridge/.claude-plugin/plugin.json", import.meta.url));
const marketplaceJson = readJson(new URL("../.claude-plugin/marketplace.json", import.meta.url));

const expectedVersion = packageJson.version;
const pluginVersion = pluginJson.version;
const marketplacePlugin = Array.isArray(marketplaceJson.plugins)
  ? marketplaceJson.plugins.find((plugin) => plugin.name === pluginJson.name)
  : null;
const marketplaceVersion = marketplacePlugin?.version;

const errors = [];

if (pluginVersion !== expectedVersion) {
  errors.push(
    `plugins/agentbridge/.claude-plugin/plugin.json version ${pluginVersion} does not match package.json version ${expectedVersion}.`,
  );
}

if (!marketplacePlugin) {
  errors.push(`.claude-plugin/marketplace.json is missing the "${pluginJson.name}" plugin entry.`);
} else if (marketplaceVersion !== expectedVersion) {
  errors.push(
    `.claude-plugin/marketplace.json version ${marketplaceVersion} does not match package.json version ${expectedVersion}.`,
  );
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(`Plugin manifests are version-aligned at ${expectedVersion}.`);
