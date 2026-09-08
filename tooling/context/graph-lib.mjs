import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function loadAndValidateGraph(graphFile) {
  const absoluteGraph = resolve(graphFile);
  const projectRoot = resolve(dirname(absoluteGraph), "..");
  let graph;

  try {
    graph = JSON.parse(readFileSync(absoluteGraph, "utf8"));
  } catch (error) {
    throw new Error(`não foi possível ler o grafo: ${error.message}`);
  }

  if (graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("grafo inválido: version 1, nodes e edges são obrigatórios");
  }

  const byId = new Map();
  const paths = new Set();
  for (const node of graph.nodes) {
    if (!node?.id || !node?.type || !node?.path) {
      throw new Error("nó inválido: id, type e path são obrigatórios");
    }
    if (byId.has(node.id)) {
      throw new Error(`nó duplicado: ${node.id}`);
    }
    if (node.path.includes("\\")) {
      throw new Error(`caminho não portável; use barras normais: ${node.path}`);
    }
    const normalizedPath = node.path.toLocaleLowerCase("en-US");
    if (paths.has(normalizedPath)) {
      throw new Error(`caminho duplicado: ${node.path}`);
    }
    const absolutePath = resolve(projectRoot, node.path);
    const outside = isAbsolute(node.path) || relative(projectRoot, absolutePath).startsWith(`..${sep}`) || relative(projectRoot, absolutePath) === "..";
    if (outside) {
      throw new Error(`caminho fora da raiz do projeto: ${node.path}`);
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`arquivo inexistente para ${node.id}: ${node.path}`);
    }
    byId.set(node.id, node);
    paths.add(normalizedPath);
  }

  const requires = new Map([...byId.keys()].map((id) => [id, []]));
  for (const edge of graph.edges) {
    if (!byId.has(edge?.from) || !byId.has(edge?.to)) {
      throw new Error(`aresta aponta para nó inexistente: ${edge?.from} -> ${edge?.to}`);
    }
    if (edge.relation !== "requires") throw new Error(`relação desconhecida: ${edge.relation ?? "ausente"}`);
    requires.get(edge.from).push(edge.to);
  }

  assertAcyclic(requires);
  return { graph, byId, requires, projectRoot };
}

function assertAcyclic(requires) {
  const visiting = new Set();
  const visited = new Set();

  function visit(id, trail) {
    if (visiting.has(id)) {
      throw new Error(`ciclo em requires: ${[...trail, id].join(" -> ")}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of requires.get(id) ?? []) {
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of requires.keys()) visit(id, []);
}

export function selectContext(startId, validated) {
  if (!validated.byId.has(startId)) {
    throw new Error(`nó inicial inexistente: ${startId}`);
  }
  const visited = new Set();
  const orderedIds = [];

  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const dependencies = [...(validated.requires.get(id) ?? [])].sort();
    for (const dependency of dependencies) visit(dependency);
    orderedIds.push(id);
  }

  visit(startId);
  return orderedIds.map((id) => validated.byId.get(id));
}
