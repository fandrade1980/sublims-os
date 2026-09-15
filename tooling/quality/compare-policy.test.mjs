import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve(import.meta.dirname, "compare-policy.mjs");

// Fixtures vivem fora do repositório. Por padrão cada raiz recebe `quality/` e as três
// specs mínimas usadas pelos controles; casos de ausência desligam a spec padrão de
// forma explícita. O que cada teste coloca ou sobrescreve é o que está sob exame.
function novaRaiz(nome, { comSpecPadrao = true, comPoliticaPadrao = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), `sublims-compare-${nome}-`));
  mkdirSync(join(root, "quality"), { recursive: true });
  mkdirSync(join(root, "specs"), { recursive: true });
  if (comPoliticaPadrao) {
    escrever(root, "quality/policy.json", JSON.stringify(politicaPadrao()));
  }
  if (comSpecPadrao) {
    escreverSpec(root, "specs/3-governance-hardening.md", {
      id: "3",
      issue: "github:#3",
      status: "approved"
    });
    escreverSpec(root, "specs/004-ai-engineering-system.md", {
      id: "004",
      issue: "local:tasks/004-ai-engineering-system.md",
      status: "approved"
    });
    escreverSpec(root, "specs/9-segredo-nao-exibir.md", {
      id: "9",
      issue: "github:#3",
      status: "approved"
    });
  }
  return root;
}

function politicaPadrao() {
  return {
    version: 2,
    enabled: true,
    commands: [
      { name: "typecheck", origin: "candidate", executable: "node", args: ["tsc", "--noEmit"] },
      { name: "lint", origin: "candidate", executable: "node", args: ["eslint", "src"] },
      { name: "test:coverage", origin: "candidate", executable: "node", args: ["vitest", "run"] },
      { name: "quality:complexity", origin: "base", executable: "node", args: ["eslint", "src"] },
      {
        name: "quality:dependencies",
        origin: "base",
        executable: "node",
        args: ["dependency-cruiser", "src"]
      },
      { name: "build", origin: "candidate", executable: "node", args: ["next", "build"] }
    ],
    coverage: {
      lines: 80,
      branches: 75,
      functions: 80,
      statements: 80,
      include: ["src/modules/**", "src/shared/**"],
      exclude: []
    },
    complexity: { maxCyclomaticPerFunction: 10 },
    appliesWhenChanged: ["src/**", "package.json"],
    allowedRebuilds: []
  };
}

function escreverPolitica(root, alterar = (policy) => policy) {
  const policy = politicaPadrao();
  escrever(root, "quality/policy.json", JSON.stringify(alterar(policy)));
}

function escrever(root, relativo, conteudo) {
  writeFileSync(join(root, relativo), conteudo);
}

function escreverSpec(root, relativo, metadata) {
  mkdirSync(join(root, "specs"), { recursive: true });
  escrever(root, relativo, `<!-- spec-meta\n${JSON.stringify(metadata)}\n-->\n`);
}

function executar(trusted, candidate) {
  return spawnSync(process.execPath, [cli, "--trusted", trusted, "--candidate", candidate], {
    encoding: "utf8"
  });
}

function executarArgumentos(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

// Marcador improvável em qualquer mensagem legítima. Se aparecer na saída, é porque
// um valor de `argv` foi interpolado — o que transformaria a linha de comando em
// canal de eco e vazaria o que quer que tenha sido passado.
const MARCADOR = "SEGREDO_NAO_EXIBIR";

// Saída completa: um vazamento em `stdout` não é menos vazamento que em `stderr`.
function saidaCompleta(result) {
  return `${result.stdout}${result.stderr}`;
}

// Stack trace expõe caminhos absolutos do runner e linhas internas do Node. Um gate
// que reprova deve dizer a classe do problema, não despejar o próprio interior.
function assertSemStackTrace(saida) {
  assert.doesNotMatch(saida, /^\s+at\s/m, "stack trace na saída");
  assert.doesNotMatch(saida, /node:internal/, "quadro interno do Node na saída");
}

// Reprovação de interface: código não-zero, mensagem da classe esperada, nenhum eco
// do marcador e nenhum stack trace. A regex é sempre específica da classe.
function assertReprovaInterface(result, padraoDaClasse) {
  const saida = saidaCompleta(result);
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, padraoDaClasse);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "marcador secreto ecoado na saída");
  assertSemStackTrace(saida);
}

// Arranjo repetido dos casos de registro inválido: monta as duas raízes, grava o
// conteúdo sob exame na confiável, executa e exige reprovação com a mensagem da
// classe. As asserções são as mesmas de antes, com a mesma especificidade.
function assertRegistroInvalido(prefixo, conteudo, padraoDaClasse) {
  const trusted = novaRaiz(prefixo);
  const candidate = novaRaiz("candidate");
  escrever(trusted, "quality/policy-exceptions.json", conteudo);
  const result = executar(trusted, candidate);
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${result.stdout}`);
  assert.match(result.stderr, padraoDaClasse);
}

test("argumento posicional com marcador reprova sem ecoar o marcador", () => {
  const trusted = novaRaiz("trusted-posicional");
  const candidate = novaRaiz("candidate");
  const result = executarArgumentos(["--trusted", trusted, "--candidate", candidate, MARCADOR]);
  assertReprovaInterface(result, /argumento posicional não é aceito/i);
});

test("argumento desconhecido com marcador reprova sem ecoar o marcador", () => {
  const trusted = novaRaiz("trusted-desconhecido");
  const candidate = novaRaiz("candidate");
  const result = executarArgumentos([
    "--trusted",
    trusted,
    "--candidate",
    candidate,
    `--${MARCADOR}`
  ]);
  assertReprovaInterface(result, /argumento desconhecido/i);
});

test("--trusted repetido reprova", () => {
  const trusted = novaRaiz("trusted-repetido");
  const candidate = novaRaiz("candidate");
  const result = executarArgumentos([
    "--trusted",
    trusted,
    "--trusted",
    trusted,
    "--candidate",
    candidate
  ]);
  assertReprovaInterface(result, /argumento repetido: --trusted/i);
});

test("--candidate repetido reprova", () => {
  const trusted = novaRaiz("trusted-candidate-repetido");
  const candidate = novaRaiz("candidate");
  const result = executarArgumentos([
    "--trusted",
    trusted,
    "--candidate",
    candidate,
    "--candidate",
    candidate
  ]);
  assertReprovaInterface(result, /argumento repetido: --candidate/i);
});

test("--trusted sem valor ao final da linha reprova", () => {
  const result = executarArgumentos(["--trusted"]);
  assertReprovaInterface(result, /--trusted exige um valor/i);
});

test("--trusted seguido de outra flag reprova", () => {
  const candidate = novaRaiz("candidate");
  const result = executarArgumentos(["--trusted", "--candidate", candidate]);
  assertReprovaInterface(result, /--trusted exige um valor/i);
});

test("--trusted com valor em branco reprova", () => {
  const candidate = novaRaiz("candidate");
  const result = executarArgumentos(["--trusted", "   ", "--candidate", candidate]);
  assertReprovaInterface(result, /--trusted exige um valor/i);
});

test("--candidate com valor em branco reprova", () => {
  const trusted = novaRaiz("trusted-candidate-branco");
  const result = executarArgumentos(["--trusted", trusted, "--candidate", "\t"]);
  assertReprovaInterface(result, /--candidate exige um valor/i);
});

test("ausência de --trusted reprova", () => {
  const candidate = novaRaiz("candidate");
  const result = executarArgumentos(["--candidate", candidate]);
  assertReprovaInterface(result, /--trusted é obrigatório/i);
});

test("ausência de --candidate reprova", () => {
  const trusted = novaRaiz("trusted-sem-candidate");
  const result = executarArgumentos(["--trusted", trusted]);
  assertReprovaInterface(result, /--candidate é obrigatório/i);
});

test("sem argumento algum reprova", () => {
  const result = executarArgumentos([]);
  assertReprovaInterface(result, /--trusted é obrigatório/i);
});

test("sucesso do comparador produz exatamente a mensagem de política compatível", () => {
  const trusted = novaRaiz("trusted-mensagem");
  const candidate = novaRaiz("candidate");
  escrever(trusted, "quality/policy-exceptions.json", '{"version":1,"exceptions":[]}');
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Política candidata compatível com a política confiável.\n");
  assert.equal(result.stderr, "");
});

test("registro de exceções ausente na raiz confiável reprova; ausência não é aprovação", () => {
  const trusted = novaRaiz("trusted-sem-registro");
  const candidate = novaRaiz("candidate");
  const result = executar(trusted, candidate);
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${result.stdout}`);
  assert.match(result.stderr, /registro de exceções ausente ou ilegível/i);
});

// Registro vazio é válido e significa NENHUMA autorização. É o oposto de aprovação
// por enumeração vazia: nada está autorizado, e qualquer afrouxamento reprovará
// quando os detectores existirem.
test("registro vazio e válido carrega e não reprova", () => {
  const trusted = novaRaiz("trusted-registro-vazio");
  const candidate = novaRaiz("candidate");
  escrever(trusted, "quality/policy-exceptions.json", '{"version":1,"exceptions":[]}');
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
});

test("registro que não é JSON válido reprova", () => {
  assertRegistroInvalido("trusted-json-invalido", "{version: 1,}", /não é JSON válido/i);
});

// Forma da raiz. Array, `null` e primitivo carregam sem erro em `JSON.parse` e
// passariam despercebidos se a forma não fosse afirmada.
for (const [nome, conteudo] of [
  ["array", "[]"],
  ["null", "null"],
  ["número", "1"],
  ["string", '"version"'],
  ["booleano", "true"]
]) {
  test(`raiz do registro como ${nome} reprova`, () => {
    assertRegistroInvalido("trusted-raiz", conteudo, /não é um objeto simples/i);
  });
}

// Conjunto de chaves exato, sem ausências e sem extras. A ORDEM não participa.
for (const [nome, conteudo] of [
  ["chave desconhecida", '{"version":1,"exceptions":[],"allow":true}'],
  ["version ausente", '{"exceptions":[]}'],
  ["exceptions ausente", '{"version":1}'],
  ["objeto vazio", "{}"]
]) {
  test(`registro com ${nome} reprova`, () => {
    assertRegistroInvalido("trusted-chaves", conteudo, /conjunto de chaves inválido/i);
  });
}

test("conjunto correto de chaves em ordem diferente é aceito", () => {
  const trusted = novaRaiz("trusted-ordem-chaves");
  const candidate = novaRaiz("candidate");
  escrever(trusted, "quality/policy-exceptions.json", '{"exceptions":[],"version":1}');
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
});

// `version` é comparada por identidade estrita. `1.0` NÃO entra aqui: em JSON é o
// mesmo número que `1` e deve ser aceito. Os casos realmente distintos são `"1"`,
// `true`, `null`, `0` e vizinhos como `1.0000000000000002`.
for (const [nome, conteudo] of [
  ["version 2", '{"version":2,"exceptions":[]}'],
  ["version textual", '{"version":"1","exceptions":[]}'],
  ["version nula", '{"version":null,"exceptions":[]}'],
  ["version zero", '{"version":0,"exceptions":[]}']
]) {
  test(`registro com ${nome} reprova`, () => {
    assertRegistroInvalido("trusted-version", conteudo, /`version` não suportada/i);
  });
}

