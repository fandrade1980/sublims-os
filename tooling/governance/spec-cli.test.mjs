import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function symlinkSkip() {
  const probe = mkdtempSync(join(tmpdir(), "sublims-spec-symlink-"));
  try {
    writeFileSync(join(probe, "alvo.md"), "x");
    symlinkSync(join(probe, "alvo.md"), join(probe, "link.md"));
    return false;
  } catch (error) {
    // Fora de Windows, symlink sempre funciona; falhar aqui é problema de ambiente.
    if (process.platform !== "win32") throw error;
    return "symlink indisponível nesta plataforma";
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
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
  // Dois caminhos válidos com o mesmo id: `4-outra.md` com id 3 reprovaria antes, na
  // checagem de nome, deixando a guarda de duplicação sem prova.
  const trusted = specTree({
    "specs/3-a.md": specWith("3", "github:#3"),
    "specs/3-b.md": specWith("3", "github:#3")
  });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /id duplicado/);
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

test("base com diretório existente e realmente vazio reprova por enumeração vazia", () => {
  const trusted = specTree({ "AGENTS.md": "# raiz" });
  mkdirSync(join(trusted, "specs"), { recursive: true });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nenhuma entrada aplicável/);
});

test("lista de alterações vazia reprova em vez de aprovar o candidato sem examiná-lo", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const candidate = specTree({
    "specs/3-governance-hardening.md": specWith("3", "github:#3"),
    "specs/9-quebrada.md": "# sem metadados\n"
  });
  const vazia = changedList([]);
  const result = runCli(["--trusted", trusted, "--candidate", candidate, "--changed", vazia]);
  assert.equal(result.status, 1, "lista vazia não pode aprovar: a 9-quebrada nunca seria lida");
  assert.match(result.stderr, /está vazia/);
  assert.doesNotMatch(result.stdout, /candidato:/, "não pode afirmar que o candidato foi validado");
});

test("alteração M é efetivamente aplicada: conteúdo inválido no candidato reprova", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  // Mesmo caminho, conteúdo diferente e inválido. Ignorar o `M` manteria a entrada da
  // base, que é válida, e o teste passaria sem provar nada.
  const candidate = specTree({ "specs/3-governance-hardening.md": "# spec sem metadados\n" });
  const changed = changedList([["M", "specs/3-governance-hardening.md"]]);
  const result = runCli(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1, "o conteúdo modificado do candidato precisa ser lido");
  assert.match(result.stderr, /candidato: specs\/3-governance-hardening\.md/);
});

test("tarefa local que existe como diretório é recusada", () => {
  const trusted = specTree({
    "specs/7-com-local.md": specWith("7", "local:tasks/7-com-local.md"),
    "AGENTS.md": "# raiz"
  });
  mkdirSync(join(trusted, "tasks/7-com-local.md"), { recursive: true });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 1, "diretório não satisfaz uma referência a arquivo de tarefa");
  assert.match(result.stderr, /issue local/);
});

test("tarefa local por symlink é recusada", { skip: symlinkSkip() }, () => {
  const trusted = specTree({
    "specs/7-com-local.md": specWith("7", "local:tasks/7-com-local.md"),
    "fora/alvo.md": "# alvo fora da árvore\n",
    "tasks/.manter": ""
  });
  symlinkSync(join(trusted, "fora/alvo.md"), join(trusted, "tasks/7-com-local.md"));
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 1, "symlink não pode satisfazer a referência local");
  assert.match(result.stderr, /symlink|issue local/);
});

test("spec herdada da base reprova se a tarefa referenciada não existir na árvore candidata", () => {
  const trusted = specTree({
    "specs/7-com-local.md": specWith("7", "local:tasks/7-com-local.md"),
    "tasks/7-com-local.md": "# Tarefa 7\n",
    "specs/3-governance-hardening.md": specWith("3", "github:#3")
  });
  // O candidato removeu a tarefa. A referência local é resolvida contra a árvore
  // candidata de propósito: é assim que a remoção é detectada.
  const candidate = specTree({
    "specs/7-com-local.md": specWith("7", "local:tasks/7-com-local.md"),
    "specs/3-governance-hardening.md": specWith("3", "github:#3")
  });
  const changed = changedList([["M", "specs/3-governance-hardening.md"]]);

  assert.equal(runCli(["--trusted", trusted]).status, 0, "a base, com a tarefa presente, é válida");
  const result = runCli(["--trusted", trusted, "--candidate", candidate, "--changed", changed]);
  assert.equal(result.status, 1, "a remoção da tarefa na árvore candidata precisa reprovar");
  assert.match(result.stderr, /issue local inexistente/);
});

