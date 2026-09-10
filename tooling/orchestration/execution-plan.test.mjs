import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve(import.meta.dirname, "validate-execution-plan.mjs");

function plan(task, steps = [{ id: "unico", agent: "developer", mode: "write", dependsOn: [], reads: [], writes: ["x"] }]) {
  return JSON.stringify({ version: 1, task, steps });
}

function tree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "sublims-plan-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

// A lista de alterações é a saída de `git diff --name-status -z`: campos separados por NUL.
function changedFile(entries) {
  const root = mkdtempSync(join(tmpdir(), "sublims-changed-"));
  const file = join(root, "changed.bin");
  writeFileSync(file, Buffer.from(entries.map(([status, path]) => `${status}\0${path}\0`).join(""), "utf8"));
  return file;
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("modo por arquivo continua aceito, porque validate-pr e o workflow o usam", () => {
  const root = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const result = run([join(root, "orchestration/plans/3.json")]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plano de execução válido/);
});

test("modo por arquivo reprova plano inválido", () => {
  const root = tree({ "orchestration/plans/3.json": JSON.stringify({ version: 2, steps: [] }) });
  const result = run([join(root, "orchestration/plans/3.json")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version 1/);
});

test("enumera e valida todos os planos do snapshot da base", () => {
  const trusted = tree({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/004.json": plan("task:004")
  });
  const result = run(["--trusted", trusted]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /base: 2 planos/);
});

test("plano inválido em qualquer ponto da base reprova a enumeração inteira", () => {
  const trusted = tree({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/4.json": JSON.stringify({ version: 1, steps: [] })
  });
  const result = run(["--trusted", trusted]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /orchestration\/plans\/4\.json/);
});

test("base sem nenhum plano aplicável reprova; enumeração vazia não é aprovação", () => {
  const trusted = tree({ "orchestration/plans/.manter": "" });
  const result = run(["--trusted", trusted]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nome fora do padrão|nenhuma entrada aplicável/);
});

test("diretório de planos ausente na base reprova", () => {
  const trusted = tree({ "AGENTS.md": "# vazio" });
  const result = run(["--trusted", trusted]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /diretório ausente ou ilegível/);
});

test("valida o plano novo do candidato, não apenas os da base", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = tree({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/4.json": JSON.stringify({ version: 1, steps: [] })
  });
  const changed = changedFile([["A", "orchestration/plans/4.json"]]);
  const result = run(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /orchestration\/plans\/4\.json/);
});

test("alteração legítima de plano existente não é tratada como duplicação", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const changed = changedFile([["M", "orchestration/plans/3.json"]]);
  const result = run(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /candidato: 1 plano/);
});

test("task duplicada dentro de um mesmo snapshot reprova", () => {
  const trusted = tree({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/4.json": plan("spec:3")
  });
  const result = run(["--trusted", trusted]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /task duplicada/);
});

test("task duplicada criada pelo candidato reprova, sem confundir com a base", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = tree({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/5.json": plan("spec:3")
  });
  const changed = changedFile([["A", "orchestration/plans/5.json"]]);
  const result = run(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /task duplicada/);
});

test("exclusão de plano presente na base reprova", () => {
  const trusted = tree({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/4.json": plan("spec:4")
  });
  const candidate = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const changed = changedFile([["D", "orchestration/plans/4.json"]]);
  const result = run(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exclusão de entrada presente na base/);
});

test("nome fora do padrão e travessia na lista de alterações reprovam", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = tree({ "orchestration/plans/3.json": plan("spec:3") });

  const foraDoPadrao = run([
    "--trusted", trusted, "--candidate", candidate,
    "--changed", changedFile([["A", "orchestration/plans/3.json.bak"]])
  ]);
  assert.equal(foraDoPadrao.status, 1);
  assert.match(foraDoPadrao.stderr, /nome fora do padrão/);

  const travessia = run([
    "--trusted", trusted, "--candidate", candidate,
    "--changed", changedFile([["A", "../fora/9.json"]])
  ]);
  assert.equal(travessia.status, 1);
  assert.match(travessia.stderr, /componente `\.\.`/);
});

test("--candidate sem --changed reprova em vez de validar só a base", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const result = run(["--trusted", trusted, "--candidate", candidate]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--changed é obrigatório/);
});

test("o candidato não consegue habilitar exclusão nem conjunto vazio por argumento", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = tree({ "orchestration/plans/.manter": "" });
  const changed = changedFile([["D", "orchestration/plans/3.json"]]);
  for (const extra of [[], ["--allow-deletion"], ["--allow-empty"], ["--allow-deletion", "--allow-empty"]]) {
    const result = run(["--trusted", trusted, "--candidate", candidate, "--changed", changed, ...extra]);
    assert.equal(result.status, 1, `argumentos ${JSON.stringify(extra)} não podem afrouxar a validação`);
    assert.match(result.stderr, /exclusão de entrada presente na base|argumento desconhecido/);
  }
});

test("conteúdo do candidato é dado: JSON inválido reprova, nunca é executado", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = tree({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/9.json": "process.exit(0); // não é JSON"
  });
  const changed = changedFile([["A", "orchestration/plans/9.json"]]);
  const result = run(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JSON inválido/);
});

test("--changed sem --candidate reprova em vez de ignorar a lista de alterações", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const changed = changedFile([["D", "orchestration/plans/3.json"]]);
  const result = run(["--trusted", trusted, "--changed", changed]);
  assert.equal(result.status, 1, "aceitar --changed sem --candidate ignora a lista e aprova por omissão");
  assert.match(result.stderr, /--changed exige --candidate/);
});

test("modo somente --trusted continua válido", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const result = run(["--trusted", trusted]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /base: 1 plano/);
});

test("modo candidato completo continua válido", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = tree({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/5.json": plan("spec:5")
  });
  const changed = changedFile([["A", "orchestration/plans/5.json"]]);
  const result = run(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /candidato: 2 planos/);
});

test("opção repetida reprova em vez de o último valor vencer em silêncio", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const result = run(["--trusted", "/caminho/inexistente", "--trusted", trusted]);
  assert.equal(result.status, 1, "o último valor não pode sobrescrever o primeiro em silêncio");
  assert.match(result.stderr, /argumento repetido: --trusted/);
});
