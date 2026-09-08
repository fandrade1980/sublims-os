import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve(import.meta.dirname, "validate-pr.mjs");
const headings = ["Status", "Problema", "Resultado esperado", "Escopo", "Fora de escopo", "Regras", "Superfícies de teste", "Critérios de aceite", "Riscos e decisões pendentes", "Evidência de conclusão"];

function validSpec() {
  return `# Especificação 123 — teste\n\n<!-- spec-meta\n{"id":"123","issue":"github:#123","status":"approved"}\n-->\n\n${headings.map((h) => `## ${h}\n\n${h === "Status" ? "Aprovada." : "Conteúdo."}`).join("\n\n")}\n`;
}

function fixture({ mutateSpec = false, body = "Tipo: implementação\nIssue: #123\nSpec: specs/123-test.md\n\n## Evidência TDD\n\n| Fatia | Vermelho | Verde |\n|---|---|---|\n| 1 | teste falhou pelo motivo esperado | teste passou |" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sublims-pr-"));
  const trusted = join(root, "trusted");
  const candidate = join(root, "candidate");
  for (const dir of [trusted, candidate]) {
    mkdirSync(join(dir, "specs"), { recursive: true });
    mkdirSync(join(dir, "tasks"), { recursive: true });
    writeFileSync(join(dir, "tasks/123-test.md"), "# Tarefa 123\n");
    writeFileSync(join(dir, "specs/123-test.md"), validSpec());
  }
  if (mutateSpec) writeFileSync(join(candidate, "specs/123-test.md"), `${validSpec()}\nMudança indevida.\n`);
  const bodyFile = join(root, "body.md");
  const changedFileList = join(root, "changed.txt");
  writeFileSync(bodyFile, body);
  writeFileSync(changedFileList, mutateSpec ? "specs/123-test.md\nsrc/example.ts\n" : "src/example.ts\n");
  return { trusted, candidate, bodyFile, changedFileList };
}

function run(fx) {
  return spawnSync(process.execPath, [cli, "--trusted", fx.trusted, "--candidate", fx.candidate, "--body", fx.bodyFile, "--changed", fx.changedFileList], { encoding: "utf8" });
}

test("aceita PR de implementação ligado a spec aprovada e imutável na base", () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
});

test("rejeita PR de implementação que altera a própria spec", () => {
  const result = run(fixture({ mutateSpec: true }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec.*separado|imutável/i);
});

test("rejeita PR sem links explícitos para issue e spec", () => {
  const result = run(fixture({ body: "Implementação pronta." }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tipo|issue|spec/i);
});

test("rejeita PR ligado a issue diferente do id da spec", () => {
  const result = run(fixture({ body: "Tipo: implementação\nIssue: #124\nSpec: specs/123-test.md\n\n## Evidência TDD\n\n| Fatia | Vermelho | Verde |\n|---|---|---|\n| 1 | falhou | passou |" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /issue.*spec/i);
});

test("rejeita implementação sem evidência vermelho e verde", () => {
  const result = run(fixture({ body: "Tipo: implementação\nIssue: #123\nSpec: specs/123-test.md\n\n## Evidência TDD\n\n| Fatia | Vermelho | Verde |\n|---|---|---|\n| 1 |  |  |" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /evidência tdd/i);
});

test("rejeita PR de spec cujo spec-meta aponta para outra issue", () => {
  const fx = fixture({ body: "Tipo: spec\nIssue: #123\nSpec: specs/123-test.md" });
  writeFileSync(join(fx.candidate, "specs/123-test.md"), validSpec().replace("github:#123", "github:#999"));
  writeFileSync(fx.changedFileList, "specs/123-test.md\n");
  const result = run(fx);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec-meta\.issue/i);
});