// Controle positivo que sustenta o comentário acima: `1.0` e `1e0` são notações do
// mesmo número que `1`, e a identidade estrita os aceita.
for (const [nome, conteudo] of [
  ["1.0", '{"version":1.0,"exceptions":[]}'],
  ["1e0", '{"version":1e0,"exceptions":[]}']
]) {
  test(`registro com version escrita como ${nome} é aceito`, () => {
    const trusted = novaRaiz("trusted-version-notacao");
    const candidate = novaRaiz("candidate");
    escrever(trusted, "quality/policy-exceptions.json", conteudo);
    const result = executar(trusted, candidate);
    assert.equal(result.status, 0, result.stderr);
  });
}

for (const [nome, conteudo] of [
  ["objeto", '{"version":1,"exceptions":{}}'],
  ["null", '{"version":1,"exceptions":null}'],
  ["string", '{"version":1,"exceptions":""}'],
  ["número", '{"version":1,"exceptions":0}']
]) {
  test(`registro com exceptions como ${nome} reprova`, () => {
    assertRegistroInvalido("trusted-exceptions", conteudo, /`exceptions` não é um array/i);
  });
}

// Unilateralidade: o registro do candidato não é consultado, nem para bem nem para
// mal. Um registro candidato impecável não supre a ausência do confiável.
test("registro presente somente na raiz candidata não supre o registro confiável", () => {
  const trusted = novaRaiz("trusted-sem-registro-2");
  const candidate = novaRaiz("candidate-com-registro");
  escrever(candidate, "quality/policy-exceptions.json", '{"version":1,"exceptions":[]}');
  const result = executar(trusted, candidate);
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${result.stdout}`);
  assert.match(result.stderr, /registro de exceções ausente ou ilegível/i);
});

// ---------------------------------------------------------------------------------
// Forma estrutural das entradas de `exceptions`.
//
// Nesta fatia os valores são apenas DADOS: nada aqui afirma que `coverage.branches`
// é um alvo reconhecido, que `70` é um limiar plausível ou que a spec existe. O que
// está sob exame é exclusivamente a forma — objeto simples e conjunto exato de sete
// propriedades próprias.
// ---------------------------------------------------------------------------------

const ENTRADA_ESTRUTURAL = Object.freeze({
  id: "exemplo",
  spec: "specs/3-governance-hardening.md",
  issue: "github:#3",
  changeClass: "coverage-threshold-lowered",
  target: "coverage.branches",
  value: 70,
  expiresOn: "2099-12-31"
});

const CAMPOS_DA_ENTRADA = Object.freeze([
  "id",
  "spec",
  "issue",
  "changeClass",
  "target",
  "value",
  "expiresOn"
]);

function registroCom(exceptions) {
  return JSON.stringify({ version: 1, exceptions });
}

function entradaSem(campo) {
  const copia = { ...ENTRADA_ESTRUTURAL };
  delete copia[campo];
  return copia;
}

// A entrada precisa ser objeto simples. `null` tem `typeof "object"`, e array também:
// os dois atravessariam uma checagem ingênua de tipo e chegariam à validação de
// campos como se fossem entradas legítimas.
for (const [nome, entrada] of [
  ["null", null],
  ["array", []],
  ["string", "exemplo"],
  ["número", 1],
  ["booleano", true]
]) {
  test(`entrada de exceptions como ${nome} reprova`, () => {
    assertRegistroInvalido(
      "trusted-entrada-forma",
      registroCom([entrada]),
      /entrada 0 de `exceptions` não é um objeto simples/i
    );
  });
}

// Ausência isolada de cada campo. Um campo faltante não pode ser lido como "não se
// aplica": sete campos obrigatórios significa sete, sempre.
for (const campo of CAMPOS_DA_ENTRADA) {
  test(`entrada sem \`${campo}\` reprova`, () => {
    assertRegistroInvalido(
      "trusted-entrada-campo",
      registroCom([entradaSem(campo)]),
      /entrada 0 de `exceptions` com conjunto de chaves inválido/i
    );
  });
}

test("entrada com chave desconhecida reprova", () => {
  assertRegistroInvalido(
    "trusted-entrada-extra",
    registroCom([{ ...ENTRADA_ESTRUTURAL, forever: true }]),
    /entrada 0 de `exceptions` com conjunto de chaves inválido/i
  );
});

test("entrada sem campo algum reprova", () => {
  assertRegistroInvalido(
    "trusted-entrada-vazia",
    registroCom([{}]),
    /entrada 0 de `exceptions` com conjunto de chaves inválido/i
  );
});

// A mensagem identifica a posição. Com a entrada defeituosa na posição 1, nada pode
// apontar para a 0, que está íntegra.
test("a posição reportada é a da entrada defeituosa", () => {
  assertRegistroInvalido(
    "trusted-entrada-posicao",
    registroCom([ENTRADA_ESTRUTURAL, entradaSem("expiresOn")]),
    /entrada 1 de `exceptions` com conjunto de chaves inválido/i
  );
});

test("ordem das sete chaves não participa da validade", () => {
  const trusted = novaRaiz("trusted-entrada-ordem");
  const candidate = novaRaiz("candidate");
  // Reconstruída de trás para frente: mesmo conjunto, ordem invertida.
  const invertida = Object.fromEntries(
    [...CAMPOS_DA_ENTRADA].reverse().map((campo) => [campo, ENTRADA_ESTRUTURAL[campo]])
  );
  assert.deepEqual(Object.keys(invertida), [...CAMPOS_DA_ENTRADA].reverse());
  escrever(trusted, "quality/policy-exceptions.json", registroCom([invertida]));
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
});

test("duas entradas estruturalmente válidas são aceitas", () => {
  const trusted = novaRaiz("trusted-entrada-dupla");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([
      ENTRADA_ESTRUTURAL,
      { ...ENTRADA_ESTRUTURAL, id: "outro", target: "coverage.lines" }
    ])
  );
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
});

// Nenhum conteúdo do registro pode vazar na saída. `id`, `spec`, `issue`, `target` e
// `value` são dados sob revisão, não material de log de gate.
test("mensagem de entrada inválida não ecoa conteúdo do registro", () => {
  const trusted = novaRaiz("trusted-entrada-eco");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([
      {
        id: MARCADOR,
        spec: `specs/9-${MARCADOR}.md`,
        issue: `github:#${MARCADOR}`,
        changeClass: MARCADOR,
        target: MARCADOR,
        value: MARCADOR,
        expiresOn: MARCADOR,
        [MARCADOR]: MARCADOR
      }
    ])
  );
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, /entrada 0 de `exceptions` com conjunto de chaves inválido/i);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "conteúdo do registro ecoado na saída");
  assertSemStackTrace(saida);
});

// ---------------------------------------------------------------------------------
// Contrato e unicidade de `id`.
//
// A ausência do campo já é coberta pela fatia da forma estrutural; aqui o campo está
// presente e o que se examina é o seu conteúdo.
// ---------------------------------------------------------------------------------

function comId(id) {
  return { ...ENTRADA_ESTRUTURAL, id };
}

// Tipos que não são string. Nenhuma coerção: `1` não vira `"1"`, e um objeto com
// `toString` útil não vira identificador.
for (const [nome, id] of [
  ["null", null],
  ["número", 1],
  ["booleano", true],
  ["array", ["a"]],
  ["objeto", { valor: "a" }]
]) {
  test(`id como ${nome} reprova`, () => {
    assertRegistroInvalido(
      "trusted-id-tipo",
      registroCom([comId(id)]),
      /entrada 0 de `exceptions` com `id` inválido/i
    );
  });
}

// Formato. Nenhum recorte e nenhuma normalização: `" a "` é inválido, não vira `"a"`.
for (const [nome, id] of [
  ["string vazia", ""],
  ["somente espaços", "   "],
  ["espaços nas extremidades", " a "],
  ["letra maiúscula", "Abc"],
  ["caractere acentuado", "exceção"],
  ["underscore", "a_b"],
  ["hífen inicial", "-a"],
  ["hífen final", "a-"],
  ["hífen duplo", "a--b"],
  ["ponto", "a.b"],
  ["barra", "a/b"],
  ["acima de 64 caracteres", "a".repeat(65)]
]) {
  test(`id com ${nome} reprova`, () => {
    assertRegistroInvalido(
      "trusted-id-formato",
      registroCom([comId(id)]),
      /entrada 0 de `exceptions` com `id` inválido/i
    );
  });
}

// Unicidade textual. Demais campos diferentes não tornam dois `id` iguais aceitáveis:
// é o identificador que precisa ser único.
test("dois registros com o mesmo id reprovam, ainda que os demais campos difiram", () => {
  assertRegistroInvalido(
    "trusted-id-duplicado",
    registroCom([
      comId("repetido"),
      { ...comId("repetido"), target: "coverage.lines", value: 60, expiresOn: "2098-01-01" }
    ]),
    /entrada 1 de `exceptions` com `id` duplicado/i
  );
});

// Valores distintos de propósito: sem eles as três entradas formariam a mesma tripla
// canônica e a reprovação viria da unicidade da autorização, não da unicidade de `id`.
// O `id` é verificado antes da tripla, então a posição 2 acusa `id` duplicado.
test("duplicata em posições não adjacentes reprova, apontando a posição repetida", () => {
  assertRegistroInvalido(
    "trusted-id-duplicado-distante",
    registroCom([
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "alfa"),
      comValor("coverage-threshold-lowered", "coverage.lines", 60, "beta"),
      comValor("coverage-threshold-lowered", "coverage.lines", 50, "alfa")
    ]),
    /entrada 2 de `exceptions` com `id` duplicado/i
  );
});

test("mensagem de id inválido não ecoa o identificador", () => {
  const trusted = novaRaiz("trusted-id-eco");
  const candidate = novaRaiz("candidate");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([comId(`A_${MARCADOR}`)]));
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, /entrada 0 de `exceptions` com `id` inválido/i);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "identificador ecoado na saída");
  assertSemStackTrace(saida);
});

test("mensagem de id duplicado não ecoa o identificador", () => {
  const trusted = novaRaiz("trusted-id-eco-dup");
  const candidate = novaRaiz("candidate");
  const id = MARCADOR.toLowerCase().replace(/_/g, "-");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([comId(id), comId(id)]));
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, /entrada 1 de `exceptions` com `id` duplicado/i);
  assert.doesNotMatch(saida, new RegExp(id), "identificador ecoado na saída");
  assertSemStackTrace(saida);
});

// Controles positivos.
function assertRegistroAceito(prefixo, conteudo) {
  const trusted = novaRaiz(prefixo);
  const candidate = novaRaiz("candidate");
  escrever(trusted, "quality/policy-exceptions.json", conteudo);
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
}

