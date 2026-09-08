#!/usr/bin/env node
import { resolve } from "node:path";
import { loadAndValidateGraph, selectContext } from "./graph-lib.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const startId = process.argv[2];
const graphFile = option("--graph", "context/graph.json");
const format = option("--format", "text");

try {
  if (!startId || startId.startsWith("--")) {
    throw new Error("uso: select-context.mjs <node-id> [--graph arquivo] [--format text|json]");
  }
  const validated = loadAndValidateGraph(graphFile);
  const nodes = selectContext(startId, validated);
  const files = nodes.map((node) => node.path);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ root: resolve(validated.projectRoot), start: startId, files }, null, 2)}\n`);
  } else if (format === "text") {
    process.stdout.write(`${files.join("\n")}\n`);
  } else {
    throw new Error(`formato desconhecido: ${format}`);
  }
} catch (error) {
  process.stderr.write(`Falha ao selecionar contexto: ${error.message}\n`);
  process.exitCode = 1;
}
