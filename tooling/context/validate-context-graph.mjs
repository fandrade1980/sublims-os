#!/usr/bin/env node
import { loadAndValidateGraph } from "./graph-lib.mjs";

const graphFile = process.argv[2] ?? "context/graph.json";

try {
  const { graph } = loadAndValidateGraph(graphFile);
  process.stdout.write(`Grafo válido: ${graph.nodes.length} nós, ${graph.edges.length} arestas.\n`);
} catch (error) {
  process.stderr.write(`Contexto inválido: ${error.message}\n`);
  process.exitCode = 1;
}