for (const [nome, id] of [
  ["um caractere", "a"],
  ["um dígito", "7"],
  ["exatamente 64 caracteres", "a".repeat(64)],
  ["kebab-case com letras e números", "pr-5-coverage-branches-2"],
  ["segmentos numéricos", "3-004-2"]
]) {
  test(`id com ${nome} é aceito`, () => {
    assertRegistroAceito("trusted-id-valido", registroCom([comId(id)]));
  });
}

test("duas entradas com ids distintos são aceitas", () => {
  assertRegistroAceito(
    "trusted-id-distintos",
    registroCom([
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "alfa"),
      comValor("coverage-threshold-lowered", "coverage.lines", 60, "beta")
    ])
  );
});

// Ordenação do array continua sendo matéria editorial: `zeta` antes de `alfa` é
// legítimo e não altera autorização alguma.
test("array em ordem não alfabética é aceito", () => {
  assertRegistroAceito(
    "trusted-id-desordenado",
    registroCom([
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "zeta"),
      comValor("coverage-threshold-lowered", "coverage.lines", 60, "alfa"),
      comValor("coverage-threshold-lowered", "coverage.lines", 50, "meio")
    ])
  );
});

// ---------------------------------------------------------------------------------
// Conjunto fechado de `changeClass` e alvos permitidos por classe.
//
// Esta seção isola classe e alvo: cada caso usa um `value` já válido PARA A CLASSE sob
// exame, de modo que o veredito dependa apenas de a classe pertencer ao conjunto
// fechado e de o alvo ser admissível para ela. O contrato de `value` — tipo, faixa e
// canonicalização — é exercitado adiante, na seção própria deste mesmo arquivo.
// ---------------------------------------------------------------------------------

// Um `value` válido por classe, para que os controles positivos de classe e alvo não
// dependam de `value` continuar sem validação.
const VALOR_VALIDO_POR_CLASSE = Object.freeze({
  "enabled-disabled": false,
  "coverage-threshold-lowered": 70,
  "complexity-max-raised": 25,
  "coverage-exclusion-added": "src/legacy/**",
  "canonical-pattern-removed": ".npmrc",
  "allowed-rebuild-added": "esbuild"
});

function valorValidoPara(changeClass) {
  return Object.hasOwn(VALOR_VALIDO_POR_CLASSE, changeClass)
    ? VALOR_VALIDO_POR_CLASSE[changeClass]
    : 70;
}

function comClasseEAlvo(changeClass, target, id = "exemplo") {
  return { ...ENTRADA_ESTRUTURAL, id, changeClass, target, value: valorValidoPara(changeClass) };
}

function comValor(changeClass, target, value, id = "exemplo") {
  return { ...ENTRADA_ESTRUTURAL, id, changeClass, target, value };
}

const COMBINACOES_VALIDAS = Object.freeze([
  ["enabled-disabled", "enabled"],
  ["coverage-threshold-lowered", "coverage.lines"],
  ["coverage-threshold-lowered", "coverage.branches"],
  ["coverage-threshold-lowered", "coverage.functions"],
  ["coverage-threshold-lowered", "coverage.statements"],
  ["complexity-max-raised", "complexity.maxCyclomaticPerFunction"],
  ["coverage-exclusion-added", "coverage.exclude"],
  ["canonical-pattern-removed", "appliesWhenChanged"],
  ["allowed-rebuild-added", "allowedRebuilds"]
]);

// `changeClass` não textual. Nenhuma coerção: um objeto com `toString` conveniente
// não se torna uma classe reconhecida.
for (const [nome, classe] of [
  ["null", null],
  ["número", 1],
  ["booleano", true],
  ["array", ["enabled-disabled"]],
  ["objeto", { valor: "enabled-disabled" }]
]) {
  test(`changeClass como ${nome} reprova`, () => {
    assertRegistroInvalido(
      "trusted-classe-tipo",
      registroCom([comClasseEAlvo(classe, "enabled")]),
      /entrada 0 de `exceptions` com `changeClass` desconhecida/i
    );
  });
}

// Forma textual. Sem `trim`, sem normalização Unicode, sem comparação sem distinção
// de caixa: a classe é reconhecida pelo que está escrito, exatamente.
for (const [nome, classe] of [
  ["string vazia", ""],
  ["somente espaços", "   "],
  ["espaço à esquerda", " enabled-disabled"],
  ["espaço à direita", "enabled-disabled "],
  ["caixa alta", "ENABLED-DISABLED"],
  ["caixa mista", "Enabled-Disabled"],
  ["valor desconhecido", "gate-disabled"],
  ["underscore no lugar do hífen", "enabled_disabled"],
  ["nome quase igual", "enabled-disable"]
]) {
  test(`changeClass com ${nome} reprova`, () => {
    assertRegistroInvalido(
      "trusted-classe-forma",
      registroCom([comClasseEAlvo(classe, "enabled")]),
      /entrada 0 de `exceptions` com `changeClass` desconhecida/i
    );
  });
}

// Diferenças de COMANDO nunca são excetuáveis. Não existe classe para elas, e tentar
// criá-la reprova como classe desconhecida — não como alvo inválido.
for (const classe of [
  "command-args-changed",
  "command-removed",
  "command-reordered",
  "command-executable-changed",
  "command-origin-changed"
]) {
  test(`classe de alteração de comando \`${classe}\` reprova como classe desconhecida`, () => {
    assertRegistroInvalido(
      "trusted-classe-comando",
      registroCom([comClasseEAlvo(classe, "commands")]),
      /entrada 0 de `exceptions` com `changeClass` desconhecida/i
    );
  });
}

// Classe desconhecida reprova COMO classe, qualquer que seja o alvo — inclusive um
// alvo perfeitamente válido para outra classe.
for (const alvo of ["enabled", "coverage.branches", "allowedRebuilds", "inexistente"]) {
  test(`classe desconhecida com alvo \`${alvo}\` reprova como classe, não como alvo`, () => {
    assertRegistroInvalido(
      "trusted-classe-precede",
      registroCom([comClasseEAlvo("classe-inexistente", alvo)]),
      /entrada 0 de `exceptions` com `changeClass` desconhecida/i
    );
  });
}

// `target` não textual.
for (const [nome, alvo] of [
  ["null", null],
  ["número", 1],
  ["booleano", true],
  ["array", ["enabled"]],
  ["objeto", { valor: "enabled" }]
]) {
  test(`target como ${nome} reprova`, () => {
    assertRegistroInvalido(
      "trusted-alvo-tipo",
      registroCom([comClasseEAlvo("enabled-disabled", alvo)]),
      /entrada 0 de `exceptions` com `target` inválido para a classe/i
    );
  });
}

for (const [nome, alvo] of [
  ["string vazia", ""],
  ["somente espaços", "   "],
  ["espaço à esquerda", " enabled"],
  ["espaço à direita", "enabled "],
  ["caixa alta", "ENABLED"],
  ["caixa mista", "Enabled"],
  ["valor desconhecido", "gates.enabled"],
  ["nome quase igual", "enable"]
]) {
  test(`target com ${nome} reprova`, () => {
    assertRegistroInvalido(
      "trusted-alvo-forma",
      registroCom([comClasseEAlvo("enabled-disabled", alvo)]),
      /entrada 0 de `exceptions` com `target` inválido para a classe/i
    );
  });
}

// Alvos cruzados: cada um é legítimo para OUTRA classe, e por isso mesmo reprova.
for (const [classe, alvo] of [
  ["enabled-disabled", "coverage.branches"],
  ["enabled-disabled", "allowedRebuilds"],
  ["coverage-threshold-lowered", "enabled"],
  ["coverage-threshold-lowered", "coverage.exclude"],
  ["coverage-threshold-lowered", "complexity.maxCyclomaticPerFunction"],
  ["complexity-max-raised", "coverage.lines"],
  ["coverage-exclusion-added", "appliesWhenChanged"],
  ["canonical-pattern-removed", "coverage.exclude"],
  ["allowed-rebuild-added", "appliesWhenChanged"]
]) {
  test(`alvo \`${alvo}\` não é aceito na classe \`${classe}\``, () => {
    assertRegistroInvalido(
      "trusted-alvo-cruzado",
      registroCom([comClasseEAlvo(classe, alvo)]),
      /entrada 0 de `exceptions` com `target` inválido para a classe/i
    );
  });
}

test("mensagem de classe desconhecida não ecoa a classe recebida", () => {
  const trusted = novaRaiz("trusted-classe-eco");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([comClasseEAlvo(MARCADOR, `${MARCADOR}-alvo`)])
  );
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, /entrada 0 de `exceptions` com `changeClass` desconhecida/i);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "classe ou alvo ecoados na saída");
  assertSemStackTrace(saida);
});

test("mensagem de alvo inválido não ecoa o alvo recebido", () => {
  const trusted = novaRaiz("trusted-alvo-eco");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([comClasseEAlvo("enabled-disabled", MARCADOR)])
  );
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, /entrada 0 de `exceptions` com `target` inválido para a classe/i);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "alvo ecoado na saída");
  assertSemStackTrace(saida);
});

// As nove combinações válidas, uma a uma.
for (const [classe, alvo] of COMBINACOES_VALIDAS) {
  test(`combinação válida \`${classe}\` → \`${alvo}\` é aceita`, () => {
    assertRegistroAceito("trusted-combinacao", registroCom([comClasseEAlvo(classe, alvo)]));
  });
}

test("múltiplas entradas válidas em ordem não alfabética são aceitas", () => {
  assertRegistroAceito(
    "trusted-combinacoes-desordenadas",
    registroCom([
      comClasseEAlvo("enabled-disabled", "enabled", "zeta"),
      comClasseEAlvo("allowed-rebuild-added", "allowedRebuilds", "alfa"),
      comClasseEAlvo("coverage-threshold-lowered", "coverage.statements", "meio")
    ])
  );
});

// Mesma classe e mesmo alvo continuam aceitos quando os VALORES canônicos diferem:
// é a tripla que precisa ser única, não o par classe/alvo.
//
// Este teste substitui o provisório "ids distintos com a mesma classe e o mesmo alvo
// continuam aceitos nesta fatia", que usava o mesmo valor. Aquele comportamento era
// consequência da unicidade da tripla ainda não existir, e passa a ser proibido pelo
// teste seguinte. A cobertura não foi removida: foi desdobrada nos dois casos.
test("ids distintos com mesma classe e alvo, mas valores diferentes, são aceitos", () => {
  assertRegistroAceito(
    "trusted-mesma-combinacao-valores-distintos",
    registroCom([
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "primeiro"),
      comValor("coverage-threshold-lowered", "coverage.lines", 60, "segundo")
    ])
  );
});

// ---------------------------------------------------------------------------------
// Contrato e canonicalização de `value`.
//
// `value` é sempre o valor candidato RESULTANTE, nunca um delta. Uma entrada declara
// "o limiar passou a ser 70", não "o limiar caiu 5".
// ---------------------------------------------------------------------------------

const PADRAO_VALOR_INVALIDO = /entrada 0 de `exceptions` com `value` inválido para a classe/i;

function assertValorInvalido(prefixo, changeClass, target, value) {
  assertRegistroInvalido(prefixo, registroCom([comValor(changeClass, target, value)]), PADRAO_VALOR_INVALIDO);
}

