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

// --- modo snapshot: enumeração da base e do candidato efetivo ---

function specWith(id, issue) {
  return `# Especificação ${id} — teste\n\n<!-- spec-meta\n{"id":"${id}","issue":"${issue}","status":"approved"}\n-->\n\n${required
    .map((heading) => `## ${heading}\n\n${heading === "Status" ? "Aprovada." : "Conteúdo verificável."}`)
    .join("\n\n")}\n`;
}

function specTree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "sublims-spec-tree-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function changedList(entries) {
  const root = mkdtempSync(join(tmpdir(), "sublims-spec-changed-"));
  const file = join(root, "changed.bin");
  writeFileSync(file, Buffer.from(entries.map(([status, path]) => `${status}\0${path}\0`).join(""), "utf8"));
  return file;
}

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("enumera e valida todas as especificações da base", () => {
  const trusted = specTree({
    "specs/3-governance-hardening.md": specWith("3", "github:#3"),
    "specs/004-ai-engineering-system.md": specWith("004", "local:tasks/004-ai-engineering-system.md"),
    "tasks/004-ai-engineering-system.md": "# Tarefa 004\n"
  });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /base: 2 especificações/);
});

test("aceita simultaneamente referência github e referência local", () => {
  const trusted = specTree({
    "specs/3-governance-hardening.md": specWith("3", "github:#3"),
    "specs/004-ai-engineering-system.md": specWith("004", "local:tasks/004-ai-engineering-system.md"),
    "tasks/004-ai-engineering-system.md": "# Tarefa 004\n"
  });
  assert.equal(runCli(["--trusted", trusted]).status, 0);
});

test("especificação inválida na base reprova a enumeração inteira", () => {
  const trusted = specTree({
    "specs/3-governance-hardening.md": specWith("3", "github:#3"),
    "specs/9-quebrada.md": "# sem metadados\n"
  });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /9-quebrada\.md|spec-meta/);
});

test("diretório de especificações ausente reprova", () => {
  const trusted = specTree({ "AGENTS.md": "# vazio" });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /diretório ausente ou ilegível/);
});

test("valida a especificação nova do candidato", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const candidate = specTree({
    "specs/3-governance-hardening.md": specWith("3", "github:#3"),
    "specs/9-nova.md": specWith("9", "github:#9").replace("## Critérios de aceite\n\nConteúdo verificável.", "")
  });
  const changed = changedList([["A", "specs/9-nova.md"]]);
  const result = runCli(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Critérios de aceite/);
});

test("alteração legítima de especificação existente não vira duplicação", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const candidate = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const changed = changedList([["M", "specs/3-governance-hardening.md"]]);
  const result = runCli(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /candidato: 1 especificação/);
});

test("id duplicado dentro de um mesmo snapshot reprova", () => {
  const trusted = specTree({
    "specs/3-governance-hardening.md": specWith("3", "github:#3"),
    "specs/4-outra.md": specWith("3", "github:#3")
  });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /id .*não corresponde|id duplicado/);
});

test("exclusão de especificação presente na base reprova", () => {
  const trusted = specTree({
    "specs/3-governance-hardening.md": specWith("3", "github:#3"),
    "specs/4-outra.md": specWith("4", "github:#4")
  });
  const candidate = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const changed = changedList([["D", "specs/4-outra.md"]]);
  const result = runCli(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exclusão de entrada presente na base/);
});

test("--candidate sem --changed reprova, e argumento desconhecido reprova", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const candidate = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });

  const semChanged = runCli(["--trusted", trusted, "--candidate", candidate]);
  assert.equal(semChanged.status, 1);
  assert.match(semChanged.stderr, /--changed é obrigatório/);

  const desconhecido = runCli(["--trusted", trusted, "--allow-deletion"]);
  assert.equal(desconhecido.status, 1);
  assert.match(desconhecido.stderr, /argumento desconhecido/);
});

test("nome fora do padrão na lista de alterações reprova", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const candidate = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const changed = changedList([["A", "specs/3-Governance.md"]]);
  const result = runCli(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nome fora do padrão/);
});

test("--changed sem --candidate reprova em vez de ignorar a lista de alterações", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const changed = changedList([["D", "specs/3-governance-hardening.md"]]);
  const result = runCli(["--trusted", trusted, "--changed", changed]);
  assert.equal(result.status, 1, "aceitar --changed sem --candidate ignora a lista e aprova por omissão");
  assert.match(result.stderr, /--changed exige --candidate/);
});

test("modo somente --trusted continua válido", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /base: 1 especificação/);
});

test("modo candidato completo continua válido", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const candidate = specTree({
    "specs/3-governance-hardening.md": specWith("3", "github:#3"),
    "specs/9-nova.md": specWith("9", "github:#9")
  });
  const changed = changedList([["A", "specs/9-nova.md"]]);
  const result = runCli(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /candidato: 2 especificações/);
});

test("opção repetida reprova em vez de o último valor vencer em silêncio", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const result = runCli(["--trusted", trusted, "--changed", "a.bin", "--changed", "b.bin"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /argumento repetido: --changed/);
});
