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

function fixture({ mutateSpec = false, changed, body = "Tipo: implementação\nIssue: #123\nSpec: specs/123-test.md\n\n## Evidência TDD\n\n| Fatia | Vermelho | Verde |\n|---|---|---|\n| 1 | teste falhou pelo motivo esperado | teste passou |" } = {}) {
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
  writeFileSync(
    changedFileList,
    changed ?? (mutateSpec ? "specs/123-test.md\nsrc/example.ts\n" : "src/example.ts\n")
  );
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

// Comprova a rejeição PÚBLICA de bloco `spec-meta` duplicado pelo gate.
//
// O que este teste NÃO prova: qual implementação produziu a recusa. `validate-pr.mjs`
// invoca `validate-spec.mjs` antes de ler os metadados, e é esse subprocesso que
// reprova aqui — a chamada a `parseSpecMeta` sequer é alcançada. O consumo direto do
// contrato compartilhado é verificado em `tooling/lib/spec-meta.test.mjs`.
//
// O valor deste teste é fixar o comportamento observável: duplicar o bloco reprova o
// PR, qualquer que seja o caminho interno que produza a recusa.
test("rejeita PR cuja spec tem bloco spec-meta duplicado", () => {
  const fx = fixture({ body: "Tipo: spec\nIssue: #123\nSpec: specs/123-test.md" });
  const duplicado = `${validSpec()}\n<!-- spec-meta\n{"id":"123","issue":"github:#123","status":"approved"}\n-->\n`;
  writeFileSync(join(fx.candidate, "specs/123-test.md"), duplicado);
  writeFileSync(fx.changedFileList, "specs/123-test.md\n");
  const result = run(fx);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ausentes ou duplicados/i);
});

test("rejeita PR de spec cujo spec-meta aponta para outra issue", () => {
  const fx = fixture({ body: "Tipo: spec\nIssue: #123\nSpec: specs/123-test.md" });
  writeFileSync(join(fx.candidate, "specs/123-test.md"), validSpec().replace("github:#123", "github:#999"));
  writeFileSync(fx.changedFileList, "specs/123-test.md\n");
  const result = run(fx);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec-meta\.issue/i);
});

// ---------------------------------------------------------------------------------
// Critérios 119 e 120 — caminho proibido na lista de alterações.
//
// Spec, linha 271: "`.gitignore` evita inclusão acidental; não impede inclusão
// deliberada, já que `git add -f` existe. Por isso a defesa é dupla: além da regra de
// ignorar, `validate-pr.mjs` reprova o PR quando a lista de arquivos alterados contiver
// caminho proibido — esse documento, qualquer `.env` que não seja `.env.example`,
// chaves, dumps, backups e `.npmrc`."
//
// A enumeração concreta vem de `.gitignore:6-8,14,16-39`.
// ---------------------------------------------------------------------------------

// Nome literal e ancorado na raiz, como em `.gitignore:14`. Montado por concatenação
// para que nenhuma ferramenta de busca do repositório trate este teste como uma
// referência ao documento em si.
const DOCUMENTO_DE_TRABALHO =
  "Prompt avançado — Engenharia reversa autorizada de plataforma SaaS.md";

for (const [nome, caminho] of [
  ["documento de trabalho da raiz", DOCUMENTO_DE_TRABALHO],
  [".env", ".env"],
  [".env de ambiente", ".env.production"],
  [".env aninhado", "apps/web/.env.local"],
  ["chave privada pem", "deploy/server.pem"],
  ["chave privada key", "certs/tls.key"],
  ["certificado crt", "certs/ca.crt"],
  ["keystore p12", "certs/bundle.p12"],
  ["keystore pfx", "certs/bundle.pfx"],
  ["chave ssh rsa", "id_rsa"],
  ["chave ssh ed25519", "infra/id_ed25519"],
  ["npmrc", ".npmrc"],
  ["npmrc aninhado", "packages/app/.npmrc"],
  ["yarnrc", ".yarnrc"],
  ["pgpass", ".pgpass"],
  ["dump", "db/producao.dump"],
  ["sql comprimido", "db/producao.sql.gz"],
  ["sqlite", "data/app.sqlite"],
  ["sqlite3", "data/app.sqlite3"],
  ["diretório de backups", "backups/2026-09-15.tar"],
  ["diretório de dumps", "dumps/producao.sql"],
  ["diretório de secrets", "secrets/token.txt"],
  ["arquivo secret", "infra/deploy.secret.json"],
  // `.gitignore:29`. Credencial local de ferramenta, na mesma classe de `.npmrc`.
  ["credencial local do Claude", ".claude/settings.local.json"],
  ["credencial local do Claude aninhada", "packages/app/.claude/settings.local.json"]
]) {
  test(`rejeita ${nome} na lista de alterações`, () => {
    const result = run(fixture({ changed: `src/example.ts\n${caminho}\n` }));
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /caminho proibido/i);
  });
}