function assertValorAceito(prefixo, changeClass, target, value) {
  assertRegistroAceito(prefixo, registroCom([comValor(changeClass, target, value)]));
}

// --- enabled-disabled: exclusivamente o booleano `false` ---
//
// `"false"`, `0` e `null` são falsos por coerção. É exatamente por isso que precisam
// ser recusados: com coerção, três valores distintos viram a mesma autorização.
for (const [nome, valor] of [
  ["true", true],
  ["string false", "false"],
  ["zero", 0],
  ["null", null],
  ["string vazia", ""],
  ["array", []],
  ["objeto", {}],
  ["número 1", 1]
]) {
  test(`enabled-disabled com value ${nome} reprova`, () => {
    assertValorInvalido("trusted-valor-enabled", "enabled-disabled", "enabled", valor);
  });
}

// --- coverage-threshold-lowered: inteiro de 0 a 100 ---
for (const [nome, valor] of [
  ["negativo", -1],
  ["acima de 100", 101],
  ["ponto flutuante", 1.5],
  ["string numérica", "70"],
  ["booleano", true],
  ["null", null],
  ["array", [70]],
  ["objeto", { valor: 70 }]
]) {
  test(`coverage-threshold-lowered com value ${nome} reprova`, () => {
    assertValorInvalido("trusted-valor-cobertura", "coverage-threshold-lowered", "coverage.lines", valor);
  });
}

// --- complexity-max-raised: inteiro SEGURO maior ou igual a 1 ---
//
// Acima de `Number.MAX_SAFE_INTEGER`, números JSON distintos colapsam para o mesmo
// valor em JavaScript. A correspondência exata exigida pela spec deixaria de existir:
// duas autorizações diferentes passariam a casar o mesmo afrouxamento.
for (const [nome, valor] of [
  ["zero", 0],
  ["negativo", -1],
  ["ponto flutuante", 1.5],
  ["string numérica", "25"],
  ["booleano", true],
  ["null", null],
  ["acima do inteiro seguro", 9007199254740993],
  ["muito acima do inteiro seguro", 1e300]
]) {
  test(`complexity-max-raised com value ${nome} reprova`, () => {
    assertValorInvalido(
      "trusted-valor-complexidade",
      "complexity-max-raised",
      "complexity.maxCyclomaticPerFunction",
      valor
    );
  });
}

// --- classes de glob: string não vazia após NFC e recorte ---
for (const [classe, alvo] of [
  ["coverage-exclusion-added", "coverage.exclude"],
  ["canonical-pattern-removed", "appliesWhenChanged"]
]) {
  for (const [nome, valor] of [
    ["não string", 1],
    ["null", null],
    ["booleano", true],
    ["array", ["src/**"]],
    ["objeto", { valor: "src/**" }],
    ["string vazia", ""],
    ["somente espaços", "   "],
    ["somente tabulação e quebra", "\t\n"]
  ]) {
    test(`${classe} com value ${nome} reprova`, () => {
      assertValorInvalido("trusted-valor-glob", classe, alvo, valor);
    });
  }
}

// --- allowed-rebuild-added: nome de pacote npm em forma canônica ---
for (const [nome, valor] of [
  ["não string", 1],
  ["null", null],
  ["booleano", true],
  ["array", ["esbuild"]],
  ["objeto", { valor: "esbuild" }],
  ["string vazia", ""],
  ["somente espaços", "   "],
  ["espaço à esquerda", " esbuild"],
  ["espaço à direita", "esbuild "],
  ["maiúscula", "ESBuild"],
  ["URL", "https://registry.npmjs.org/esbuild"],
  ["caminho com barra fora de escopo", "node_modules/esbuild"],
  ["travessia", "../esbuild"],
  ["travessia com escopo", "@org/../esbuild"],
  ["escopo incompleto", "@org"],
  ["escopo sem nome", "@org/"],
  ["escopo sem arroba", "org/esbuild"],
  ["ponto inicial", ".esbuild"],
  ["underscore inicial", "_esbuild"]
]) {
  test(`allowed-rebuild-added com value ${nome} reprova`, () => {
    assertValorInvalido("trusted-valor-pacote", "allowed-rebuild-added", "allowedRebuilds", valor);
  });
}

// `-0` exige JSON literal. `JSON.stringify(-0)` produz `"0"`, então uma fixture
// construída por serialização entregaria `0` — limiar perfeitamente válido — e o teste
// exercitaria outra coisa. `JSON.parse("-0")` produz `-0` de verdade, e é assim que um
// registro escrito à mão pode conter o valor.
for (const [classe, alvo] of [
  ["coverage-threshold-lowered", "coverage.lines"],
  ["complexity-max-raised", "complexity.maxCyclomaticPerFunction"]
]) {
  test(`${classe} com value menos zero literal reprova`, () => {
    const bruto = JSON.stringify({
      version: 1,
      exceptions: [comValor(classe, alvo, 0)]
    }).replace('"value":0', '"value":-0');
    assert.match(bruto, /"value":-0/, "a fixture precisa conter o literal -0");
    assert.ok(Object.is(JSON.parse(bruto).exceptions[0].value, -0), "o literal precisa produzir -0");
    assertRegistroInvalido("trusted-valor-menos-zero", bruto, PADRAO_VALOR_INVALIDO);
  });
}

// Ausência de eco. Glob e nome de pacote carregam conteúdo do candidato — caminhos,
// nomes internos — e não pertencem ao log de um gate.
test("mensagem de glob inválido não ecoa o padrão recebido", () => {
  const trusted = novaRaiz("trusted-valor-glob-eco");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    // Um glob TEXTUAL contendo o marcador seria válido; para que o caso seja inválido
    // e ainda carregue o marcador, o valor precisa ser não textual.
    registroCom([
      comValor("coverage-exclusion-added", "coverage.exclude", { [MARCADOR]: `src/${MARCADOR}/**` })
    ])
  );
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, PADRAO_VALOR_INVALIDO);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "padrão ecoado na saída");
  assertSemStackTrace(saida);
});

test("mensagem de pacote inválido não ecoa o nome recebido", () => {
  const trusted = novaRaiz("trusted-valor-pacote-eco");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([comValor("allowed-rebuild-added", "allowedRebuilds", `https://x/${MARCADOR}`)])
  );
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, PADRAO_VALOR_INVALIDO);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "nome de pacote ecoado na saída");
  assertSemStackTrace(saida);
});

// Precedência: classe e alvo continuam reprovando ANTES de `value`. Um `value`
// absurdo não muda o diagnóstico quando a classe já é desconhecida.
test("classe desconhecida reprova como classe mesmo com value absurdo", () => {
  assertRegistroInvalido(
    "trusted-precedencia-classe",
    registroCom([comValor("classe-inexistente", "enabled", { qualquer: "coisa" })]),
    /entrada 0 de `exceptions` com `changeClass` desconhecida/i
  );
});

test("alvo cruzado reprova como alvo mesmo com value absurdo", () => {
  assertRegistroInvalido(
    "trusted-precedencia-alvo",
    registroCom([comValor("enabled-disabled", "coverage.lines", { qualquer: "coisa" })]),
    /entrada 0 de `exceptions` com `target` inválido para a classe/i
  );
});

// --- controles positivos ---
for (const [nome, classe, alvo, valor] of [
  ["enabled-disabled com false", "enabled-disabled", "enabled", false],
  ["cobertura em 0", "coverage-threshold-lowered", "coverage.lines", 0],
  ["cobertura em 100", "coverage-threshold-lowered", "coverage.statements", 100],
  ["cobertura intermediária", "coverage-threshold-lowered", "coverage.branches", 75],
  ["complexidade em 1", "complexity-max-raised", "complexity.maxCyclomaticPerFunction", 1],
  [
    "complexidade no maior inteiro seguro",
    "complexity-max-raised",
    "complexity.maxCyclomaticPerFunction",
    Number.MAX_SAFE_INTEGER
  ],
  ["glob simples", "coverage-exclusion-added", "coverage.exclude", "src/legacy/**"],
  ["glob com espaços periféricos", "coverage-exclusion-added", "coverage.exclude", "  src/legacy/**  "],
  ["padrão canônico", "canonical-pattern-removed", "appliesWhenChanged", ".npmrc"],
  ["pacote simples", "allowed-rebuild-added", "allowedRebuilds", "esbuild"],
  ["pacote com escopo", "allowed-rebuild-added", "allowedRebuilds", "@org/ferramenta"],
  ["pacote com ponto e hífen internos", "allowed-rebuild-added", "allowedRebuilds", "node-gyp.build"]
]) {
  test(`value válido: ${nome}`, () => {
    assertValorAceito("trusted-valor-valido", classe, alvo, valor);
  });
}

// Forma NFD é aceita pela canonicalização NFC. Registro honesto: esta aceitação
// isolada prova que a entrada NÃO é recusada, e apenas isso — ela não observa qual
// forma foi devolvida internamente, porque a suíte não importa funções privadas nem
// usa interface de depuração. A equivalência canônica já é observável de fora nos
// testes de colisão mais abaixo, onde duas entradas que só coincidem depois de NFC,
// ou depois do recorte, são recusadas como tripla duplicada.
test("glob em forma NFD é aceito", () => {
  const nfd = "src/exceção/**".normalize("NFD");
  assert.notEqual(nfd, nfd.normalize("NFC"), "a fixture precisa diferir em NFD e NFC");
  assertValorAceito("trusted-valor-nfd", "coverage-exclusion-added", "coverage.exclude", nfd);
});

// Separadores não forjam classe: `=` e `+=` são caracteres comuns de glob e passam
// como dado, sem virar sintaxe.
for (const padrao of ["src/**/*=*", "src/**/a+=b", "src/{a,b}/**", "src/**/*.{ts,tsx}"]) {
  test(`glob com separadores literais é aceito: ${padrao}`, () => {
    assertValorAceito("trusted-valor-separadores", "coverage-exclusion-added", "coverage.exclude", padrao);
  });
}

// ---------------------------------------------------------------------------------
// Formato, existência e vigência de `expiresOn`.
//
// A autorização é temporária por construção: vale enquanto o dia corrente não passar
// da data declarada e caduca sozinha no dia seguinte. Uma exceção que não expira não é
// exceção, é política — e passaria a valer sem nunca voltar à revisão humana.
//
// A data é civil e UTC, exatamente `YYYY-MM-DD`. Nada de horário, fuso ou notação
// alternativa: duas grafias do mesmo instante obrigariam a decidir qual fuso julga a
// vigência, e a resposta mudaria conforme a máquina onde o gate roda.
// ---------------------------------------------------------------------------------

const PADRAO_EXPIRACAO_INVALIDA = /entrada 0 de `exceptions` com `expiresOn` inválida/i;
const PADRAO_EXPIRADA = /entrada 0 de `exceptions` expirada/i;

function comExpiracao(expiresOn, id = "exemplo") {
  return { ...ENTRADA_ESTRUTURAL, id, expiresOn };
}

