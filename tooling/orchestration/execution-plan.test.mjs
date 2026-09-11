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

test("base com diretório existente e realmente vazio reprova por enumeração vazia", () => {
  const trusted = tree({ "AGENTS.md": "# raiz" });
  mkdirSync(join(trusted, "orchestration/plans"), { recursive: true });
  const result = run(["--trusted", trusted]);
  assert.equal(result.status, 1);
  // Mensagem exata: `.manter` reprovaria antes, por padrão, deixando esta guarda sem prova.
  assert.match(result.stderr, /nenhuma entrada aplicável/);
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

test("lista de alterações vazia reprova em vez de aprovar o candidato sem examiná-lo", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = tree({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/9.json": JSON.stringify({ version: 1, steps: [] })
  });
  const vazia = changedFile([]);
  const result = run(["--trusted", trusted, "--candidate", candidate, "--changed", vazia]);
  assert.equal(result.status, 1, "lista vazia não pode aprovar: o 9.json inválido nunca seria lido");
  assert.match(result.stderr, /está vazia/);
  assert.doesNotMatch(result.stdout, /candidato:/, "não pode afirmar que o candidato foi validado");
});

test("alteração M é efetivamente aplicada: conteúdo inválido no candidato reprova", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  // Mesmo caminho, conteúdo diferente e inválido. Ignorar o `M` manteria a entrada da
  // base, que é válida, e o teste passaria sem provar nada.
  const candidate = tree({ "orchestration/plans/3.json": JSON.stringify({ version: 1, task: "spec:3", steps: [] }) });
  const changed = changedFile([["M", "orchestration/plans/3.json"]]);
  const result = run(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1, "o conteúdo modificado do candidato precisa ser lido");
  assert.match(result.stderr, /candidato: orchestration\/plans\/3\.json/);
});

test("modo posicional exige `task`, como o modo snapshot", () => {
  const root = tree({
    "orchestration/plans/3.json": JSON.stringify({
      version: 1,
      steps: [{ id: "u", agent: "developer", mode: "write", dependsOn: [], reads: [], writes: ["x"] }]
    })
  });
  const result = run([join(root, "orchestration/plans/3.json")]);
  assert.equal(result.status, 1, "plano sem `task` não pode passar no modo por arquivo");
  assert.match(result.stderr, /sem `task`/);
});

// --- cobertura das invariantes do DAG, recuperada da base 9d2dd09 ---
// Os três casos originais foram perdidos quando este arquivo foi reescrito. Restaurados
// aqui com `task`, que passou a ser obrigatório, e estendidos ao modo snapshot para
// provar paridade entre os dois modos.

const ANALISES_PARALELAS = {
  version: 1,
  task: "spec:3",
  steps: [
    { id: "product", agent: "product", mode: "read", dependsOn: [], reads: ["specs/**"], writes: [] },
    { id: "security", agent: "security-data-reviewer", mode: "read", dependsOn: [], reads: ["**"], writes: [] },
    { id: "consolidate", agent: "orchestrator", mode: "read", dependsOn: ["product", "security"], reads: ["**"], writes: [] },
    { id: "implement", agent: "developer", mode: "write", dependsOn: ["consolidate"], reads: ["**"], writes: ["tooling/**"] }
  ]
};

const ESCRITORES_PARALELOS = {
  version: 1,
  task: "spec:3",
  steps: [
    { id: "write-a", agent: "developer", mode: "write", dependsOn: [], reads: [], writes: ["src/a.ts"] },
    { id: "write-b", agent: "platform-devops", mode: "write", dependsOn: [], reads: [], writes: ["infra/a.yml"] }
  ]
};

const CICLO = {
  version: 1,
  task: "spec:3",
  steps: [
    { id: "a", agent: "product", mode: "read", dependsOn: ["b"], reads: [], writes: [] },
    { id: "b", agent: "architect", mode: "read", dependsOn: ["a"], reads: [], writes: [] }
  ]
};

function posicional(plano) {
  const root = tree({ "orchestration/plans/3.json": JSON.stringify(plano) });
  return run([join(root, "orchestration/plans/3.json")]);
}

function snapshot(plano) {
  const root = tree({ "orchestration/plans/3.json": JSON.stringify(plano) });
  return run(["--trusted", root]);
}

test("aceita análises paralelas seguidas por um único escritor", () => {
  for (const [modo, resultado] of [["posicional", posicional(ANALISES_PARALELAS)], ["snapshot", snapshot(ANALISES_PARALELAS)]]) {
    assert.equal(resultado.status, 0, `${modo}: ${resultado.stderr}`);
  }
});

test("rejeita dois escritores que podem executar em paralelo, nos dois modos", () => {
  for (const [modo, resultado] of [["posicional", posicional(ESCRITORES_PARALELOS)], ["snapshot", snapshot(ESCRITORES_PARALELOS)]]) {
    assert.notEqual(resultado.status, 0, `${modo} deveria reprovar escritores concorrentes`);
    assert.match(resultado.stderr, /escritores.*paralelo/i, `${modo}`);
  }
});

test("rejeita ciclo no DAG de execução, nos dois modos", () => {
  for (const [modo, resultado] of [["posicional", posicional(CICLO)], ["snapshot", snapshot(CICLO)]]) {
    assert.notEqual(resultado.status, 0, `${modo} deveria reprovar ciclo`);
    assert.match(resultado.stderr, /ciclo/i, `${modo}`);
  }
});

test("valor vazio ou em branco é recusado em toda opção, com a opção identificada", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  const changed = changedFile([["M", "orchestration/plans/3.json"]]);
  for (const vazio of ["", "   ", "\t"]) {
    for (const [args, opcao] of [
      [["--trusted", vazio], "--trusted"],
      [["--trusted", trusted, "--candidate", vazio, "--changed", changed], "--candidate"],
      [["--trusted", trusted, "--candidate", trusted, "--changed", vazio], "--changed"]
    ]) {
      const result = run(args);
      assert.equal(result.status, 1, `${opcao} com ${JSON.stringify(vazio)} não pode ser aceito`);
      assert.match(result.stderr, new RegExp(`${opcao} exige um valor`), opcao);
    }
  }
});

test("o modo é escolhido pela presença da opção, não pela veracidade do valor", () => {
  const trusted = tree({ "orchestration/plans/3.json": plan("spec:3") });
  // `--candidate ""` não pode degradar silenciosamente para validação só da base.
  const result = run(["--trusted", trusted, "--candidate", ""]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /base: 1 plano/, "não pode reportar sucesso de base");
});