// A exceção do nome `.env.example` neutraliza SOMENTE a regra genérica de `.env`.
// Ela não pode devolver "permitido" antes de conferir as demais proibições: um
// arquivo dentro de `secrets/`, `backups/` ou `dumps/` continua proibido, qualquer que
// seja o nome.
for (const caminho of [
  "secrets/.env.example",
  "backups/.env.example",
  "dumps/.env.example",
  "secrets/config/.env.example",
  "infra/backups/.env.example"
]) {
  test(`rejeita .env.example dentro de diretório proibido: ${caminho}`, () => {
    const result = run(fixture({ changed: `src/example.ts\n${caminho}\n` }));
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /caminho proibido/i);
  });
}

// ---------------------------------------------------------------------------------
// Entrada não canônica na lista de alterações.
//
// O produtor atual é `git diff --name-only`, que aplica C-style quoting a caminhos com
// bytes fora do ASCII imprimível: o caminho vem entre aspas e com escapes octais. Nessa
// forma, a comparação textual contra os padrões proibidos deixa de valer — inclusive
// para o próprio documento protegido, cujo nome tem acentuação e travessão.
//
// Enquanto a migração NUL-safe não acontece (PR 6), a postura é fail-closed: entrada
// não canônica reprova, em vez de ser comparada como se fosse literal.
// ---------------------------------------------------------------------------------

// Forma quoted que o Git produziria para o documento protegido da raiz, com escapes
// octais UTF-8. Montada byte a byte para não depender da codificação deste arquivo.
const DOCUMENTO_QUOTED =
  '"Prompt avan\\303\\247ado \\342\\200\\224 Engenharia reversa autorizada de plataforma SaaS.md"';

for (const [nome, entrada] of [
  ["documento protegido em forma quoted", DOCUMENTO_QUOTED],
  ["caminho Unicode quoted", '"src/exce\\303\\247\\303\\243o/page.tsx"'],
  ["quoted sem escapes", '"src/example.ts"'],
  ["barra invertida em npmrc", "apps\\web\\.npmrc"],
  ["barra invertida em secrets", "secrets\\token.txt"],
  ["barra invertida em caminho comum", "src\\example.ts"],
  ["barra invertida isolada", "a\\b"]
]) {
  test(`rejeita entrada não canônica: ${nome}`, () => {
    const result = run(fixture({ changed: `src/example.ts\n${entrada}\n` }));
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /ambíguo ou não canônico/i);
  });
}

test("mensagem de entrada não canônica não ecoa o conteúdo", () => {
  const result = run(fixture({ changed: `src/example.ts\n"src/${"SEGREDO_NAO_EXIBIR"}.ts"\n` }));
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, saida);
  assert.match(result.stderr, /ambíguo ou não canônico/i);
  assert.doesNotMatch(saida, /SEGREDO_NAO_EXIBIR/, "entrada ecoada na saída");
  assert.doesNotMatch(saida, /^\s+at\s/m, "stack trace na saída");
});

// Aspas que não delimitam a entrada inteira não são a forma quoted do Git, e um nome
// de arquivo legítimo pode contê-las. Continua permitido.
test("aceita aspas no meio do nome, que não é a forma quoted do Git", () => {
  const result = run(fixture({ changed: 'src/example.ts\nsrc/a"b.ts\n' }));
  assert.equal(result.status, 0, result.stderr);
});

// Um nome proibido em QUALQUER componente ancestral proíbe os descendentes. Padrões do
// `.gitignore` também correspondem a diretórios, e ancorar a verificação no fim do
// caminho deixaria passar tudo que estiver abaixo de um nome proibido — bastaria
// acrescentar um componente permitido ao final.
for (const caminho of [
  ".env/.env.example",
  ".env.production/.env.example",
  ".npmrc/.env.example",
  ".claude/settings.local.json/.env.example",
  "private.pem/.env.example",
  "id_rsa_backup/.env.example",
  "backups-seguro/private.key/arquivo.txt",
  // `.env.example` como DIRETÓRIO não é a exceção: a exceção vale apenas quando ele é
  // o próprio arquivo final permitido.
  ".env.example/arquivo.txt",
  ".env.example/.npmrc",
  "certs/tls.key/leia-me.md",
  "db/producao.dump/parte-01",
  "infra/.pgpass/copia.txt"
]) {
  test(`rejeita descendente de componente proibido: ${caminho}`, () => {
    const result = run(fixture({ changed: `src/example.ts\n${caminho}\n` }));
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /caminho proibido/i);
  });
}