function assertExpiracaoInvalida(prefixo, expiresOn) {
  assertRegistroInvalido(
    prefixo,
    registroCom([comExpiracao(expiresOn)]),
    PADRAO_EXPIRACAO_INVALIDA
  );
}

// O dia corrente do CLI vem de `new Date().toISOString().slice(0, 10)` e NÃO é
// configurável: não existe `--now`, variável de ambiente de teste nem relógio
// injetável. Quem invoca o gate não pode deslocar a vigência. A suíte apenas lê o
// mesmo relógio, de fora, para montar fixtures relativas a hoje.
function diaUtcCorrente() {
  return new Date().toISOString().slice(0, 10);
}

// Aritmética de calendário sobre a data civil, sem depender do fuso local. `new Date(0)`
// já está em 00:00:00Z, e `setUTCFullYear` normaliza dia fora da faixa — é assim que a
// véspera de 1º de janeiro atravessa a virada de ano sem caso especial.
function diaDeslocado(dia, deslocamento) {
  const [ano, mes, diaDoMes] = dia.split("-").map(Number);
  const data = new Date(0);
  data.setUTCFullYear(ano, mes - 1, diaDoMes + deslocamento);
  return data.toISOString().slice(0, 10);
}

// O 29 de fevereiro do controle positivo precisa ser de um ano bissexto REAL e ainda
// no futuro. Uma data literal viraria bomba-relógio assim que aquele ano chegasse.
function proximoAnoBissextoApos(ano) {
  let candidato = ano + 1;
  while (!((candidato % 4 === 0 && candidato % 100 !== 0) || candidato % 400 === 0)) {
    candidato += 1;
  }
  return candidato;
}

// Entre montar a fixture e o subprocesso terminar, a meia-noite UTC pode virar: a
// fixture diria "hoje" e o CLI julgaria contra outro dia. A proteção é ler o dia antes
// e depois e, se tiver mudado, remontar a fixture com o dia novo e repetir UMA vez.
// Resultado ambíguo nunca é aceito: a segunda virada dentro da mesma execução falha o
// teste em vez de ser interpretada.
function executarComDiaCorrente(prefixo, montarConteudo) {
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const antes = diaUtcCorrente();
    const trusted = novaRaiz(prefixo);
    const candidate = novaRaiz("candidate");
    escrever(trusted, "quality/policy-exceptions.json", montarConteudo(antes));
    const result = executar(trusted, candidate);
    if (diaUtcCorrente() === antes) return { result, dia: antes };
  }
  assert.fail("o dia UTC virou em duas tentativas seguidas; resultado ambíguo recusado");
}

// Tipos que não são string. Nenhuma coerção: `20260915` não vira `"2026-09-15"`, e um
// objeto com `toString` conveniente não vira data.
for (const [nome, expiracao] of [
  ["null", null],
  ["número", 20260915],
  ["booleano", true],
  ["array", ["2026-09-15"]],
  ["objeto", { valor: "2026-09-15" }]
]) {
  test(`expiresOn como ${nome} reprova`, () => {
    assertExpiracaoInvalida("trusted-expiracao-tipo", expiracao);
  });
}

// Forma exata. Sem recorte, sem coerção e sem parsing permissivo: a data é o que está
// escrito, e apenas `YYYY-MM-DD` está escrito corretamente.
//
// Os casos de dia inexistente — 31 de abril, 29 de fevereiro fora de ano bissexto — são
// o motivo de o regex não bastar: ele conta dígitos, não dias do mês.
for (const [nome, expiracao] of [
  ["string vazia", ""],
  ["somente espaços", "   "],
  ["espaço à esquerda", " 2026-09-15"],
  ["espaço à direita", "2026-09-15 "],
  ["barras no lugar de hífens", "2026/09/15"],
  ["mês sem zero à esquerda", "2026-9-15"],
  ["dia sem zero à esquerda", "2026-09-5"],
  ["timestamp anexado", "2026-09-15T00:00:00"],
  ["timestamp com milissegundos", "2026-09-15T12:34:56.789"],
  ["timezone Z anexado", "2026-09-15T00:00:00Z"],
  ["sufixo Z sem horário", "2026-09-15Z"],
  ["deslocamento de fuso anexado", "2026-09-15+03:00"],
  ["ano com dois dígitos", "26-09-15"],
  ["ano com três dígitos", "226-09-15"],
  ["ano com cinco dígitos", "20260-09-15"],
  ["mês 00", "2026-00-15"],
  ["mês 13", "2026-13-15"],
  ["dia 00", "2026-09-00"],
  ["dia 32", "2026-09-32"],
  ["31 de abril", "2026-04-31"],
  ["31 de novembro", "2026-11-31"],
  ["29 de fevereiro fora de ano bissexto", "2025-02-29"],
  ["30 de fevereiro", "2026-02-30"]
]) {
  test(`expiresOn com ${nome} reprova`, () => {
    assertExpiracaoInvalida("trusted-expiracao-forma", expiracao);
  });
}

// Data bem formada e existente, mas vencida. Classe de mensagem própria: "inválida" e
// "expirada" são problemas distintos e pedem ações distintas — corrigir o campo ou
// renovar a autorização sob revisão humana.
test("expiresOn inequivocamente passada reprova como expirada", () => {
  assertRegistroInvalido(
    "trusted-expiracao-passada",
    registroCom([comExpiracao("2020-01-01")]),
    PADRAO_EXPIRADA
  );
});

// Anos de um, dois, três e quatro dígitos abaixo de 1900. TESTES DE CARACTERIZAÇÃO:
// eles nascem verdes e existem para PROTEGER CONTRA REGRESSÃO para `Date.UTC(...)` ou
// `new Date(ano, ...)` na prova de existência da data civil. Ambas as formas mapeiam
// anos de `0000` a `0099` para `1900 + ano` — `0026-09-15` viraria 1926-09-15 — e a ida
// e volta deixaria de reimprimir a string recebida: estas datas seriam classificadas
// como `expiresOn` INVÁLIDA em vez de EXPIRADA, trocando "renove a autorização" por
// "corrija o campo" e escondendo a causa real. A implementação atual usa
// `setUTCFullYear`, que não tem esse mapeamento.
//
// A tabela cobre a faixa afetada e sua fronteira: `0000` e `0099` são os extremos do
// intervalo remapeado, `0001` e `0026` ficam no interior — `0026` reproduz exatamente o
// exemplo citado no comentário da implementação — e `0100` é o primeiro ano fora da
// faixa, que precisa continuar se comportando igual.
for (const data of ["0000-01-01", "0001-01-01", "0026-09-15", "0099-12-31", "0100-01-01"]) {
  test(`expiresOn em ${data} reprova como expirada, não como data inválida`, () => {
    const trusted = novaRaiz("trusted-expiracao-ano-baixo");
    const candidate = novaRaiz("candidate");
    escrever(trusted, "quality/policy-exceptions.json", registroCom([comExpiracao(data)]));
    const result = executar(trusted, candidate);
    const saida = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
    assert.match(result.stderr, PADRAO_EXPIRADA);
    assert.doesNotMatch(result.stderr, PADRAO_EXPIRACAO_INVALIDA, "data civil válida recusada");
    assert.doesNotMatch(saida, /\d{4}-\d{2}-\d{2}/, "data ecoada na saída");
    assertSemStackTrace(saida);
  });
}

test("mensagem de expiresOn inválida não ecoa a data recebida", () => {
  const trusted = novaRaiz("trusted-expiracao-eco");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([comExpiracao(`2026-09-15-${MARCADOR}`)])
  );
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, PADRAO_EXPIRACAO_INVALIDA);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "data ecoada na saída");
  assertSemStackTrace(saida);
});

// A mensagem de entrada expirada é ainda mais sensível: a data ali é legítima, e
// ecoá-la publicaria o calendário interno de afrouxamentos da base junto com a spec, a
// issue e o identificador que a acompanham.
test("mensagem de entrada expirada não ecoa data, spec, issue nem identificador", () => {
  const trusted = novaRaiz("trusted-expirada-eco");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([
      {
        ...comExpiracao("2020-01-01", "identificador-unico"),
        spec: `specs/9-${MARCADOR}.md`,
        issue: `github:#${MARCADOR}`
      }
    ])
  );
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, PADRAO_EXPIRADA);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "spec ou issue ecoadas na saída");
  assert.doesNotMatch(saida, /identificador-unico/, "identificador ecoado na saída");
  assert.doesNotMatch(saida, /\d{4}-\d{2}-\d{2}/, "data ecoada na saída");
  assertSemStackTrace(saida);
});

// Precedência: `value` continua sendo apurado ANTES de `expiresOn`. Uma entrada com os
// dois campos defeituosos é reportada pelo primeiro problema na ordem, para que a
// correção não vire uma sequência de tentativas.
test("value inválido reprova como value mesmo com expiresOn inválida", () => {
  assertRegistroInvalido(
    "trusted-precedencia-valor-expiracao",
    registroCom([
      { ...comValor("coverage-threshold-lowered", "coverage.lines", 1.5), expiresOn: "2026/09/15" }
    ]),
    PADRAO_VALOR_INVALIDO
  );
});

// Precedência inversa: `expiresOn` é apurado ANTES da unicidade da tripla. Uma entrada
// inválida ou expirada não pode ocupar lugar no conjunto de autorizações canônicas —
// nem sequer para colidir com outra e mascarar a causa real.
test("expiresOn inválida reprova antes da duplicação da tripla", () => {
  assertRegistroInvalido(
    "trusted-precedencia-expiracao-tripla",
    registroCom([
      comValor("allowed-rebuild-added", "allowedRebuilds", "esbuild", "primeiro"),
      {
        ...comValor("allowed-rebuild-added", "allowedRebuilds", "esbuild", "segundo"),
        expiresOn: "2026-02-30"
      }
    ]),
    /entrada 1 de `exceptions` com `expiresOn` inválida/i
  );
});

test("expiresOn expirada reprova antes da duplicação da tripla", () => {
  assertRegistroInvalido(
    "trusted-precedencia-expirada-tripla",
    registroCom([
      comValor("allowed-rebuild-added", "allowedRebuilds", "esbuild", "primeiro"),
      {
        ...comValor("allowed-rebuild-added", "allowedRebuilds", "esbuild", "segundo"),
        expiresOn: "2020-01-01"
      }
    ]),
    /entrada 1 de `exceptions` expirada/i
  );
});

test("a posição reportada é a da entrada com expiresOn inválida", () => {
  assertRegistroInvalido(
    "trusted-expiracao-posicao",
    registroCom([
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "primeiro"),
      {
        ...comValor("coverage-threshold-lowered", "coverage.branches", 60, "segundo"),
        expiresOn: "2026-13-01"
      }
    ]),
    /entrada 1 de `exceptions` com `expiresOn` inválida/i
  );
});

test("a posição reportada é a da entrada expirada", () => {
  assertRegistroInvalido(
    "trusted-expirada-posicao",
    registroCom([
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "primeiro"),
      {
        ...comValor("coverage-threshold-lowered", "coverage.branches", 60, "segundo"),
        expiresOn: "2020-01-01"
      }
    ]),
    /entrada 1 de `exceptions` expirada/i
  );
});

