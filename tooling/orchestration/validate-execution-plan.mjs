#!/usr/bin/env node
import { readFileSync } from "node:fs";

function validate(plan) {
  if (plan.version !== 1 || !Array.isArray(plan.steps) || !plan.steps.length) {
    throw new Error("plano inválido: version 1 e steps são obrigatórios");
  }
  const byId = new Map();
  for (const step of plan.steps) {
    if (!step?.id || !step?.agent || !["read", "write"].includes(step.mode)) {
      throw new Error("passo inválido: id, agent e mode read|write são obrigatórios");
    }
    if (!Array.isArray(step.dependsOn) || !Array.isArray(step.reads) || !Array.isArray(step.writes)) {
      throw new Error(`passo ${step.id}: dependsOn, reads e writes devem ser listas`);
    }
    if (step.mode === "read" && step.writes.length) {
      throw new Error(`passo de leitura não pode escrever: ${step.id}`);
    }
    if (byId.has(step.id)) throw new Error(`passo duplicado: ${step.id}`);
    byId.set(step.id, step);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`dependência inexistente: ${step.id} -> ${dependency}`);
    }
  }
  assertAcyclic(byId);
  assertWritersSerialized(plan.steps, byId);
}

function assertAcyclic(byId) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail) {
    if (visiting.has(id)) throw new Error(`ciclo no DAG: ${[...trail, id].join(" -> ")}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id, []);
}

function dependsOn(start, target, byId, seen = new Set()) {
  if (seen.has(start)) return false;
  seen.add(start);
  for (const dependency of byId.get(start).dependsOn) {
    if (dependency === target || dependsOn(dependency, target, byId, seen)) return true;
  }
  return false;
}

function assertWritersSerialized(steps, byId) {
  const writers = steps.filter((step) => step.mode === "write");
  for (let left = 0; left < writers.length; left += 1) {
    for (let right = left + 1; right < writers.length; right += 1) {
      const a = writers[left].id;
      const b = writers[right].id;
      if (!dependsOn(a, b, byId) && !dependsOn(b, a, byId)) {
        throw new Error(`escritores podem executar em paralelo: ${a}, ${b}`);
      }
    }
  }
}

const file = process.argv[2];
try {
  if (!file) throw new Error("informe o arquivo do plano");
  const plan = JSON.parse(readFileSync(file, "utf8"));
  validate(plan);
  process.stdout.write(`Plano de execução válido: ${plan.steps.length} passos.\n`);
} catch (error) {
  process.stderr.write(`Plano de execução inválido: ${error.message}\n`);
  process.exitCode = 1;
}
