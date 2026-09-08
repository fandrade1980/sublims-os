import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "../..");
const cli = join(projectRoot, "tooling/governance/validate-spec.mjs");
const required = [
  "Status",
  "Problema",
  "Resultado esperado",
  "Escopo",
  "Fora de escopo",
  "Regras",
  "Superfícies de teste",
  "Critérios de aceite",
  "Riscos e decisões pendentes",
  "Evidência de conclusão"
];

function spec(extra = "") {
  return `# Especificação 999 — teste\n\n<!-- spec-meta\n{"id":"999","issue":"local:tasks/999-test.md","status":"approved"}\n-->\n\n${required
    .map((heading) => `## ${heading}\n\n${heading === "Status" ? "Aprovada." : "Conteúdo verificável."}`)
    .join("\n\n")}\n${extra}`;
}

test("aceita especificação com todas as seções obrigatórias", () => {
  const dir = mkdtempSync(join(tmpdir(), "sublims-spec-"));
  mkdirSync(join(dir, "specs"));
  mkdirSync(join(dir, "tasks"));
  writeFileSync(join(dir, "tasks/999-test.md"), "# Tarefa 999\n");
  const path = join(dir, "specs/999-test.md");
  writeFileSync(path, spec());
  const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /especificação válida/i);
});

test("rejeita especificação sem critérios de aceite", () => {
  const dir = mkdtempSync(join(tmpdir(), "sublims-spec-"));
  mkdirSync(join(dir, "specs"));
  mkdirSync(join(dir, "tasks"));
  writeFileSync(join(dir, "tasks/999-test.md"), "# Tarefa 999\n");
  const path = join(dir, "specs/999-test.md");
  writeFileSync(path, spec().replace("## Critérios de aceite", "## Critérios removidos"));
  const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /critérios de aceite/i);
});

test("rejeita especificação marcada como rascunho", () => {
  const dir = mkdtempSync(join(tmpdir(), "sublims-spec-"));
  mkdirSync(join(dir, "specs"));
  mkdirSync(join(dir, "tasks"));
  writeFileSync(join(dir, "tasks/999-test.md"), "# Tarefa 999\n");
  const path = join(dir, "specs/999-test.md");
  writeFileSync(path, spec().replace('"status":"approved"', '"status":"draft"'));
  const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /não está aprovada/i);
});

test("rejeita especificação sem metadados inequívocos", () => {
  const dir = mkdtempSync(join(tmpdir(), "sublims-spec-"));
  mkdirSync(join(dir, "specs"));
  const path = join(dir, "specs/999-test.md");
  writeFileSync(path, spec().replace(/<!-- spec-meta[\s\S]*?-->\n\n/, ""));
  const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /metadados/i);
});

test("rejeita id de metadados diferente do nome do arquivo", () => {
  const dir = mkdtempSync(join(tmpdir(), "sublims-spec-"));
  mkdirSync(join(dir, "specs"));
  mkdirSync(join(dir, "tasks"));
  writeFileSync(join(dir, "tasks/999-test.md"), "# Tarefa 999\n");
  const path = join(dir, "specs/999-test.md");
  writeFileSync(path, spec().replace('"id":"999"', '"id":"998"'));
  const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /não corresponde/i);
});

test("rejeita referência local que tenta escapar da raiz", () => {
  const dir = mkdtempSync(join(tmpdir(), "sublims-spec-"));
  mkdirSync(join(dir, "specs"));
  const path = join(dir, "specs/999-test.md");
  writeFileSync(path, spec().replace("local:tasks/999-test.md", "local:../outside.md"));
  writeFileSync(join(dir, "../outside.md"), "# Fora\n");
  const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /issue local inválida/i);
});