// A reprovação não depende do tipo: um PR de spec com caminho proibido também reprova.
test("rejeita caminho proibido também em PR de spec", () => {
  const fx = fixture({
    body: "Tipo: spec\nIssue: #123\nSpec: specs/123-test.md",
    changed: "specs/123-test.md\n.npmrc\n"
  });
  const result = run(fx);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /caminho proibido/i);
});

// A mensagem declara a classe do problema e nunca o caminho: nome de arquivo privado,
// ambiente e material criptográfico não pertencem ao log público de um gate.
test("mensagem de caminho proibido não ecoa o caminho", () => {
  const result = run(fixture({ changed: `src/example.ts\nsecrets/${"SEGREDO_NAO_EXIBIR"}.pem\n` }));
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, saida);
  assert.match(result.stderr, /caminho proibido/i);
  assert.doesNotMatch(saida, /SEGREDO_NAO_EXIBIR/, "caminho ecoado na saída");
  assert.doesNotMatch(saida, /\.pem/, "extensão do caminho ecoada na saída");
  assert.doesNotMatch(saida, /^\s+at\s/m, "stack trace na saída");
});

// Controles positivos: o que é legítimo continua passando.
for (const [nome, caminho] of [
  [".env.example", ".env.example"],
  [".env.example aninhado", "apps/web/.env.example"],
  ["arquivo comum", "src/pricing/calculate.ts"],
  ["documento", "docs/architecture.md"],
  ["arquivo com env no nome", "src/environment.ts"],
  ["arquivo com key no nome", "src/keyboard.ts"],
  ["diretório parecido com backups", "src/backups-ui/page.tsx"]
]) {
  test(`aceita ${nome} na lista de alterações`, () => {
    const result = run(fixture({ changed: `src/example.ts\n${caminho}\n` }));
    assert.equal(result.status, 0, result.stderr);
  });
}

// ---------------------------------------------------------------------------------
// Critérios 68 a 71 — tipo automatizado inferido de metadados confiáveis.
//
// Spec, Item 15, linha 184: "A classificação é inferida exclusivamente dos metadados
// confiáveis do evento, entregues pelo workflow: autor, referência da branch de origem
// e repositório de origem. O campo `Tipo:` do corpo é irrelevante para essa
// classificação, porque o corpo é criado pelo próprio bot e é dado não confiável."
//
// Linha 186: "A isenção alcança somente os campos `Issue` e `Spec`."
//
// Linha 188, condições cumulativas: autor exatamente `dependabot[bot]`; branch de
// origem casando `^dependabot/`; repositório de origem idêntico ao base, com fork
// recusado mesmo que o nome da branch coincida; ecossistema `npm`; e arquivos alterados
// limitados a `package.json`, `package-lock.json` e `npm-shrinkwrap.json`.
//
// Linha 190: "Se qualquer condição falhar, o PR é reprovado imediatamente como tipo
// automatizado, sem conversão ambígua para outro fluxo."
// ---------------------------------------------------------------------------------

const REPO_BASE = "fandrade1980/sublims-os";
const CORPO_DO_BOT = "Bumps eslint from 10.9.0 to 10.10.0.\n";
const MARCADOR = "SEGREDO_NAO_EXIBIR";

function runComMetadados(fx, metadados) {
  const extra = Object.entries(metadados).flatMap(([flag, valor]) => [`--${flag}`, valor]);
  return spawnSync(
    process.execPath,
    [cli, "--trusted", fx.trusted, "--candidate", fx.candidate, "--body", fx.bodyFile, "--changed", fx.changedFileList, ...extra],
    { encoding: "utf8" }
  );
}

const METADADOS_NPM = Object.freeze({
  author: "dependabot[bot]",
  "head-ref": "dependabot/npm_and_yarn/eslint-10.10.0",
  "head-repo": REPO_BASE,
  "base-repo": REPO_BASE
});

// Linha 558 da spec: "PR npm restrito a manifesto e lockfile aceito sem Issue e Spec".
test("aceita PR automatizado npm restrito a manifesto e lockfile, sem Issue e Spec", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
  const result = runComMetadados(fx, METADADOS_NPM);
  assert.equal(result.status, 0, result.stderr);
});