// --- controles positivos ---

// Vigência INCLUSIVA: no último dia a autorização ainda vale. A alternativa — expirar
// no próprio dia declarado — faria toda exceção durar um dia a menos do que a revisão
// humana aprovou, e a diferença só apareceria no pior momento.
test("o dia UTC corrente é aceito: a vigência é inclusiva", () => {
  const { result } = executarComDiaCorrente("trusted-expiracao-hoje", (dia) =>
    registroCom([comExpiracao(dia)])
  );
  assert.equal(result.status, 0, result.stderr);
});

test("o dia seguinte ao corrente é aceito", () => {
  const { result } = executarComDiaCorrente("trusted-expiracao-amanha", (dia) =>
    registroCom([comExpiracao(diaDeslocado(dia, 1))])
  );
  assert.equal(result.status, 0, result.stderr);
});

// A outra metade da fronteira: a véspera já está expirada. Os dois testes juntos fixam
// a borda exata, sem deixar margem para um `>=` no lugar de um `>`.
test("a véspera do dia corrente reprova como expirada", () => {
  const { result } = executarComDiaCorrente("trusted-expiracao-vespera", (dia) =>
    registroCom([comExpiracao(diaDeslocado(dia, -1))])
  );
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${result.stdout}`);
  assert.match(result.stderr, PADRAO_EXPIRADA);
});

test("data futura é aceita", () => {
  assertRegistroAceito(
    "trusted-expiracao-futura",
    registroCom([comExpiracao(diaDeslocado(diaUtcCorrente(), 90))])
  );
});

test("29 de fevereiro de ano bissexto real é aceito", () => {
  const ano = proximoAnoBissextoApos(Number(diaUtcCorrente().slice(0, 4)));
  const data = `${ano}-02-29`;
  assert.equal(
    new Date(`${data}T00:00:00Z`).toISOString().slice(0, 10),
    data,
    "a fixture precisa ser uma data civil realmente existente"
  );
  assertRegistroAceito("trusted-expiracao-bissexto", registroCom([comExpiracao(data)]));
});

// A versão 1 não impõe horizonte máximo: uma expiração muito distante é sintaticamente
// válida e vigente. Isso é risco residual registrado, sujeito à revisão humana da
// própria entrada — não algo que o comparador decida sozinho.
test("expiração muito distante continua válida na versão 1", () => {
  assertRegistroAceito("trusted-expiracao-distante", registroCom([comExpiracao("9999-12-31")]));
});

test("duas entradas vigentes com triplas diferentes são aceitas", () => {
  const dia = diaUtcCorrente();
  assertRegistroAceito(
    "trusted-expiracao-duas-vigentes",
    registroCom([
      {
        ...comValor("coverage-threshold-lowered", "coverage.lines", 70, "primeiro"),
        expiresOn: diaDeslocado(dia, 30)
      },
      {
        ...comValor("coverage-threshold-lowered", "coverage.branches", 60, "segundo"),
        expiresOn: diaDeslocado(dia, 60)
      }
    ])
  );
});

// ---------------------------------------------------------------------------------
// Unicidade da tripla canônica `changeClass` + `target` + `value`.
//
// Uma autorização é atômica. Duas entradas que autorizam exatamente o mesmo
// afrouxamento tornam a consulta ambígua — qual expiração vale? — e permitiriam
// manter expirações concorrentes para a mesma coisa.
// ---------------------------------------------------------------------------------

const PADRAO_TRIPLA_DUPLICADA = /entrada \d+ de `exceptions` com autorização canônica duplicada/i;

test("duas entradas com ids diferentes e a mesma tripla exata reprovam", () => {
  assertRegistroInvalido(
    "trusted-tripla-exata",
    registroCom([
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "primeiro"),
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "segundo")
    ]),
    /entrada 1 de `exceptions` com autorização canônica duplicada/i
  );
});

test("duplicata não adjacente reprova na posição repetida", () => {
  assertRegistroInvalido(
    "trusted-tripla-distante",
    registroCom([
      comValor("enabled-disabled", "enabled", false, "alfa"),
      comValor("complexity-max-raised", "complexity.maxCyclomaticPerFunction", 25, "beta"),
      comValor("enabled-disabled", "enabled", false, "gama")
    ]),
    /entrada 2 de `exceptions` com autorização canônica duplicada/i
  );
});

// Colisão que só existe DEPOIS da canonicalização. Este é o teste que torna a
// canonicalização observável de fora: se o valor bruto fosse usado, `"src/**"` e
// `"  src/**  "` seriam distintos e as duas entradas passariam.
test("dois globs que só coincidem após recorte reprovam como tripla duplicada", () => {
  assertRegistroInvalido(
    "trusted-tripla-trim",
    registroCom([
      comValor("coverage-exclusion-added", "coverage.exclude", "src/legacy/**", "primeiro"),
      comValor("coverage-exclusion-added", "coverage.exclude", "   src/legacy/**   ", "segundo")
    ]),
    PADRAO_TRIPLA_DUPLICADA
  );
});

// Mesma prova para a normalização Unicode. As duas strings são textualmente
// diferentes e canonicamente iguais.
test("glob NFC e o equivalente NFD reprovam como tripla duplicada", () => {
  const nfc = "src/exceção/**".normalize("NFC");
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfc, nfd, "a fixture precisa diferir textualmente em NFC e NFD");
  assertRegistroInvalido(
    "trusted-tripla-nfd",
    registroCom([
      comValor("canonical-pattern-removed", "appliesWhenChanged", nfc, "primeiro"),
      comValor("canonical-pattern-removed", "appliesWhenChanged", nfd, "segundo")
    ]),
    PADRAO_TRIPLA_DUPLICADA
  );
});

// A unicidade é da tripla e só dela, depois de todas as referências estarem válidas.
// Variar a spec junto da issue correspondente, ou variar a expiração, não cria uma
// segunda autorização legítima — cria exatamente a ambiguidade que a regra proíbe.
for (const [nome, extra] of [
  ["spec", { spec: "specs/9-segredo-nao-exibir.md" }],
  ["expiresOn", { expiresOn: "2098-06-15" }],
  [
    "spec, issue e expiresOn ao mesmo tempo",
    {
      spec: "specs/004-ai-engineering-system.md",
      issue: "local:tasks/004-ai-engineering-system.md",
      expiresOn: "2098-06-15"
    }
  ]
]) {
  test(`duplicata reprova mesmo com ${nome} diferente`, () => {
    assertRegistroInvalido(
      "trusted-tripla-campos-livres",
      registroCom([
        comValor("allowed-rebuild-added", "allowedRebuilds", "esbuild", "primeiro"),
        { ...comValor("allowed-rebuild-added", "allowedRebuilds", "esbuild", "segundo"), ...extra }
      ]),
      /entrada 1 de `exceptions` com autorização canônica duplicada/i
    );
  });
}

test("mensagem de duplicação não ecoa campo algum da entrada", () => {
  const trusted = novaRaiz("trusted-tripla-eco");
  const candidate = novaRaiz("candidate");
  const glob = `src/${MARCADOR}/**`;
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([
      {
        ...comValor("coverage-exclusion-added", "coverage.exclude", glob, "primeiro"),
        spec: "specs/9-segredo-nao-exibir.md"
      },
      {
        ...comValor("coverage-exclusion-added", "coverage.exclude", glob, "segundo"),
        spec: "specs/004-ai-engineering-system.md",
        issue: "local:tasks/004-ai-engineering-system.md"
      }
    ])
  );
  const result = executar(trusted, candidate);
  const saida = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, PADRAO_TRIPLA_DUPLICADA);
  assert.doesNotMatch(saida, new RegExp(MARCADOR), "conteúdo da entrada ecoado na saída");
  assert.doesNotMatch(saida, /segredo-nao-exibir/, "caminho da spec ecoado na saída");
  assert.doesNotMatch(saida, /primeiro|segundo/, "identificador ecoado na saída");
  assertSemStackTrace(saida);
});

// Não basta reprovar: é preciso não reprovar demais.
test("mesmo valor em alvos de cobertura diferentes é aceito", () => {
  assertRegistroAceito(
    "trusted-tripla-alvos",
    registroCom([
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "linhas"),
      comValor("coverage-threshold-lowered", "coverage.branches", 70, "ramos"),
      comValor("coverage-threshold-lowered", "coverage.functions", 70, "funcoes"),
      comValor("coverage-threshold-lowered", "coverage.statements", 70, "instrucoes")
    ])
  );
});

// Glob e nome de pacote podem conter `=`, `+=`, chaves e vírgulas. Uma tripla
// serializada por concatenação faria dois pares distintos produzirem a mesma chave;
// a estrutura aninhada não tem essa fragilidade.
test("valores com separadores não colidem artificialmente", () => {
  assertRegistroAceito(
    "trusted-tripla-separadores",
    registroCom([
      comValor("coverage-exclusion-added", "coverage.exclude", "src/a=b/**", "um"),
      comValor("coverage-exclusion-added", "coverage.exclude", "src/a+=b/**", "dois"),
      comValor("coverage-exclusion-added", "coverage.exclude", "src/{a,b}/**", "tres"),
      comValor("coverage-exclusion-added", "coverage.exclude", "src/a|b/**", "quatro")
    ])
  );
});

// Classes diferentes nunca colidem entre si, mesmo com valor textualmente igual.
test("mesmo valor textual em classes diferentes é aceito", () => {
  assertRegistroAceito(
    "trusted-tripla-classes",
    registroCom([
      comValor("coverage-exclusion-added", "coverage.exclude", "src/legacy/**", "exclusao"),
      comValor("canonical-pattern-removed", "appliesWhenChanged", "src/legacy/**", "padrao")
    ])
  );
});

// Um registro candidato malformado não pode reprovar nem influenciar: ele não é lido.
test("registro malformado na raiz candidata é irrelevante", () => {
  const trusted = novaRaiz("trusted-ok");
  const candidate = novaRaiz("candidate-malformado");
  escrever(trusted, "quality/policy-exceptions.json", '{"version":1,"exceptions":[]}');
  escrever(candidate, "quality/policy-exceptions.json", "isto não é JSON");
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
});

// ---------------------------------------------------------------------------------
// Vínculo da autorização com uma especificação aprovada da base confiável.
//
// O seam permanece a CLI real. Caminhos e metadados são dados sob revisão: erros
// nomeiam posição e classe, nunca o valor recebido.
// ---------------------------------------------------------------------------------

test("spec fora do padrão canônico reprova sem ecoar o caminho", () => {
  const trusted = novaRaiz("trusted-spec-formato");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([{ ...ENTRADA_ESTRUTURAL, spec: `../${MARCADOR}.md` }])
  );
  const result = executar(trusted, candidate);
  assertReprovaInterface(result, /entrada 0 de `exceptions` com `spec` inválida/i);
});

test("spec existente somente no candidato não autoriza a entrada", () => {
  const trusted = novaRaiz("trusted-spec-ausente", { comSpecPadrao: false });
  const candidate = novaRaiz("candidate-spec-presente");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([ENTRADA_ESTRUTURAL]));
  escreverSpec(candidate, ENTRADA_ESTRUTURAL.spec, {
    id: "3",
    issue: "github:#3",
    status: "approved"
  });
  const result = executar(trusted, candidate);
  assertReprovaInterface(result, /entrada 0 de `exceptions` com `spec` ausente na base confiável/i);
});

test("snapshot de specs inválido reprova com posição sem ecoar o caminho", () => {
  const trusted = novaRaiz("trusted-snapshot-spec-invalido");
  const candidate = novaRaiz("candidate");
  escrever(trusted, `specs/${MARCADOR}.txt`, "conteúdo privado");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([ENTRADA_ESTRUTURAL]));
  const result = executar(trusted, candidate);
  assertReprovaInterface(
    result,
    /entrada 0 de `exceptions` com snapshot confiável de specs inválido/i
  );
});

test("spec presente na base sem aprovação não autoriza a entrada", () => {
  const trusted = novaRaiz("trusted-spec-nao-aprovada");
  const candidate = novaRaiz("candidate");
  escreverSpec(trusted, ENTRADA_ESTRUTURAL.spec, {
    id: "3",
    issue: "github:#3",
    status: "proposed"
  });
  escrever(trusted, "quality/policy-exceptions.json", registroCom([ENTRADA_ESTRUTURAL]));
  const result = executar(trusted, candidate);
  assertReprovaInterface(result, /entrada 0 de `exceptions` com `spec` não aprovada/i);
});

test("issue diferente da declarada pela spec não autoriza a entrada", () => {
  const trusted = novaRaiz("trusted-issue-divergente");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([{ ...ENTRADA_ESTRUTURAL, issue: "github:#99" }])
  );
  const result = executar(trusted, candidate);
  assertReprovaInterface(
    result,
    /entrada 0 de `exceptions` com `issue` diferente da especificação confiável/i
  );
});

test("divergência de issue não ecoa issue nem caminho da spec", () => {
  const trusted = novaRaiz("trusted-issue-eco");
  const candidate = novaRaiz("candidate");
  escrever(
    trusted,
    "quality/policy-exceptions.json",
    registroCom([
      {
        ...ENTRADA_ESTRUTURAL,
        spec: "specs/9-segredo-nao-exibir.md",
        issue: "local:tasks/9-segredo-nao-exibir.md"
      }
    ])
  );
  const result = executar(trusted, candidate);
  const saida = saidaCompleta(result);
  assert.notEqual(result.status, 0, `aprovou indevidamente: ${saida}`);
  assert.match(result.stderr, /entrada 0 de `exceptions` com `issue` diferente/i);
  assert.doesNotMatch(saida, /segredo-nao-exibir/, "spec ou issue ecoada na saída");
  assertSemStackTrace(saida);
});

// Cobertura de forma depois do tracer bullet: todos estes casos pertencem à mesma
// regra pública já instalada, sem coerção, recorte ou normalização de caminho.
for (const [nome, spec] of [
  ["null", null],
  ["número", 3],
  ["booleano", true],
  ["array", ["specs/3-governance-hardening.md"]],
  ["objeto", { path: "specs/3-governance-hardening.md" }],
  ["string vazia", ""],
  ["somente espaços", "   "],
  ["espaço à esquerda", " specs/3-governance-hardening.md"],
  ["espaço à direita", "specs/3-governance-hardening.md "],
  ["barra invertida", "specs\\3-governance-hardening.md"],
  ["travessia", "specs/../specs/3-governance-hardening.md"],
  ["caminho absoluto", "C:/specs/3-governance-hardening.md"],
  ["extensão incorreta", "specs/3-governance-hardening.txt"],
  ["nome com maiúscula", "specs/3-Governance-hardening.md"],
  ["subdiretório", "specs/archive/3-governance-hardening.md"]
]) {
  test(`spec como ${nome} reprova`, () => {
    assertRegistroInvalido(
      "trusted-spec-forma",
      registroCom([{ ...ENTRADA_ESTRUTURAL, spec }]),
      /entrada 0 de `exceptions` com `spec` inválida/i
    );
  });
}

for (const [nome, markdown] of [
  ["metadado ausente", "# Sem metadado\n"],
  [
    "metadado duplicado",
    '<!-- spec-meta\n{"id":"3","issue":"github:#3","status":"approved"}\n-->\n' +
      '<!-- spec-meta\n{"id":"3","issue":"github:#3","status":"approved"}\n-->\n'
  ],
  ["JSON inválido", "<!-- spec-meta\n{invalid}\n-->\n"],
  ["identidade divergente", '<!-- spec-meta\n{"id":"03","issue":"github:#3","status":"approved"}\n-->\n'],
  ["issue inválida nos metadados", '<!-- spec-meta\n{"id":"3","issue":"texto livre","status":"approved"}\n-->\n']
]) {
  test(`spec confiável com ${nome} reprova sem expor seu conteúdo`, () => {
    const trusted = novaRaiz("trusted-spec-metadado");
    const candidate = novaRaiz("candidate");
    escrever(trusted, ENTRADA_ESTRUTURAL.spec, `${markdown}<!-- ${MARCADOR} -->\n`);
    escrever(trusted, "quality/policy-exceptions.json", registroCom([ENTRADA_ESTRUTURAL]));
    const result = executar(trusted, candidate);
    assertReprovaInterface(result, /entrada 0 de `exceptions` com `spec` inválida na base confiável/i);
  });
}

for (const [nome, issue] of [
  ["null", null],
  ["número", 3],
  ["booleano", true],
  ["array", ["github:#3"]],
  ["objeto", { value: "github:#3" }],
  ["string vazia", ""],
  ["somente espaços", "   "],
  ["espaço à esquerda", " github:#3"],
  ["espaço à direita", "github:#3 "],
  ["GitHub sem cerquilha", "github:3"],
  ["GitHub sem número", "github:#"],
  ["local com travessia", "local:tasks/../3-segredo.md"],
  ["local com barra invertida", "local:tasks\\3-segredo.md"],
  ["local com nome maiúsculo", "local:tasks/3-Segredo.md"]
]) {
  test(`issue como ${nome} reprova`, () => {
    assertRegistroInvalido(
      "trusted-issue-forma",
      registroCom([{ ...ENTRADA_ESTRUTURAL, issue }]),
      /entrada 0 de `exceptions` com `issue` inválida/i
    );
  });
}

test("spec legada com issue local correspondente continua aceita", () => {
  assertRegistroAceito(
    "trusted-spec-legada",
    registroCom([
      {
        ...ENTRADA_ESTRUTURAL,
        spec: "specs/004-ai-engineering-system.md",
        issue: "local:tasks/004-ai-engineering-system.md"
      }
    ])
  );
});

test("duas autorizações podem reutilizar a mesma spec aprovada", () => {
  assertRegistroAceito(
    "trusted-spec-reutilizada",
    registroCom([
      comValor("coverage-threshold-lowered", "coverage.lines", 70, "linhas"),
      comValor("coverage-threshold-lowered", "coverage.branches", 60, "ramos")
    ])
  );
});

test("alteração da spec somente no candidato não muda a autoridade da base", () => {
  const trusted = novaRaiz("trusted-spec-aprovada");
  const candidate = novaRaiz("candidate-spec-alterada");
  escreverSpec(candidate, ENTRADA_ESTRUTURAL.spec, {
    id: "3",
    issue: "github:#99",
    status: "proposed"
  });
  escrever(trusted, "quality/policy-exceptions.json", registroCom([ENTRADA_ESTRUTURAL]));
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
});

test("registro vazio não exige snapshot de specs", () => {
  const trusted = novaRaiz("trusted-sem-specs", { comSpecPadrao: false });
  const candidate = novaRaiz("candidate");
  escrever(trusted, "quality/policy-exceptions.json", '{"version":1,"exceptions":[]}');
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
});

// ---------------------------------------------------------------------------------
// Comparação efetiva da política candidata contra a política confiável.
//
// O seam continua sendo a CLI real. A política e o registro são arquivos JSON sob
// raízes temporárias; nenhuma função privada é importada e nenhum módulo candidato é
// executado.
// ---------------------------------------------------------------------------------

function executarComPoliticas(prefixo, alterarCandidate, exceptions = []) {
  const trusted = novaRaiz(`trusted-${prefixo}`);
  const candidate = novaRaiz(`candidate-${prefixo}`);
  escrever(trusted, "quality/policy-exceptions.json", registroCom(exceptions));
  escreverPolitica(candidate, alterarCandidate);
  return executar(trusted, candidate);
}

test("remover um dos seis comandos reprova", () => {
  const result = executarComPoliticas("comando-removido", (policy) => {
    policy.commands.pop();
    return policy;
  });
  assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
});

test("acrescentar um sétimo comando reprova", () => {
  const result = executarComPoliticas("comando-acrescentado", (policy) => {
    policy.commands.push({ name: "extra", origin: "base", executable: "node", args: ["extra"] });
    return policy;
  });
  assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
});

test("reordenar os comandos reprova", () => {
  const result = executarComPoliticas("comandos-reordenados", (policy) => {
    [policy.commands[0], policy.commands[1]] = [policy.commands[1], policy.commands[0]];
    return policy;
  });
  assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
});

test("alterar o name de um comando reprova", () => {
  const result = executarComPoliticas("comando-name", (policy) => {
    policy.commands[0].name = "outro";
    return policy;
  });
  assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
});

test("alterar o executable de um comando reprova", () => {
  const result = executarComPoliticas("comando-executable", (policy) => {
    policy.commands[0].executable = "outro";
    return policy;
  });
  assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
});

test("alterar a origin de um comando reprova", () => {
  const result = executarComPoliticas("comando-origin", (policy) => {
    policy.commands[0].origin = "base";
    return policy;
  });
  assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
});

test("substituir um argumento de comando reprova", () => {
  const result = executarComPoliticas("comando-argumento-substituido", (policy) => {
    policy.commands[0].args[1] = "--passWithNoTests";
    return policy;
  });
  assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
});

for (const [nome, alterar] of [
  ["acrescentar", (args) => args.push("--extra")],
  ["remover", (args) => args.pop()],
  ["reordenar", (args) => args.reverse()],
  ["apontar para outra configuração", (args) => args.splice(0, 1, "outra-configuração")],
  ["acrescentar exclusão", (args) => args.push("--exclude=src/**")]
]) {
  test(`${nome} argumento de comando reprova`, () => {
    const result = executarComPoliticas(`comando-args-${nome}`, (policy) => {
      alterar(policy.commands[1].args);
      return policy;
    });
    assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
  });
}

test("desabilitar a política sem autorização confiável reprova", () => {
  const result = executarComPoliticas("enabled-sem-autorizacao", (policy) => {
    policy.enabled = false;
    return policy;
  });
  assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
});

test("autorização confiável exata permite desabilitar a política", () => {
  const result = executarComPoliticas(
    "enabled-autorizado",
    (policy) => {
      policy.enabled = false;
      return policy;
    },
    [comValor("enabled-disabled", "enabled", false, "enabled-autorizado")]
  );
  assert.equal(result.status, 0, result.stderr);
});

test("reduzir limiar de cobertura sem autorização confiável reprova", () => {
  const result = executarComPoliticas("cobertura-sem-autorizacao", (policy) => {
    policy.coverage.lines = 79;
    return policy;
  });
  assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
});

test("autorização confiável exata permite reduzir limiar de cobertura", () => {
  const result = executarComPoliticas(
    "cobertura-autorizada",
    (policy) => {
      policy.coverage.lines = 79;
      return policy;
    },
    [comValor("coverage-threshold-lowered", "coverage.lines", 79, "cobertura-autorizada")]
  );
  assert.equal(result.status, 0, result.stderr);
});

for (const target of ["branches", "functions", "statements"]) {
  test(`reduzir coverage.${target} sem autorização confiável reprova`, () => {
    const result = executarComPoliticas(`cobertura-${target}`, (policy) => {
      policy.coverage[target] -= 1;
      return policy;
    });
    assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
  });
}

test("elevar máximo de complexidade sem autorização confiável reprova", () => {
  const result = executarComPoliticas("complexidade-sem-autorizacao", (policy) => {
    policy.complexity.maxCyclomaticPerFunction = 11;
    return policy;
  });
  assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
});

test("autorização confiável exata permite elevar máximo de complexidade", () => {
  const result = executarComPoliticas(
    "complexidade-autorizada",
    (policy) => {
      policy.complexity.maxCyclomaticPerFunction = 11;
      return policy;
    },
    [
      comValor(
        "complexity-max-raised",
        "complexity.maxCyclomaticPerFunction",
        11,
        "complexidade-autorizada"
      )
    ]
  );
  assert.equal(result.status, 0, result.stderr);
});

test("acrescentar exclusão de cobertura sem autorização confiável reprova", () => {
  const result = executarComPoliticas("exclusao-sem-autorizacao", (policy) => {
    policy.coverage.exclude.push("src/legacy/**");
    return policy;
  });
  assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
});

test("autorização confiável exata permite acrescentar exclusão de cobertura", () => {
  const result = executarComPoliticas(
    "exclusao-autorizada",
    (policy) => {
      policy.coverage.exclude.push("src/legacy/**");
      return policy;
    },
    [comValor("coverage-exclusion-added", "coverage.exclude", "src/legacy/**", "exclusao")]
  );
  assert.equal(result.status, 0, result.stderr);
});

test("remover padrão canônico sem autorização confiável reprova", () => {
  const result = executarComPoliticas("padrao-sem-autorizacao", (policy) => {
    policy.appliesWhenChanged.shift();
    return policy;
  });
  assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
});

test("autorização confiável exata permite remover padrão canônico", () => {
  const result = executarComPoliticas(
    "padrao-autorizado",
    (policy) => {
      policy.appliesWhenChanged.shift();
      return policy;
    },
    [comValor("canonical-pattern-removed", "appliesWhenChanged", "src/**", "padrao")]
  );
  assert.equal(result.status, 0, result.stderr);
});

test("normalização NFC e recorte preservam padrão canônico observado", () => {
  const trusted = novaRaiz("trusted-padrao-normalizado");
  const candidate = novaRaiz("candidate-padrao-normalizado");
  const nfc = "src/exceção/**".normalize("NFC");
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfc, nfd, "a fixture precisa distinguir NFC de NFD");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([]));
  escreverPolitica(trusted, (policy) => {
    policy.appliesWhenChanged = [nfc, "package.json"];
    return policy;
  });
  escreverPolitica(candidate, (policy) => {
    policy.appliesWhenChanged = [`  ${nfd}  `, "package.json"];
    return policy;
  });
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
});

test("padrões adicionais em appliesWhenChanged são aceitos", () => {
  const result = executarComPoliticas("padrao-adicional", (policy) => {
    policy.appliesWhenChanged.push("docs/**");
    return policy;
  });
  assert.equal(result.status, 0, result.stderr);
});

test("acrescentar pacote a allowedRebuilds sem autorização confiável reprova", () => {
  const result = executarComPoliticas("rebuild-sem-autorizacao", (policy) => {
    policy.allowedRebuilds.push("esbuild");
    return policy;
  });
  assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
});

test("autorização confiável exata permite acrescentar pacote a allowedRebuilds", () => {
  const result = executarComPoliticas(
    "rebuild-autorizado",
    (policy) => {
      policy.allowedRebuilds.push("esbuild");
      return policy;
    },
    [comValor("allowed-rebuild-added", "allowedRebuilds", "esbuild", "rebuild")]
  );
  assert.equal(result.status, 0, result.stderr);
});

for (const [nome, autorizacao] of [
  [
    "classe diferente",
    comValor("complexity-max-raised", "complexity.maxCyclomaticPerFunction", 79, "classe")
  ],
  [
    "target diferente",
    comValor("coverage-threshold-lowered", "coverage.branches", 79, "alvo")
  ],
  ["valor diferente", comValor("coverage-threshold-lowered", "coverage.lines", 78, "valor")]
]) {
  test(`autorização com ${nome} não permite o afrouxamento`, () => {
    const result = executarComPoliticas(
      `autorizacao-${nome}`,
      (policy) => {
        policy.coverage.lines = 79;
        return policy;
      },
      [autorizacao]
    );
    assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
  });
}

test("múltiplos afrouxamentos exigem uma autorização para cada um", () => {
  const result = executarComPoliticas(
    "multiplos-incompletos",
    (policy) => {
      policy.enabled = false;
      policy.coverage.lines = 79;
      return policy;
    },
    [comValor("enabled-disabled", "enabled", false, "somente-enabled")]
  );
  assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
});

test("múltiplos afrouxamentos passam somente com todas as autorizações exatas", () => {
  const result = executarComPoliticas(
    "multiplos-completos",
    (policy) => {
      policy.enabled = false;
      policy.coverage.lines = 79;
      return policy;
    },
    [
      comValor("enabled-disabled", "enabled", false, "enabled"),
      comValor("coverage-threshold-lowered", "coverage.lines", 79, "cobertura")
    ]
  );
  assert.equal(result.status, 0, result.stderr);
});

test("autorização introduzida somente no candidato nunca autoriza", () => {
  const trusted = novaRaiz("trusted-registro-unilateral");
  const candidate = novaRaiz("candidate-registro-unilateral");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([]));
  escrever(
    candidate,
    "quality/policy-exceptions.json",
    registroCom([comValor("enabled-disabled", "enabled", false, "somente-candidato")])
  );
  escreverPolitica(candidate, (policy) => {
    policy.enabled = false;
    return policy;
  });
  const result = executar(trusted, candidate);
  assertReprovaInterface(result, /afrouxamento da política sem autorização confiável/i);
});

test("consulta da autorização usa a mesma normalização NFC e recorte do glob observado", () => {
  const nfc = "src/exceção/**".normalize("NFC");
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfc, nfd, "a fixture precisa distinguir NFC de NFD");
  const result = executarComPoliticas(
    "autorizacao-glob-normalizado",
    (policy) => {
      policy.coverage.exclude.push(`  ${nfd}  `);
      return policy;
    },
    [comValor("coverage-exclusion-added", "coverage.exclude", nfc, "glob-normalizado")]
  );
  assert.equal(result.status, 0, result.stderr);
});

test("mudanças endurecedoras são aceitas sem autorização", () => {
  const trusted = novaRaiz("trusted-endurecimento");
  const candidate = novaRaiz("candidate-endurecimento");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([]));
  escreverPolitica(trusted, (policy) => {
    policy.enabled = false;
    policy.coverage.lines = 70;
    policy.complexity.maxCyclomaticPerFunction = 12;
    policy.coverage.exclude = ["src/legacy/**"];
    policy.allowedRebuilds = ["esbuild"];
    return policy;
  });
  const result = executar(trusted, candidate);
  assert.equal(result.status, 0, result.stderr);
});

test("política candidata ausente reprova genericamente", () => {
  const trusted = novaRaiz("trusted-policy-ausente");
  const candidate = novaRaiz("candidate-policy-ausente", { comPoliticaPadrao: false });
  escrever(trusted, "quality/policy-exceptions.json", registroCom([]));
  const result = executar(trusted, candidate);
  assertReprovaInterface(result, /política candidata ausente ou ilegível/i);
});

test("política confiável ausente reprova genericamente", () => {
  const trusted = novaRaiz("trusted-policy-ausente", { comPoliticaPadrao: false });
  const candidate = novaRaiz("candidate-policy-presente");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([]));
  const result = executar(trusted, candidate);
  assertReprovaInterface(result, /política confiável ausente ou ilegível/i);
});

test("política candidata com JSON inválido reprova genericamente", () => {
  const trusted = novaRaiz("trusted-policy-json");
  const candidate = novaRaiz("candidate-policy-json");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([]));
  escrever(candidate, "quality/policy.json", `{${MARCADOR}`);
  const result = executar(trusted, candidate);
  assertReprovaInterface(result, /política candidata não é JSON válido/i);
});

test("política confiável com JSON inválido reprova genericamente", () => {
  const trusted = novaRaiz("trusted-policy-json");
  const candidate = novaRaiz("candidate-policy-json-valido");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([]));
  escrever(trusted, "quality/policy.json", `{${MARCADOR}`);
  const result = executar(trusted, candidate);
  assertReprovaInterface(result, /política confiável não é JSON válido/i);
});

test("política candidata com forma insuficiente reprova genericamente", () => {
  const trusted = novaRaiz("trusted-policy-insuficiente");
  const candidate = novaRaiz("candidate-policy-insuficiente");
  escrever(trusted, "quality/policy-exceptions.json", registroCom([]));
  escrever(candidate, "quality/policy.json", "{}");
  const result = executar(trusted, candidate);
  assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
});

for (const [campo, valor] of [
  ["name", null],
  ["executable", 1],
  ["origin", false],
  ["args", "não-array"]
]) {
  test(`campo ${campo} de comando com tipo inválido reprova`, () => {
    const result = executarComPoliticas(`comando-forma-${campo}`, (policy) => {
      policy.commands[0][campo] = valor;
      return policy;
    });
    assertReprovaInterface(result, /comandos da política candidata divergem da base confiável/i);
  });
}

for (const [nome, alterar] of [
  ["enabled textual", (policy) => (policy.enabled = "true")],
  ["limiar textual", (policy) => (policy.coverage.lines = "80")],
  ["complexidade textual", (policy) => (policy.complexity.maxCyclomaticPerFunction = "10")],
  ["exclude não-array", (policy) => (policy.coverage.exclude = "src/**")],
  ["appliesWhenChanged não-array", (policy) => (policy.appliesWhenChanged = "src/**")],
  ["allowedRebuilds não-array", (policy) => (policy.allowedRebuilds = "esbuild")]
]) {
  test(`política candidata com ${nome} reprova por forma`, () => {
    const result = executarComPoliticas(`policy-forma-${nome}`, (policy) => {
      alterar(policy);
      return policy;
    });
    assertReprovaInterface(result, /política com forma inválida/i);
  });
}