test("valor vazio ou em branco é recusado em toda opção, com a opção identificada", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const changed = changedList([["M", "specs/3-governance-hardening.md"]]);
  for (const vazio of ["", "   ", "\t"]) {
    for (const [args, opcao] of [
      [["--trusted", vazio], "--trusted"],
      [["--trusted", trusted, "--candidate", vazio, "--changed", changed], "--candidate"],
      [["--trusted", trusted, "--candidate", trusted, "--changed", vazio], "--changed"]
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1, `${opcao} com ${JSON.stringify(vazio)} não pode ser aceito`);
      assert.match(result.stderr, new RegExp(`${opcao} exige um valor`), opcao);
    }
  }
});

test("o modo é escolhido pela presença da opção, não pela veracidade do valor", () => {
  const trusted = specTree({ "specs/3-governance-hardening.md": specWith("3", "github:#3") });
  const result = runCli(["--trusted", trusted, "--candidate", ""]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /base: 1 especificação/, "não pode reportar sucesso de base");
});

test("ids que diferem só por zeros à esquerda reprovam como duplicata", () => {
  // Cada spec é válida isoladamente: o metadado corresponde textualmente ao nome.
  // Sem chave canônica, `3` e `003` passariam como identificadores distintos da mesma issue.
  const trusted = specTree({
    "specs/3-a.md": specWith("3", "github:#3"),
    "specs/003-b.md": specWith("003", "github:#3")
  });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 1, "3 e 003 designam a mesma issue e não podem coexistir");
  assert.match(result.stderr, /id duplicado/);
});

test("a chave canônica cobre qualquer quantidade de zeros à esquerda", () => {
  for (const [a, b] of [["3", "03"], ["3", "0003"], ["03", "003"], ["10", "010"]]) {
    const trusted = specTree({
      [`specs/${a}-a.md`]: specWith(a, "github:#3"),
      [`specs/${b}-b.md`]: specWith(b, "github:#3")
    });
    const result = runCli(["--trusted", trusted]);
    assert.equal(result.status, 1, `${a} e ${b} deveriam colidir`);
    assert.match(result.stderr, /id duplicado/, `${a} vs ${b}`);
  }
});

test("ids canônicos distintos continuam aprovados", () => {
  const trusted = specTree({
    "specs/3-a.md": specWith("3", "github:#3"),
    "specs/10-b.md": specWith("10", "github:#10"),
    "specs/123-c.md": specWith("123", "github:#123")
  });
  const result = runCli(["--trusted", trusted]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /base: 3 especificações/);
});

test("a correspondência textual entre nome e metadata.id permanece estrita", () => {
  // Compatibilidade: id legado com zeros à esquerda continua válido quando o nome combina.
  const legado = specTree({ "specs/004-x.md": specWith("004", "github:#4") });
  assert.equal(runCli(["--trusted", legado]).status, 0, "004 com id 004 precisa continuar válido");

  // A canonização vale só para unicidade: nome e metadado não podem divergir textualmente.
  const divergente = specTree({ "specs/004-x.md": specWith("4", "github:#4") });
  const result = runCli(["--trusted", divergente]);
  assert.equal(result.status, 1, "004 com id 4 continua inválido");
  assert.match(result.stderr, /não corresponde ao nome do arquivo/);
});

test("a árvore confiável atual, com a spec 004, permanece válida", () => {
  const raiz = resolve(import.meta.dirname, "../..");
  const snapshot = runCli(["--trusted", raiz]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.match(snapshot.stdout, /base: 2 especificações/);

  const posicional = spawnSync(
    process.execPath,
    [cli, join(raiz, "specs/004-ai-engineering-system.md")],
    { encoding: "utf8" }
  );
  assert.equal(posicional.status, 0, posicional.stderr);
});