test("aceita PR automatizado que altera apenas npm-shrinkwrap.json", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "npm-shrinkwrap.json\n" });
  const result = runComMetadados(fx, METADADOS_NPM);
  assert.equal(result.status, 0, result.stderr);
});

// Critério 70.
for (const [nome, lista] of [
  ["código", "package.json\npackage-lock.json\nsrc/example.ts\n"],
  ["workflow", "package.json\n.github/workflows/pr-gates.yml\n"],
  ["documentação", "package-lock.json\ndocs/architecture.md\n"],
  ["spec", "package.json\nspecs/123-test.md\n"]
]) {
  test(`reprova PR automatizado que também altera ${nome}`, () => {
    const fx = fixture({ body: CORPO_DO_BOT, changed: lista });
    const result = runComMetadados(fx, METADADOS_NPM);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /automatizad/i);
  });
}

// Critério 71 e linha 558: "PR de github-actions não isento".
test("reprova PR automatizado do ecossistema github-actions", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: ".github/workflows/pr-gates.yml\n" });
  const result = runComMetadados(fx, {
    ...METADADOS_NPM,
    "head-ref": "dependabot/github_actions/actions/checkout-7.0.1"
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /automatizad/i);
});

// Linha 188: "fork recusado mesmo que o nome da branch coincida".
test("reprova PR automatizado vindo de fork", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
  const result = runComMetadados(fx, { ...METADADOS_NPM, "head-repo": "atacante/sublims-os" });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /automatizad/i);
});

test("reprova PR automatizado com branch fora de dependabot/", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
  const result = runComMetadados(fx, { ...METADADOS_NPM, "head-ref": "feature/atualiza-eslint" });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /automatizad/i);
});

// Critério 69: nenhuma conversão para outro fluxo. Um corpo declarando
// `Tipo: implementação` não resgata um automatizado que falhou uma condição.
test("corpo com Tipo implementação não converte PR automatizado reprovado", () => {
  const fx = fixture({
    body: "Tipo: implementação\nIssue: #123\nSpec: specs/123-test.md\n\n## Evidência TDD\n\n| Fatia | Vermelho | Verde |\n|---|---|---|\n| 1 | falhou | passou |",
    changed: "package.json\nsrc/example.ts\n"
  });
  const result = runComMetadados(fx, METADADOS_NPM);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /automatizad/i);
});

// Critério 68: o campo `Tipo:` não participa da classificação.
test("corpo com Tipo spec não participa da classificação automatizada", () => {
  const fx = fixture({
    body: "Tipo: spec\nIssue: #123\nSpec: specs/123-test.md\n",
    changed: "package.json\npackage-lock.json\n"
  });
  const result = runComMetadados(fx, METADADOS_NPM);
  assert.equal(result.status, 0, result.stderr);
});

// Autor diferente do bot não é automatizado, ainda que a branch imite o padrão:
// volta ao fluxo normal, que exige Tipo, Issue e Spec.
test("autor humano com branch dependabot não vira PR automatizado", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
  const result = runComMetadados(fx, { ...METADADOS_NPM, author: "fandrade1980" });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Tipo, Issue e Spec/i);
});

// Fail-closed sobre metadados parciais: subconjunto das quatro flags não autoriza
// classificação alguma.
for (const ausente of ["author", "head-ref", "head-repo", "base-repo"]) {
  test(`reprova metadados de evento incompletos: falta --${ausente}`, () => {
    const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
    const parciais = { ...METADADOS_NPM };
    delete parciais[ausente];
    const result = runComMetadados(fx, parciais);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /metadados do evento/i);
  });
}

// Compatibilidade R1: o workflow invoca hoje com exatamente quatro argumentos.
test("sem metadados do evento, o fluxo por Tipo permanece inalterado", () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
});

// Flag repetida. A primeira ocorrência é válida e a segunda conflita: um parser que
// resolve por "a primeira vence" aceitaria a classificação afirmada pela primeira e
// ignoraria a contradição em silêncio.
test("reprova --author repetido com segunda ocorrência conflitante", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
  const result = spawnSync(
    process.execPath,
    [
      cli, "--trusted", fx.trusted, "--candidate", fx.candidate,
      "--body", fx.bodyFile, "--changed", fx.changedFileList,
      "--author", "dependabot[bot]",
      "--author", "atacante",
      "--head-ref", METADADOS_NPM["head-ref"],
      "--head-repo", REPO_BASE,
      "--base-repo", REPO_BASE
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /metadado do evento repetido/i);
});

for (const repetida of ["head-ref", "head-repo", "base-repo"]) {
  test(`reprova --${repetida} repetido`, () => {
    const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
    const extra = Object.entries(METADADOS_NPM).flatMap(([flag, valor]) => [`--${flag}`, valor]);
    const result = spawnSync(
      process.execPath,
      [
        cli, "--trusted", fx.trusted, "--candidate", fx.candidate,
        "--body", fx.bodyFile, "--changed", fx.changedFileList,
        ...extra, `--${repetida}`, METADADOS_NPM[repetida]
      ],
      { encoding: "utf8" }
    );
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /metadado do evento repetido/i);
  });
}

// Quatro flags presentes com valores vazios NÃO podem ser tratadas como ausência
// total: isso devolveria o PR ao fluxo legado exatamente quando os metadados existem e
// são inutilizáveis.
for (const [nome, vazio] of [
  ["vazios", ""],
  ["em branco", "   "],
  ["tabulação", "\t"]
]) {
  test(`reprova quatro flags de metadados com valores ${nome}`, () => {
    const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
    const result = runComMetadados(fx, {
      author: vazio,
      "head-ref": vazio,
      "head-repo": vazio,
      "base-repo": vazio
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /metadado do evento sem valor/i);
  });
}

// Flag sem valor, seguida imediatamente por outra flag: o valor capturado seria o nome
// da flag seguinte, que ainda por cima ficaria sem valor próprio.
test("reprova flag de metadado seguida imediatamente por outra flag", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
  const result = spawnSync(
    process.execPath,
    [
      cli, "--trusted", fx.trusted, "--candidate", fx.candidate,
      "--body", fx.bodyFile, "--changed", fx.changedFileList,
      "--author", "--head-ref", METADADOS_NPM["head-ref"],
      "--head-repo", REPO_BASE,
      "--base-repo", REPO_BASE
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /metadado do evento sem valor/i);
});

test("reprova flag de metadado como último argumento, sem valor", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
  const result = spawnSync(
    process.execPath,
    [
      cli, "--trusted", fx.trusted, "--candidate", fx.candidate,
      "--body", fx.bodyFile, "--changed", fx.changedFileList,
      "--head-ref", METADADOS_NPM["head-ref"],
      "--head-repo", REPO_BASE,
      "--base-repo", REPO_BASE,
      "--author"
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /metadado do evento sem valor/i);
});

// Autor humano com os quatro metadados completos e válidos: não é automatizado, e o
// fluxo normal por `Tipo:` é preservado integralmente.
test("autor humano com metadados completos segue o fluxo normal e é aceito", () => {
  const fx = fixture({ changed: "src/example.ts\n" });
  const result = runComMetadados(fx, { ...METADADOS_NPM, author: "fandrade1980" });
  assert.equal(result.status, 0, result.stderr);
});

test("falha de metadado não converte Dependabot inválido nem ecoa os valores", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\npackage-lock.json\n" });
  const result = runComMetadados(fx, {
    author: "dependabot[bot]",
    "head-ref": `dependabot/npm_and_yarn/${MARCADOR}-1.0.0`,
    "head-repo": `${MARCADOR}/repo`,
    "base-repo": `outro-${MARCADOR}/repo`
  });
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, saida);
  assert.match(result.stderr, /automatizad/i);
  assert.doesNotMatch(saida, /Tipo, Issue e Spec/i, "converteu para o fluxo legado");
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "metadado do evento ecoado na saída");
});

// A isenção alcança somente `Issue` e `Spec`. Caminho proibido continua reprovando.
test("PR automatizado com caminho proibido continua reprovando", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\n.npmrc\n" });
  const result = runComMetadados(fx, METADADOS_NPM);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /caminho proibido/i);
});

test("mensagem de PR automatizado reprovado não ecoa autor, branch nem repositório", () => {
  const fx = fixture({ body: CORPO_DO_BOT, changed: "package.json\nsrc/example.ts\n" });
  const result = runComMetadados(fx, {
    author: "dependabot[bot]",
    "head-ref": `dependabot/npm_and_yarn/${MARCADOR}-1.0.0`,
    "head-repo": `${MARCADOR}/repo`,
    "base-repo": `${MARCADOR}/repo`
  });
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, saida);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "metadado do evento ecoado na saída");
  assert.doesNotMatch(saida, /^\s+at\s/m, "stack trace na saída");
});
