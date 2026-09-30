import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = fileURLToPath(new URL("./validate-candidate-config.mjs", import.meta.url));

const POLICY = {
  version: 2,
  coverage: {
    lines: 80,
    branches: 75,
    functions: 80,
    statements: 80,
    include: ["src/modules/**", "src/shared/**"],
    exclude: []
  },
  complexity: { maxCyclomaticPerFunction: 10 },
  dependencies: {
    rules: [
      "domain-not-to-ui",
      "domain-not-to-infrastructure",
      "module-not-to-foreign-adapters",
      "integrations-only-to-module-seam"
    ]
  }
};

// A forma canônica é o OBJETO LITERAL exportado diretamente. O envoltório
// `defineConfig` foi removido da gramática aceita porque é inexequível neste
// contrato: o identificador não existe globalmente, o preâmbulo canônico não
// admite a importação que o traria, e carregar o arquivo dá ReferenceError. A
// forma aceita precisa ser a mesma que o Vitest conseguiria carregar.
const VITEST = `export default {
  test: {
    coverage: {
      include: ["src/modules/**", "src/shared/**"],
      exclude: [],
      thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 }
    }
  }
};\n`;

// --- H3a. Migração mecânica das fixtures canônicas de lint.
//
// O contrato passou a exigir, no bloco que PROVA o alcance, a associação entre a
// regra de complexidade e o analisador — `languageOptions: { parser }` — e, no
// preâmbulo, a única importação que liga esse identificador. As duas constantes
// abaixo são a forma canônica, aplicada a TODAS as fixtures de lint que antes
// aprovavam; nenhuma asserção foi enfraquecida e nenhum caso negativo virou
// positivo. Onde a classe de erro mudou, o teste registra a nova classe e
// continua provando o mesmo defeito.
const IMPORT_PARSER = 'import parser from "@typescript-eslint/parser";\n';
const PARSER_NO_BLOCO = "languageOptions: { parser }";

// --- H3b1. Forma canônica das proteções locais do bloco de complexidade.
//
// As duas propriedades são obrigatórias, no PRÓPRIO bloco que prova o alcance.
// `BLINDAGEM_NO_BLOCO` é a migração MECÂNICA das fixtures positivas: onde antes
// bastava o analisador, agora vão o analisador e as proteções, na mesma posição
// e na mesma ordem. Nenhuma asserção foi enfraquecida e nenhum caso negativo
// virou positivo. `semProtecoes` desfaz exatamente essa adição, para os vetores
// que precisam de um bloco de complexidade DESPROTEGIDO.
const PROTECOES_NO_BLOCO = 'linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" }';
const BLINDAGEM_NO_BLOCO = `${PARSER_NO_BLOCO}, ${PROTECOES_NO_BLOCO}`;
const semProtecoes = (texto) => texto.split(`, ${PROTECOES_NO_BLOCO}`).join("");

const ESLINT = `${IMPORT_PARSER}export default [{
  files: ["src/**/*.ts"],
  ${BLINDAGEM_NO_BLOCO},
  rules: { complexity: ["error", { max: 10, variant: "classic" }] }
}];\n`;

function dependencyConfig(severity = "error") {
  return {
    forbidden: POLICY.dependencies.rules.map((name) => ({ name, severity, from: {}, to: {} })),
    options: {}
  };
}

function fixture({ vitest = VITEST, eslint = ESLINT, dependency = dependencyConfig(), policy = POLICY } = {}) {
  const root = mkdtempSync(join(tmpdir(), "candidate-config-"));
  const candidate = join(root, "candidate");
  const trusted = join(root, "trusted");
  mkdirSync(join(candidate, "tooling", "toolchain"), { recursive: true });
  mkdirSync(join(trusted, "quality"), { recursive: true });
  mkdirSync(join(trusted, "tooling", "toolchain"), { recursive: true });
  if (vitest !== null) writeFileSync(join(candidate, "vitest.config.ts"), vitest);
  if (eslint !== null) writeFileSync(join(candidate, "eslint.config.mjs"), eslint);
  if (dependency !== null) {
    writeFileSync(join(trusted, "tooling", "toolchain", "dependency-cruiser.json"), JSON.stringify(dependency));
  }
  writeFileSync(join(trusted, "quality", "policy.json"), JSON.stringify(policy));
  // A raiz confiável é EXPOSTA: a interface aponta `--trusted <raiz>`, e é sob ela
  // que o validador resolve `quality/policy.json` e `tooling/toolchain/dependency-cruiser.json`.
  // `candidate` e `trusted` são diretórios irmãos sob a mesma raiz temporária, disjuntos
  // por segmento — nenhum é prefixo do outro —, de modo que a fronteira de confiança é
  // respeitada por construção.
  return { candidate, trusted };
}

function run(fx, extras = []) {
  return spawnSync(process.execPath, [cli, "--candidate", fx.candidate, "--trusted", fx.trusted, ...extras], {
    encoding: "utf8"
  });
}

function assertRejeicao(result, padrao) {
  assert.notEqual(result.status, 0, "configuração foi aprovada indevidamente");
  assert.match(result.stderr, padrao);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at\s/u);
}

test("aceita configuração mínima explícita", () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Configuração candidata compatível com a política confiável.");
});

test("recusa configuração obrigatória ausente", () => {
  const result = run(fixture({ vitest: null }));
  assertRejeicao(result, /configuração obrigatória ausente ou ilegível/i);
});

test("recusa argumento obrigatório ausente", () => {
  const result = spawnSync(process.execPath, [cli, "--candidate", fixture().candidate], { encoding: "utf8" });
  assertRejeicao(result, /uso:/i);
});

test("recusa argumento desconhecido", () => {
  const result = run(fixture(), ["--surpresa"]);
  assertRejeicao(result, /argumento inválido/i);
});

test("recusa exclusão de cobertura que alcança módulos", () => {
  const vitest = VITEST.replace("exclude: []", 'exclude: ["src/modules/**"]');
  const result = run(fixture({ vitest }));
  assertRejeicao(result, /exclusão de cobertura incompatível/i);
});

test("não conta padrões de cobertura escondidos em comentário", () => {
  const vitest = VITEST.replace('["src/modules/**", "src/shared/**"]', "[]")
    .concat('// include: ["src/modules/**", "src/shared/**"]\n');
  const result = run(fixture({ vitest }));
  assertRejeicao(result, /escopo de cobertura incompatível/i);
});

test("recusa ignore de lint que alcança toda a árvore src", () => {
  const eslint = ESLINT.replace("files:", 'ignores: ["**"],\n  files:');
  const result = run(fixture({ eslint }));
  assertRejeicao(result, /ignorar src é proibido/i);
});

test("recusa limiar de cobertura abaixo da política", () => {
  const vitest = VITEST.replace("lines: 80", "lines: 79");
  const result = run(fixture({ vitest }));
  assertRejeicao(result, /limiar de cobertura incompatível/i);
});

test("recusa regra de complexidade desligada", () => {
  const eslint = ESLINT.replace('["error", { max: 10, variant: "classic" }]', '"off"');
  const result = run(fixture({ eslint }));
  assertRejeicao(result, /regra de complexidade incompatível/i);
});

test("recusa máximo de complexidade acima da política", () => {
  const eslint = ESLINT.replace("max: 10", "max: 11");
  const result = run(fixture({ eslint }));
  assertRejeicao(result, /regra de complexidade incompatível/i);
});

test("recusa regra de dependência ausente", () => {
  const dependency = dependencyConfig();
  dependency.forbidden.pop();
  const result = run(fixture({ dependency }));
  assertRejeicao(result, /regras de dependência incompatíveis/i);
});

test("recusa regra de dependência sem severidade error", () => {
  const result = run(fixture({ dependency: dependencyConfig("warn") }));
  assertRejeicao(result, /regras de dependência incompatíveis/i);
});

test("recusa conjunto vazio de regras de dependência", () => {
  const result = run(fixture({ dependency: { forbidden: [], options: {} } }));
  assertRejeicao(result, /regras de dependência incompatíveis/i);
});

test("não aceita cobertura boa em objeto que não é exportado", () => {
  const decoy = 'const decoy = { include: ["src/modules/**", "src/shared/**"], thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 } };\n';
  const vitest = `${decoy}${VITEST.replace('["src/modules/**", "src/shared/**"]', "[]")}`;
  const result = run(fixture({ vitest }));
  assertRejeicao(result, /escopo de cobertura incompatível/i);
});

for (const [name, options] of [
  ["eslint", { eslint: null }],
  ["regras de dependência", { dependency: null }]
]) {
  test(`recusa configuração obrigatória ausente: ${name}`, () => {
    const result = run(fixture(options));
    assertRejeicao(result, /configuração obrigatória ausente ou ilegível/i);
  });
}

// O efeito colateral fica DENTRO da expressão exportada, porque a gramática
// canônica não admite nada além de espaço e comentário antes de "export default".
// Avaliar o módulo dispararia a exceção; ler o texto não.
//
// H3b2a. O caso foi PRESERVADO e a expectativa invertida: o bloco de lint deixou
// de tolerar propriedade desconhecida, e a mesma fixture agora reprova. A prova
// de que a candidata não é avaliada sobrevive à inversão e fica mais forte —
// não basta reprovar, é preciso reprovar SEM que a exceção da candidata tenha
// existido: sem o marcador secreto, sem rastro de pilha e sem a linha de
// aprovação. Se o validador importasse o módulo, o marcador apareceria na
// saída, e é exatamente isso que as três negativas medem.
test("não importa nem avalia a configuração candidata", () => {
  const eslint = ESLINT.replace(
    "\n}];",
    ',\n  boom: (() => { throw new Error("NÃO_EXECUTAR_CONFIGURAÇÃO"); })()\n}];'
  );
  const result = run(fixture({ eslint }));
  assert.notEqual(result.status, 0, "configuração foi aprovada indevidamente");
  assert.doesNotMatch(result.stdout, /compatível com a política confiável/u, "linha de aprovação foi emitida");
  assert.match(result.stderr, /configuração de lint em forma não canônica/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /NÃO_EXECUTAR_CONFIGURAÇÃO/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at\s/u);
});

// H3b3. A propriedade alheia deixou de ter onde morar: os níveis exportado e
// `test` também são fechados, e `note:` reprovaria pela forma antes de o escopo
// ser comparado — o que mediria outra coisa. O carregador que sobra para o
// padrão fora da cadeia efetiva é o comentário, e a pergunta continua a mesma.
test("não conta padrões fora da cadeia efetiva de cobertura", () => {
  const vitest = `// note: ["src/modules/**", "src/shared/**"]\n${VITEST.replace(
    '["src/modules/**", "src/shared/**"]',
    "[]"
  )}`;
  const result = run(fixture({ vitest }));
  assertRejeicao(result, /escopo de cobertura incompatível/i);
});

test("recusa configuração que desativa complexidade em bloco posterior", () => {
  const eslint = ESLINT.replace(
    "}];\n",
    '}, { files: ["src/**"], rules: { complexity: "off" } }];\n'
  );
  const result = run(fixture({ eslint }));
  assertRejeicao(result, /regra de complexidade incompatível/i);
});

// --- Âncoras ambíguas: o validador ancora na PRIMEIRA ocorrência de cada marcador.
// Um chamariz conforme colocado antes da configuração efetiva enfraquecida faz o
// validador aprovar o que o Vitest nunca vai usar. Configuração ambígua deve reprovar.

const STRONG_THRESHOLDS = "thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 }";
const WEAK_THRESHOLDS = "thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 }";
const STRONG_INCLUDE = 'include: ["src/modules/**", "src/shared/**"]';
const WEAK_INCLUDE = "include: []";
const STRONG_EXCLUDE = "exclude: []";
const WEAK_EXCLUDE = 'exclude: ["src/**"]';
const STRONG_COVERAGE = `{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} }`;
const WEAK_COVERAGE = `{ ${WEAK_INCLUDE}, ${WEAK_EXCLUDE}, ${WEAK_THRESHOLDS} }`;

const exportDefault = (body) => `export default ${body};\n`;
const withCoverage = (body) => exportDefault(`{ test: { coverage: ${body} } }`);
// Chamariz fora da cadeia efetiva. Os três níveis inspecionados — exportado,
// `test` e `coverage` — passaram a ter gramática FECHADA, então nenhuma
// propriedade alheia sobrevive para carregar o chamariz: ali ele reprovaria
// pela forma, e não por deixar de ser contado, que é justamente o que estes
// vetores precisam demonstrar. O carregador restante é o comentário, que a
// varredura converte em espaço antes de qualquer leitura estrutural — antes e
// depois do objeto exportado, porque a pergunta é de ordem.
const comChamarizForaDaCadeia = (decoy, coverage, depois = false) => {
  const chamariz = `// test: { coverage: ${decoy} }\n`;
  const efetiva = withCoverage(coverage);
  return depois ? `${efetiva}${chamariz}` : `${chamariz}${efetiva}`;
};

function assertSemVazamentoDaCobertura(result, fx, vitest) {
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at\s/u);
  for (const vazamento of ["src/modules", "src/shared", "src/**", "defineConfig", "__DOC__", fx.candidate]) {
    assert.ok(!result.stderr.includes(vazamento), "mensagem vazou conteúdo inspecionado");
  }
  for (const linha of vitest.split("\n")) {
    const texto = linha.trim();
    if (texto.length > 8) assert.ok(!result.stderr.includes(texto), "mensagem ecoou trecho da candidata");
  }
}

function assertAmbiguidade(result, ancora, fx, vitest) {
  assert.notEqual(result.status, 0, "configuração ambígua foi aprovada indevidamente");
  assert.match(result.stderr, /Configuração candidata reprovada: configuração ambígua/u);
  assert.match(result.stderr, new RegExp(`âncora "${ancora}"`, "u"));
  assert.match(result.stderr, /deslocamentos? \d/u);
  assertSemVazamentoDaCobertura(result, fx, vitest);
}

// A decisão de cobertura deixou de contar âncoras textuais: ela é tomada sobre a
// estrutura efetivamente exportada. O chamariz não satisfaz mais nada, porque a
// propriedade é lida no objeto REAL a que pertence, e a chave repetida reprova
// antes que a última declaração vença. As classes abaixo substituem, caso a caso,
// a antiga mensagem de âncora ambígua; o RESULTADO — reprovar sem vazar conteúdo
// — é o mesmo.
const COBERTURA_ESCOPO = /Configuração candidata reprovada: escopo de cobertura incompatível com a política/u;
const COBERTURA_EXCLUSAO = /Configuração candidata reprovada: exclusão de cobertura incompatível com a política/u;
const COBERTURA_LIMIAR = /Configuração candidata reprovada: limiar de cobertura incompatível com a política/u;
const COBERTURA_NAO_CANONICA =
  /Configuração candidata reprovada: configuração de cobertura em forma não canônica/u;
const COBERTURA_DUPLICADA =
  /Configuração candidata reprovada: configuração ambígua: propriedade de cobertura declarada duas vezes no mesmo objeto/u;

function assertCobertura(result, padrao, fx, vitest) {
  assert.notEqual(result.status, 0, "configuração de cobertura foi aprovada indevidamente");
  assert.doesNotMatch(result.stdout, /compatível com a política confiável/u, "linha de aprovação foi emitida");
  assert.match(result.stderr, padrao);
  assertSemVazamentoDaCobertura(result, fx, vitest);
}

const AMBIGUOS = [
  // export default: o primeiro marcador está dentro de um template literal legítimo.
  [
    'export default: chamariz antes',
    "export default",
    "const banner = `export default defineConfig({ test: { coverage: " +
      `${STRONG_COVERAGE} } })\`;\n${exportDefault(`{ test: { coverage: ${WEAK_COVERAGE} } }`)}`
  ],
  [
    'export default: chamariz depois',
    "export default",
    `${exportDefault(`{ test: { coverage: ${WEAK_COVERAGE} } }`)}` +
      "const banner = `export default defineConfig({ test: { coverage: " +
      `${STRONG_COVERAGE} } })\`;\n`
  ],
];

for (const [nome, ancora, vitest] of AMBIGUOS) {
  test(`recusa âncora ambígua — ${nome}`, () => {
    const fx = fixture({ vitest });
    assertAmbiguidade(run(fx), ancora, fx, vitest);
  });
}

// Mesmos vetores de chamariz e de chave duplicada, agora decididos pela estrutura.
const CHAMARIZ_OU_DUPLICADA = [
  [
    "test: chamariz antes",
    COBERTURA_ESCOPO,
    `// define: { __DOC__: { test: { coverage: ${STRONG_COVERAGE} } } }\n${exportDefault(
      `{ test: { coverage: ${WEAK_COVERAGE} } }`
    )}`
  ],
  [
    "test: chamariz depois",
    COBERTURA_ESCOPO,
    `${exportDefault(
      `{ test: { coverage: ${WEAK_COVERAGE} } }`
    )}// define: { __DOC__: { test: { coverage: ${STRONG_COVERAGE} } } }\n`
  ],
  [
    "test: chave duplicada",
    COBERTURA_DUPLICADA,
    exportDefault(`{ test: { coverage: ${STRONG_COVERAGE} }, test: { coverage: ${WEAK_COVERAGE} } }`)
  ],
  [
    "coverage: chamariz antes",
    COBERTURA_ESCOPO,
    comChamarizForaDaCadeia(STRONG_COVERAGE, WEAK_COVERAGE)
  ],
  [
    "coverage: chamariz depois",
    COBERTURA_ESCOPO,
    comChamarizForaDaCadeia(STRONG_COVERAGE, WEAK_COVERAGE, true)
  ],
  [
    "coverage: chave duplicada",
    COBERTURA_DUPLICADA,
    exportDefault(`{ test: { coverage: ${STRONG_COVERAGE}, coverage: ${WEAK_COVERAGE} } }`)
  ],
  [
    "include: chamariz antes",
    COBERTURA_ESCOPO,
    comChamarizForaDaCadeia(`{ ${STRONG_INCLUDE} }`, `{ ${WEAK_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} }`)
  ],
  [
    "include: chamariz depois",
    COBERTURA_ESCOPO,
    comChamarizForaDaCadeia(`{ ${STRONG_INCLUDE} }`, `{ ${WEAK_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} }`, true)
  ],
  [
    "include: chave duplicada",
    COBERTURA_DUPLICADA,
    withCoverage(`{ ${STRONG_INCLUDE}, ${WEAK_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} }`)
  ],
  [
    "exclude: chamariz antes",
    COBERTURA_EXCLUSAO,
    comChamarizForaDaCadeia(`{ ${STRONG_EXCLUDE} }`, `{ ${STRONG_INCLUDE}, ${WEAK_EXCLUDE}, ${STRONG_THRESHOLDS} }`)
  ],
  [
    "exclude: chamariz depois",
    COBERTURA_EXCLUSAO,
    comChamarizForaDaCadeia(`{ ${STRONG_EXCLUDE} }`, `{ ${STRONG_INCLUDE}, ${WEAK_EXCLUDE}, ${STRONG_THRESHOLDS} }`, true)
  ],
  [
    "exclude: chave duplicada",
    COBERTURA_DUPLICADA,
    withCoverage(`{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${WEAK_EXCLUDE}, ${STRONG_THRESHOLDS} }`)
  ],
  [
    "thresholds: chamariz antes",
    COBERTURA_LIMIAR,
    comChamarizForaDaCadeia(`{ ${STRONG_THRESHOLDS} }`, `{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${WEAK_THRESHOLDS} }`)
  ],
  [
    "thresholds: chamariz depois",
    COBERTURA_LIMIAR,
    comChamarizForaDaCadeia(`{ ${STRONG_THRESHOLDS} }`, `{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${WEAK_THRESHOLDS} }`, true)
  ],
  [
    "thresholds: chave duplicada",
    COBERTURA_DUPLICADA,
    withCoverage(`{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}, ${WEAK_THRESHOLDS} }`)
  ]
];

const LIMIARES = { lines: 80, branches: 75, functions: 80, statements: 80 };

function limiaresCom(metric, transformar) {
  const pares = Object.entries(LIMIARES).map(([nome, limite]) => `${nome}: ${nome === metric ? 0 : limite}`);
  return transformar(pares);
}

for (const [metric, valor] of Object.entries(LIMIARES)) {
  const variantes = [
    [
      `${metric}: chamariz antes`,
      COBERTURA_LIMIAR,
      limiaresCom(metric, (pares) => `{ ${pares.join(", ")} }`),
      `{ thresholds: { ${metric}: ${valor} } }`
    ],
    [
      `${metric}: chamariz depois`,
      COBERTURA_LIMIAR,
      limiaresCom(metric, (pares) => `{ ${pares.join(", ")} }`),
      `{ thresholds: { ${metric}: ${valor} } }`,
      true
    ],
    [
      `${metric}: chave duplicada`,
      COBERTURA_DUPLICADA,
      limiaresCom(
        metric,
        (pares) =>
          `{ ${pares.map((par) => (par.startsWith(`${metric}:`) ? `${metric}: ${valor}, ${par}` : par)).join(", ")} }`
      )
    ]
  ];
  for (const [nome, padrao, thresholds, decoy, depois] of variantes) {
    const coverage = `{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, thresholds: ${thresholds} }`;
    CHAMARIZ_OU_DUPLICADA.push([
      nome,
      padrao,
      decoy === undefined ? withCoverage(coverage) : comChamarizForaDaCadeia(decoy, coverage, depois === true)
    ]);
  }
}

for (const [nome, padrao, vitest] of CHAMARIZ_OU_DUPLICADA) {
  test(`recusa chamariz ou chave duplicada na cobertura — ${nome}`, () => {
    const fx = fixture({ vitest });
    assertCobertura(run(fx), padrao, fx, vitest);
  });
}

// --- Arrays "ignores" do ESLint: a delimitação precisa ser sensível a aspas.
// Um "]" dentro de uma string é bracket expression legítima de glob e não pode
// encerrar o array inspecionado. Todos os arrays "ignores" do arquivo precisam
// ser lidos, porque flat config admite vários blocos.

const REGRAS_LINT = 'rules: { complexity: ["error", { max: 10, variant: "classic" }] }';

// H3b2a. O nível do OBJETO DE CONFIGURAÇÃO passou a ser fechado, e os chamarizes
// textuais que antes viviam em propriedade desconhecida do bloco migraram para
// dentro de `rules`, que continua tolerando regras adicionais. A posição é outra;
// o TEXTO do chamariz e a prova que ele sustenta são os mesmos. O fechamento das
// regras adicionais é trabalho do H3b2b.
const regrasComRuido = (...extras) =>
  `rules: { complexity: ["error", { max: 10, variant: "classic" }]${extras.map((extra) => `, ${extra}`).join("")} }`;

function eslintComIgnores(...listas) {
  const blocos = listas.map((lista, indice) =>
    indice === 0
      ? `{ ignores: [${lista}], files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`
      : `{ ignores: [${lista}] }`
  );
  return `${IMPORT_PARSER}export default [\n  ${blocos.join(",\n  ")}\n];\n`;
}

function assertReprova(result, padrao) {
  assert.notEqual(result.status, 0, "configuração foi aprovada indevidamente");
  assert.doesNotMatch(result.stdout, /compatível com a política confiável/u, "linha de aprovação foi emitida");
  assert.match(result.stderr, padrao);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at\s/u);
}

function assertSemVazamento(result, fx, eslint) {
  assert.ok(!result.stderr.includes(fx.candidate), "mensagem vazou o caminho da candidata");
  for (const trecho of ["src/**", "src/modules/**", "src/shared/**", "**/*.[]]", "docs/", "ignores", "complexity"]) {
    assert.ok(!result.stderr.includes(trecho), `mensagem vazou conteúdo inspecionado: ${trecho}`);
  }
  for (const linha of eslint.split("\n")) {
    const texto = linha.trim();
    if (texto.length > 8) assert.ok(!result.stderr.includes(texto), "mensagem ecoou trecho da candidata");
  }
}

const IGNORES_QUE_ALCANCAM_SRC = [
  ["vetor exato: colchete dentro de string antes de src", ['"**/*.[]]", "src/**"']],
  ["colchete de fechamento em glob antes de src", ['"docs/a]b/**", "src/**"']],
  ["colchete escapado dentro de string", ['"**/*.[\\]]", "src/**"']],
  ["colchetes combinados dentro de string", ['"[[]]", "[]]", "src/**"']],
  ["primeiro array seguro e segundo alcança src", ['"docs/**"', '"**/*.[]]", "src/**"']],
  ["violação em posição intermediária", ['"docs/**"', '"**/*.[]]", "src/**"', '"build/**"']],
  ["violação em posição final", ['"docs/**"', '"build/**"', '"**/*.[]]", "src/**"']],
  ["alcança src/modules", ['"src/modules/**"']],
  ["alcança src/shared", ['"src/shared/**"']],
  ["alcança src/modules em array posterior", ['"docs/**"', '"src/modules/**"']]
];

for (const [nome, listas] of IGNORES_QUE_ALCANCAM_SRC) {
  test(`recusa ignore de lint que alcança src — ${nome}`, () => {
    const eslint = eslintComIgnores(...listas);
    const fx = fixture({ eslint });
    const result = run(fx);
    assertReprova(result, /Configuração candidata reprovada: ignorar src é proibido/u);
    assertSemVazamento(result, fx, eslint);
  });
}

const ESLINT_ARRAY_MALFORMADO = `${IMPORT_PARSER}export default [{
  ignores: ["docs/**",
  files: ["src/**/*.ts"],
  ${BLINDAGEM_NO_BLOCO},
  ${REGRAS_LINT}
}];\n`;

const ESLINT_ARRAY_TRUNCADO = `${ESLINT}const extra = { ignores: [ "docs/**"\n`;

const IGNORES_ILEGIVEIS = [
  ["array malformado", ESLINT_ARRAY_MALFORMADO],
  ["array truncado sem fechamento", ESLINT_ARRAY_TRUNCADO],
  ["conteúdo não textual: identificador", eslintComIgnores("PADROES_IGNORADOS")],
  ["conteúdo não textual: espalhamento", eslintComIgnores('...BASE, "docs/**"')],
  ["conteúdo não textual: número", eslintComIgnores('42, "docs/**"')]
];

for (const [nome, eslint] of IGNORES_ILEGIVEIS) {
  test(`recusa lista de ignores ilegível — ${nome}`, () => {
    const fx = fixture({ eslint });
    const result = run(fx);
    assertReprova(result, /Configuração candidata reprovada: lista de padrões ignorados ilegível ou não textual/u);
    assertSemVazamento(result, fx, eslint);
  });
}

const IGNORES_SEGUROS = [
  ["glob com colchete que não alcança src", eslintComIgnores('"docs/*.[]]"')],
  ["múltiplos arrays seguros", eslintComIgnores('"docs/**"', '"build/**"', '"coverage/[]]/**"')],
  ["sem nenhum ignores", ESLINT]
];

for (const [nome, eslint] of IGNORES_SEGUROS) {
  test(`aceita configuração de lint sem alcance em src — ${nome}`, () => {
    const result = run(fixture({ eslint }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Configuração candidata compatível com a política confiável.");
  });
}

// --- A propriedade que ignora arquivos precisa ser LOCALIZADA antes de se
// decidir se o valor é aceitável. Âncora que exige chave + ":" + "[" deixa
// passar tanto a chave escrita em outra grafia quanto o valor dinâmico, e
// ausência de correspondência vira aprovação silenciosa.

function eslintComPropriedades(...propriedades) {
  const blocos = propriedades.map((propriedade, indice) =>
    indice === 0
      ? `{ ${propriedade}, files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`
      : `{ ${propriedade} }`
  );
  return `${IMPORT_PARSER}export default [\n  ${blocos.join(",\n  ")}\n];\n`;
}

const PADROES_SEGUROS = 'ignores: ["docs/**"]';
const NAO_LITERAL = /Configuração candidata reprovada: lista de padrões ignorados não é um array literal/u;
const ALCANCA_SRC = /Configuração candidata reprovada: ignorar src é proibido/u;

const VALORES_DINAMICOS = [
  ["valor por identificador", "ignores: IGNORES"],
  ["valor por chamada de função", "ignores: buildIgnores()"],
  ["valor por condicional", 'ignores: condition ? ["docs/**"] : ["src/**"]']
];

for (const [nome, propriedade] of VALORES_DINAMICOS) {
  test(`recusa padrões ignorados sem array literal — ${nome} no primeiro bloco`, () => {
    const eslint = eslintComPropriedades(propriedade);
    const fx = fixture({ eslint });
    const result = run(fx);
    assertReprova(result, NAO_LITERAL);
    assertSemVazamento(result, fx, eslint);
  });

  test(`recusa padrões ignorados sem array literal — ${nome} no terceiro bloco`, () => {
    const eslint = eslintComPropriedades(PADROES_SEGUROS, PADROES_SEGUROS, propriedade);
    const fx = fixture({ eslint });
    const result = run(fx);
    assertReprova(result, NAO_LITERAL);
    assertSemVazamento(result, fx, eslint);
  });
}

const CHAVES_LITERAIS_QUE_ALCANCAM_SRC = [
  ["chave em aspas duplas", '"ignores": ["src/**"]'],
  ["chave em aspas simples", "'ignores': [\"src/**\"]"],
  ["chave computada literal", '["ignores"]: ["src/**"]']
];

for (const [nome, propriedade] of CHAVES_LITERAIS_QUE_ALCANCAM_SRC) {
  test(`recusa ignore de lint que alcança src — ${nome} no primeiro bloco`, () => {
    const eslint = eslintComPropriedades(propriedade);
    const fx = fixture({ eslint });
    const result = run(fx);
    assertReprova(result, ALCANCA_SRC);
    assertSemVazamento(result, fx, eslint);
  });

  test(`recusa ignore de lint que alcança src — ${nome} no segundo bloco`, () => {
    const eslint = eslintComPropriedades(PADROES_SEGUROS, propriedade);
    const fx = fixture({ eslint });
    const result = run(fx);
    assertReprova(result, ALCANCA_SRC);
    assertSemVazamento(result, fx, eslint);
  });
}

const CHAVES_LITERAIS_SEGURAS = [
  ["chave em aspas duplas", eslintComPropriedades('"ignores": ["docs/**"]')],
  ["chave em aspas simples", eslintComPropriedades("'ignores': [\"dist/**\"]")],
  ["chave computada em aspas duplas", eslintComPropriedades('["ignores"]: ["coverage/**"]')],
  ["chave computada em aspas simples", eslintComPropriedades("['ignores']: [\"build/**\"]")],
  [
    "grafias diferentes no mesmo arquivo",
    eslintComPropriedades(
      PADROES_SEGUROS,
      '"ignores": ["dist/**"]',
      "'ignores': [\"build/**\"]",
      '["ignores"]: ["coverage/**"]'
    )
  ],
  // A propriedade de apoio não pode repetir "files": chave declarada duas vezes no
  // mesmo objeto é ambígua e reprova por si só.
  // H3b2a. A propriedade de apoio `name:` deixou de ser admitida no bloco e virou
  // COMENTÁRIO na mesma posição: o vetor continua sendo um bloco sem nenhuma
  // propriedade de padrões ignorados, que é o que este caso existe para provar.
  [
    "nenhuma propriedade de padrões ignorados",
    `${IMPORT_PARSER}export default [\n  { /* name: "bloco sem padrões ignorados" */ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }\n];\n`
  ]
];

for (const [nome, eslint] of CHAVES_LITERAIS_SEGURAS) {
  test(`aceita padrões ignorados literais e seguros — ${nome}`, () => {
    const result = run(fixture({ eslint }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Configuração candidata compatível com a política confiável.");
  });
}

// --- Casamento de padrões: a decisão precisa ser determinística e segmentada.
// Um padrão que nomeia o diretório protegido alcança os descendentes dele, com
// ou sem barra final, e "**" casa zero ou mais segmentos. Classes de caracteres
// são legítimas e precisam ser interpretadas, não transformadas em expressão
// regular. Limites estruturais são verificados antes do casamento.

const APROVACAO = "Configuração candidata compatível com a política confiável.";
const NAO_CANONICA = /Configuração candidata reprovada: padrão de caminho em forma não canônica/u;
const LIMITE_PADRAO = /Configuração candidata reprovada: padrão de caminho excede os limites estruturais/u;
const LIMITE_LISTA = /Configuração candidata reprovada: lista de padrões excede os limites estruturais/u;
const LIMITE_ARQUIVO =
  /Configuração candidata reprovada: arquivo de configuração candidata excede o tamanho máximo/u;

// Fusível contra processo residual. Nunca é a asserção principal de um teste.
function runComFusivel(fx) {
  return spawnSync(process.execPath, [cli, "--candidate", fx.candidate, "--trusted", fx.trusted], {
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL"
  });
}

const excludeCom = (lista) => VITEST.replace("exclude: []", `exclude: [${lista}]`);

const DIRETORIO_EM_IGNORES = ["src/", "src", "**/src/**"];

for (const padrao of DIRETORIO_EM_IGNORES) {
  test(`recusa ignore de lint que alcança src — semântica de diretório ${JSON.stringify(padrao)}`, () => {
    const eslint = eslintComIgnores(JSON.stringify(padrao));
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, ALCANCA_SRC);
    assertSemVazamento(result, fx, eslint);
  });
}

const DIRETORIO_EM_EXCLUDE = ["src/modules/", "src/modules", "**/src/modules/**"];

for (const padrao of DIRETORIO_EM_EXCLUDE) {
  test(`recusa exclusão de cobertura que alcança módulos — semântica de diretório ${JSON.stringify(padrao)}`, () => {
    const result = runComFusivel(fixture({ vitest: excludeCom(JSON.stringify(padrao)) }));
    assertReprova(result, /Configuração candidata reprovada: exclusão de cobertura incompatível com a política/u);
  });
}

const CLASSES_INVALIDAS = [
  ["classe sem fechamento", '"docs/[abc/**"'],
  ["classe com intervalo invertido", '"docs/[z-a]/**"'],
  ["padrão iniciado por negação", '"!src/**"']
];

for (const [nome, lista] of CLASSES_INVALIDAS) {
  test(`recusa padrão de caminho em forma não canônica — ${nome}`, () => {
    const eslint = eslintComIgnores(lista);
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, NAO_CANONICA);
    assertSemVazamento(result, fx, eslint);
  });
}

const CLASSES_SEGURAS_EM_EXCLUDE = [
  ["colchete literal no fim do segmento", '"docs/*.[]]"'],
  ["colchete literal como segmento inteiro", '"coverage/[]]/**"']
];

for (const [nome, lista] of CLASSES_SEGURAS_EM_EXCLUDE) {
  test(`aceita classe de caracteres canônica em exclusão de cobertura — ${nome}`, () => {
    const result = runComFusivel(fixture({ vitest: excludeCom(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

test("recusa padrão de caminho com mais segmentos do que o limite", () => {
  const eslint = eslintComIgnores(JSON.stringify(Array.from({ length: 40 }, () => "**").join("/")));
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, LIMITE_PADRAO);
  assertSemVazamento(result, fx, eslint);
});

test("recusa padrão de caminho acima do comprimento máximo", () => {
  const eslint = eslintComIgnores(JSON.stringify(`docs/${"a".repeat(1100)}`));
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, LIMITE_PADRAO);
  assertSemVazamento(result, fx, eslint);
});

test("recusa array de padrões ignorados acima do limite de padrões", () => {
  const eslint = eslintComIgnores(Array.from({ length: 1001 }, (_, i) => `"docs/p${i}/**"`).join(", "));
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, LIMITE_LISTA);
  assertSemVazamento(result, fx, eslint);
});

test("recusa quantidade de arrays de padrões ignorados acima do limite", () => {
  const eslint = eslintComIgnores(...Array.from({ length: 51 }, () => '"docs/**"'));
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, LIMITE_LISTA);
  assertSemVazamento(result, fx, eslint);
});

test("recusa arquivo de configuração candidata acima do tamanho máximo", () => {
  const eslint = `${ESLINT}const padding = "${"a".repeat(1024 * 1024 + 1)}";\n`;
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, LIMITE_ARQUIVO);
  assert.ok(!result.stderr.includes(fx.candidate), "mensagem vazou o caminho da candidata");
});

test("decide de forma determinística padrão com muitos coringas em um único segmento", () => {
  const eslint = eslintComIgnores(JSON.stringify(`${"**".repeat(40)}z`));
  const result = runComFusivel(fixture({ eslint }));
  assert.notEqual(result.signal, "SIGKILL", "processo não terminou dentro do fusível");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

// --- Literal de string nos arrays de padrões precisa ser DECODIFICADO antes do
// casamento. Ler o texto cru entre aspas deixa passar escapes que reconstroem um
// caminho protegido. Literal sem leitura inequívoca reprova sem executar nada.

const EXCLUSAO_INCOMPATIVEL =
  /Configuração candidata reprovada: exclusão de cobertura incompatível com a política/u;
const IGNORES_ILEGIVEL =
  /Configuração candidata reprovada: lista de padrões ignorados ilegível ou não textual/u;

const ESCAPES_QUE_ALCANCAM_SRC = [
  ["escape unicode", '"\\u0073rc/**"'],
  ["escape de barra", '"src\\/**"'],
  ["escape hexadecimal", '"sr\\x63/**"']
];

for (const [nome, lista] of ESCAPES_QUE_ALCANCAM_SRC) {
  test(`recusa ignore de lint que alcança src por ${nome}`, () => {
    const eslint = eslintComIgnores(lista);
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, ALCANCA_SRC);
    assertSemVazamento(result, fx, eslint);
  });
}

const ESCAPES_QUE_ALCANCAM_MODULOS = [
  ["escape unicode", '"\\u0073rc/modules/**"'],
  ["escape de barra", '"src\\/modules/**"'],
  ["escape hexadecimal", '"sr\\x63/modules/**"']
];

for (const [nome, lista] of ESCAPES_QUE_ALCANCAM_MODULOS) {
  test(`recusa exclusão de cobertura que alcança módulos por ${nome}`, () => {
    const result = runComFusivel(fixture({ vitest: excludeCom(lista) }));
    assertReprova(result, EXCLUSAO_INCOMPATIVEL);
  });
}

const ESCAPES_SEGUROS = [
  ["escape unicode", '"do\\u0063s/**"'],
  ["escape de barra", '"docs\\/**"'],
  ["escape hexadecimal", '"do\\x63s/**"']
];

for (const [nome, lista] of ESCAPES_SEGUROS) {
  test(`aceita ignore de lint com ${nome} que decodifica para caminho seguro`, () => {
    const result = runComFusivel(fixture({ eslint: eslintComIgnores(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });

  test(`aceita exclusão de cobertura com ${nome} que decodifica para caminho seguro`, () => {
    const result = runComFusivel(fixture({ vitest: excludeCom(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

const ESLINT_LITERAL_SEM_FECHAMENTO = `${ESLINT}const extra = { ignores: ["docs/**", "build/**]\n};\n`;

const LITERAIS_MALFORMADOS_NO_LINT = [
  ["escape unicode incompleto", eslintComIgnores('"docs\\u12"')],
  ["escape hexadecimal incompleto", eslintComIgnores('"docs\\x4"')],
  ["literal sem fechamento", ESLINT_LITERAL_SEM_FECHAMENTO],
  ["quebra de linha crua no literal", eslintComIgnores('"docs/\n**"')],
  ["elemento por template literal", eslintComIgnores("`docs/**`")],
  // Decisão: "\u{...}" é forma não canônica de literal e reprova sem decodificar.
  ["escape unicode com chaves", eslintComIgnores('"\\u{73}rc/**"')]
];

for (const [nome, eslint] of LITERAIS_MALFORMADOS_NO_LINT) {
  test(`recusa lista de ignores com literal malformado — ${nome}`, () => {
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, IGNORES_ILEGIVEL);
    assertSemVazamento(result, fx, eslint);
  });
}

const LITERAIS_MALFORMADOS_NA_COBERTURA = [
  ["escape unicode incompleto", '"docs\\u12"'],
  ["escape hexadecimal incompleto", '"docs\\x4"'],
  ["quebra de linha crua no literal", '"docs/\n**"'],
  ["elemento por template literal", "`docs/**`"]
];

for (const [nome, lista] of LITERAIS_MALFORMADOS_NA_COBERTURA) {
  test(`recusa exclusão de cobertura com literal malformado — ${nome}`, () => {
    const result = runComFusivel(fixture({ vitest: excludeCom(lista) }));
    assertReprova(result, EXCLUSAO_INCOMPATIVEL);
  });
}

const LITERAIS_CANONICOS_SEGUROS = [
  ["aspas duplas", '"docs/**"'],
  ["aspas simples", "'docs/**'"],
  ["vírgula final", '"docs/**",'],
  ["múltiplos padrões", '"docs/**", "build/**", "coverage/**"'],
  ["classe com colchete literal", '"docs/*.[]]"'],
  ["classe com barra invertida literal", '"docs/*.[\\]]"'],
  ["escape de aspas dentro do literal", '"docs/a\\"b/**"']
  // O vetor "escape de barra invertida" — `"docs/a\\b/**"` no arquivo candidato —
  // saiu daqui: o literal É canônico, mas o valor DECODIFICADO carrega uma
  // contrabarra, e contrabarra no valor decodificado passou a reprovar. O vetor
  // não foi removido: foi INVERTIDO, junto dos demais, no bloco de contrabarra
  // no valor decodificado, ao final deste arquivo.
];

for (const [nome, lista] of LITERAIS_CANONICOS_SEGUROS) {
  test(`aceita literal canônico seguro em ignores — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: eslintComIgnores(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- A configuração de lint precisa ser LIDA como estrutura. Procurar a chave por
// varredura textual aceita qualquer grafia equivalente em JavaScript e qualquer
// composição indireta, porque aí o valor efetivo só existe depois de avaliar o
// módulo. O contrato aceito é estreito de propósito: um único "export default",
// cuja expressão é um array literal de objetos literais, com a propriedade de
// padrões ignorados escrita literalmente no nível superior do objeto.

const NAO_CANONICO_LINT = /Configuração candidata reprovada: configuração de lint em forma não canônica/u;
const IGNORES_DUPLICADO =
  /Configuração candidata reprovada: configuração ambígua: padrões ignorados declarados duas vezes no mesmo bloco/u;

const BLOCO_LINT = `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`;
const exportaLint = (expressao) => `${IMPORT_PARSER}export default ${expressao};\n`;
const arrayLint = (...elementos) => exportaLint(`[${elementos.join(", ")}]`);
const blocoCom = (propriedade) =>
  `{ ${propriedade}, files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`;

const COMPOSICOES_NAO_CANONICAS = [
  ["V04 chamada de ignore global como elemento", arrayLint('globalIgnores(["src/**"])', BLOCO_LINT)],
  ["V04 chamada de ignore global como expressão exportada", exportaLint(`globalIgnores(["src/**"], ${BLOCO_LINT})`)],
  [
    "V05 objeto de configuração referenciado por identificador",
    `const compartilhado = { ignores: ["src/**"] };\n${arrayLint("compartilhado", BLOCO_LINT)}`
  ],
  [
    "V06 espalhamento de array no nível superior",
    `const base = [{ ignores: ["src/**"] }];\n${arrayLint("...base", BLOCO_LINT)}`
  ],
  ["V10 identificador de chave escapado", arrayLint(blocoCom('\\u0069gnores: ["src/**"]'))],
  ["V11 chave citada com escape", arrayLint(blocoCom('"ignore\\u0073": ["src/**"]'))],
  ["V12 chave computada por concatenação", arrayLint(blocoCom('["ign" + "ores"]: ["src/**"]'))],
  ["V13 chave computada por template", arrayLint(blocoCom('[`ignores`]: ["src/**"]'))],
  ["V14 acessador get", arrayLint(blocoCom('get ignores() { return ["src/**"]; }'))],
  ["acessador set", arrayLint(blocoCom("set ignores(valor) { this.lista = valor; }"))],
  ["método com o nome da propriedade", arrayLint(blocoCom('ignores() { return ["src/**"]; }'))],
  ["chave computada dinâmica", arrayLint(blocoCom('[chave]: ["src/**"]'))],
  [
    "espalhamento dentro do objeto de configuração",
    `const base = { ignores: ["src/**"] };\n${arrayLint(blocoCom("...base"))}`
  ],
  ["expressão exportada por chamada", exportaLint(`defineConfig([${BLOCO_LINT}])`)],
  [
    "expressão exportada por identificador",
    `const configuracao = [${BLOCO_LINT}];\n${exportaLint("configuracao")}`
  ],
  ["elemento superior que não é objeto literal", arrayLint(BLOCO_LINT, "outraConfiguracao")],
  [
    "declaração residual depois do array exportado",
    `${arrayLint(BLOCO_LINT)}const extra = { ignores: ["docs/**"] };\n`
  ]
];

for (const [nome, eslint] of COMPOSICOES_NAO_CANONICAS) {
  test(`recusa configuração de lint em forma não canônica — ${nome}`, () => {
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, NAO_CANONICO_LINT);
    assertSemVazamento(result, fx, eslint);
  });
}

test("recusa padrões ignorados declarados duas vezes no mesmo bloco", () => {
  const eslint = arrayLint(
    `{ ignores: ["docs/**"], ignores: ["build/**"], files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`
  );
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, IGNORES_DUPLICADO);
  assertSemVazamento(result, fx, eslint);
});

test("recusa mais de um export default na configuração de lint", () => {
  const eslint = `${arrayLint(BLOCO_LINT)}${arrayLint('{ ignores: ["src/**"] }')}`;
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, /Configuração candidata reprovada: configuração ambígua/u);
  assert.match(result.stderr, /âncora "export default"/u);
  assertSemVazamento(result, fx, eslint);
});

const GRAFIAS_CANONICAS = arrayLint(
  blocoCom('ignores: ["docs/**"]'),
  '{ "ignores": ["dist/**"] }',
  "{ 'ignores': [\"build/**\"] }",
  '{ ["ignores"]: ["coverage/**"] }',
  "{ ['ignores']: [\"reports/**\"] }"
);

const PREAMBULO_LINT = `import js from "@eslint/js";\nconst naoUtilizado = { limite: 10 };\n${arrayLint(BLOCO_LINT)}`;

const RUIDO_TEXTUAL = `// export default [{ ignores: ["src/**"] }]\n/* globalIgnores(["src/**"]) e ... */\n${arrayLint(
  `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${regrasComRuido(
    'name: "ignores: [\\"src/**\\"] ... globalIgnores"'
  )} }`
)}`;

const VIRGULA_FINAL = `${IMPORT_PARSER}export default [\n  { ignores: ["docs/**"], files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT}, },\n];\n`;

// PREAMBULO_LINT deixou de ser aceito: o preâmbulo é código executado pelo ESLint
// ao carregar a configuração, e a gramática canônica admite ali apenas espaço,
// comentário e — desde o H3a — a importação canônica do analisador. Uma segunda
// importação, uma importação de outro pacote ou qualquer declaração continuam
// reprovando. Ver a seção do scanner determinístico.
const LINT_CANONICO_SEGURO = [
  ["configuração canônica sem padrões ignorados", ESLINT],
  ["cinco grafias canônicas da chave", GRAFIAS_CANONICAS],
  ["palavras estruturais apenas em comentário e string", RUIDO_TEXTUAL],
  ["vírgula final no objeto e no array", VIRGULA_FINAL],
  [
    "vários objetos literais com listas seguras",
    arrayLint(blocoCom('ignores: ["docs/**"]'), '{ ignores: ["build/**"] }', '{ files: ["tests/**/*.ts"] }')
  ]
];

for (const [nome, eslint] of LINT_CANONICO_SEGURO) {
  test(`aceita configuração de lint canônica — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- A exigência de complexidade também precisa ser LIDA como estrutura. Contar
// ocorrências textuais de "complexity:" no arquivo inteiro aceita qualquer forma
// que anule a regra depois de escrita: espalhamento, chave repetida, acessador,
// método, chave computada dinâmica e objeto de regras montado indiretamente. Pior:
// um chamariz em propriedade alheia satisfaz a contagem sozinho. Só a regra
// efetivamente associada à chave "rules" pode satisfazer a política.

const REGRA_CANONICA = 'complexity: ["error", { max: 10, variant: "classic" }]';
const blocoRegras = (corpo) => `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, rules: { ${corpo} } }`;

const COMPLEXIDADE_ANULADA = [
  [
    "espalhamento depois da regra válida",
    `const extra = { complexity: "off" };\n${arrayLint(blocoRegras(`${REGRA_CANONICA}, ...extra`))}`,
    NAO_CANONICO_LINT
  ],
  [
    "chave rules repetida com objeto dinâmico por último",
    `const dinamicas = {};\n${arrayLint(`{ files: ["src/**/*.ts"], rules: { ${REGRA_CANONICA} }, rules: dinamicas }`)}`,
    NAO_CANONICO_LINT
  ],
  [
    "objeto de regras dinâmico com chamariz em propriedade alheia",
    `const dinamicas = {};\n${arrayLint(
      `{ files: ["src/**/*.ts"], note: 'rules: { ${REGRA_CANONICA} }', rules: dinamicas }`
    )}`,
    NAO_CANONICO_LINT
  ],
  [
    "chave computada dinâmica que sobrescreve a regra",
    `const chave = "complexity";\n${arrayLint(blocoRegras(`${REGRA_CANONICA}, [chave]: "off"`))}`,
    NAO_CANONICO_LINT
  ],
  [
    "acessador get com o nome da regra",
    arrayLint(blocoRegras(`${REGRA_CANONICA}, get complexity() { return "off"; }`)),
    NAO_CANONICO_LINT
  ],
  [
    "método com o nome da regra",
    arrayLint(blocoRegras(`${REGRA_CANONICA}, complexity() { return "off"; }`)),
    NAO_CANONICO_LINT
  ],
  [
    "espalhamento antes da regra válida",
    `const extra = { complexity: "off" };\n${arrayLint(blocoRegras(`...extra, ${REGRA_CANONICA}`))}`,
    NAO_CANONICO_LINT
  ],
  [
    "chave da regra escrita duas vezes",
    arrayLint(blocoRegras(`${REGRA_CANONICA}, complexity: "off"`)),
    /Configuração candidata reprovada: /u
  ]
];

for (const [nome, eslint, padrao] of COMPLEXIDADE_ANULADA) {
  test(`recusa configuração que anula a regra de complexidade — ${nome}`, () => {
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, padrao);
    assertSemVazamento(result, fx, eslint);
  });
}

const COMPLEXIDADE_INCOMPATIVEL = /Configuração candidata reprovada: regra de complexidade incompatível com a política/u;

const COMPLEXIDADE_FORA_DA_POLITICA = [
  ["valor não é array literal", blocoRegras('complexity: "off"'), COMPLEXIDADE_INCOMPATIVEL],
  ["severidade diferente de error", blocoRegras('complexity: ["warn", { max: 10, variant: "classic" }]'), COMPLEXIDADE_INCOMPATIVEL],
  ["máximo acima da política", blocoRegras('complexity: ["error", { max: 11, variant: "classic" }]'), COMPLEXIDADE_INCOMPATIVEL],
  ["máximo abaixo de um", blocoRegras('complexity: ["error", { max: 0, variant: "classic" }]'), COMPLEXIDADE_INCOMPATIVEL],
  ["máximo não inteiro decimal", blocoRegras('complexity: ["error", { max: 1e1, variant: "classic" }]'), COMPLEXIDADE_INCOMPATIVEL],
  ["variante ausente", blocoRegras('complexity: ["error", { max: 10 }]'), COMPLEXIDADE_INCOMPATIVEL],
  ["variante fora da forma canônica", blocoRegras('complexity: ["error", { max: 10, variant: "modified" }]'), COMPLEXIDADE_INCOMPATIVEL],
  ["opção desconhecida na regra", blocoRegras('complexity: ["error", { max: 10, variant: "classic", maximum: 99 }]'), COMPLEXIDADE_INCOMPATIVEL],
  ["terceiro elemento no array da regra", blocoRegras('complexity: ["error", { max: 10, variant: "classic" }, "extra"]'), COMPLEXIDADE_INCOMPATIVEL],
  ["opções indiretas", `const opcoes = {};\n${arrayLint(blocoRegras('complexity: ["error", opcoes]'))}`, COMPLEXIDADE_INCOMPATIVEL],
  ["acessador dentro das opções", blocoRegras('complexity: ["error", { get max() { return 10; }, variant: "classic" }]'), NAO_CANONICO_LINT],
  ["nenhum objeto de configuração declara a regra", '{ files: ["src/**/*.ts"] }', COMPLEXIDADE_INCOMPATIVEL]
];

for (const [nome, corpo, padrao] of COMPLEXIDADE_FORA_DA_POLITICA) {
  test(`recusa regra de complexidade fora da política — ${nome}`, () => {
    const eslint = corpo.startsWith("{") ? arrayLint(corpo) : corpo;
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, padrao);
    assertSemVazamento(result, fx, eslint);
  });
}

const OUTRAS_REGRAS = '"@typescript-eslint/no-explicit-any": "error", eqeqeq: ["error", "always"]';
const OPCOES_ANINHADAS =
  '"sort-keys": ["error", "asc", { caseSensitive: true, natural: false, opcoes: { profundo: { ativo: true } } }]';

const RUIDO_EM_REGRAS = `/* rules: { complexity: ["error", { max: 99 }] } ... get set */\n${arrayLint(
  blocoRegras(`${REGRA_CANONICA}, "no-restricted-syntax": ["error", { selector: "rules complexity ... get" }]`)
)}`;

const COMPLEXIDADE_CANONICA = [
  ["objeto de regras literal com a regra canônica", arrayLint(blocoRegras(REGRA_CANONICA))],
  ["outras regras estáticas antes e depois", arrayLint(blocoRegras(`${OUTRAS_REGRAS}, ${REGRA_CANONICA}, ${OPCOES_ANINHADAS}`))],
  [
    "vários objetos de configuração com regras estáticas",
    arrayLint(blocoRegras(REGRA_CANONICA), `{ files: ["tests/**/*.ts"], rules: { ${OUTRAS_REGRAS}, ${REGRA_CANONICA} } }`)
  ],
  ["opções da regra em ordem invertida", arrayLint(blocoRegras('complexity: ["error", { variant: "classic", max: 10 }]'))],
  ["aspas simples na severidade e na variante", arrayLint(blocoRegras("complexity: ['error', { max: 9, variant: 'classic' }]"))],
  ["chave da regra citada", arrayLint(blocoRegras(`"complexity": ["error", { max: 10, variant: "classic" }]`))],
  ["palavras estruturais apenas em comentário e string", RUIDO_EM_REGRAS],
  [
    "vírgula final nas opções e no objeto de regras",
    arrayLint(
      `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, rules: { complexity: ["error", { max: 10, variant: "classic", }], }, }`
    )
  ]
];

for (const [nome, eslint] of COMPLEXIDADE_CANONICA) {
  test(`aceita regra de complexidade canônica — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- A remoção de comentários precisa ser um SCANNER determinístico, não uma
// máquina de aspas. Um literal de expressão regular como /'/ ou /"/ inverte a
// paridade das aspas: a partir dali um "/*" que no JavaScript real está dentro de
// uma string vira início de comentário, e todo o trecho até um "*/" igualmente
// interno a outra string é apagado ANTES de a gramática ver o arquivo. A gramática
// então analisa, com rigor perfeito, um texto que não é o programa. A interpolação
// de template é um segundo primitivo com o mesmo efeito.
//
// Além disso, tudo o que antecedia "export default" era descartado sem inspeção. O
// arquivo de configuração é um módulo que a ferramenta EXECUTA: preâmbulo
// arbitrário é código com privilégio no runner.

const TOKEN_FORA_DA_GRAMATICA =
  /Configuração candidata reprovada: token fora da gramática canônica da configuração/u;
const COMENTARIO_ABERTO = /Configuração candidata reprovada: comentário de bloco sem fechamento/u;
const PREAMBULO_EXECUTAVEL =
  /Configuração candidata reprovada: apenas espaços e comentários podem preceder export default/u;
// H3a: o preâmbulo do LINT passou a admitir a importação canônica do analisador,
// e por isso deixou de ser descrito pela mensagem acima — que continua valendo,
// intacta, para a COBERTURA. Os vetores de preâmbulo executável do lint são os
// MESMOS; o que mudou é a classe que os descreve, agora a da gramática do
// preâmbulo. Nenhum vetor foi removido e nenhum passou a aprovar.
const PREAMBULO_LINT_INVALIDO =
  /Configuração candidata reprovada: preâmbulo da configuração de lint fora da gramática canônica/u;

// H3b2a. Os marcadores "/*" e "*/" saíram das propriedades desconhecidas do
// bloco — que deixaram de ser admitidas — e passaram para regras adicionais,
// posição que continua tolerando valor textual. O payload PRESERVADO entre eles
// é o mesmo em cada caso: em P1, o bloco cujo `ignores` alcança src; em P2, a
// regra de complexidade desligada. Se o scanner apagasse o trecho entre os
// marcadores, o payload sumiria e a razão da reprovação mudaria.
const CORPO_P1 = `[{ files: ["src/**/*.ts"], rules: { complexity: ["error", { max: 10, variant: "classic" }], z: '/*' } },
 { ignores: ["src/**"] },
 { rules: { w: '*/' } }]`;

const CORPO_P2 = `[{ files: ["src/**/*.ts"], rules: { complexity: ["error", { max: 10, variant: "classic" }] } },
 { rules: { nota: "/*", complexity: "off", nota2: "*/" } }]`;

// H3b3. Os marcadores migraram de propriedades alheias em `test` — que a
// gramática fechada recusa pela forma, o que mediria outra coisa — para o TEXTO
// de padrões dentro de `coverage`, o único lugar que ainda lê strings.
//
// H3b4. A variante que somava marcadores E literal de expressão regular foi
// DESFEITA, por medição: o `.replace` que instalava o regex sobrescrevia o único
// `*/` da fixture, e a variante combinada ficava com "/*" pendente e nenhum
// fechamento. Pior, ela reprovava por TOKEN — exatamente a mesma classe de um
// regex sem marcador algum —, de modo que nada provava além do que o caso de
// regex já provava. As duas classes são agora medidas separadamente:
//
//   CORPO_P3_REGEX  → recusa LÉXICA (token fora da gramática), sem marcador
//                     nenhum no arquivo, para que o veredito não possa depender
//                     deles;
//   CORPO_P3        → classe SEMÂNTICA (propriedade de cobertura duplicada),
//                     com um par de marcadores DELIBERADO cercando o payload.
//
// O par de CORPO_P3 é inequívoco por construção: nenhum padrão da fixture usa
// "**", justamente porque um glob como "src/shared/**" já contém "/*" e tornaria
// o marcador de abertura indistinguível de subproduto. Aqui o ÚNICO "/*" do
// arquivo é o final de "docs/abre/*" e o ÚNICO "*/" é o final de "docs/fecha*/".
// A unicidade do par e a presença do payload entre eles são ASSERTADAS abaixo,
// em "o par de marcadores da cobertura é único e cerca o payload", junto com o
// contrafactual: apagar o trecho entre os marcadores muda a classe da reprovação.
const CORPO_P3_REGEX = `{ test: { coverage: {
  include: ["docs/apenas"], exclude: /"/,
  thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 }
} } }`;

const CORPO_P3_SEGUNDO_EXCLUDE = 'exclude: ["src/modules/__candidate__.ts"]';
const CORPO_P3_LIMIARES_ZERADOS = "thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 }";

const CORPO_P3 = `{ test: { coverage: {
  include: ["docs/abre/*"], exclude: [],
  thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 },
  ${CORPO_P3_SEGUNDO_EXCLUDE},
  ${CORPO_P3_LIMIARES_ZERADOS},
  include: ["docs/fecha*/"]
} } }`;

// Payloads reproduzidos: a candidata era APROVADA porque o trecho entre marcadores
// internos a strings era apagado antes de a gramática analisar o arquivo. Em P1 e
// P2 o literal de expressão regular vive no preâmbulo e o payload vive entre
// marcadores; em P3 o literal está no próprio valor inspecionado e não há marcador
// algum — o que esta família mede, em todos os três, é a RECUSA LÉXICA.
const PAYLOADS_DE_DESSINCRONIZACAO = [
  [
    "P1 ignores que alcança src escondido por regex no preâmbulo",
    { eslint: `const re = /'/;\nexport default ${CORPO_P1};\n` }
  ],
  ["P2 segundo bloco que desliga a complexidade", { eslint: `const re = /"/;\nexport default ${CORPO_P2};\n` }],
  [
    // Caso 1. Literal de expressão regular REAL no valor de `exclude`. O arquivo
    // não contém "/*" nem "*/", nem dentro de string: a recusa é puramente
    // léxica e nenhum marcador participa do veredito.
    "P3 literal de expressão regular no valor de exclusão da cobertura",
    { vitest: `export default ${CORPO_P3_REGEX};\n` }
  ]
];

for (const [nome, opcoes] of PAYLOADS_DE_DESSINCRONIZACAO) {
  test(`recusa dessincronização léxica por literal de expressão regular — ${nome}`, () => {
    const fx = fixture(opcoes);
    const result = runComFusivel(fx);
    assertReprova(result, TOKEN_FORA_DA_GRAMATICA);
    assertSemVazamento(result, fx, opcoes.eslint ?? opcoes.vitest);
  });
}

// Prova de que o texto candidato NÃO é apagado: os mesmos payloads, sem o literal
// de expressão regular, mantêm os marcadores "/*" e "*/" dentro de strings. Cada um
// reprova pela razão que só existe se o validador enxergar o texto real entre eles.
const TEXTO_EFETIVO_VISIVEL = [
  ["P1 sem regex: o ignores entre os marcadores é lido", { eslint: `export default ${CORPO_P1};\n` }, ALCANCA_SRC],
  [
    "P2 sem regex: o segundo bloco entre os marcadores é lido",
    { eslint: `export default ${CORPO_P2};\n` },
    COMPLEXIDADE_INCOMPATIVEL
  ],
  [
    // Caso 2. Sem regex nenhum: só o par deliberado de marcadores dentro de
    // strings. A razão mudou de âncora contada para propriedade duplicada no
    // MESMO objeto; a prova continua sendo que o segundo "exclude", entre os
    // marcadores, é enxergado pelo validador.
    "P3 sem regex: o segundo exclude entre os marcadores é lido",
    { vitest: `export default ${CORPO_P3};\n` },
    COBERTURA_DUPLICADA
  ]
];

for (const [nome, opcoes, padrao] of TEXTO_EFETIVO_VISIVEL) {
  test(`enxerga o texto efetivo entre marcadores internos a strings — ${nome}`, () => {
    const result = runComFusivel(fixture(opcoes));
    assertReprova(result, padrao);
  });
}

// Sem esta verificação, a prova de P3 dependeria de alguém LER o literal e
// acreditar que existe um par de marcadores cercando o payload. Aqui isso é
// medido: o par é único, o payload está entre os marcadores, o caso de regex não
// tem marcador nenhum e — contrafactual — apagar o trecho entre eles, que é
// exatamente o que um scanner ingênuo faria, muda a classe da reprovação.
const contar = (texto, marcador) => texto.split(marcador).length - 1;

const apagarEntreMarcadores = (texto) => {
  const abre = texto.indexOf("/*");
  const fecha = texto.indexOf("*/", abre + 2);
  assert.ok(abre !== -1 && fecha !== -1, "fixture não tem par de marcadores");
  return `${texto.slice(0, abre)}${texto.slice(fecha + 2)}`;
};

test("o par de marcadores da cobertura é único e cerca o payload", () => {
  assert.equal(contar(CORPO_P3_REGEX, "/*"), 0, "o caso de regex não pode depender de marcador");
  assert.equal(contar(CORPO_P3_REGEX, "*/"), 0, "o caso de regex não pode depender de marcador");

  assert.equal(contar(CORPO_P3, "/*"), 1, "o marcador de abertura precisa ser único, não subproduto de **");
  assert.equal(contar(CORPO_P3, "*/"), 1, "o marcador de fechamento precisa ser único, não subproduto de **");

  const abre = CORPO_P3.indexOf("/*");
  const fecha = CORPO_P3.indexOf("*/");
  for (const payload of [CORPO_P3_SEGUNDO_EXCLUDE, CORPO_P3_LIMIARES_ZERADOS]) {
    const posicao = CORPO_P3.indexOf(payload);
    assert.notEqual(posicao, -1, "payload ausente da fixture");
    assert.ok(abre < posicao && posicao + payload.length < fecha, "payload fora do par de marcadores");
  }

  // O texto que sobraria se o trecho entre os marcadores fosse apagado reprova
  // por OUTRA classe: a classe observada em P3 depende do payload preservado.
  const truncado = apagarEntreMarcadores(CORPO_P3);
  assert.equal(contar(truncado, CORPO_P3_SEGUNDO_EXCLUDE), 0, "o truncamento precisa remover o payload");
  const result = runComFusivel(fixture({ vitest: `export default ${truncado};\n` }));
  assertReprova(result, COBERTURA_ESCOPO);
  assert.doesNotMatch(result.stderr, COBERTURA_DUPLICADA, "a classe não pode sobreviver ao apagamento");
});

// Fronteira do preâmbulo: nada além de espaço e comentário pode preceder o único
// "export default".
const PREAMBULOS_EXECUTAVEIS = [
  ["importação", 'import js from "@eslint/js";\n'],
  ["declaração de constante", "const naoUtilizado = { limite: 10 };\n"],
  ["chamada de função", "configurarAmbiente();\n"],
  ["importação e constante não utilizadas", PREAMBULO_LINT.slice(0, PREAMBULO_LINT.indexOf("export default"))],
  // O vetor "literal de string sem fechamento" migrou de aspas duplas para
  // simples. Motivo medido, não estético: o corpo canônico do lint passou a
  // conter a linha de importação, e um literal aberto com aspas DUPLAS agora
  // fecha na primeira aspa dessa linha, deixando o especificador do pacote fora
  // de literal — ali o "/" não abre comentário e a reprovação passa a ser de
  // TOKEN, antes do preâmbulo. O vetor de token foi preservado em teste próprio,
  // logo abaixo da família de tokens; aqui fica a forma que continua provando o
  // que esta família existe para provar: preâmbulo com código reprova COMO
  // preâmbulo. Não há aspa simples no corpo canônico, então o literal corre até
  // o fim do arquivo e o preâmbulo é lido como a declaração que ele é.
  ["literal de string sem fechamento", "const aberto = 'sem fim\n"],
  ["atribuição em objeto global", "globalThis.__PWN__ = true;\n"]
];

for (const [nome, preambulo] of PREAMBULOS_EXECUTAVEIS) {
  test(`recusa código executável antes de export default — ${nome}`, () => {
    const eslint = `${preambulo}${arrayLint(BLOCO_LINT)}`;
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, PREAMBULO_LINT_INVALIDO);
    assertSemVazamento(result, fx, eslint);
  });
}

test("recusa código executável antes de export default na cobertura", () => {
  const vitest = `const defineConfig = (o) => o;\n${VITEST}`;
  const result = runComFusivel(fixture({ vitest }));
  assertReprova(result, PREAMBULO_EXECUTAVEL);
});

// Tokens fora da gramática canônica: o scanner reprova em vez de adivinhar se um
// "/" abre divisão, expressão regular ou comentário.
const TOKENS_FORA_DA_GRAMATICA = [
  ["literal de expressão regular no preâmbulo", `/x/.test("a");\n${arrayLint(BLOCO_LINT)}`],
  ["interpolação de template no preâmbulo", 'const a = `${"`"}`;\n' + arrayLint(BLOCO_LINT)],
  ["interpolação de template no corpo exportado", arrayLint(blocoCom("nota: `a${b}c`"))],
  ["divisão no corpo exportado", arrayLint(blocoCom("limite: 10 / 2"))]
];

for (const [nome, eslint] of TOKENS_FORA_DA_GRAMATICA) {
  test(`recusa token fora da gramática canônica — ${nome}`, () => {
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, TOKEN_FORA_DA_GRAMATICA);
    assertSemVazamento(result, fx, eslint);
  });
}

// O vetor de aspas duplas não foi removido: ele continua reprovando, e agora
// pela classe que descreve o defeito com mais precisão. O literal aberto com
// aspas duplas fecha na primeira aspa da linha de importação, o especificador do
// pacote fica fora de literal e o "/" que o atravessa não abre comentário
// nenhum. A prova permanece a mesma — literal sem fechamento no preâmbulo nunca
// aprova — e o diagnóstico não ecoa nada da candidata.
test("recusa literal de string sem fechamento no preâmbulo do lint", () => {
  const eslint = `const aberto = "sem fim\n${arrayLint(BLOCO_LINT)}`;
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, TOKEN_FORA_DA_GRAMATICA);
  assertSemVazamento(result, fx, eslint);
});

// O bloco de apoio não pode conter "src/**/*.ts": em JavaScript real o "*/" dentro
// desse padrão FECHA o comentário de bloco, mesmo estando dentro de aspas. O caso
// sem fechamento precisa de um arquivo onde "*/" não ocorra em lugar nenhum.
const BLOCO_SEM_FECHA_COMENTARIO = `{ files: ["src/**"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`;

test("recusa comentário de bloco sem fechamento", () => {
  const eslint = `/* comentário que nunca fecha\n${arrayLint(BLOCO_SEM_FECHA_COMENTARIO)}`;
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, COMENTARIO_ABERTO);
  assertSemVazamento(result, fx, eslint);
});

test("recusa comentário de bloco sem fechamento na cobertura", () => {
  const vitest = `/* comentário que nunca fecha\n${VITEST}`;
  const result = runComFusivel(fixture({ vitest }));
  assertReprova(result, COMENTARIO_ABERTO);
});

// Controles positivos: espaço e comentário antes do export, marcadores de
// comentário como DADOS dentro de strings, e aspas escapadas.
// H3b2a. Os marcadores migraram de propriedade desconhecida do bloco para regra
// adicional dentro de `rules`. O texto é o mesmo e a prova também: se o scanner
// apagasse o trecho entre "/*" e "*/", o objeto de regras deixaria de fechar e a
// configuração canônica reprovaria.
const MARCADORES_EM_STRING = arrayLint(
  `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ignores: ["docs/**"], ${regrasComRuido(
    "z: '/*'",
    "w: '*/'",
    'nota: "// não abre comentário"'
  )} }`
);

const ASPAS_ESCAPADAS = arrayLint(
  `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ignores: ["docs/**"], ${regrasComRuido(
    'nota: "diz \\"/*\\" e segue"'
  )} }`
);

const COMENTARIOS_ANTES = `// somente comentário\n\n/* e um bloco\n   em várias linhas */\n\n${arrayLint(BLOCO_LINT)}`;

const SCANNER_CANONICO_SEGURO = [
  ["comentário de linha, de bloco e espaços antes do único export", COMENTARIOS_ANTES],
  ["marcadores de comentário dentro de strings continuam dados", MARCADORES_EM_STRING],
  ["aspas escapadas dentro de string não encerram o literal", ASPAS_ESCAPADAS]
];

for (const [nome, eslint] of SCANNER_CANONICO_SEGURO) {
  test(`aceita configuração canônica sob o scanner determinístico — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// MUDANÇA DE POLARIDADE registrada, H3b2b: "template sem interpolação é dado"
// saiu da família positiva acima porque o valor de regra adicional passou a
// exigir literal estático, e a crase é o primitivo da interpolação. O vetor NÃO
// foi apagado nem enfraquecido: o que ele existe para provar é que o SCANNER
// trata o template como dado, e isso continua medido aqui pela classe da
// reprovação — forma não canônica do lint, e nunca token fora da gramática, que
// é o que o scanner emitiria se tropeçasse na crase.
test("aceita configuração canônica sob o scanner determinístico — template sem interpolação é dado ao scanner e reprova por forma", () => {
  const eslint = arrayLint(
    `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${regrasComRuido("nota: `apenas texto`")} }`
  );
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, NAO_CANONICO_LINT);
  assert.doesNotMatch(result.stderr, TOKEN_FORA_DA_GRAMATICA, "o scanner tropeçou na crase");
  assertSemVazamento(result, fx, eslint);
});

// Sonda de tamanho: um passo único para frente decide entradas grandes. A asserção
// é a classe da decisão, nunca o tempo de parede; o fusível apenas evita processo
// residual se o comportamento deixar de ser razoável.
test("decide entrada grande de comentário em um único passo", () => {
  const eslint = `/*${"a".repeat(400_000)}*/\n${arrayLint(BLOCO_LINT)}`;
  const result = runComFusivel(fixture({ eslint }));
  assert.notEqual(result.signal, "SIGKILL", "processo não terminou dentro do fusível");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

test("decide entrada grande de literal em um único passo", () => {
  const eslint = `const ruido = "${"a".repeat(400_000)}";\n${arrayLint(BLOCO_LINT)}`;
  const result = runComFusivel(fixture({ eslint }));
  assert.notEqual(result.signal, "SIGKILL", "processo não terminou dentro do fusível");
  assertReprova(result, PREAMBULO_LINT_INVALIDO);
});

// --- O comando de lint opera sobre "src". Uma regra de complexidade declarada
// apenas em blocos cujo escopo não alcança src deixa o gate sem efeito, e
// configuração que torna um gate um no-op é rejeitada. A associação entre o
// escopo e a regra é POR OBJETO: agregar todos os escopos de um lado e todas as
// regras de outro aprovaria um arquivo em que o bloco de src não declara a regra
// e o bloco que declara a regra não é de src.

const COMPLEXIDADE_SEM_ALCANCE =
  /Configuração candidata reprovada: regra de complexidade não alcança os arquivos de src/u;

const blocoComEscopo = (escopo) => `{ files: ${escopo}, ${BLINDAGEM_NO_BLOCO}, rules: { ${REGRA_CANONICA} } }`;
const OUTRA_REGRA = 'eqeqeq: ["error", "always"]';

const ESCOPOS_QUE_NAO_ALCANCAM_SRC = [
  ["escopo apenas de documentação", arrayLint(blocoComEscopo('["docs/**/*.md"]'))],
  ["escopo apenas de testes", arrayLint(blocoComEscopo('["tests/**/*.ts"]'))],
  [
    "bloco de src sem a regra e bloco com a regra fora de src",
    arrayLint(`{ files: ["src/**/*.ts"], rules: { ${OUTRA_REGRA} } }`, blocoComEscopo('["docs/**/*.md"]'))
  ],
  [
    "chamariz de escopo em comentário, string e propriedade alheia",
    `// files: ["src/**/*.ts"]\n${arrayLint(
      `{ files: ["docs/**/*.md"], rules: { ${REGRA_CANONICA}, nota: 'files: ["src/**/*.ts"]', escopos: ["src/**/*.ts"] } }`
    )}`
  ],
  // MIGRAÇÃO H3b2a, Fatia 4. Três vetores saíram desta lista sem perder a
  // intenção: `files: ESCOPOS`, `files: escoposDeSrc()` e `files: [PADRAO]`
  // continuam reprovando, mas agora pela CLASSE DE FORMA, não pela de alcance —
  // um escopo que não é literal não é um escopo que deixou de alcançar src, é um
  // escopo que o validador não pode ler. `lista de escopos vazia` migrou pelo
  // mesmo motivo. Os quatro estão reescritos, um a um, na seção `ESCOPOS FORA DA
  // FORMA LITERAL`, ao lado dos controles que preservam a classe de alcance.
  ["diretório irmão com o mesmo prefixo", arrayLint(blocoComEscopo('["src-legado/**/*.ts"]'))],
  ["extensão fora do conjunto analisado pelo gate", arrayLint(blocoComEscopo('["src/**/*.md"]'))],
  [
    "três blocos e nenhum deles alcança src com a regra",
    arrayLint(
      '{ ignores: ["docs/**"] }',
      `{ files: ["src/**/*.ts"], rules: { ${OUTRA_REGRA} } }`,
      blocoComEscopo('["tests/**/*.ts"]')
    )
  ]
];

for (const [nome, eslint] of ESCOPOS_QUE_NAO_ALCANCAM_SRC) {
  test(`recusa regra de complexidade fora do alcance do gate — ${nome}`, () => {
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, COMPLEXIDADE_SEM_ALCANCE);
    assertSemVazamento(result, fx, eslint);
  });
}

const ESCOPOS_QUE_ALCANCAM_SRC = [
  ["bloco global, sem propriedade de escopo", arrayLint(`{ ${BLINDAGEM_NO_BLOCO}, rules: { ${REGRA_CANONICA} } }`)],
  ["escopo típico de TypeScript em src", arrayLint(blocoComEscopo('["src/**/*.ts"]'))],
  ["escopo por diretório, sem extensão", arrayLint(blocoComEscopo('["src/**"]'))],
  ["escopo de módulos e compartilhados", arrayLint(blocoComEscopo('["src/modules/**/*.ts", "src/shared/**/*.ts"]'))],
  [
    "escopo de src junto de escopos adicionais",
    arrayLint(blocoComEscopo('["docs/**/*.md", "src/**/*.ts", "tests/**/*.ts"]'))
  ],
  [
    "todas as extensões analisadas pelo gate",
    arrayLint(
      blocoComEscopo(
        '["src/**/*.js", "src/**/*.mjs", "src/**/*.cjs", "src/**/*.ts", "src/**/*.mts", "src/**/*.cts", "src/**/*.jsx", "src/**/*.tsx"]'
      )
    )
  ],
  [
    "vários blocos e ao menos um alcança src com a regra",
    arrayLint(
      `{ files: ["docs/**/*.md"], rules: { ${OUTRA_REGRA} } }`,
      blocoComEscopo('["src/**/*.ts"]'),
      '{ ignores: ["build/**"] }'
    )
  ],
  [
    "bloco global com a regra ao lado de bloco restrito sem ela",
    arrayLint(`{ ${BLINDAGEM_NO_BLOCO}, rules: { ${REGRA_CANONICA} } }`, `{ files: ["tests/**/*.ts"], rules: { ${OUTRA_REGRA} } }`)
  ]
];

for (const [nome, eslint] of ESCOPOS_QUE_ALCANCAM_SRC) {
  test(`aceita regra de complexidade que alcança o gate — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- "Ignorar src é proibido" vale para QUALQUER caminho sob src, não para uma
// lista finita de caminhos-testemunha. A decisão é tomada sobre a gramática do
// padrão: primeiro segmento significativo capaz de casar "src", globstar inicial
// ou reescrita por ".." alcançam src e reprovam.

const IGNORES_SOB_SRC = [
  ["subdiretório de domínio", '"src/domain/**"'],
  ["segmento arbitrário sob a raiz protegida", '"src/qualquer-segmento/**"'],
  ["subdiretório sem barra nem globstar", '"src/domain"'],
  ["arquivo único sob a raiz protegida", '"src/main.ts"'],
  ["coringa de um caractere no primeiro segmento", '"s?c/**"'],
  ["classe de caracteres no primeiro segmento", '"s[q-t]c/**"'],
  ["coringa com prefixo no primeiro segmento", '"sr*/**"'],
  ["coringa isolado no primeiro segmento", '"*/domain/**"'],
  ["globstar inicial alcança qualquer diretório, inclusive a raiz protegida", '"**/domain/**"'],
  ["raiz protegida alcançada por barra inicial", '"/src/**"'],
  ["raiz protegida alcançada por prefixo relativo", '"./src/**"'],
  ["reescrita de caminho por segmento pai", '"docs/../src/**"']
];

for (const [nome, lista] of IGNORES_SOB_SRC) {
  test(`recusa ignore de lint que alcança um caminho sob src — ${nome}`, () => {
    const eslint = eslintComIgnores(lista);
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, ALCANCA_SRC);
    assertSemVazamento(result, fx, eslint);
  });
}

const IGNORES_COMPROVADAMENTE_FORA_DE_SRC = [
  ["documentação", '"docs/**"'],
  ["relatórios de cobertura", '"coverage/**"'],
  ["artefatos de build com extensão", '"dist/**/*.js"'],
  ["diretório irmão com o mesmo prefixo", '"src-legado/**"'],
  ["vários caminhos fora da raiz protegida", '"docs/**", "coverage/**", "build/**"']
];

for (const [nome, lista] of IGNORES_COMPROVADAMENTE_FORA_DE_SRC) {
  test(`aceita ignore de lint comprovadamente fora de src — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: eslintComIgnores(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- O alcance do escopo é decidido pela GRAMÁTICA do padrão compilado: a
// pergunta do contrato é se EXISTE algum arquivo de código, com uma das
// extensões analisadas, sob "src", que o padrão pode alcançar. Não é se o padrão
// casa um exemplo conhecido: nenhuma lista finita de diretórios cobre "src/app",
// "src/ui" ou as subárvores que ainda não existem.

const ESCOPOS_DE_SUBARVORES_ARBITRARIAS = [
  ["subárvore de aplicação", '["src/app/**/*.ts"]'],
  ["subárvore de componentes", '["src/components/**/*.tsx"]'],
  ["subárvore de interface", '["src/ui/**/*.jsx"]'],
  ["subárvore de integrações", '["src/integrations/**/*.mts"]'],
  ["subárvore de domínio", '["src/domain/**/*.cts"]'],
  ["subárvore profunda com nomes arbitrários", '["src/a/b/c/d/e/**/*.js"]'],
  ["arquivo único na raiz protegida", '["src/main.ts"]'],
  ["coringa de segmento seguido de globstar", '["src/*/**/*.mjs"]'],
  ["padrão global sem nomear subárvore", '["**/*.ts"]'],
  ["padrão global de qualquer nome", '["**/*"]'],
  ["coringa com prefixo no nome do diretório", '["src/mod*/**/*.ts"]'],
  ["classe de caracteres no nome do diretório", '["src/[a-z]*/**/*.ts"]']
];

for (const [nome, escopo] of ESCOPOS_DE_SUBARVORES_ARBITRARIAS) {
  test(`aceita escopo que alcança código em qualquer subárvore de src — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: arrayLint(blocoComEscopo(escopo)) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

const ESCOPOS_SEM_ARQUIVO_DE_CODIGO_EM_SRC = [
  ["documentação com extensão analisada fora de src", arrayLint(blocoComEscopo('["docs/**/*.ts"]'))],
  ["testes com extensão analisada fora de src", arrayLint(blocoComEscopo('["tests/**/*.tsx"]'))],
  ["marcação sob a raiz protegida", arrayLint(blocoComEscopo('["src/**/*.md"]'))],
  ["dados sob a raiz protegida", arrayLint(blocoComEscopo('["src/**/*.json"]'))],
  [
    "bloco de src sem a regra ao lado de bloco de documentação com a regra",
    arrayLint(`{ files: ["src/**/*.ts"], rules: { ${OUTRA_REGRA} } }`, blocoComEscopo('["docs/**/*.md"]'))
  ]
];

for (const [nome, eslint] of ESCOPOS_SEM_ARQUIVO_DE_CODIGO_EM_SRC) {
  test(`recusa escopo sem arquivo de código sob src — ${nome}`, () => {
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, COMPLEXIDADE_SEM_ALCANCE);
    assertSemVazamento(result, fx, eslint);
  });
}

// --- Um padrão de DIRETÓRIO PURO não alcança caminho de arquivo algum. No
// ESLint, "src" casa o nome do diretório e não os caminhos sob ele: o escopo
// lintaria zero arquivos e o gate de complexidade seria um no-op aprovado. A
// condição de aceitação é alcançar ao menos um CAMINHO DE ARQUIVO sob a raiz
// protegida terminado em uma das extensões analisadas. Alcançar somente um
// diretório NÃO satisfaz, mesmo quando o último segmento é um coringa: um
// segmento curto demais para conter ".<ext>" só pode nomear um diretório.

const ESCOPOS_DE_DIRETORIO_PURO = [
  ["raiz protegida sem barra", '["src"]'],
  ["raiz protegida com barra final", '["src/"]'],
  ["subdiretório de aplicação", '["src/app"]'],
  ["subdiretório de módulos", '["src/modules"]'],
  ["subdiretório com barra final", '["src/modules/"]'],
  ["coringa de um caractere como último segmento", '["src/?"]'],
  ["classe de caracteres como último segmento", '["src/[a-z]"]'],
  ["globstar seguido de segmento curto demais para extensão", '["src/**/[a-z]"]'],
  ["subárvore profunda terminada em diretório", '["src/a/b/c/d/e"]']
];

for (const [nome, escopo] of ESCOPOS_DE_DIRETORIO_PURO) {
  test(`recusa escopo que alcança apenas diretório sob src — ${nome}`, () => {
    const eslint = arrayLint(blocoComEscopo(escopo));
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, COMPLEXIDADE_SEM_ALCANCE);
    assertSemVazamento(result, fx, eslint);
  });
}

// --- A validação dos padrões não pode ser interrompida pela decisão de alcance:
// o primeiro padrão já prova o alcance, e ainda assim o padrão POSTERIOR precisa
// ser validado. Sem as duas etapas separadas, um padrão inválido entraria na
// configuração por carona.

const ESCOPOS_COM_PADRAO_POSTERIOR_INVALIDO = [
  ["negação depois de padrão suficiente", '["src/**/*.ts", "!src/interno/**"]', NAO_CANONICA],
  ["classe sem fechamento depois de padrão suficiente", '["src/**/*.ts", "src/**/*.[jt"]', NAO_CANONICA],
  ["intervalo invertido depois de padrão suficiente", '["src/**/*.ts", "src/**/*.[t-j]s"]', NAO_CANONICA],
  [
    "comprimento acima do limite depois de padrão suficiente",
    `["src/**/*.ts", "src/${"a".repeat(1100)}/**/*.ts"]`,
    LIMITE_PADRAO
  ],
  [
    "número de segmentos acima do limite depois de padrão suficiente",
    `["src/**/*.ts", "${"a/".repeat(40)}x.ts"]`,
    LIMITE_PADRAO
  ]
];

for (const [nome, escopo, classe] of ESCOPOS_COM_PADRAO_POSTERIOR_INVALIDO) {
  test(`recusa escopo cujo padrão posterior é inválido — ${nome}`, () => {
    const eslint = arrayLint(blocoComEscopo(escopo));
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, classe);
    assertSemVazamento(result, fx, eslint);
  });
}

// --- A decisão de cobertura precisa decorrer da ESTRUTURA efetivamente exportada.
// Ancorar em expressões regulares por "test", "coverage", "include", "exclude",
// "thresholds" e pelas métricas aceitava qualquer grafia equivalente em
// JavaScript e qualquer composição indireta: a chave montada por concatenação,
// por template ou por escape descreve a MESMA propriedade que o Vitest aplicaria,
// e o validador não a via. Pior: a exclusão era decidida contra dois
// caminhos-testemunha fixos, de modo que qualquer subárvore com outro nome
// passava intacta.

const cobertura = (corpo) => withCoverage(`{ ${corpo} }`);
const METRICAS_FORTES = "lines: 80, branches: 75, functions: 80, statements: 80";
const LISTA_INCLUDE = STRONG_INCLUDE.slice("include: ".length);
const comLimiares = (corpo) => cobertura(`${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, thresholds: { ${corpo} }`);
const comExclude = (lista) => cobertura(`${STRONG_INCLUDE}, exclude: ${lista}, ${STRONG_THRESHOLDS}`);
const CADEIA_FORTE = `{ test: { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`;

const ESTRUTURA_DE_COBERTURA_RECUSADA = [
  // Envoltório e expressão exportada. NENHUM envoltório é canônico: a expressão
  // exportada precisa ser o objeto literal. `defineConfig` não existe
  // globalmente, o preâmbulo canônico não admite a importação que o traria e
  // carregar o arquivo daria ReferenceError — aceitá-lo aprovaria uma forma que
  // o Vitest nunca conseguiria executar.
  ["envoltório defineConfig", COBERTURA_NAO_CANONICA, `export default defineConfig(${CADEIA_FORTE});\n`],
  ["envoltório defineConfig em várias linhas", COBERTURA_NAO_CANONICA, `export default defineConfig({\n  test: {\n    coverage: {\n      ${STRONG_INCLUDE},\n      ${STRONG_EXCLUDE},\n      ${STRONG_THRESHOLDS}\n    }\n  }\n});\n`],
  ["envoltório com outro nome", COBERTURA_NAO_CANONICA, `export default envolve(${CADEIA_FORTE});\n`],
  ["envoltório aninhado", COBERTURA_NAO_CANONICA, `export default a(b(${CADEIA_FORTE}));\n`],
  ["chamada sem argumento retornando o objeto", COBERTURA_NAO_CANONICA, "export default criar();\n"],
  ["identificador declarado no preâmbulo retornando o objeto", COBERTURA_NAO_CANONICA, `const cfg = ${CADEIA_FORTE};\nexport default cfg;\n`],
  ["segundo argumento em defineConfig", COBERTURA_NAO_CANONICA, `export default defineConfig(${CADEIA_FORTE}, { extra: 1 });\n`],
  ["envoltório diferente de defineConfig", COBERTURA_NAO_CANONICA, `export default criarConfig(${CADEIA_FORTE});\n`],
  ["composição de chamadas no envoltório", COBERTURA_NAO_CANONICA, `export default defineConfig(defineConfig(${CADEIA_FORTE}));\n`],
  ["argumento do envoltório por identificador", COBERTURA_NAO_CANONICA, "export default defineConfig(configuracaoBase);\n"],
  ["expressão exportada por identificador", COBERTURA_NAO_CANONICA, "export default configuracaoBase;\n"],
  ["expressão exportada por array", COBERTURA_NAO_CANONICA, `export default [defineConfig(${CADEIA_FORTE})];\n`],

  // Composição dinâmica: espalhamento em cada nível, inline e com preâmbulo.
  ["espalhamento inline no objeto exportado", COBERTURA_NAO_CANONICA, exportDefault(`{ ...base, test: { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)],
  ["espalhamento inline em test", COBERTURA_NAO_CANONICA, exportDefault(`{ test: { ...base, coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)],
  ["espalhamento inline em coverage", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}, ...base`)],
  ["espalhamento inline em thresholds", COBERTURA_NAO_CANONICA, comLimiares(`${METRICAS_FORTES}, ...fracos`)],
  ["espalhamento com const no preâmbulo no objeto exportado", COBERTURA_NAO_CANONICA, `const base = {};\n${exportDefault(`{ ...base, test: { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)}`],
  ["espalhamento com const no preâmbulo em test", COBERTURA_NAO_CANONICA, `const base = {};\n${exportDefault(`{ test: { ...base, coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)}`],
  ["espalhamento com const no preâmbulo em coverage", COBERTURA_NAO_CANONICA, `const base = {};\n${cobertura(`${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}, ...base`)}`],
  ["espalhamento com const no preâmbulo em thresholds", COBERTURA_NAO_CANONICA, `const fracos = {};\n${comLimiares(`${METRICAS_FORTES}, ...fracos`)}`],

  // Valores por identificador ou por chamada em cada nível inspecionado.
  ["test por identificador", COBERTURA_NAO_CANONICA, exportDefault("{ test: configuracaoDeTeste }")],
  ["coverage por identificador", COBERTURA_NAO_CANONICA, exportDefault("{ test: { coverage: coberturaBase } }")],
  ["include por identificador", COBERTURA_ESCOPO, cobertura(`include: PADROES, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`)],
  ["exclude por identificador", COBERTURA_EXCLUSAO, comExclude("EXCLUSOES")],
  ["thresholds por identificador", COBERTURA_LIMIAR, cobertura(`${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, thresholds: LIMIARES`)],
  ["include por chamada", COBERTURA_ESCOPO, cobertura(`include: padroes(), ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`)],
  ["exclude por condicional", COBERTURA_EXCLUSAO, comExclude('condicao ? [] : ["src/**"]')],

  // Chaves não canônicas em cada nível relevante.
  ["chave test por concatenação", COBERTURA_NAO_CANONICA, exportDefault(`{ ["te" + "st"]: { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)],
  ["chave test por template", COBERTURA_NAO_CANONICA, exportDefault(`{ [\`test\`]: { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)],
  ["chave test citada com escape", COBERTURA_NAO_CANONICA, exportDefault(`{ "tes\\u0074": { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)],
  ["acessador get em test", COBERTURA_NAO_CANONICA, exportDefault(`{ get test() { return { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } }; } }`)],
  ["método com o nome de test", COBERTURA_NAO_CANONICA, exportDefault(`{ test() { return { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } }; } }`)],
  ["chave coverage por concatenação", COBERTURA_NAO_CANONICA, exportDefault(`{ test: { ["cover" + "age"]: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)],
  ["chave coverage por template", COBERTURA_NAO_CANONICA, exportDefault(`{ test: { [\`coverage\`]: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)],
  ["chave coverage citada com escape", COBERTURA_NAO_CANONICA, exportDefault(`{ test: { "coverag\\u0065": { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)],
  ["método com o nome de coverage", COBERTURA_NAO_CANONICA, exportDefault(`{ test: { coverage() { return { ${STRONG_INCLUDE} }; } } }`)],
  ["chave include por concatenação", COBERTURA_NAO_CANONICA, cobertura(`["inc" + "lude"]: ${LISTA_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`)],
  ["chave include por template", COBERTURA_NAO_CANONICA, cobertura(`[\`include\`]: ${LISTA_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`)],
  ["chave include citada com escape", COBERTURA_NAO_CANONICA, cobertura(`"includ\\u0065": ${LISTA_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`)],
  ["acessador get em include", COBERTURA_NAO_CANONICA, cobertura(`get include() { return ${LISTA_INCLUDE}; }, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`)],
  ["chave exclude por concatenação", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, ["ex" + "clude"]: ["src/**"], ${STRONG_THRESHOLDS}`)],
  ["chave exclude por template", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, [\`exclude\`]: ["src/**"], ${STRONG_THRESHOLDS}`)],
  ["chave exclude citada com escape", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, "excl\\u0075de": ["src/**"], ${STRONG_THRESHOLDS}`)],
  ["método com o nome de exclude", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, exclude() { return ["src/**"]; }, ${STRONG_THRESHOLDS}`)],
  ["acessador get em exclude", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, get exclude() { return ["src/**"]; }, ${STRONG_THRESHOLDS}`)],
  ["chave thresholds por concatenação", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ["thre" + "sholds"]: { ${METRICAS_FORTES} }`)],
  ["chave thresholds por template", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, [\`thresholds\`]: { ${METRICAS_FORTES} }`)],
  ["chave thresholds citada com escape", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, "threshold\\u0073": { ${METRICAS_FORTES} }`)],
  ["método com o nome de thresholds", COBERTURA_NAO_CANONICA, cobertura(`${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, thresholds() { return { ${METRICAS_FORTES} }; }`)],
  ["chave de métrica por concatenação", COBERTURA_NAO_CANONICA, comLimiares('["li" + "nes"]: 80, branches: 75, functions: 80, statements: 80')],
  ["chave de métrica por template", COBERTURA_NAO_CANONICA, comLimiares("[`lines`]: 80, branches: 75, functions: 80, statements: 80")],
  ["chave de métrica citada com escape", COBERTURA_NAO_CANONICA, comLimiares('"line\\u0073": 80, branches: 75, functions: 80, statements: 80')],
  ["chave de métrica computada por identificador", COBERTURA_NAO_CANONICA, comLimiares("[chave]: 80, branches: 75, functions: 80, statements: 80")],
  ["acessador get em métrica", COBERTURA_NAO_CANONICA, comLimiares("get lines() { return 80; }, branches: 75, functions: 80, statements: 80")],
  ["método com o nome de métrica", COBERTURA_NAO_CANONICA, comLimiares("lines() { return 80; }, branches: 75, functions: 80, statements: 80")],

  // Limiares fora da política.
  ["métrica ausente", COBERTURA_LIMIAR, comLimiares("lines: 80, branches: 75, functions: 80")],
  ["thresholds ausente", COBERTURA_LIMIAR, cobertura(`${STRONG_INCLUDE}, ${STRONG_EXCLUDE}`)],
  ["valor de métrica inferior à política", COBERTURA_LIMIAR, comLimiares("lines: 79, branches: 75, functions: 80, statements: 80")],
  ["valor de métrica zerado", COBERTURA_LIMIAR, comLimiares("lines: 0, branches: 75, functions: 80, statements: 80")],
  ["métrica por expoente", COBERTURA_LIMIAR, comLimiares("lines: 8e1, branches: 75, functions: 80, statements: 80")],
  ["métrica hexadecimal", COBERTURA_LIMIAR, comLimiares("lines: 0x50, branches: 75, functions: 80, statements: 80")],
  ["métrica textual", COBERTURA_LIMIAR, comLimiares('lines: "80", branches: 75, functions: 80, statements: 80')],
  ["métrica negativa", COBERTURA_LIMIAR, comLimiares("lines: -80, branches: 75, functions: 80, statements: 80")],
  ["métrica com separador decimal", COBERTURA_LIMIAR, comLimiares("lines: 80.5, branches: 75, functions: 80, statements: 80")],

  // Chamarizes: valor forte que não pertence à cadeia efetiva.
  ["chamariz forte em comentário com limiares efetivos fracos", COBERTURA_LIMIAR, `// thresholds: { ${METRICAS_FORTES} }\n${comLimiares("lines: 0, branches: 0, functions: 0, statements: 0")}`],
  // Os chamarizes que viviam em propriedade alheia migraram para os dois
  // carregadores que sobrevivem à gramática fechada: o comentário, que a
  // varredura converte em espaço, e o TEXTO de um padrão de exclusão, lido
  // DENTRO de `coverage`. O segundo é o que mantém viva a distinção
  // string-versus-estrutura: ali o validador lê a string e a trata como
  // caminho, nunca como par chave/valor da configuração.
  ["chamariz forte em texto de padrão de exclusão com limiares efetivos fracos", COBERTURA_LIMIAR, cobertura(`${STRONG_INCLUDE}, exclude: ["docs/${METRICAS_FORTES}/**"], thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 }`)],
  ["chamariz forte em propriedade alheia com limiares efetivos fracos", COBERTURA_LIMIAR, comChamarizForaDaCadeia(`{ thresholds: { ${METRICAS_FORTES} } }`, `{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 } }`)],
  ["chamariz de include em objeto aninhado não associado à cadeia", COBERTURA_ESCOPO, comChamarizForaDaCadeia(`{ coverage: { ${STRONG_INCLUDE} } }`, `{ include: [], ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} }`)],
  ["cadeia completa em comentário e cadeia efetiva fraca", COBERTURA_ESCOPO, `// define: ${CADEIA_FORTE}\n${exportDefault(`{ test: { coverage: { include: [], ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`)}`],

  // Semântica das exclusões protegidas: qualquer caminho alcançável sob as raízes
  // declaradas na política reprova, e nenhum nome de subárvore é enumerado.
  ["exclusão de subárvore privada de módulos", COBERTURA_EXCLUSAO, comExclude('["src/modules/private/**"]')],
  ["exclusão de subárvore arbitrária de módulos", COBERTURA_EXCLUSAO, comExclude('["src/modules/qualquer-subarvore/**"]')],
  ["exclusão de subárvore interna de compartilhados", COBERTURA_EXCLUSAO, comExclude('["src/shared/internal/**"]')],
  ["curinga de segmento que alcança as duas árvores", COBERTURA_EXCLUSAO, comExclude('["src/*/private/**"]')],
  ["curinga parcial no nome da árvore de módulos", COBERTURA_EXCLUSAO, comExclude('["src/mod*/**"]')],
  ["classe de caracteres no nome da árvore de compartilhados", COBERTURA_EXCLUSAO, comExclude('["src/[a-z]hared/**"]')],
  ["globstar inicial alcança qualquer árvore protegida", COBERTURA_EXCLUSAO, comExclude('["**/*.ts"]')],
  ["arquivo único sob a árvore de módulos", COBERTURA_EXCLUSAO, comExclude('["src/modules/indice.ts"]')],
  ["ancestral das árvores protegidas", COBERTURA_EXCLUSAO, comExclude('["src"]')],
  ["reescrita de caminho por segmento pai", COBERTURA_EXCLUSAO, comExclude('["docs/../src/modules/**"]')],
  ["exclusão ausente", COBERTURA_EXCLUSAO, cobertura(`${STRONG_INCLUDE}, ${STRONG_THRESHOLDS}`)],
  ["padrão posterior inválido depois de padrão seguro", NAO_CANONICA, comExclude('["docs/**", "docs/[z-a]/**"]')],
  ["negação em padrão de exclusão", NAO_CANONICA, comExclude('["!docs/**"]')]
];

for (const [nome, padrao, vitest] of ESTRUTURA_DE_COBERTURA_RECUSADA) {
  test(`recusa configuração de cobertura não estrutural — ${nome}`, () => {
    const fx = fixture({ vitest });
    assertCobertura(runComFusivel(fx), padrao, fx, vitest);
  });
}

const ESTRUTURA_DE_COBERTURA_ACEITA = [
  ["objeto literal exportado diretamente", `export default ${CADEIA_FORTE};\n`],
  ["objeto literal exportado em várias linhas", VITEST],
  [
    // H3b3. O vetor que aprovava `plugins`, `globals`, `reporters` e `esbuild`
    // virou negativo em NIVEL_FECHADO_RECUSADO: os níveis exportado e `test`
    // também passaram a ter gramática fechada. O positivo que fica no lugar é a
    // outra metade da mesma regra — o fechamento decide sobre ESTRUTURA, não
    // sobre texto: o nome proibido escrito em comentário não é propriedade.
    "nome de propriedade proibida citado em comentário",
    `// plugins: [], esbuild: { target: "es2022" }\n${exportDefault(
      `{ test: { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} } } }`
    )}`
  ],
  ["limiares acima da política", comLimiares("lines: 100, branches: 100, functions: 100, statements: 100")],
  ["métricas em ordem invertida", comLimiares("statements: 80, functions: 80, branches: 75, lines: 80")],
  [
    "vírgula final nos objetos inspecionados",
    `export default { test: { coverage: { ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, thresholds: { ${METRICAS_FORTES}, }, }, }, };\n`
  ],
  [
    "include com padrões adicionais",
    cobertura(`include: ["src/modules/**", "src/shared/**", "src/app/**"], ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`)
  ],
  ["exclusões comprovadamente fora das árvores protegidas", comExclude('["docs/**", "coverage/**", "tests/x.ts"]')],
  ["exclusão de irmão com o mesmo prefixo da árvore protegida", comExclude('["src-legado/**", "srcx/**"]')]
];

for (const [nome, vitest] of ESTRUTURA_DE_COBERTURA_ACEITA) {
  test(`aceita configuração de cobertura canônica — ${nome}`, () => {
    const result = runComFusivel(fixture({ vitest }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- Divergência de DIALETO entre o verificador e os consumidores reais. O
// matcher próprio não implementa brace expansion nem extglob: ele trata "{a,b}" e
// "@(...)" como sequências literais, enquanto ESLint e Vitest os interpretam como
// sintaxe. Um padrão que o validador julga inofensivo — porque "casa apenas o nome
// literal {src,vendor}" — esvazia o gate no consumidor, que o expande para "src".
// A correção NÃO é implementar o dialeto: é recusar, fail-closed, no lexer do
// segmento, antes de qualquer decisão de alcance. Isso vale para TODOS os
// consumidores do compilador: ignores, files, include e exclude.

const SINTAXE_NAO_SUPORTADA =
  /Configuração candidata reprovada: padrão de caminho usa sintaxe não suportada pelo verificador/u;

const DIALETO_EM_IGNORES = [
  ["brace expansion no primeiro segmento", '"{src,vendor}/**"'],
  ["brace expansion por intervalo numérico", '"{1..3}/**"'],
  ["extglob de alternativa única", '"@(src)/**"'],
  ["extglob de uma ou mais ocorrências", '"+(src)/**"'],
  ["extglob opcional", '"?(src)/**"'],
  ["extglob de zero ou mais ocorrências", '"*(src)/**"'],
  ["extglob de negação no primeiro segmento", '"!(docs)/**"'],
  ["extglob de negação em segmento posterior", '"docs/!(public)/**"']
];

for (const [nome, lista] of DIALETO_EM_IGNORES) {
  test(`recusa dialeto de glob não suportado em ignores — ${nome}`, () => {
    const eslint = eslintComIgnores(lista);
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, SINTAXE_NAO_SUPORTADA);
    assertSemVazamento(result, fx, eslint);
  });
}

// O escopo do lint precisa herdar a mesma proteção, inclusive quando um padrão
// ANTERIOR já provaria o alcance: sem as duas etapas separadas, o padrão em
// dialeto não suportado entraria na configuração por carona.
const DIALETO_EM_ESCOPO = [
  ["extglob no primeiro segmento", '["@(src)/**/*.ts"]'],
  ["brace expansion no primeiro segmento", '["{src,docs}/**/*.ts"]'],
  ["brace expansion depois de padrão suficiente", '["src/**/*.ts", "{a,b}/**/*.ts"]'],
  ["extglob depois de padrão suficiente", '["src/**/*.ts", "@(a|b)/**/*.ts"]']
];

for (const [nome, escopo] of DIALETO_EM_ESCOPO) {
  test(`recusa dialeto de glob não suportado em escopo de lint — ${nome}`, () => {
    const eslint = arrayLint(blocoComEscopo(escopo));
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, SINTAXE_NAO_SUPORTADA);
    assertSemVazamento(result, fx, eslint);
  });
}

const INCLUDE_COM_DIALETO = (adicional) =>
  cobertura(`include: ["src/modules/**", "src/shared/**", "${adicional}"], ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`);

const DIALETO_EM_COBERTURA = [
  ["exclusão com brace expansion", comExclude('["src/{modules,shared}/**"]')],
  ["exclusão com extglob de alternativa única", comExclude('["src/@(modules|shared)/**"]')],
  ["exclusão com extglob de uma ou mais ocorrências", comExclude('["src/+(modules|shared)/**"]')],
  ["exclusão segura seguida de padrão não suportado", comExclude('["docs/**", "src/{a,b}/**"]')],
  ["escopo com padrão adicional em brace expansion", INCLUDE_COM_DIALETO("{a,b}/**")],
  ["escopo com padrão adicional em extglob", INCLUDE_COM_DIALETO("@(a|b)/**")]
];

for (const [nome, vitest] of DIALETO_EM_COBERTURA) {
  test(`recusa dialeto de glob não suportado em cobertura — ${nome}`, () => {
    const fx = fixture({ vitest });
    assertCobertura(runComFusivel(fx), SINTAXE_NAO_SUPORTADA, fx, vitest);
  });
}

// A detecção é LÉXICA: dentro de uma classe de caracteres, "{", "}" e os
// operadores de extglob são caracteres comuns, e fora dela o operador sozinho
// continua sendo literal ou coringa — quem carrega a sintaxe é o parêntese que o
// acompanha. Recusar por busca textual no padrão inteiro reprovaria estes
// controles positivos.
const DIALETO_SEM_SIGNIFICADO_SINTATICO = [
  ["chaves dentro de classe de caracteres", '"docs/[{}]/**"'],
  ["operadores de extglob dentro de classe de caracteres", '"docs/[@+?!]/**"'],
  ["arroba fora de classe sem parêntese seguinte", '"docs/@scope/**"'],
  ["mais fora de classe sem parêntese seguinte", '"docs/+arquivo/**"'],
  ["colchete literal logo após a abertura da classe", '"docs/*.[]]"'],
  ["coringa de um caractere sem parêntese seguinte", '"docs/?ota/**"'],
  ["coringa de segmento sem parêntese seguinte", '"docs/*.md"']
];

for (const [nome, lista] of DIALETO_SEM_SIGNIFICADO_SINTATICO) {
  test(`aceita operador sem significado sintático no dialeto — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: eslintComIgnores(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// Classe sem fechamento continua reprovando pela classe de erro ANTIGA, mesmo
// quando contém uma chave: a nova regra não pode sequestrar esse diagnóstico.
test("classe de caracteres sem fechamento com chave dentro reprova pela classe antiga", () => {
  const eslint = eslintComIgnores('"docs/[{abc/**"');
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, NAO_CANONICA);
  assert.doesNotMatch(result.stderr, SINTAXE_NAO_SUPORTADA, "classe de erro nova sequestrou o diagnóstico antigo");
  assertSemVazamento(result, fx, eslint);
});

// A mensagem descreve a CLASSE do defeito e nada mais: ecoar o padrão devolveria
// ao atacante um canal de eco controlado por ele.
test("a recusa por dialeto não suportado não ecoa o padrão ofensivo", () => {
  const eslint = eslintComIgnores('"{alfa,beta}/**"');
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, SINTAXE_NAO_SUPORTADA);
  for (const fragmento of ["{alfa,beta}", "alfa", "beta", "{", "}", "@(", "+(", "!(", "?(", "*("]) {
    assert.ok(!result.stderr.includes(fragmento), `mensagem vazou fragmento do padrão: ${fragmento}`);
  }
  assertSemVazamento(result, fx, eslint);
});

// Adjudicação: o leitor de literais decodifica "\\{" para "{" e o compilador não
// tem escape de glob. A chave escapada, portanto, CHEGA ao lexer como chave e é
// recusada. Este teste registra o comportamento medido; nenhum suporte a escape é
// introduzido.
test("chave escapada com contrabarra decodifica para chave e reprova pela nova classe", () => {
  const eslint = eslintComIgnores('"docs/\\{a,b\\}/**"');
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, SINTAXE_NAO_SUPORTADA);
  assertSemVazamento(result, fx, eslint);
});

// Adjudicação REVISTA: o parêntese NU, sem operador de extglob antes dele, também
// é sintaxe nos consumidores — entra na expressão regular gerada como grupo — e
// passa a reprovar pela MESMA classe. O teste que registrava a decisão anterior foi
// INVERTIDO, não removido, porque o que mudou é a decisão, não o vetor observado.
test("parêntese sem operador de extglob reprova pela classe de sintaxe não suportada", () => {
  const result = runComFusivel(fixture({ eslint: eslintComIgnores('"docs/(nota)/**"') }));
  assert.match(result.stderr, SINTAXE_NAO_SUPORTADA);
});

// --- Parêntese NU fora de classe de caracteres.
//
// "docs/(nota)/**" pareceria, para este verificador, nomear um diretório literal
// chamado "(nota)". Em picomatch e minimatch o parêntese fora de classe vira grupo
// na expressão regular gerada e o consumidor casaria "docs/nota". É a MESMA
// divergência de dialeto já fechada para brace expansion e extglob, e a resposta é
// a mesma: recusar no lexer do segmento, fail-closed, com a classe já existente.

const PARENTESE_NU_EM_IGNORES = [
  ["parênteses cercando o nome inteiro", '"docs/(nota)/**"'],
  ["parênteses no meio do nome", '"docs/foo(bar)/**"'],
  ["parêntese de fechamento desacompanhado", '"docs/foo)/bar/**"'],
  ["parêntese de abertura como segmento inteiro", '"docs/(/**"'],
  ["parêntese de fechamento como segmento inteiro", '"docs/)/**"']
];

for (const [nome, lista] of PARENTESE_NU_EM_IGNORES) {
  test(`recusa parêntese fora de classe de caracteres — ${nome}`, () => {
    const eslint = eslintComIgnores(lista);
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, SINTAXE_NAO_SUPORTADA);
    assertSemVazamento(result, fx, eslint);
  });
}

// Controles positivos: dentro da classe de caracteres o parêntese é caractere
// comum, em POSIX e em picomatch. `compileClass` consome o conteúdo antes de o laço
// voltar a decidir, então a detecção não pode ser uma busca textual no padrão.
const PARENTESE_EM_CLASSE = [
  ["os dois parênteses dentro da classe", '"docs/[()]/**"'],
  ["parêntese de abertura dentro da classe", '"docs/[(]/**"'],
  ["parêntese de fechamento dentro da classe", '"docs/[)]/**"']
];

for (const [nome, lista] of PARENTESE_EM_CLASSE) {
  test(`aceita parêntese dentro de classe de caracteres — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: eslintComIgnores(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- Precedência entre negação, dialeto e limites estruturais.
//
// "!(" no início do padrão é extglob e precisa da classe de DIALETO. Qualquer outro
// "!" inicial é negação e precisa da classe de FORMA NÃO CANÔNICA, decidida antes
// dos limites estruturais: um padrão negado longo ou profundo que recebesse o
// diagnóstico de limite descreveria o defeito errado e esconderia a negação.

function assertNegacaoNaoCanonica(result, fx, eslint) {
  assertReprova(result, NAO_CANONICA);
  assert.doesNotMatch(result.stderr, SINTAXE_NAO_SUPORTADA, "diagnóstico de dialeto sequestrou a negação");
  assert.doesNotMatch(result.stderr, LIMITE_PADRAO, "diagnóstico de limite sequestrou a negação");
  assertSemVazamento(result, fx, eslint);
}

const NEGACAO_NAO_CANONICA = [
  ["negação seguida de brace expansion", "!{a,b}/**"],
  ["negação com mais segmentos do que o limite", `!${Array.from({ length: 41 }, () => "**").join("/")}`],
  ["negação acima do comprimento máximo", `!docs/${"a".repeat(1100)}`],
  ["negação com parêntese em segmento posterior", "!docs/(x)/**"],
  ["negação isolada", "!"],
  ["negação seguida de parêntese de fechamento", "!)"]
];

for (const [nome, padrao] of NEGACAO_NAO_CANONICA) {
  test(`recusa padrão negado pela classe de forma não canônica — ${nome}`, () => {
    const eslint = eslintComIgnores(JSON.stringify(padrao));
    const fx = fixture({ eslint });
    assertNegacaoNaoCanonica(runComFusivel(fx), fx, eslint);
  });
}

// O extglob de negação é a única exceção e mantém a classe de dialeto, agora
// decidida também antes dos limites estruturais.
const NEGACAO_COM_EXTGLOB = [
  ["extglob de negação no primeiro segmento", "!(docs)/**"],
  ["abertura de extglob de negação isolada", "!("]
];

for (const [nome, padrao] of NEGACAO_COM_EXTGLOB) {
  test(`recusa extglob de negação pela classe de dialeto — ${nome}`, () => {
    const eslint = eslintComIgnores(JSON.stringify(padrao));
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, SINTAXE_NAO_SUPORTADA);
    assert.doesNotMatch(result.stderr, NAO_CANONICA, "diagnóstico de negação sequestrou o extglob");
    assertSemVazamento(result, fx, eslint);
  });
}

// --- Classes ANINHADAS dentro de classe de caracteres: o último vetor da família
// de divergência de dialeto.
//
// `compileClass` trata a primeira "]" interna como fechamento da classe EXTERNA.
// Em "[[:alpha:]]rc" o verificador lê a classe como "[:alpha:", devolve o "]"
// seguinte como caractere literal e o padrão passa a casar "a]rc" — um nome que
// não existe. minimatch lê "[[:alpha:]]" como UM caractere alfabético e casa
// "src": o consumidor ignoraria a raiz protegida inteira enquanto o verificador
// aprova. É a mesma divergência já fechada para brace expansion, extglob e
// parêntese nu, e a resposta é a mesma: recusar, fail-closed, pela classe de
// sintaxe não suportada.
//
// A recusa é por FAMÍLIA SINTÁTICA, não por vocabulário: nenhum nome de classe
// POSIX é enumerado e nada é interpretado. Dentro de `compileClass`, antes de
// aceitar um "[" como membro literal, o caractere seguinte decide — ":" abre
// classe nomeada, "." abre símbolo de colação e "=" abre classe de equivalência.
// Nenhuma expressão regular participa da decisão.

function assertClasseAninhada(result, fx, eslint) {
  assertReprova(result, SINTAXE_NAO_SUPORTADA);
  assert.doesNotMatch(result.stderr, NAO_CANONICA, "diagnóstico de forma não canônica sequestrou a classe aninhada");
  assert.doesNotMatch(result.stderr, LIMITE_PADRAO, "diagnóstico de limite sequestrou a classe aninhada");
  assert.doesNotMatch(result.stderr, ALCANCA_SRC, "diagnóstico de alcance sequestrou a classe aninhada");
  assertSemVazamento(result, fx, eslint);
}

const CLASSE_ANINHADA_EM_IGNORES = [
  ["classe nomeada cobrindo o primeiro caractere do nome", "[[:alpha:]]rc/**"],
  ["classe nomeada no meio do nome", "s[[:alpha:]]c/**"],
  ["classe nomeada sob a raiz protegida", "src/[[:digit:]]*/**"],
  ["classe nomeada em segmento posterior", "docs/[[:digit:]]/**"],
  ["símbolo de colação", "[[.ch.]]/**"],
  ["classe de equivalência", "[[=a=]]/**"],
  ["classe nomeada dentro de classe negada por exclamação", "docs/[![:alpha:]]/**"],
  ["classe nomeada dentro de classe negada por circunflexo", "docs/[^[:alpha:]]/**"]
];

for (const [nome, padrao] of CLASSE_ANINHADA_EM_IGNORES) {
  test(`recusa classe aninhada de dialeto POSIX em ignores — ${nome}`, () => {
    const eslint = eslintComIgnores(JSON.stringify(padrao));
    const fx = fixture({ eslint });
    assertClasseAninhada(runComFusivel(fx), fx, eslint);
  });
}

// O marcador de abertura basta: um marcador sem o fechamento correspondente
// continua sendo a mesma família sintática e não tem leitura inequívoca aqui.
// Recusar apenas a forma completa deixaria a decisão depender de reconhecer o
// vocabulário, que é exatamente o que esta regra não faz.
const MARCADOR_ANINHADO_TRUNCADO = [
  ["abertura de classe nomeada sem fechamento", "docs/[[:]/**"],
  ["abertura de símbolo de colação sem fechamento", "docs/[[.]/**"],
  ["abertura de classe de equivalência sem fechamento", "docs/[[=]/**"],
  ["classe nomeada sem o colchete externo de fechamento", "docs/[[:alpha:]/**"]
];

for (const [nome, padrao] of MARCADOR_ANINHADO_TRUNCADO) {
  test(`recusa marcador de classe aninhada pelo caractere de abertura — ${nome}`, () => {
    const eslint = eslintComIgnores(JSON.stringify(padrao));
    const fx = fixture({ eslint });
    assertClasseAninhada(runComFusivel(fx), fx, eslint);
  });
}

// O escopo do lint herda a proteção, inclusive quando um padrão ANTERIOR já
// provaria o alcance: sem as duas etapas separadas, a classe aninhada entraria na
// configuração por carona e o gate seria decidido antes de o dialeto ser visto.
const CLASSE_ANINHADA_EM_ESCOPO = [
  ["classe nomeada no primeiro segmento", '["[[:alpha:]]rc/**/*.ts"]'],
  ["classe nomeada depois de padrão suficiente", '["src/**/*.ts", "[[:alpha:]]rc/**/*.ts"]'],
  ["símbolo de colação depois de padrão suficiente", '["src/**/*.ts", "[[.ch.]]/**/*.ts"]']
];

for (const [nome, escopo] of CLASSE_ANINHADA_EM_ESCOPO) {
  test(`recusa classe aninhada de dialeto POSIX em escopo de lint — ${nome}`, () => {
    const eslint = arrayLint(blocoComEscopo(escopo));
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, SINTAXE_NAO_SUPORTADA);
    assert.doesNotMatch(result.stderr, NAO_CANONICA, "diagnóstico de forma não canônica sequestrou a classe aninhada");
    assert.doesNotMatch(result.stderr, LIMITE_PADRAO, "diagnóstico de limite sequestrou a classe aninhada");
    assert.doesNotMatch(
      result.stderr,
      COMPLEXIDADE_SEM_ALCANCE,
      "diagnóstico de alcance da complexidade sequestrou a classe aninhada"
    );
    assertSemVazamento(result, fx, eslint);
  });
}

const CLASSE_ANINHADA_EM_COBERTURA = [
  ["exclusão que alcançaria a árvore de módulos", comExclude('["src/[[:alpha:]]odules/**"]'), COBERTURA_EXCLUSAO],
  ["exclusão que alcançaria a árvore de compartilhados", comExclude('["src/[[:alpha:]]hared/**"]'), COBERTURA_EXCLUSAO],
  ["exclusão com símbolo de colação", comExclude('["[[.ch.]]/**"]'), COBERTURA_EXCLUSAO],
  ["exclusão segura seguida de classe nomeada", comExclude('["docs/**", "src/[[:digit:]]*/**"]'), COBERTURA_EXCLUSAO],
  ["escopo com padrão adicional em classe nomeada", INCLUDE_COM_DIALETO("[[:alpha:]]bc/**"), COBERTURA_ESCOPO],
  ["escopo com padrão adicional em classe de equivalência", INCLUDE_COM_DIALETO("[[=a=]]/**"), COBERTURA_ESCOPO]
];

for (const [nome, vitest, vizinha] of CLASSE_ANINHADA_EM_COBERTURA) {
  test(`recusa classe aninhada de dialeto POSIX em cobertura — ${nome}`, () => {
    const fx = fixture({ vitest });
    const result = runComFusivel(fx);
    assertCobertura(result, SINTAXE_NAO_SUPORTADA, fx, vitest);
    assert.doesNotMatch(result.stderr, NAO_CANONICA, "diagnóstico de forma não canônica sequestrou a classe aninhada");
    assert.doesNotMatch(result.stderr, LIMITE_PADRAO, "diagnóstico de limite sequestrou a classe aninhada");
    assert.doesNotMatch(result.stderr, vizinha, "diagnóstico de cobertura sequestrou a classe aninhada");
  });
}

// Controles positivos de fronteira. A regra olha UM caractere: o que segue um "["
// INTERNO à classe. Sem "[" interno não há marcador, e ":" , "." e "=" seguem
// membros comuns — "docs/[:alpha:]/**" é uma bracket expression ordinária cujos
// membros são ":", "a", "l", "p" e "h". Um "[" interno seguido de qualquer outro
// caractere também permanece membro comum. Recusar por busca textual de "[[",
// "[:" ou ":]" no padrão inteiro reprovaria todos estes.
const CLASSE_SEM_MARCADOR_ANINHADO = [
  ["dois-pontos e letras como membros comuns", '"docs/[:alpha:]/**"'],
  ["dois-pontos como único membro", '"docs/[:]/**"'],
  ["ponto como único membro", '"docs/[.]/**"'],
  ["igual como único membro", '"docs/[=]/**"'],
  ["ponto entre letras", '"docs/[a.b]/**"'],
  ["igual entre letras", '"docs/[a=b]/**"'],
  ["colchete de abertura literal como único membro", '"docs/[[]/**"'],
  ["colchete de abertura literal no meio da classe", '"docs/[a[b]/**"'],
  ["colchete de abertura literal seguido de letra", '"docs/[[a]/**"'],
  ["colchete de abertura literal em classe negada", '"docs/[![]/**"']
];

for (const [nome, lista] of CLASSE_SEM_MARCADOR_ANINHADO) {
  test(`aceita classe de caracteres sem marcador aninhado — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: eslintComIgnores(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// Controles positivos das formas de classe já suportadas: a regra nova não altera
// intervalo, negação canônica nem o "]" literal logo após a abertura.
const CLASSE_CANONICA_PRESERVADA = [
  ["intervalo de letras", '"docs/[a-z]/**"'],
  ["intervalo de dígitos", '"docs/[0-9]/**"'],
  ["parênteses como membros comuns", '"docs/[()]/**"'],
  ["chaves como membros comuns", '"docs/[{}]/**"'],
  ["operadores de extglob como membros comuns", '"docs/[@+?!]/**"'],
  ["colchete de fechamento literal logo após a abertura", '"docs/*.[]]"'],
  ["classe negada por exclamação", '"docs/[!abc]/**"'],
  ["classe negada por circunflexo", '"docs/[^abc]/**"'],
  ["colchete de fechamento literal em classe negada", '"docs/[!]]/**"']
];

for (const [nome, lista] of CLASSE_CANONICA_PRESERVADA) {
  test(`preserva a semântica das classes de caracteres já suportadas — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: eslintComIgnores(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// A mensagem descreve a CLASSE do defeito e nada mais: nenhum fragmento do
// marcador nem do vocabulário POSIX pode voltar ao autor do padrão.
test("a recusa por classe aninhada não ecoa o padrão ofensivo", () => {
  const eslint = eslintComIgnores('"[[:alpha:]]rc/**"');
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, SINTAXE_NAO_SUPORTADA);
  for (const fragmento of ["[[:", ":]]", "alpha", "[[.", "[[=", "[", "]"]) {
    assert.ok(!result.stderr.includes(fragmento), `mensagem vazou fragmento do padrão: ${fragmento}`);
  }
  assertSemVazamento(result, fx, eslint);
});

// --- Contrabarra no valor DECODIFICADO do padrão.
//
// Há DUAS decodificações em série, e confundi-las inverte o veredito:
//
//   1. o literal no arquivo candidato, que o leitor de literais decodifica —
//      `"\*"` entrega `*`, e a contrabarra DESAPARECE;
//   2. o valor decodificado, que é o único sobre o qual o compilador de padrões
//      decide.
//
// Por isso cada vetor desta família precisa de DUAS contrabarras no arquivo
// candidato para entregar UMA ao glob, e os literais abaixo são montados com
// `String.raw` para que o motor JS deste arquivo de teste não consuma nenhuma
// antes de o texto chegar ao disco. Um bloco de prova, adiante, mede as duas
// etapas carregando o mesmo literal como módulo ES real.
//
// O dialeto canônico usa "/" como separador e NÃO oferece sintaxe de escape
// dentro do glob. Em `src/\*/**/*.ts` o verificador lê "\" como caractere comum
// e "*" como coringa, conclui que o escopo alcança arquivos sob a raiz protegida
// e aprova; picomatch lê `\*` como asterisco LITERAL escapado, o ESLint procura
// um diretório chamado literalmente "*", não encontra nada, e o gate de
// complexidade cobre zero arquivo. O verificador acredita em um alcance que o
// consumidor não tem — a mesma divergência de dialeto de chaves, extglob,
// parêntese nu e classe aninhada, e a mesma resposta: recusar, fail-closed, pela
// classe de sintaxe não suportada, sem interpretar escape, sem converter "\" em
// "/" e sem distinguir separador de Windows de caractere de escape. Qualquer uma
// dessas interpretações criaria uma divergência nova.

const CONTRABARRA = "\\";
const contaContrabarras = (texto) => [...texto].filter((caractere) => caractere === CONTRABARRA).length;
const comoLiteral = (padrao) => `"${padrao}"`;
const listaLiteral = (...padroes) => `[${padroes.map(comoLiteral).join(", ")}]`;

// Texto EXATO do literal como ele é gravado no arquivo candidato. Duas
// contrabarras aqui, uma contrabarra no valor que chega ao glob.
const ESCAPADO = {
  estrela: String.raw`src/\\*/**/*.ts`,
  interrogacao: String.raw`src/\\?rc/**/*.ts`,
  colchete: String.raw`src/\\[a]/**/*.ts`,
  comum: String.raw`src/a\\b/**/*.ts`,
  separadorEmEscopo: String.raw`src\\modules\\**\\*.ts`,
  raizEmIgnores: String.raw`\\src/**`,
  separadorEmIgnores: String.raw`src\\**`,
  estrelaEmIgnores: String.raw`src/\\*/**`,
  classeEmIgnores: String.raw`docs/[\\]]/**`,
  intervaloEmIgnores: String.raw`docs/[a-\\]/**`,
  comumEmIgnores: String.raw`docs/a\\b/**`,
  modulos: String.raw`\\src/modules/**`,
  compartilhados: String.raw`src/\\shared/**`,
  classeEmExclude: String.raw`src/[\\]m]odules/**`,
  include: String.raw`a\\b/**`,
  negado: String.raw`!src/a\\b/**`
};

// UMA contrabarra no arquivo candidato: o leitor a consome e o valor que chega
// ao glob NÃO tem contrabarra nenhuma. São o controle que separa a decisão sobre
// o valor decodificado de uma decisão sobre os bytes do arquivo.
const CONSUMIDO = {
  estrela: String.raw`docs/\*.md`,
  interrogacao: String.raw`docs/\?ota/**`,
  escopo: String.raw`src/\*/**/*.ts`
};

// Prova das duas etapas, sem confiar na aparência do código-fonte: o mesmo
// literal é gravado em um módulo ES real, importado, e as contrabarras são
// contadas antes e depois da decodificação do motor JS.
async function valorEntreguePeloMotorJs(literal) {
  const raiz = mkdtempSync(join(tmpdir(), "candidate-literal-"));
  const arquivo = join(raiz, "literal.mjs");
  writeFileSync(arquivo, `export default [${comoLiteral(literal)}];\n`);
  return (await import(pathToFileURL(arquivo).href)).default[0];
}

const PROVA_DE_DECODIFICACAO = [
  ...Object.entries(ESCAPADO).map(([nome, literal]) => [nome, literal, true]),
  ...Object.entries(CONSUMIDO).map(([nome, literal]) => [`${nome} com uma contrabarra`, literal, false])
];

for (const [nome, literal, entregaContrabarra] of PROVA_DE_DECODIFICACAO) {
  test(`o literal candidato entrega ao glob a quantidade medida de contrabarras — ${nome}`, async () => {
    const noArquivo = contaContrabarras(literal);
    const valor = await valorEntreguePeloMotorJs(literal);
    const noValor = contaContrabarras(valor);
    assert.ok(noArquivo > 0, "o literal não tem contrabarra nenhuma no arquivo candidato");
    assert.equal(noValor > 0, entregaContrabarra, "a fixture não entrega ao glob a contrabarra que pretende testar");
    // Par escapado entrega metade; contrabarra consumida pelo leitor entrega nada.
    assert.equal(noValor, entregaContrabarra ? noArquivo / 2 : 0, "contagem inesperada no valor decodificado");
  });
}

function assertContrabarra(result, fx, eslint, vizinha) {
  assertReprova(result, SINTAXE_NAO_SUPORTADA);
  assert.doesNotMatch(result.stderr, NAO_CANONICA, "diagnóstico de forma não canônica sequestrou a contrabarra");
  assert.doesNotMatch(result.stderr, LIMITE_PADRAO, "diagnóstico de limite sequestrou a contrabarra");
  assert.doesNotMatch(result.stderr, vizinha, "diagnóstico vizinho sequestrou a contrabarra");
  assertSemVazamento(result, fx, eslint);
}

// Escopo do lint. `src/\*/**/*.ts` e `src/\?rc/**/*.ts` APROVAVAM: o verificador
// os lê como alcançando arquivos sob a raiz protegida. `src\modules\**\*.ts` já
// reprovava, mas pela classe ERRADA — "a regra de complexidade não alcança os
// arquivos de src" descreve o sintoma e esconde o dialeto.
const CONTRABARRA_EM_ESCOPO = [
  ["contrabarra antes do coringa de segmento", listaLiteral(ESCAPADO.estrela)],
  ["contrabarra antes do coringa de um caractere", listaLiteral(ESCAPADO.interrogacao)],
  ["contrabarra antes da abertura de classe", listaLiteral(ESCAPADO.colchete)],
  ["contrabarra antes de caractere comum", listaLiteral(ESCAPADO.comum)],
  ["contrabarra como separador de diretório", listaLiteral(ESCAPADO.separadorEmEscopo)],
  ["padrão válido antes do padrão com contrabarra", listaLiteral("src/**/*.ts", ESCAPADO.estrela)]
];

for (const [nome, escopo] of CONTRABARRA_EM_ESCOPO) {
  test(`recusa contrabarra no valor decodificado em escopo de lint — ${nome}`, () => {
    const eslint = arrayLint(blocoComEscopo(escopo));
    const fx = fixture({ eslint });
    assertContrabarra(runComFusivel(fx), fx, eslint, COMPLEXIDADE_SEM_ALCANCE);
  });
}

// Padrões ignorados. `\src/**` é o vetor mais direto: o verificador lê quatro
// caracteres comuns, conclui que o padrão não nomeia a raiz protegida e APROVA;
// picomatch lê `\s` como "s" literal e o consumidor ignora a árvore de src
// inteira. `src/\*/**` já reprovava, mas por "ignorar src é proibido".
const CONTRABARRA_EM_IGNORES = [
  ["escape de letra que o consumidor lê como a raiz protegida", comoLiteral(ESCAPADO.raizEmIgnores)],
  ["contrabarra como separador de diretório", comoLiteral(ESCAPADO.separadorEmIgnores)],
  ["contrabarra antes do coringa sob a raiz protegida", comoLiteral(ESCAPADO.estrelaEmIgnores)],
  ["contrabarra antes de caractere comum", comoLiteral(ESCAPADO.comumEmIgnores)],
  ["contrabarra como membro de classe de caracteres", comoLiteral(ESCAPADO.classeEmIgnores)],
  ["contrabarra como limite superior de intervalo", comoLiteral(ESCAPADO.intervaloEmIgnores)],
  ["padrão seguro antes do padrão com contrabarra", `"docs/**", ${comoLiteral(ESCAPADO.raizEmIgnores)}`]
];

for (const [nome, lista] of CONTRABARRA_EM_IGNORES) {
  test(`recusa contrabarra no valor decodificado em ignores — ${nome}`, () => {
    const eslint = eslintComIgnores(lista);
    const fx = fixture({ eslint });
    assertContrabarra(runComFusivel(fx), fx, eslint, ALCANCA_SRC);
  });
}

// Cobertura. `\src/modules/**` e `src/\shared/**` APROVAVAM como exclusões: o
// verificador não vê alcance nenhum sobre as árvores protegidas, enquanto o
// consumidor esvazia a cobertura exatamente delas.
const CONTRABARRA_EM_COBERTURA = [
  ["exclusão que esconde a árvore de módulos", comExclude(listaLiteral(ESCAPADO.modulos)), COBERTURA_EXCLUSAO],
  [
    "exclusão que esconde a árvore de compartilhados",
    comExclude(listaLiteral(ESCAPADO.compartilhados)),
    COBERTURA_EXCLUSAO
  ],
  [
    "exclusão com contrabarra dentro de classe de caracteres",
    comExclude(listaLiteral(ESCAPADO.classeEmExclude)),
    COBERTURA_EXCLUSAO
  ],
  [
    "exclusão segura antes da exclusão com contrabarra",
    comExclude(listaLiteral("docs/**", ESCAPADO.modulos)),
    COBERTURA_EXCLUSAO
  ],
  ["escopo com padrão adicional contendo contrabarra", INCLUDE_COM_DIALETO(ESCAPADO.include), COBERTURA_ESCOPO]
];

for (const [nome, vitest, vizinha] of CONTRABARRA_EM_COBERTURA) {
  test(`recusa contrabarra no valor decodificado em cobertura — ${nome}`, () => {
    const fx = fixture({ vitest });
    const result = runComFusivel(fx);
    assertCobertura(result, SINTAXE_NAO_SUPORTADA, fx, vitest);
    assert.doesNotMatch(result.stderr, NAO_CANONICA, "diagnóstico de forma não canônica sequestrou a contrabarra");
    assert.doesNotMatch(result.stderr, LIMITE_PADRAO, "diagnóstico de limite sequestrou a contrabarra");
    assert.doesNotMatch(result.stderr, vizinha, "diagnóstico de cobertura sequestrou a contrabarra");
  });
}

// Borda de precedência: a negação é decidida ANTES da compilação dos segmentos,
// então um padrão NEGADO com contrabarra continua sendo, antes de tudo, um padrão
// negado. Trocar a classe aqui esconderia a negação.
test("padrão negado com contrabarra reprova pela forma não canônica", () => {
  const eslint = eslintComIgnores(comoLiteral(ESCAPADO.negado));
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, NAO_CANONICA);
  assert.doesNotMatch(result.stderr, SINTAXE_NAO_SUPORTADA, "diagnóstico de dialeto sequestrou a negação");
  assert.doesNotMatch(result.stderr, LIMITE_PADRAO, "diagnóstico de limite sequestrou a negação");
  assertSemVazamento(result, fx, eslint);
});

// A mensagem descreve a CLASSE do defeito e nada mais: nem a contrabarra nem
// nenhum fragmento do padrão podem voltar ao autor do padrão.
test("a recusa por contrabarra não ecoa o padrão ofensivo", () => {
  const eslint = eslintComIgnores(comoLiteral(ESCAPADO.raizEmIgnores));
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, SINTAXE_NAO_SUPORTADA);
  for (const fragmento of [CONTRABARRA, "src", "separador", "escape"]) {
    assert.ok(!result.stderr.includes(fragmento), `mensagem vazou fragmento do padrão: ${fragmento}`);
  }
  assertSemVazamento(result, fx, eslint);
});

// Controles positivos: os MESMOS caminhos escritos com "/" continuam aprovando,
// e assim os coringas e as classes canônicas. A regra decide sobre o valor
// decodificado, não sobre os bytes do arquivo.
const ESCOPO_SEM_CONTRABARRA = [
  ["coringa de segmento sob a raiz protegida", '["src/*/**/*.ts"]'],
  ["árvore de módulos", '["src/modules/**/*.ts"]'],
  ["classe canônica no primeiro nome sob a raiz", '["src/[a-z]*/**/*.ts"]'],
  ["uma contrabarra no arquivo candidato, nenhuma no valor", listaLiteral(CONSUMIDO.escopo)]
];

for (const [nome, escopo] of ESCOPO_SEM_CONTRABARRA) {
  test(`aceita escopo de lint sem contrabarra no valor decodificado — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: arrayLint(blocoComEscopo(escopo)) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

const IGNORES_SEM_CONTRABARRA = [
  ["árvore de documentação", '"docs/**"'],
  ["parênteses dentro de classe", '"docs/[()]/**"'],
  ["chaves dentro de classe", '"docs/[{}]/**"'],
  ["colchete de fechamento literal logo após a abertura", '"docs/*.[]]"'],
  ["uma contrabarra no arquivo candidato antes do coringa de segmento", comoLiteral(CONSUMIDO.estrela)],
  ["uma contrabarra no arquivo candidato antes do coringa de um caractere", comoLiteral(CONSUMIDO.interrogacao)]
];

for (const [nome, lista] of IGNORES_SEM_CONTRABARRA) {
  test(`aceita ignore sem contrabarra no valor decodificado — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: eslintComIgnores(lista) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- H2. Gramática FECHADA da cobertura, resíduo depois do export, valores não
// inspecionados e política confiável incompleta.

const POLITICA_INCOMPLETA =
  /Configuração candidata reprovada: política confiável não define escopo de cobertura utilizável/u;

const CLASSES_VIZINHAS_DA_COBERTURA = [
  ["escopo", COBERTURA_ESCOPO],
  ["exclusão", COBERTURA_EXCLUSAO],
  ["limiar", COBERTURA_LIMIAR],
  ["duplicidade", COBERTURA_DUPLICADA]
];

// Endurecimento contra as classes vizinhas: a recusa por FORMA não pode ser
// confundida com incompatibilidade de valor, nem vice-versa.
function assertFormaNaoCanonica(result, fx, vitest, ...termosProibidos) {
  assertCobertura(result, COBERTURA_NAO_CANONICA, fx, vitest);
  for (const [nome, vizinha] of CLASSES_VIZINHAS_DA_COBERTURA) {
    assert.doesNotMatch(result.stderr, vizinha, `diagnóstico de ${nome} sequestrou a forma não canônica`);
  }
  for (const termo of termosProibidos) {
    assert.ok(!result.stderr.includes(termo), `mensagem ecoou a chave ou o valor recusado: ${termo}`);
  }
}

const COVERAGE_CANONICO = `${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`;

// --- Tarefa B. Dentro de `coverage` valem exatamente `include`, `exclude` e
// `thresholds`, uma vez cada. Qualquer outra chave reprova pela forma, sem que a
// mensagem ecoe o nome ou o valor recusado.
const CHAVE_ESTRANHA_EM_COVERAGE = [
  ["all desligado antes das três", `all: false, ${COVERAGE_CANONICO}`, ["all", "false"]],
  ["provider substituído", `provider: "custom", ${COVERAGE_CANONICO}`, ["provider", "custom"]],
  [
    "provedor de cobertura inteiro substituído",
    `all: false, provider: "custom", customProviderModule: "./fake.mjs", ${COVERAGE_CANONICO}`,
    ["provider", "custom", "customProviderModule", "fake.mjs"]
  ],
  ["cobertura desabilitada", `enabled: false, ${COVERAGE_CANONICO}`, ["enabled"]],
  ["chave arbitrária", `${COVERAGE_CANONICO}, qualquerCoisa: 1`, ["qualquerCoisa"]],
  [
    "chave desconhecida entre include e exclude",
    `${STRONG_INCLUDE}, all: false, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}`,
    ["all"]
  ],
  [
    "chave desconhecida entre exclude e thresholds",
    `${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, all: false, ${STRONG_THRESHOLDS}`,
    ["all"]
  ],
  ["chave desconhecida depois das três", `${COVERAGE_CANONICO}, all: false`, ["all"]],
  ["chave desconhecida citada", `"all": false, ${COVERAGE_CANONICO}`, ["all"]],
  ["chave desconhecida duplicada", `all: false, all: true, ${COVERAGE_CANONICO}`, ["all"]],
  ["espalhamento que introduz chave desconhecida", `${COVERAGE_CANONICO}, ...extras`, ["extras"]],
  ["reporter de cobertura", `reporter: ["text"], ${COVERAGE_CANONICO}`, ["reporter"]],
  ["diretório de relatório", `reportsDirectory: "./cobertura", ${COVERAGE_CANONICO}`, ["reportsDirectory"]]
];

for (const [nome, corpo, termos] of CHAVE_ESTRANHA_EM_COVERAGE) {
  test(`recusa chave fora da gramática de coverage — ${nome}`, () => {
    const vitest = cobertura(corpo);
    const fx = fixture({ vitest });
    assertFormaNaoCanonica(runComFusivel(fx), fx, vitest, ...termos);
  });
}

// --- Tarefa C. Dentro de `thresholds` valem exatamente as quatro métricas, uma
// vez cada, e as quatro continuam obrigatórias. Limiar por arquivo ou por
// diretório é a forma que esvaziava o gate: ele convive com as quatro métricas
// globais e substitui o limiar efetivo da subárvore protegida.
const CHAVE_ESTRANHA_EM_THRESHOLDS = [
  [
    "limiar por diretório protegido",
    `${METRICAS_FORTES}, "src/**": { lines: 0, branches: 0, functions: 0, statements: 0 }`,
    ["src/**"]
  ],
  ["limiar por arquivo", `${METRICAS_FORTES}, "src/modules/indice.ts": { lines: 0 }`, ["indice.ts"]],
  ["limiar por diretório antes das métricas", `"src/**": { lines: 0 }, ${METRICAS_FORTES}`, ["src/**"]],
  ["comparação por arquivo", `perFile: false, ${METRICAS_FORTES}`, ["perFile"]],
  ["atualização automática de limiares", `${METRICAS_FORTES}, autoUpdate: true`, ["autoUpdate"]],
  ["chave arbitrária", `${METRICAS_FORTES}, qualquerCoisa: 1`, ["qualquerCoisa"]],
  [
    "chave desconhecida entre as métricas",
    "lines: 80, branches: 75, perFile: false, functions: 80, statements: 80",
    ["perFile"]
  ],
  ["chave desconhecida citada", `"perFile": false, ${METRICAS_FORTES}`, ["perFile"]],
  ["chave desconhecida duplicada", `perFile: false, perFile: true, ${METRICAS_FORTES}`, ["perFile"]]
];

for (const [nome, corpo, termos] of CHAVE_ESTRANHA_EM_THRESHOLDS) {
  test(`recusa chave fora da gramática de thresholds — ${nome}`, () => {
    const vitest = comLimiares(corpo);
    const fx = fixture({ vitest });
    assertFormaNaoCanonica(runComFusivel(fx), fx, vitest, ...termos);
  });
}

// As quatro métricas continuam OBRIGATÓRIAS: fechar a gramática não pode
// transformar ausência em aprovação silenciosa.
for (const metrica of ["lines", "branches", "functions", "statements"]) {
  test(`mantém obrigatória a métrica de limiar — ${metrica}`, () => {
    const corpo = METRICAS_FORTES.split(", ")
      .filter((par) => !par.startsWith(`${metrica}:`))
      .join(", ");
    const vitest = comLimiares(corpo);
    const fx = fixture({ vitest });
    assertCobertura(runComFusivel(fx), COBERTURA_LIMIAR, fx, vitest);
  });
}

// --- Tarefa D. Política confiável incompleta. O arranjo é montado com uma CÓPIA
// FIEL do que o validador lê a partir da raiz confiável apontada por `--trusted`:
// `quality/policy.json` e `tooling/toolchain/dependency-cruiser.json`, ambos
// resolvidos internamente sob essa raiz. A fidelidade é provada ANTES de qualquer
// mutação.
const RAIZ_DO_REPOSITORIO = fileURLToPath(new URL("../../", import.meta.url));
const POLITICA_REAL = JSON.parse(readFileSync(join(RAIZ_DO_REPOSITORIO, "quality", "policy.json"), "utf8"));
const DEPENDENCIAS_REAIS = JSON.parse(
  readFileSync(join(RAIZ_DO_REPOSITORIO, "tooling", "toolchain", "dependency-cruiser.json"), "utf8")
);

const comPoliticaReal = (mutar) => {
  const policy = JSON.parse(JSON.stringify(POLITICA_REAL));
  if (mutar) mutar(policy);
  return fixture({ policy, dependency: DEPENDENCIAS_REAIS });
};

test("arranjo confiável fiel reproduz o resultado da política real", () => {
  const result = runComFusivel(comPoliticaReal());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

const ESCOPOS_DE_POLITICA_INUTILIZAVEIS = [
  ["include ausente", (policy) => delete policy.coverage.include],
  ["include nulo", (policy) => (policy.coverage.include = null)],
  ["include textual", (policy) => (policy.coverage.include = "src/**")],
  ["include como objeto", (policy) => (policy.coverage.include = { "0": "src/**" })],
  ["include vazio", (policy) => (policy.coverage.include = [])],
  ["item não textual", (policy) => (policy.coverage.include = ["src/modules/**", 5])],
  ["item nulo", (policy) => (policy.coverage.include = ["src/modules/**", null])],
  ["item aninhado", (policy) => (policy.coverage.include = [["src/modules/**"]])],
  ["sem raiz protegida: globstar isolado", (policy) => (policy.coverage.include = ["**"])],
  ["sem raiz protegida: coringa isolado", (policy) => (policy.coverage.include = ["*"])],
  ["sem raiz protegida: globstar inicial", (policy) => (policy.coverage.include = ["**/*.ts"])],
  ["sem raiz protegida: padrão vazio", (policy) => (policy.coverage.include = [""])],
  ["sem raiz protegida: diretório atual", (policy) => (policy.coverage.include = ["./**"])],
  ["uma raiz válida e outra sem raiz protegida", (policy) => (policy.coverage.include = ["src/modules/**", "**"])],
  ["seção de cobertura ausente", (policy) => delete policy.coverage]
];

for (const [nome, mutar] of ESCOPOS_DE_POLITICA_INUTILIZAVEIS) {
  test(`reprova fail-closed quando a política confiável não produz raiz protegida — ${nome}`, () => {
    const fx = comPoliticaReal(mutar);
    const result = runComFusivel(fx);
    assertCobertura(result, POLITICA_INCOMPLETA, fx, VITEST);
    for (const [classe, vizinha] of CLASSES_VIZINHAS_DA_COBERTURA) {
      assert.doesNotMatch(result.stderr, vizinha, `diagnóstico de ${classe} sequestrou a política incompleta`);
    }
    assert.doesNotMatch(result.stderr, COBERTURA_NAO_CANONICA, "diagnóstico de forma sequestrou a política incompleta");
  });
}

// A degradação medida: com escopo vazio na política, uma exclusão que apaga a
// árvore protegida inteira era aprovada. Agora a própria política reprova antes.
test("política com escopo vazio não aprova exclusão que apaga a árvore protegida", () => {
  const fx = fixture({
    policy: { ...POLITICA_REAL, coverage: { ...POLITICA_REAL.coverage, include: [] } },
    dependency: DEPENDENCIAS_REAIS,
    vitest: comExclude('["src/**"]')
  });
  const result = runComFusivel(fx);
  assert.notEqual(result.status, 0, "exclusão total foi aprovada por política degradada");
  assert.match(result.stderr, POLITICA_INCOMPLETA);
  assert.doesNotMatch(result.stdout, /compatível com a política confiável/u, "linha de aprovação foi emitida");
});

// --- Tarefa E. Resíduo depois do objeto exportado. Mesma disciplina do lint:
// nada além de espaço, comentário já neutralizado e o ponto e vírgula do
// contrato compõe a configuração efetiva.
const RESIDUO_EXECUTAVEL = [
  ["encerramento do processo", "process.exit(0);\n"],
  ["atribuição em objeto global", "globalThis.__PWN__ = true;\n"],
  ["segundo objeto literal", "({ extra: 1 });\n"],
  ["segunda expressão", "const extra = 1;\n"],
  ["chamada de função", "configurarAmbiente();\n"],
  ["expressão imediatamente invocada", "(() => { globalThis.__PWN__ = true; })();\n"],
  ["token solto depois do ponto e vírgula", "x\n"],
  ["exportação nomeada adicional", "export const extra = 1;\n"]
];

for (const [nome, residuo] of RESIDUO_EXECUTAVEL) {
  test(`recusa resíduo depois do objeto exportado na cobertura — ${nome}`, () => {
    const vitest = `export default ${CADEIA_FORTE};\n${residuo}`;
    const fx = fixture({ vitest });
    assertFormaNaoCanonica(runComFusivel(fx), fx, vitest);
  });
}

const RESIDUO_INOFENSIVO = [
  ["fim imediato depois do objeto", `export default ${CADEIA_FORTE}`],
  ["ponto e vírgula final", `export default ${CADEIA_FORTE};`],
  ["espaço em branco depois do ponto e vírgula", `export default ${CADEIA_FORTE};\n\n   \n`],
  ["comentário de linha depois do objeto", `export default ${CADEIA_FORTE};\n// nota final\n`],
  ["comentário de bloco depois do objeto", `export default ${CADEIA_FORTE};\n/* nota final */\n`]
];

for (const [nome, vitest] of RESIDUO_INOFENSIVO) {
  test(`aceita resíduo inofensivo depois do objeto exportado — ${nome}`, () => {
    const result = runComFusivel(fixture({ vitest }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- Tarefa F. Formas EXECUTÁVEIS declaradas nos níveis exportado e `test`.
// Estes vetores já reprovavam quando havia tolerância a valor não inspecionado,
// e continuam reprovando depois do fechamento dos dois níveis — agora pelo
// nome da propriedade, antes que o valor chegue a ser lido. São preservados
// como controle de não regressão da classe: nenhuma delas pode passar a
// aprovar, nem a produzir diagnóstico de outra classe.
const VALOR_EXECUTAVEL = [
  [
    "expressão imediatamente invocada no nível exportado",
    `{ boom: (() => 1)(), test: { coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "importação dinâmica no nível exportado",
    `{ plugin: await import("./carga.mjs"), test: { coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  ["chamada de função no nível exportado", `{ plugins: carregar(), test: { coverage: { ${COVERAGE_CANONICO} } } }`],
  [
    "encerramento do processo no nível exportado",
    `{ boom: process.exit(0), test: { coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "acessador no nível exportado",
    `{ get docs() { return 1; }, test: { coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  ["método no nível exportado", `{ docs() { return 1; }, test: { coverage: { ${COVERAGE_CANONICO} } } }`],
  [
    "expressão imediatamente invocada no nível test",
    `{ test: { boom: (() => 1)(), coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "importação dinâmica no nível test",
    `{ test: { setup: await import("./carga.mjs"), coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  ["chamada de função no nível test", `{ test: { reporters: criar(), coverage: { ${COVERAGE_CANONICO} } } }`],
  ["encerramento do processo no nível test", `{ test: { boom: process.exit(0), coverage: { ${COVERAGE_CANONICO} } } }`],
  ["acessador no nível test", `{ test: { get docs() { return 1; }, coverage: { ${COVERAGE_CANONICO} } } }`],
  ["método no nível test", `{ test: { docs() { return 1; }, coverage: { ${COVERAGE_CANONICO} } } }`],
  [
    "chamada dentro de objeto aninhado no nível exportado",
    `{ define: { valor: carregar() }, test: { coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  ["chamada dentro de array no nível test", `{ test: { reporters: [criar()], coverage: { ${COVERAGE_CANONICO} } } }`],
  [
    "função de seta como valor no nível test",
    `{ test: { setup: (contexto) => contexto, coverage: { ${COVERAGE_CANONICO} } } }`
  ]
];

for (const [nome, corpo] of VALOR_EXECUTAVEL) {
  test(`recusa valor não inspecionado que executa código — ${nome}`, () => {
    const vitest = exportDefault(corpo);
    const fx = fixture({ vitest });
    const result = runComFusivel(fx);
    assertFormaNaoCanonica(result, fx, vitest);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /NÃO_EXECUTAR|__PWN__/u);
  });
}

// H3b3. Os DOIS níveis restantes foram FECHADOS: o objeto exportado declara
// somente `test`, e `test` declara somente `coverage`. A tolerância genérica a
// "valor não inspecionado estruturalmente estático" DEIXOU DE DEFINIR O
// CONTRATO, e não por gosto: ela media a forma do VALOR, e o leitor só sabia
// recusar o parêntese. `new Reporter`, um tagged template, um acessador
// encadeado, um `await` e um identificador livre não têm parêntese nenhum e
// entravam por uma propriedade que o validador não lê — executando com o
// privilégio do runner assim que o Vitest carregasse o módulo. Pior: nomes
// perfeitamente legítimos do Vitest (`setupFiles`, `globalSetup`, `reporters`,
// `plugins`) fazem o runner IMPORTAR um arquivo escolhido pela candidata, e
// `include: []` ou `passWithNoTests` esvaziam a medição sem tocar em
// `coverage`. Nenhuma inspeção do valor separa esses casos; o NOME separa.
//
// O preço é assumido: propriedade legítima do Vitest reprova. Ampliar a
// allowlist exige o PR próprio descrito em `docs/ai-engineering-system.md`.
// A recusa não ecoa o nome nem o valor: o defeito é a forma.
const NIVEL_FECHADO_RECUSADO = [
  // (a) Carregamento de módulo. Cada uma faz o runner importar e executar um
  // arquivo apontado pela candidata, sem nenhum parêntese na configuração.
  ["setupFiles no nível test", `{ test: { setupFiles: ["./s.ts"], coverage: { ${COVERAGE_CANONICO} } } }`],
  ["globalSetup no nível test", `{ test: { globalSetup: ["./g.ts"], coverage: { ${COVERAGE_CANONICO} } } }`],
  ["reporters no nível test", `{ test: { reporters: ["./r.ts"], coverage: { ${COVERAGE_CANONICO} } } }`],
  [
    "snapshotSerializers no nível test",
    `{ test: { snapshotSerializers: ["./x.ts"], coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  ["plugins no nível exportado", `{ plugins: ["./p.ts"], test: { coverage: { ${COVERAGE_CANONICO} } } }`],
  ["globalSetup no nível exportado", `{ globalSetup: ["./g.ts"], test: { coverage: { ${COVERAGE_CANONICO} } } }`],

  // (b) Seleção ou supressão de testes. Esvaziam a medição sem alterar um único
  // limiar: a cobertura continua "forte" sobre um conjunto vazio.
  ["include vazio no nível test", `{ test: { include: [], coverage: { ${COVERAGE_CANONICO} } } }`],
  ["exclude do código no nível test", `{ test: { exclude: ["src/**"], coverage: { ${COVERAGE_CANONICO} } } }`],
  ["passWithNoTests no nível test", `{ test: { passWithNoTests: true, coverage: { ${COVERAGE_CANONICO} } } }`],
  ["bail no nível test", `{ test: { bail: 1, coverage: { ${COVERAGE_CANONICO} } } }`],
  ["testTimeout no nível test", `{ test: { testTimeout: 1, coverage: { ${COVERAGE_CANONICO} } } }`],

  // (c) Expressões executáveis SEM parêntese — a classe inteira que o leitor de
  // valor estático deixava passar. Todas com sintaxe válida de módulo ES.
  ["tagged template no nível test", `{ test: { x: sql\`select 1\`, coverage: { ${COVERAGE_CANONICO} } } }`],
  ["new sem lista de argumentos no nível test", `{ test: { x: new Reporter, coverage: { ${COVERAGE_CANONICO} } } }`],
  ["new sobre membro no nível test", `{ test: { x: new mod.Reporter, coverage: { ${COVERAGE_CANONICO} } } }`],
  ["acesso a membro por ponto no nível test", `{ test: { x: modulo.prop, coverage: { ${COVERAGE_CANONICO} } } }`],
  [
    "acesso a membro por colchete no nível test",
    `{ test: { x: modulo["prop"], coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  ["função de seta sem parêntese no nível test", `{ test: { x: v => v, coverage: { ${COVERAGE_CANONICO} } } }`],
  [
    "atribuição a objeto global no nível test",
    `{ test: { x: globalThis.__PWN__ = 1, coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  ["duas chaves livres em sequência no nível test", `{ test: { x: 1, y: 2, coverage: { ${COVERAGE_CANONICO} } } }`],
  ["await de promessa no nível test", `{ test: { x: await promessa, coverage: { ${COVERAGE_CANONICO} } } }`],
  ["template literal no nível test", `{ test: { x: \`texto\`, coverage: { ${COVERAGE_CANONICO} } } }`],

  // (d) Dados PASSIVOS. Também reprovam, e isso é a consequência assumida do
  // critério por nome: o validador não distingue dado de gatilho sem ler valor.
  [
    "resolve.alias no nível exportado",
    `{ resolve: { alias: { "@": "./src" } }, test: { coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "esbuild.target no nível exportado",
    `{ esbuild: { target: "es2022" }, test: { coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  ["globals no nível test", `{ test: { globals: true, coverage: { ${COVERAGE_CANONICO} } } }`],
  ["environment no nível test", `{ test: { environment: "node", coverage: { ${COVERAGE_CANONICO} } } }`],

  // (e) Os SEIS vetores que a tolerância genérica aprovava, preservados letra
  // por letra e com a polaridade invertida. Nenhum foi apagado: o que mudou é
  // a resposta, e o nome do teste diz qual é a nova recusa.
  [
    "antes tolerado: array vazio e booleano",
    `{ plugins: [], test: { globals: true, coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "antes tolerado: número, nulo e texto",
    `{ porta: 5173, alias: null, raiz: "./app", test: { coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "antes tolerado: objeto aninhado estático",
    `{ resolve: { alias: { "@": "./src" } }, test: { coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "antes tolerado: array de objetos estáticos no nível test",
    `{ test: { projetos: [{ nome: "a" }, { nome: "b" }], coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "antes tolerado: parênteses dentro de literal textual",
    `{ nota: "carregar()", test: { nota: "f(x)", coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "antes tolerado: identificador livre como valor",
    `{ test: { ambiente: PADRAO, coverage: { ${COVERAGE_CANONICO} } } }`
  ],
  [
    "antes tolerado: propriedades alheias nos níveis exportado e test",
    `{ plugins: [], test: { globals: true, coverage: { ${COVERAGE_CANONICO} }, reporters: ["default"] }, esbuild: { target: "es2022" } }`
  ]
];

for (const [nome, corpo] of NIVEL_FECHADO_RECUSADO) {
  test(`recusa propriedade fora dos níveis fechados — ${nome}`, () => {
    const vitest = exportDefault(corpo);
    const fx = fixture({ vitest });
    const result = runComFusivel(fx);
    assertFormaNaoCanonica(result, fx, vitest);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /NÃO_EXECUTAR|__PWN__/u);
  });
}

// Controle positivo do mesmo contrato: a cadeia canônica mínima continua
// aprovando, e nada dentro de `coverage` mudou.
test("aceita a cadeia canônica mínima sob os níveis fechados", () => {
  const result = runComFusivel(fixture({ vitest: exportDefault(`{ test: { coverage: { ${COVERAGE_CANONICO} } } }`) }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

// O contrato do LINT não muda: lá o valor não inspecionado continua tolerado,
// inclusive quando é executável, porque é o que prova que o módulo não é
// avaliado. Controle de assimetria deliberada, medido nos dois arquivos.
// H3b2a. Título substituído — "o contrato de valores não inspecionados do lint
// permanece intacto" descrevia uma tolerância que deixou de existir. A FIXTURE
// foi preservada intacta e só a polaridade mudou: o bloco de lint passou a
// recusar propriedade desconhecida, e o valor executável reprova pela forma.
test("o contrato de valores não inspecionados do lint foi fechado no nível do bloco", () => {
  const eslint = ESLINT.replace("\n}];", ",\n  extra: carregar()\n}];");
  const fx = fixture({ eslint });
  assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
});

// --- H3a. Importação canônica do analisador, associação entre a regra de
// complexidade e o analisador, e propriedade `processor` proibida.
//
// O gate de complexidade da base roda sobre TypeScript. Sem um analisador que
// entenda TypeScript, o ESLint falha ao ler os arquivos protegidos e a regra
// cobre zero arquivo: o gate continua declarado no texto e deixa de valer na
// prática. Declarar o analisador exige trazê-lo, e trazê-lo exige uma
// importação — a única declaração que o preâmbulo do lint passa a admitir.
//
// A permissão é ESTREITA de propósito. O preâmbulo é código executado pelo
// ESLint ao carregar a configuração: qualquer outra forma de importação, uma
// segunda importação, `require`, importação dinâmica ou uma declaração comum
// voltariam a dar ao arquivo um lugar onde código roda com o privilégio da
// ferramenta. E a associação é ESTRUTURAL, no mesmo objeto: `languageOptions` é
// aplicado por bloco, então um analisador declarado em bloco alheio não alcança
// os arquivos protegidos.

const ANALISADOR_SEM_IMPORTACAO =
  /Configuração candidata reprovada: analisador declarado sem a importação canônica/u;
const ANALISADOR_AUSENTE =
  /Configuração candidata reprovada: bloco de complexidade não declara o analisador exigido/u;
const PROPRIEDADE_PROIBIDA = /Configuração candidata reprovada: propriedade proibida na configuração de lint/u;
const PROTECOES_INCOMPATIVEIS =
  /Configuração candidata reprovada: proteções locais da configuração de lint ausentes ou incompatíveis/u;

const CLASSES_VIZINHAS_DO_LINT = [
  ["proteções locais do bloco", PROTECOES_INCOMPATIVEIS],
  ["forma não canônica", NAO_CANONICO_LINT],
  ["preâmbulo do lint", PREAMBULO_LINT_INVALIDO],
  ["analisador sem importação", ANALISADOR_SEM_IMPORTACAO],
  ["analisador ausente", ANALISADOR_AUSENTE],
  ["propriedade proibida", PROPRIEDADE_PROIBIDA],
  ["complexidade incompatível", COMPLEXIDADE_INCOMPATIVEL],
  ["alcance da complexidade", COMPLEXIDADE_SEM_ALCANCE],
  ["padrões ignorados", ALCANCA_SRC]
];

// Termos que a mensagem NUNCA pode conter: eles nomeiam a chave, o pacote ou a
// expressão da candidata, e devolvê-los daria ao autor do arquivo um canal de
// eco controlado por ele.
const TERMOS_DA_CANDIDATA = [
  "processor",
  "languageOptions",
  "linterOptions",
  "noInlineConfig",
  "reportUnusedDisableDirectives",
  "@typescript-eslint",
  "parser",
  "require",
  "import(",
  "@eslint/js"
];

function assertClasseDoLint(result, fx, eslint, esperada) {
  assertReprova(result, esperada);
  for (const [nome, vizinha] of CLASSES_VIZINHAS_DO_LINT) {
    if (vizinha === esperada) continue;
    assert.doesNotMatch(result.stderr, vizinha, `diagnóstico de ${nome} sequestrou a classe esperada`);
  }
  for (const termo of TERMOS_DA_CANDIDATA) {
    assert.ok(!result.stderr.includes(termo), `mensagem ecoou conteúdo da candidata: ${termo}`);
  }
  assertSemVazamento(result, fx, eslint);
}

const lintComPreambulo = (preambulo) => `${preambulo}export default [${BLOCO_LINT}];\n`;
const lintComBlocos = (...blocos) => `${IMPORT_PARSER}export default [${blocos.join(", ")}];\n`;
const lintSemImportacao = (...blocos) => `export default [${blocos.join(", ")}];\n`;
const blocoDeSrcCom = (propriedade) => `{ files: ["src/**/*.ts"], ${propriedade}, ${REGRAS_LINT} }`;
const BLOCO_DE_DOCS = `{ files: ["docs/**/*.md"], ${BLINDAGEM_NO_BLOCO} }`;

// --- Parte 1. Gramática do preâmbulo. Uma única importação, exatamente esta.
const PREAMBULOS_FORA_DA_GRAMATICA = [
  ["pacote diferente", 'import parser from "@eslint/js";\n'],
  ["pacote parecido com o canônico", 'import parser from "@typescript-eslint/parser-extra";\n'],
  ["caminho relativo no lugar do pacote", 'import parser from "./parser.mjs";\n'],
  ["identificador diferente de parser", 'import tsParser from "@typescript-eslint/parser";\n'],
  ["importação nomeada", 'import { parser } from "@typescript-eslint/parser";\n'],
  ["importação nomeada com renomeação", 'import { default as parser } from "@typescript-eslint/parser";\n'],
  ["importação por namespace", 'import * as parser from "@typescript-eslint/parser";\n'],
  ["importação de efeito colateral", 'import "@typescript-eslint/parser";\n'],
  ["importação padrão acompanhada de nomeada", 'import parser, { x } from "@typescript-eslint/parser";\n'],
  ["importação duplicada", `${IMPORT_PARSER}${IMPORT_PARSER}`],
  ["segunda importação de outro pacote", `${IMPORT_PARSER}import js from "@eslint/js";\n`],
  ["importação canônica depois de outra", `import js from "@eslint/js";\n${IMPORT_PARSER}`],
  ["require em constante", 'const parser = require("@typescript-eslint/parser");\n'],
  ["importação dinâmica aguardada", 'const parser = await import("@typescript-eslint/parser");\n'],
  ["importação dinâmica sem await", 'const parser = import("@typescript-eslint/parser");\n'],
  ["importação dinâmica como expressão solta", 'import("@typescript-eslint/parser");\n'],
  ["especificador com escape unicode", 'import parser from "@typescript-eslint\\u002fparser";\n'],
  ["atributo de importação depois do especificador", IMPORT_PARSER.replace(";", ' with { type: "json" };')],
  ["importação sem ponto e vírgula", 'import parser from "@typescript-eslint/parser"\n'],
  ["especificador por identificador", "import parser from PACOTE;\n"],
  ["chamariz de importação em literal textual", '"import parser from \'@typescript-eslint/parser\';";\n'],
  ["declaração depois da importação canônica", `${IMPORT_PARSER}const limite = 10;\n`],
  ["chamada depois da importação canônica", `${IMPORT_PARSER}configurarAmbiente();\n`]
];

for (const [nome, preambulo] of PREAMBULOS_FORA_DA_GRAMATICA) {
  test(`recusa preâmbulo de lint fora da gramática canônica — ${nome}`, () => {
    const eslint = lintComPreambulo(preambulo);
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, PREAMBULO_LINT_INVALIDO);
  });
}

// Controles positivos do preâmbulo: espaço e comentário continuam livres em
// volta da importação, e o especificador aceita as duas aspas canônicas.
const PREAMBULOS_CANONICOS = [
  ["importação canônica seguida do export default", IMPORT_PARSER],
  ["comentário de linha antes da importação", `// analisador de TypeScript\n${IMPORT_PARSER}`],
  ["comentário de bloco antes da importação", `/* analisador\n   de TypeScript */\n${IMPORT_PARSER}`],
  ["comentário depois da importação", `${IMPORT_PARSER}// nada mais roda aqui\n`],
  ["comentário entre a importação e o export", `${IMPORT_PARSER}/* nada mais roda aqui */\n\n`],
  ["espaços e quebras de linha em volta da importação", `\n\n   ${IMPORT_PARSER.trim()}   \n\n`],
  ["quebra de linha dentro da declaração", 'import\n  parser\n  from\n  "@typescript-eslint/parser";\n'],
  ["aspas simples no especificador", "import parser from '@typescript-eslint/parser';\n"],
  [
    "comentário entre as palavras da declaração",
    'import /* padrão */ parser /* de */ from /* pacote */ "@typescript-eslint/parser";\n'
  ]
];

for (const [nome, preambulo] of PREAMBULOS_CANONICOS) {
  test(`aceita preâmbulo canônico do lint — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: lintComPreambulo(preambulo) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- Parte 2. Associação entre a regra de complexidade e o analisador.
//
// O analisador usado sem a importação que o liga é ReferenceError no ESLint: o
// arquivo nem chega a produzir configuração. Aprovar esse texto seria aprovar
// uma configuração que o consumidor não carrega.
const ANALISADOR_SEM_A_IMPORTACAO = [
  ["bloco de complexidade nomeia o analisador sem importá-lo", lintSemImportacao(BLOCO_LINT)],
  [
    "analisador em bloco alheio sem importação",
    lintSemImportacao(BLOCO_DE_DOCS, `{ files: ["src/**/*.ts"], ${REGRAS_LINT} }`)
  ],
  [
    "importação apenas em comentário",
    `// ${IMPORT_PARSER.trim()}\n/* ${IMPORT_PARSER.trim()} */\n${lintSemImportacao(BLOCO_LINT)}`
  ],
  [
    "importação apenas em literal textual dentro do corpo exportado",
    lintSemImportacao(
      `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${regrasComRuido(
        `nota: "import parser from '@typescript-eslint/parser';"`
      )} }`
    )
  ]
];

for (const [nome, eslint] of ANALISADOR_SEM_A_IMPORTACAO) {
  test(`recusa analisador declarado sem a importação canônica — ${nome}`, () => {
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, ANALISADOR_SEM_IMPORTACAO);
  });
}

// A prova precisa ser estruturalmente demonstrável no MESMO bloco: bloco
// desconectado não prova nada por outro.
const ANALISADOR_FORA_DO_BLOCO = [
  [
    "importação presente e bloco de complexidade sem o analisador",
    lintComBlocos(`{ files: ["src/**/*.ts"], ${REGRAS_LINT} }`)
  ],
  ["bloco global com a regra e sem o analisador", lintComBlocos(`{ ${REGRAS_LINT} }`)],
  ["analisador declarado em bloco anterior", lintComBlocos(BLOCO_DE_DOCS, `{ files: ["src/**/*.ts"], ${REGRAS_LINT} }`)],
  ["analisador declarado em bloco posterior", lintComBlocos(`{ files: ["src/**/*.ts"], ${REGRAS_LINT} }`, BLOCO_DE_DOCS)],
  [
    "analisador em bloco de src que não declara a regra",
    lintComBlocos(`{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO} }`, `{ files: ["src/**/*.ts"], ${REGRAS_LINT} }`)
  ],
  [
    "dois blocos provam o alcance e só um declara o analisador",
    lintComBlocos(BLOCO_LINT, `{ files: ["src/**/*.tsx"], ${REGRAS_LINT} }`)
  ],
  [
    "analisador apenas em propriedade alheia do mesmo bloco",
    lintComBlocos(`{ files: ["src/**/*.ts"], ${regrasComRuido('nota: "languageOptions: { parser }"')} }`)
  ]
];

for (const [nome, eslint] of ANALISADOR_FORA_DO_BLOCO) {
  test(`recusa bloco de complexidade sem o analisador exigido — ${nome}`, () => {
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, ANALISADOR_AUSENTE);
  });
}

// Formas de `languageOptions` cujo valor só existiria depois de avaliar o
// módulo, e formas que abrem o nível para opções que o validador não compara.
const ANALISADOR_EM_FORMA_INDIRETA = [
  ["valor textual", 'languageOptions: { parser: "parser" }'],
  ["outro identificador abreviado", "languageOptions: { tsParser }"],
  ["outro identificador como valor", "languageOptions: { parser: tsParser }"],
  ["membro de objeto", "languageOptions: { parser: modulo.parser }"],
  ["chamada", "languageOptions: { parser: criarParser() }"],
  ["expressão imediatamente invocada", "languageOptions: { parser: (() => 1)() }"],
  ["importação dinâmica aguardada", 'languageOptions: { parser: await import("@typescript-eslint/parser") }'],
  ["importação dinâmica", 'languageOptions: { parser: import("@typescript-eslint/parser") }'],
  ["acessador", "languageOptions: { get parser() { return 1; } }"],
  ["método", "languageOptions: { parser() { return 1; } }"],
  ["espalhamento", "languageOptions: { ...base }"],
  ["chave abreviada duplicada", "languageOptions: { parser, parser }"],
  ["chave citada", 'languageOptions: { "parser": parser }'],
  ["chave computada", 'languageOptions: { ["parser"]: parser }'],
  ["opção adicional ao lado do analisador", "languageOptions: { parser, ecmaVersion: 2022 }"],
  ["opção adicional antes do analisador", "languageOptions: { ecmaVersion: 2022, parser }"],
  ["nível vazio", "languageOptions: {}"],
  ["valor que não é objeto: array", "languageOptions: [parser]"],
  ["valor que não é objeto: identificador", "languageOptions: parser"],
  ["valor que não é objeto: literal textual", 'languageOptions: "parser"'],
  // Duplicação do ANALISADOR: a forma canônica das proteções entra uma única vez,
  // para que o defeito exercitado continue sendo a chave repetida de languageOptions.
  ["propriedade declarada duas vezes", `${PARSER_NO_BLOCO}, ${BLINDAGEM_NO_BLOCO}`]
];

for (const [nome, propriedade] of ANALISADOR_EM_FORMA_INDIRETA) {
  test(`recusa analisador em forma não canônica — ${nome}`, () => {
    const eslint = lintComBlocos(blocoDeSrcCom(propriedade));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
  });
}

// Controles positivos da associação.
const ASSOCIACAO_CANONICA = [
  ["bloco de src com a regra e o analisador", lintComBlocos(BLOCO_LINT)],
  ["bloco global com a regra e o analisador", lintComBlocos(`{ ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`)],
  ["analisador antes do escopo", lintComBlocos(`{ ${BLINDAGEM_NO_BLOCO}, files: ["src/**/*.ts"], ${REGRAS_LINT} }`)],
  ["analisador depois das regras", lintComBlocos(`{ files: ["src/**/*.ts"], ${REGRAS_LINT}, ${BLINDAGEM_NO_BLOCO} }`)],
  [
    "vírgula final dentro de languageOptions",
    lintComBlocos(blocoDeSrcCom(`languageOptions: { parser, }, ${PROTECOES_NO_BLOCO}`))
  ],
  [
    "espaços e quebras de linha dentro de languageOptions",
    lintComBlocos(blocoDeSrcCom(`languageOptions: {\n    parser\n  }, ${PROTECOES_NO_BLOCO}`))
  ],
  [
    "forma explícita parser: parser — chave estrutural e valor são o mesmo identificador estático, demonstrável sem avaliar o módulo",
    lintComBlocos(blocoDeSrcCom(`languageOptions: { parser: parser }, ${PROTECOES_NO_BLOCO}`))
  ],
  [
    "bloco que declara a regra fora do alcance não precisa do analisador",
    lintComBlocos(BLOCO_LINT, `{ files: ["tests/**/*.ts"], ${REGRAS_LINT} }`)
  ],
  [
    "bloco sem a regra não precisa do analisador",
    lintComBlocos(BLOCO_LINT, '{ files: ["docs/**/*.md"], rules: { eqeqeq: ["error", "always"] } }')
  ],
  ["analisador declarado também em bloco alheio", lintComBlocos(BLOCO_DE_DOCS, BLOCO_LINT)],
  [
    "dois blocos provam o alcance e os dois declaram o analisador",
    lintComBlocos(BLOCO_LINT, `{ files: ["src/**/*.tsx"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`)
  ]
];

for (const [nome, eslint] of ASSOCIACAO_CANONICA) {
  test(`aceita associação canônica entre complexidade e analisador — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- Parte 3. `processor` é proibido, qualquer que seja o valor.
//
// Um processador substitui o texto que o ESLint analisa: a regra de
// complexidade passaria a medir outro código, e o gate continuaria declarado
// sobre os arquivos protegidos sem valer para eles. A recusa é pela PRESENÇA da
// propriedade estrutural, não pelo valor, e a mensagem não ecoa nem a chave nem
// o que estava do outro lado dos dois-pontos.
const PROCESSADOR_DECLARADO = [
  ["valor textual", 'processor: "markdown/markdown"'],
  ["valor por identificador", "processor: processadorLocal"],
  ["valor por membro de objeto", "processor: plugin.processors.md"],
  ["valor por chamada", "processor: criarProcessador()"],
  ["valor por importação dinâmica aguardada", 'processor: await import("./processador.mjs")'],
  ["valor nulo", "processor: null"],
  ["valor por objeto literal", "processor: { preprocess: 1, postprocess: 2 }"],
  ["chave citada em aspas duplas", '"processor": "markdown/markdown"'],
  ["chave citada em aspas simples", "'processor': \"markdown/markdown\""],
  ["chave computada literal", '["processor"]: "markdown/markdown"'],
  ["chave declarada duas vezes", 'processor: "a", processor: "b"']
];

for (const [nome, propriedade] of PROCESSADOR_DECLARADO) {
  test(`recusa propriedade de processador no bloco de complexidade — ${nome}`, () => {
    const eslint = lintComBlocos(blocoDeSrcCom(`${BLINDAGEM_NO_BLOCO}, ${propriedade}`));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, PROPRIEDADE_PROIBIDA);
  });

  test(`recusa propriedade de processador em bloco alheio — ${nome}`, () => {
    const eslint = lintComBlocos(BLOCO_LINT, `{ files: ["docs/**/*.md"], ${propriedade} }`);
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, PROPRIEDADE_PROIBIDA);
  });
}

// Grafias que nem chegam a nomear a propriedade: a chave com escape, o acessador
// e o método não têm valor conhecido sem avaliar o módulo e reprovam ANTES, pela
// gramática. O resultado — nunca aprovar — é o mesmo, e a classe descreve o
// defeito mais específico encontrado.
const PROCESSADOR_POR_GRAMATICA = [
  ["chave citada com escape", '"process\\u006fr": "markdown/markdown"'],
  ["identificador de chave escapado", '\\u0070rocessor: "markdown/markdown"'],
  ["chave computada por concatenação", '["proces" + "sor"]: "markdown/markdown"'],
  ["chave computada por template", '[`processor`]: "markdown/markdown"'],
  ["chave computada dinâmica", '[chave]: "markdown/markdown"'],
  ["acessador", 'get processor() { return "markdown/markdown"; }'],
  ["método", 'processor() { return "markdown/markdown"; }']
];

for (const [nome, propriedade] of PROCESSADOR_POR_GRAMATICA) {
  test(`recusa grafia indireta de processador pela gramática — ${nome}`, () => {
    const eslint = lintComBlocos(blocoDeSrcCom(`${BLINDAGEM_NO_BLOCO}, ${propriedade}`));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
  });
}

// Controles positivos: a proibição olha a propriedade ESTRUTURAL, não o texto.
// A mesma palavra em comentário, em literal textual ou como prefixo de outro
// nome continua sendo dado.
const SEM_PROCESSADOR = [
  ["configuração canônica sem a propriedade", lintComBlocos(BLOCO_LINT)],
  ["palavra em comentário", `/* processor: "markdown-markdown" */\n${lintComBlocos(BLOCO_LINT)}`],
  // H3b2a. Os três chamarizes migraram de propriedade desconhecida do bloco para
  // regra adicional. A prova é a mesma e fica até mais precisa: a proibição olha
  // a propriedade ESTRUTURAL do bloco, e nem a palavra em literal textual nem um
  // NOME DE REGRA com o mesmo prefixo ou o mesmo sufixo a aciona.
  [
    "palavra em literal textual",
    lintComBlocos(
      `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${regrasComRuido('nota: "processor: markdown"')} }`
    )
  ],
  [
    "nome com o mesmo prefixo",
    lintComBlocos(`{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${regrasComRuido("processors: []")} }`)
  ],
  [
    "nome com o mesmo sufixo",
    lintComBlocos(`{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${regrasComRuido("preprocessor: 1")} }`)
  ]
];

for (const [nome, eslint] of SEM_PROCESSADOR) {
  test(`aceita configuração de lint sem propriedade de processador — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// O preâmbulo da COBERTURA não herda nada disto: lá nenhuma propriedade
// inspecionada depende de identificador, e por isso a gramática continua fechada
// em espaços e comentários, exatamente como o H2 a deixou. Controle de
// assimetria deliberada, medido no arquivo que não recebeu a permissão.
test("o preâmbulo da cobertura não admite a importação canônica do analisador", () => {
  const vitest = `${IMPORT_PARSER}${VITEST}`;
  const fx = fixture({ vitest });
  const result = runComFusivel(fx);
  assertCobertura(result, PREAMBULO_EXECUTAVEL, fx, vitest);
  assert.doesNotMatch(result.stderr, PREAMBULO_LINT_INVALIDO, "a classe do lint sequestrou o preâmbulo da cobertura");
});

// --- H3b1. Proteções locais do bloco de complexidade.
//
// Fatia 1. Uma diretiva em comentário dentro do código analisado desliga a regra
// arquivo a arquivo. `noInlineConfig: true` é o que impede isso, e escrevê-lo com
// o valor invertido é a forma mais direta de declarar o gate e não tê-lo.
const comProtecoes = (corpo) => `linterOptions: { ${corpo} }`;

test("recusa noInlineConfig desligado no bloco que prova a complexidade", () => {
  const eslint = lintComBlocos(
    blocoDeSrcCom(`${PARSER_NO_BLOCO}, ${comProtecoes('noInlineConfig: false, reportUnusedDisableDirectives: "error"')}`)
  );
  const fx = fixture({ eslint });
  assertClasseDoLint(runComFusivel(fx), fx, eslint, PROTECOES_INCOMPATIVEIS);
});

// Fatia 2. A prova é ESTRUTURAL, no mesmo objeto: `linterOptions` é aplicado por
// bloco, então proteções declaradas em bloco alheio deixam os arquivos
// protegidos sem elas. A exigência vale para TODOS os blocos que participam da
// prova de alcance, não para um deles.
const BLOCO_DE_SRC_DESPROTEGIDO = semProtecoes(BLOCO_LINT);
const BLOCO_DE_DOCS_PROTEGIDO = `{ files: ["docs/**/*.md"], ${BLINDAGEM_NO_BLOCO} }`;
const BLOCO_DE_SRC_SEM_REGRA = `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO} }`;

const PROTECOES_FORA_DO_BLOCO = [
  ["bloco de src com a regra e sem as proteções", lintComBlocos(BLOCO_DE_SRC_DESPROTEGIDO)],
  ["bloco global com a regra e sem as proteções", lintComBlocos(`{ ${PARSER_NO_BLOCO}, ${REGRAS_LINT} }`)],
  ["proteções declaradas em bloco anterior", lintComBlocos(BLOCO_DE_DOCS_PROTEGIDO, BLOCO_DE_SRC_DESPROTEGIDO)],
  ["proteções declaradas em bloco posterior", lintComBlocos(BLOCO_DE_SRC_DESPROTEGIDO, BLOCO_DE_DOCS_PROTEGIDO)],
  [
    "proteções em bloco de src que não declara a regra",
    lintComBlocos(BLOCO_DE_SRC_SEM_REGRA, BLOCO_DE_SRC_DESPROTEGIDO)
  ],
  [
    "dois blocos provam o alcance e só um declara as proteções",
    lintComBlocos(BLOCO_LINT, `{ files: ["src/**/*.tsx"], ${PARSER_NO_BLOCO}, ${REGRAS_LINT} }`)
  ],
  [
    "proteções apenas em propriedade alheia do mesmo bloco",
    lintComBlocos(
      `{ files: ["src/**/*.ts"], ${PARSER_NO_BLOCO}, ${regrasComRuido(
        "nota: 'linterOptions: { noInlineConfig: true }'"
      )} }`
    )
  ],
  [
    "proteções apenas em comentário dentro do bloco",
    lintComBlocos(`{ files: ["src/**/*.ts"], ${PARSER_NO_BLOCO}, /* ${PROTECOES_NO_BLOCO}, */ ${REGRAS_LINT} }`)
  ]
];

for (const [nome, eslint] of PROTECOES_FORA_DO_BLOCO) {
  test(`recusa bloco de complexidade sem as proteções locais exigidas — ${nome}`, () => {
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, PROTECOES_INCOMPATIVEIS);
  });
}

// Fatia 3. A segunda propriedade é tão obrigatória quanto a primeira, e o único
// valor aceito é o literal textual exato `"error"`: uma diretiva de desativação
// esquecida no código deixaria de ser reportada com qualquer severidade menor, e
// toda forma indireta só teria valor depois de avaliar o módulo.
const DIRETIVAS_SEM_PROVA = [
  ["propriedade ausente", "noInlineConfig: true"],
  ["severidade permissiva", 'noInlineConfig: true, reportUnusedDisableDirectives: "warn"'],
  ["severidade desligada", 'noInlineConfig: true, reportUnusedDisableDirectives: "off"'],
  ["severidade numérica", "noInlineConfig: true, reportUnusedDisableDirectives: 2"],
  ["severidade booleana", "noInlineConfig: true, reportUnusedDisableDirectives: true"],
  ["severidade por identificador", "noInlineConfig: true, reportUnusedDisableDirectives: severidade"],
  ["severidade por chamada", "noInlineConfig: true, reportUnusedDisableDirectives: obterSeveridade()"],
  [
    "severidade por importação dinâmica aguardada",
    'noInlineConfig: true, reportUnusedDisableDirectives: await import("./severidade.mjs")'
  ],
  ["severidade por concatenação", 'noInlineConfig: true, reportUnusedDisableDirectives: "er" + "ror"'],
  ["severidade com escape unicode", 'noInlineConfig: true, reportUnusedDisableDirectives: "\\u0065rror"'],
  ["severidade por template", "noInlineConfig: true, reportUnusedDisableDirectives: `error`"],
  ["severidade em array", 'noInlineConfig: true, reportUnusedDisableDirectives: ["error"]'],
  ["severidade por condicional", 'noInlineConfig: true, reportUnusedDisableDirectives: ci ? "error" : "off"'],
  ["severidade seguida de concatenação", 'noInlineConfig: true, reportUnusedDisableDirectives: "error" + ""'],
  ["apenas a segunda propriedade", 'reportUnusedDisableDirectives: "error"']
];

for (const [nome, corpo] of DIRETIVAS_SEM_PROVA) {
  test(`recusa proteções locais sem a exigência de diretivas não usadas — ${nome}`, () => {
    const eslint = lintComBlocos(blocoDeSrcCom(`${PARSER_NO_BLOCO}, ${comProtecoes(corpo)}`));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, PROTECOES_INCOMPATIVEIS);
  });
}

// Fatia 4. O nível é FECHADO, com a mesma disciplina já aplicada a
// `languageOptions`, a `coverage` e a `thresholds`. Ali não existe motivo
// legítimo para uma chave adicional: toda opção extra deste nível muda o que o
// ESLint aceita do próprio arquivo analisado sem passar por comparação alguma. E
// a chave precisa ser o identificador escrito diretamente: chave citada,
// escapada ou computada, acessador, método e espalhamento só teriam valor
// depois de avaliar o módulo.
const DENTRO_CANONICO = 'noInlineConfig: true, reportUnusedDisableDirectives: "error"';

const NIVEL_DE_PROTECOES_ABERTO = [
  ["opção adicional depois das exigidas", `${DENTRO_CANONICO}, cacheDeRegras: true`],
  ["opção adicional antes das exigidas", `cacheDeRegras: true, ${DENTRO_CANONICO}`],
  ["chave citada em aspas duplas", `"noInlineConfig": true, reportUnusedDisableDirectives: "error"`],
  ["chave citada em aspas simples", `'noInlineConfig': true, reportUnusedDisableDirectives: "error"`],
  ["chave computada literal", `["noInlineConfig"]: true, reportUnusedDisableDirectives: "error"`],
  ["chave computada por template", "[`noInlineConfig`]: true, reportUnusedDisableDirectives: \"error\""],
  ["chave computada por concatenação", `["noInline" + "Config"]: true, reportUnusedDisableDirectives: "error"`],
  ["chave computada dinâmica", `[chave]: true, reportUnusedDisableDirectives: "error"`],
  ["identificador de chave escapado", `\\u006eoInlineConfig: true, reportUnusedDisableDirectives: "error"`],
  ["chave citada com escape", `"noInlineConfi\\u0067": true, reportUnusedDisableDirectives: "error"`],
  ["acessador", `get noInlineConfig() { return true; }, reportUnusedDisableDirectives: "error"`],
  ["método", `noInlineConfig() { return true; }, reportUnusedDisableDirectives: "error"`],
  ["espalhamento", `...base, ${DENTRO_CANONICO}`],
  ["primeira propriedade declarada duas vezes", `noInlineConfig: true, ${DENTRO_CANONICO}`],
  ["segunda propriedade declarada duas vezes", `${DENTRO_CANONICO}, reportUnusedDisableDirectives: "error"`],
  ["nível vazio", ""]
];

for (const [nome, corpo] of NIVEL_DE_PROTECOES_ABERTO) {
  test(`recusa nível de proteções locais fora da gramática fechada — ${nome}`, () => {
    const eslint = lintComBlocos(blocoDeSrcCom(`${PARSER_NO_BLOCO}, ${comProtecoes(corpo)}`));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, PROTECOES_INCOMPATIVEIS);
  });
}

// O valor precisa ser o objeto literal: qualquer outra expressão só teria valor
// conhecido depois de avaliar a candidata.
const PROTECOES_QUE_NAO_SAO_OBJETO = [
  ["identificador", "linterOptions: opcoesDeLint"],
  ["literal textual", 'linterOptions: "estrito"'],
  ["booleano", "linterOptions: true"],
  ["array", "linterOptions: [true]"],
  ["chamada", "linterOptions: criarOpcoes()"],
  ["importação dinâmica aguardada", 'linterOptions: await import("./opcoes.mjs")'],
  ["expressão imediatamente invocada", "linterOptions: (() => ({}))()"]
];

for (const [nome, propriedade] of PROTECOES_QUE_NAO_SAO_OBJETO) {
  test(`recusa proteções locais que não são objeto literal — ${nome}`, () => {
    const eslint = lintComBlocos(blocoDeSrcCom(`${PARSER_NO_BLOCO}, ${propriedade}`));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, PROTECOES_INCOMPATIVEIS);
  });
}

// A duplicação da PRÓPRIA propriedade é detectada um nível acima, pela mesma
// disciplina de chave repetida que já vale para todo bloco de lint: a última
// declaração venceria em silêncio. A classe é a do bloco, não a das proteções.
test("recusa proteções locais declaradas duas vezes no mesmo bloco", () => {
  const eslint = lintComBlocos(blocoDeSrcCom(`${BLINDAGEM_NO_BLOCO}, ${PROTECOES_NO_BLOCO}`));
  const fx = fixture({ eslint });
  assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
});

// Controles positivos: ordem, espaçamento, vírgula final e as duas aspas
// canônicas da severidade.
const PROTECOES_CANONICAS = [
  ["forma canônica", BLINDAGEM_NO_BLOCO],
  [
    "ordem inversa das duas propriedades",
    `${PARSER_NO_BLOCO}, ${comProtecoes('reportUnusedDisableDirectives: "error", noInlineConfig: true')}`
  ],
  [
    "aspas simples na severidade",
    `${PARSER_NO_BLOCO}, ${comProtecoes("noInlineConfig: true, reportUnusedDisableDirectives: 'error'")}`
  ],
  ["vírgula final dentro das proteções", `${PARSER_NO_BLOCO}, ${comProtecoes(`${DENTRO_CANONICO},`)}`],
  [
    "espaços e quebras de linha dentro das proteções",
    `${PARSER_NO_BLOCO}, linterOptions: {\n    noInlineConfig: true,\n    reportUnusedDisableDirectives: "error"\n  }`
  ],
  ["proteções antes do analisador", `${PROTECOES_NO_BLOCO}, ${PARSER_NO_BLOCO}`]
];

for (const [nome, propriedade] of PROTECOES_CANONICAS) {
  test(`aceita proteções locais canônicas — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: lintComBlocos(blocoDeSrcCom(propriedade)) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// A exigência acompanha a PROVA de alcance, e só ela: bloco alheio, bloco sem a
// regra e bloco fora do alcance continuam livres.
const ALCANCE_DAS_PROTECOES = [
  ["bloco sem a regra não precisa das proteções", lintComBlocos(BLOCO_LINT, semProtecoes(BLOCO_DE_DOCS_PROTEGIDO))],
  [
    "bloco que declara a regra fora do alcance não precisa das proteções",
    lintComBlocos(BLOCO_LINT, `{ files: ["tests/**/*.ts"], ${REGRAS_LINT} }`)
  ],
  [
    "dois blocos provam o alcance e os dois declaram as proteções",
    lintComBlocos(BLOCO_LINT, `{ files: ["src/**/*.tsx"], ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`)
  ],
  ["proteções declaradas também em bloco alheio", lintComBlocos(BLOCO_DE_DOCS_PROTEGIDO, BLOCO_LINT)]
];

for (const [nome, eslint] of ALCANCE_DAS_PROTECOES) {
  test(`aceita configuração de lint com proteções locais onde elas são exigidas — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- H3b1.1. A CHAVE das proteções também precisa ser a grafia direta.
//
// A Fatia 4 já fechou o nível DE DENTRO: lá, `"noInlineConfig"` e
// `["noInlineConfig"]` reprovam. A própria chave `linterOptions`, um nível
// acima, continuava aceitando as quatro grafias indiretas porque o bloco de
// lint herda a tolerância que o G2 concedeu a `ignores`. O efeito é o mesmo
// defeito de forma: a chave só é conhecida como `linterOptions` depois de
// decodificar um literal, e a mesma posição sintática aceita a chave montada em
// tempo de execução. A exigência vale para a chave que INTRODUZ as proteções,
// não para as vizinhas do bloco.
const GRAFIAS_INDIRETAS_DAS_PROTECOES = [
  ["chave citada em aspas duplas", '"linterOptions"'],
  ["chave citada em aspas simples", "'linterOptions'"],
  ["chave computada por literal em aspas duplas", '["linterOptions"]'],
  ["chave computada por literal em aspas simples", "['linterOptions']"]
];

const CORPO_DAS_PROTECOES = '{ noInlineConfig: true, reportUnusedDisableDirectives: "error" }';

for (const [nome, chave] of GRAFIAS_INDIRETAS_DAS_PROTECOES) {
  test(`recusa proteções locais introduzidas por chave indireta — ${nome}`, () => {
    const eslint = lintComBlocos(blocoDeSrcCom(`${PARSER_NO_BLOCO}, ${chave}: ${CORPO_DAS_PROTECOES}`));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, PROTECOES_INCOMPATIVEIS);
  });
}

// A grafia indireta reprova mesmo quando o conteúdo é o canônico e o bloco é o
// único que prova o alcance: o defeito é a forma da chave, não o valor.
test("recusa chave indireta das proteções mesmo com o alcance provado por dois blocos", () => {
  const eslint = lintComBlocos(BLOCO_LINT, `{ files: ["src/**/*.tsx"], ${PARSER_NO_BLOCO}, "linterOptions": ${CORPO_DAS_PROTECOES}, ${REGRAS_LINT} }`);
  const fx = fixture({ eslint });
  assertClasseDoLint(runComFusivel(fx), fx, eslint, PROTECOES_INCOMPATIVEIS);
});

// Controle de preservação 1. A grafia DIRETA continua sendo a forma aceita.
test("preserva a aprovação das proteções locais escritas com a chave direta", () => {
  const eslint = lintComBlocos(blocoDeSrcCom(`${PARSER_NO_BLOCO}, linterOptions: ${CORPO_DAS_PROTECOES}`));
  const result = runComFusivel(fixture({ eslint }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

// Controle de preservação 2. A tolerância que o G2 concedeu a `ignores` é
// histórica e NÃO pode ser alcançada por esta correção: as cinco grafias
// continuam aprovando ao lado do bloco protegido.
const IGNORES_TOLERADOS_PELO_G2 = [
  ["chave direta", 'ignores: ["docs/**"]'],
  ["chave citada em aspas duplas", '"ignores": ["dist/**"]'],
  ["chave citada em aspas simples", "'ignores': [\"build/**\"]"],
  ["chave computada em aspas duplas", '["ignores"]: ["coverage/**"]'],
  ["chave computada em aspas simples", "['ignores']: [\"reports/**\"]"]
];

for (const [nome, propriedade] of IGNORES_TOLERADOS_PELO_G2) {
  test(`preserva a tolerância do G2 para padrões ignorados ao lado das proteções — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: lintComBlocos(`{ ${propriedade} }`, BLOCO_LINT) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// Controle de preservação 3 — POLARIDADE INVERTIDA pela Fatia 3 do H3b2a.
//
// Enquanto só `linterOptions` exigia a grafia direta, a chave do analisador
// mantinha a tolerância herdada de `ignores` e as quatro grafias indiretas
// APROVAVAM. A Fatia 3 estendeu a exigência às três propriedades conhecidas que
// o validador LÊ — `files`, `languageOptions` e `rules` —, de modo que estes
// quatro vetores passam a reprovar pela classe genérica de forma. O título
// anterior era `preserva a grafia indireta aceita na chave do analisador do
// bloco — <grafia>`; a substituição documentada é o título abaixo, com os
// mesmos quatro vetores e a mesma intenção, agora como caso negativo.
const ANALISADOR_COM_CHAVE_INDIRETA = [
  ["chave citada em aspas duplas", '"languageOptions"'],
  ["chave citada em aspas simples", "'languageOptions'"],
  ["chave computada em aspas duplas", '["languageOptions"]'],
  ["chave computada em aspas simples", "['languageOptions']"]
];

for (const [nome, chave] of ANALISADOR_COM_CHAVE_INDIRETA) {
  test(`recusa a grafia indireta na chave do analisador do bloco — ${nome}`, () => {
    const eslint = lintComBlocos(blocoDeSrcCom(`${chave}: { parser }, ${PROTECOES_NO_BLOCO}`));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
  });
}

// Controle de preservação 4. A propriedade proibida continua reprovando pela
// PRESENÇA, em qualquer grafia, e pela classe dela — não pela das proteções.
const PROCESSADOR_COM_CHAVE_INDIRETA = [
  ["chave citada em aspas duplas", '"processor"'],
  ["chave citada em aspas simples", "'processor'"],
  ["chave computada em aspas duplas", '["processor"]'],
  ["chave computada em aspas simples", "['processor']"]
];

for (const [nome, chave] of PROCESSADOR_COM_CHAVE_INDIRETA) {
  test(`preserva a recusa da propriedade proibida em qualquer grafia da chave — ${nome}`, () => {
    const eslint = lintComBlocos(blocoDeSrcCom(`${BLINDAGEM_NO_BLOCO}, ${chave}: "md"`));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, PROPRIEDADE_PROIBIDA);
  });
}

// Controle de preservação 5. O dialeto da COBERTURA é outro e continua onde
// estava: chave citada é tolerada ali, chave computada não.
test("preserva o dialeto da cobertura — chave citada continua aceita", () => {
  const vitest = VITEST.replace("thresholds:", '"thresholds":');
  const result = runComFusivel(fixture({ vitest }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

test("preserva o dialeto da cobertura — chave computada continua recusada", () => {
  const vitest = VITEST.replace("thresholds:", '["thresholds"]:');
  const fx = fixture({ vitest });
  const result = runComFusivel(fx);
  assertCobertura(result, /configuração de cobertura em forma não canônica/u, fx, vitest);
});

// --- H3b2a. O nível do OBJETO DE CONFIGURAÇÃO é fechado.
//
// Fatia 1. Propriedade desconhecida com valor EXECUTÁVEL.
//
// O objeto de configuração é lido, não avaliado — mas o ESLint o avalia. Uma
// propriedade que o validador não conhece era percorrida por equilíbrio de
// delimitadores e aprovada qualquer que fosse o conteúdo, inclusive
// `(() => { ... })()`, `carregar()`, `await import(...)` e uma atribuição em
// objeto global. Isso dava ao arquivo um lugar onde código roda com o
// privilégio da ferramenta assim que o ESLint carrega a configuração —
// exatamente o que a regra do preâmbulo impede antes do `export default`.
//
// A recusa não interpreta expressão nenhuma: o primitivo de execução da
// linguagem é a chamada, e toda forma executável precisa do parêntese fora de
// literal textual. É a MESMA disciplina que o H2 aplicou aos valores não
// inspecionados da cobertura.
const bloco = (corpo) => `{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${corpo} }`;
const BOOM = 'boom: (() => { throw new Error("NÃO_EXECUTAR_CONFIGURAÇÃO"); })()';

const DESCONHECIDA_EXECUTAVEL = [
  ["expressão imediatamente invocada depois das regras", bloco(`${REGRAS_LINT}, ${BOOM}`)],
  ["expressão imediatamente invocada antes das regras", bloco(`${BOOM}, ${REGRAS_LINT}`)],
  ["chamada de função", bloco(`nota: carregar(), ${REGRAS_LINT}`)],
  ["importação dinâmica aguardada", bloco(`nota: (await import("x")).default, ${REGRAS_LINT}`)],
  ["atribuição em objeto global", bloco(`nota: (globalThis.__PWN__ = true), ${REGRAS_LINT}`)]
];

for (const [nome, corpo] of DESCONHECIDA_EXECUTAVEL) {
  test(`recusa propriedade desconhecida com valor executável no bloco de lint — ${nome}`, () => {
    const eslint = lintComBlocos(corpo);
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertClasseDoLint(result, fx, eslint, NAO_CANONICO_LINT);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /NÃO_EXECUTAR_CONFIGURAÇÃO|__PWN__/u);
  });
}

// Fatia 2. Propriedade desconhecida com valor ESTÁTICO.
//
// Ser estática não torna a propriedade conhecida. O nível do objeto de
// configuração é comparado com a política inteira, e o que o validador não lê
// não é comparado: uma chave a mais é uma opção do ESLint aplicada ao mesmo
// bloco sem passar por comparação alguma. `plugins`, `settings` e `name` são
// nomes REAIS do ESLint, e justamente por isso são o vetor mais plausível —
// `plugins` troca a implementação da própria regra medida. O nível passa a ser
// FECHADO em `files`, `ignores`, `languageOptions`, `linterOptions` e `rules`,
// com a mesma disciplina já aplicada a `coverage`, a `thresholds` e ao nível
// das proteções locais. A mensagem é a genérica de forma: nome, valor e
// expressão da candidata não voltam ao autor do arquivo.
const DESCONHECIDA_ESTATICA = [
  ["literal textual", 'nota: "texto"'],
  ["número", "nota: 1"],
  ["booleano", "nota: true"],
  ["objeto literal", "nota: { a: 1 }"],
  ["array literal", "nota: [1, 2]"],
  ["identificador", "nota: algo"],
  ["nome real do ESLint: plugins", "plugins: { x: 1 }"],
  ["nome real do ESLint: settings", "settings: { a: 1 }"],
  ["nome real do ESLint: name", 'name: "bloco"']
];

for (const [nome, propriedade] of DESCONHECIDA_ESTATICA) {
  test(`recusa propriedade desconhecida com valor estático no bloco de lint — ${nome}`, () => {
    const eslint = lintComBlocos(bloco(`${propriedade}, ${REGRAS_LINT}`));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
  });

  test(`recusa propriedade desconhecida com valor estático em bloco alheio — ${nome}`, () => {
    const eslint = lintComBlocos(BLOCO_LINT, `{ files: ["docs/**/*.md"], ${propriedade} }`);
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
  });
}

// Fatia 3. As propriedades CONHECIDAS do bloco exigem a grafia direta.
//
// As Fatias 1 e 2 fecharam o nível contra a chave DESCONHECIDA. Sobrava a outra
// metade do mesmo defeito: as chaves que o validador conhece e LÊ continuavam
// aceitando as quatro grafias indiretas, porque o dialeto do bloco de lint
// herdou a tolerância que o G2 concedeu a `ignores`. O efeito é o mesmo já
// corrigido em `linterOptions` pelo H3b1.1 — a chave só é conhecida depois de
// decodificar um literal, e a MESMA posição sintática aceita a chave montada em
// tempo de execução, cujo nome efetivo só existiria depois de avaliar o módulo.
// Com `["fi" + "les"]` indistinguível de `["files"]` na leitura estrutural, o
// escopo, o analisador e as regras do bloco deixariam de ser comparados com a
// política sem que nada no arquivo denunciasse a troca.
//
// A exigência alcança exatamente `files`, `languageOptions` e `rules`. Ela NÃO
// alcança `ignores`: as cinco grafias históricas do G2 continuam aprovando, e o
// controle logo abaixo mede isso no mesmo movimento.
const CORPO_DAS_REGRAS = '{ complexity: ["error", { max: 10, variant: "classic" }] }';

const blocoComGrafias = ({ escopo = "files", analisador = "languageOptions", regras = "rules" } = {}) =>
  `{ ${escopo}: ["src/**/*.ts"], ${analisador}: { parser }, ${PROTECOES_NO_BLOCO}, ${regras}: ${CORPO_DAS_REGRAS} }`;

const GRAFIAS_INDIRETAS_DA_CHAVE = [
  ["chave citada em aspas duplas", (nome) => `"${nome}"`],
  ["chave citada em aspas simples", (nome) => `'${nome}'`],
  ["chave computada por literal em aspas duplas", (nome) => `["${nome}"]`],
  ["chave computada por literal em aspas simples", (nome) => `['${nome}']`]
];

const PROPRIEDADES_DE_GRAFIA_DIRETA = [
  ["escopo do bloco", "escopo", "files"],
  ["analisador do bloco", "analisador", "languageOptions"],
  ["regras do bloco", "regras", "rules"]
];

for (const [rotulo, campo, nome] of PROPRIEDADES_DE_GRAFIA_DIRETA) {
  for (const [grafia, escrever] of GRAFIAS_INDIRETAS_DA_CHAVE) {
    test(`recusa grafia indireta em propriedade conhecida do bloco de lint — ${rotulo}, ${grafia}`, () => {
      const eslint = lintComBlocos(blocoComGrafias({ [campo]: escrever(nome) }));
      const fx = fixture({ eslint });
      assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
    });
  }
}

// A grafia indireta reprova mesmo quando o bloco que prova o alcance é outro: o
// defeito é a forma da chave, e ele vale para todo bloco do arquivo.
for (const [rotulo, campo, nome] of PROPRIEDADES_DE_GRAFIA_DIRETA) {
  test(`recusa grafia indireta em propriedade conhecida de bloco alheio — ${rotulo}`, () => {
    const eslint = lintComBlocos(BLOCO_LINT, blocoComGrafias({ [campo]: `["${nome}"]` }));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
  });
}

// Controle positivo da Fatia 3. As três chaves escritas diretamente continuam
// sendo a forma aceita, no mesmo bloco e com o mesmo conteúdo.
test("aceita o bloco de lint com as três propriedades conhecidas em grafia direta", () => {
  const result = runComFusivel(fixture({ eslint: lintComBlocos(blocoComGrafias()) }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

// Baseline intocável do G2, medida no mesmo movimento: as cinco grafias de
// `ignores` continuam aprovando ao lado do bloco canônico.
for (const [nome, propriedade] of IGNORES_TOLERADOS_PELO_G2) {
  test(`preserva as cinco grafias históricas de padrões ignorados na Fatia 3 — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: lintComBlocos(`{ ${propriedade} }`, blocoComGrafias()) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- H3b2a. Fatia 4. ESCOPOS FORA DA FORMA LITERAL.
//
// O escopo do bloco é o que decide se o gate de complexidade alcança `src`. Ele
// era lido assim: array literal textual vira lista de padrões; QUALQUER outra
// forma vira "escopo desconhecido", é percorrida por `readSkippedValue` e o
// bloco simplesmente deixa de provar alcance. Duas consequências, ambas erradas.
//
// A primeira é de diagnóstico: `files: carregar()` reprovava com "regra de
// complexidade não alcança os arquivos de src", que descreve um defeito que o
// arquivo não tem — o alcance não foi negado, ele não foi LIDO. A segunda é de
// superfície: `readSkippedValue` só equilibra delimitadores, de modo que o
// escopo era o último lugar do bloco onde `(() => { ... })()` e
// `(await import("x")).default` atravessavam intactos, com o privilégio da
// ferramenta no momento em que o ESLint carrega a configuração — exatamente o
// que as Fatias 1 e 2 fecharam para as propriedades desconhecidas.
//
// O escopo passa a ser ESTRITAMENTE LITERAL: array literal, não vazio, só com
// literais textuais. Array vazio entra aqui porque não declara escopo nenhum —
// não é um escopo que erra o alvo, é a ausência de escopo escrita com a sintaxe
// de escopo, e o próprio ESLint recusa `files` vazio.
//
// A DISTINÇÃO que esta fatia não pode destruir está medida logo abaixo: valor
// não literal reprova pela classe de FORMA; valor literal válido que não alcança
// `src` continua reprovando pela classe de ALCANCE. Todos os padrões lidos
// continuam passando pelo compilador e pelas regras H1–H1.3.
const EXECUTAR_NO_ESCOPO = '(() => { throw new Error("NÃO_EXECUTAR_CONFIGURAÇÃO"); })()';

const ESCOPOS_FORA_DA_FORMA_LITERAL = [
  // Migrados da lista de alcance, com a intenção preservada e a classe corrigida.
  ["escopo declarado por identificador", "padroes"],
  ["escopo declarado por chamada", "carregar()"],
  ["escopo com elemento não textual", '["src/**/*.ts", PADRAO]'],
  ["lista de escopos vazia", "[]"],
  // Formas executáveis, fechadas pela mesma disciplina das Fatias 1 e 2.
  ["expressão imediatamente invocada", "(() => [])()"],
  ["expressão imediatamente invocada que lança", EXECUTAR_NO_ESCOPO],
  ["importação dinâmica aguardada", '(await import("x")).default'],
  ["atribuição em objeto global", "(globalThis.__PWN__ = [])"],
  // Formas estáticas que não descrevem uma lista de padrões legível.
  ["objeto literal", "{ a: 1 }"],
  ["literal textual isolado", '"src/**/*.ts"'],
  ["número", "1"],
  ["elemento numérico ao lado de um padrão válido", '["src/**/*.ts", 1]'],
  ["elemento por identificador ao lado de um padrão válido", '["src/**/*.ts", padrao]'],
  ["elemento em template ao lado de um padrão válido", '["src/**/*.ts", `x`]'],
  ["espalhamento dentro do array", "[...padroes]"],
  ["array aninhado", '[["src/**/*.ts"]]']
];

for (const [nome, escopo] of ESCOPOS_FORA_DA_FORMA_LITERAL) {
  test(`recusa escopo do bloco fora da forma literal — ${nome}`, () => {
    const eslint = arrayLint(blocoComEscopo(escopo));
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertClasseDoLint(result, fx, eslint, NAO_CANONICO_LINT);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /NÃO_EXECUTAR_CONFIGURAÇÃO|__PWN__/u);
  });
}

// A propriedade de escopo também precisa ser uma propriedade canônica: acessador,
// método, espalhamento e chave escapada não têm valor conhecido sem avaliar o
// módulo, e reprovam pela mesma classe de forma.
const ESCOPO_FORA_DA_PROPRIEDADE_CANONICA = [
  ["acessador", 'get files() { return ["src/**/*.ts"]; }'],
  ["método", 'files() { return ["src/**/*.ts"]; }'],
  ["espalhamento de objeto", '...{ files: ["src/**/*.ts"] }'],
  ["chave com escape unicode", '"fil\\u0065s": ["src/**/*.ts"]']
];

for (const [nome, propriedade] of ESCOPO_FORA_DA_PROPRIEDADE_CANONICA) {
  test(`recusa a propriedade de escopo fora da forma canônica — ${nome}`, () => {
    const eslint = lintComBlocos(`{ ${propriedade}, ${BLINDAGEM_NO_BLOCO}, ${REGRAS_LINT} }`);
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
  });
}

// A recusa por forma vale em bloco alheio: o escopo ilegível não é o do bloco
// que prova o alcance, e mesmo assim o arquivo inteiro reprova.
test("recusa escopo fora da forma literal em bloco alheio ao que prova o alcance", () => {
  const eslint = lintComBlocos(BLOCO_LINT, '{ files: carregar(), ignores: ["docs/**"] }');
  const fx = fixture({ eslint });
  assertClasseDoLint(runComFusivel(fx), fx, eslint, NAO_CANONICO_LINT);
});

// --- A NUANCE, medida lado a lado. Valor NÃO LITERAL é defeito de FORMA; valor
// LITERAL VÁLIDO que não alcança `src` continua sendo defeito de ALCANCE. As duas
// classes precisam continuar distinguíveis: fundi-las apagaria a informação que
// diz ao autor se ele escreveu o escopo errado ou se escreveu o escopo de um jeito
// que o validador não consegue ler.
const ESCOPOS_LITERAIS_FORA_DE_ALCANCE = [
  ["apenas documentação", '["docs/**/*.ts"]'],
  ["apenas testes", '["tests/**/*.ts"]'],
  ["diretório irmão com o mesmo prefixo", '["src-legado/**/*.ts"]'],
  ["extensão fora do conjunto analisado pelo gate", '["src/**/*.md"]'],
  ["diretório puro sob a raiz protegida", '["src"]']
];

for (const [nome, escopo] of ESCOPOS_LITERAIS_FORA_DE_ALCANCE) {
  test(`preserva a classe de alcance para escopo literal que não alcança src — ${nome}`, () => {
    const eslint = arrayLint(blocoComEscopo(escopo));
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, COMPLEXIDADE_SEM_ALCANCE);
  });
}

test("distingue escopo não literal de escopo literal fora de alcance no mesmo movimento", () => {
  const naoLiteral = arrayLint(blocoComEscopo("carregar()"));
  const literalForaDeAlcance = arrayLint(blocoComEscopo('["docs/**/*.ts"]'));
  const fxForma = fixture({ eslint: naoLiteral });
  const fxAlcance = fixture({ eslint: literalForaDeAlcance });
  const forma = runComFusivel(fxForma);
  const alcance = runComFusivel(fxAlcance);
  assert.match(forma.stderr, NAO_CANONICO_LINT);
  assert.doesNotMatch(forma.stderr, COMPLEXIDADE_SEM_ALCANCE);
  assert.match(alcance.stderr, COMPLEXIDADE_SEM_ALCANCE);
  assert.doesNotMatch(alcance.stderr, NAO_CANONICO_LINT);
  assertSemVazamento(forma, fxForma, naoLiteral);
  assertSemVazamento(alcance, fxAlcance, literalForaDeAlcance);
});

// --- Controles positivos da Fatia 4. O escopo literal continua sendo lido, e os
// padrões continuam passando pelo compilador e pelo matcher H1–H1.3.
const ESCOPOS_LITERAIS_ACEITOS = [
  ["um único padrão de src", '["src/**/*.ts"]'],
  ["vários padrões textuais", '["src/modules/**/*.ts", "src/shared/**/*.ts"]'],
  ["padrão de src ao lado de padrões fora de src", '["docs/**/*.md", "src/**/*.ts", "tests/**/*.ts"]'],
  ["aspas simples nos padrões", "['src/**/*.ts']"],
  ["vírgula final na lista", '["src/**/*.ts",]'],
  ["classe de caracteres aceita pelo matcher", '["src/**/*.[jt]s"]'],
  ["coringa de um caractere aceito pelo matcher", '["src/**/?.ts"]']
];

for (const [nome, escopo] of ESCOPOS_LITERAIS_ACEITOS) {
  test(`aceita escopo do bloco em forma literal — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: arrayLint(blocoComEscopo(escopo)) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// O escopo literal continua submetido às regras de dialeto do H1–H1.3: um padrão
// fora da gramática suportada reprova pela classe DELE, não pela da forma.
const ESCOPOS_LITERAIS_COM_PADRAO_INVALIDO = [
  ["chave de expansão", '["{src,vendor}/**/*.ts"]', SINTAXE_NAO_SUPORTADA],
  ["parêntese de grupo", '["src/(app)/**/*.ts"]', SINTAXE_NAO_SUPORTADA],
  ["contrabarra no valor decodificado", '["src/\\\\*/**/*.ts"]', SINTAXE_NAO_SUPORTADA],
  ["negação fora da convenção", '["!src/**/*.ts"]', NAO_CANONICA]
];

for (const [nome, escopo, esperada] of ESCOPOS_LITERAIS_COM_PADRAO_INVALIDO) {
  test(`preserva o dialeto dos padrões do escopo literal — ${nome}`, () => {
    const eslint = arrayLint(blocoComEscopo(escopo));
    const fx = fixture({ eslint });
    const result = runComFusivel(fx);
    assertReprova(result, esperada);
    assert.doesNotMatch(result.stderr, NAO_CANONICO_LINT);
    assertSemVazamento(result, fx, eslint);
  });
}

// --- H3b2b. VALOR DE REGRA ADICIONAL FORA DA FORMA LITERAL.
//
// Dentro de `rules`, só `complexity` era LIDA. Toda outra regra tinha o valor
// percorrido por `readSkippedValue`, que apenas equilibra delimitadores: depois
// que a Fatia 4 do H3b2a fechou o escopo do bloco, a regra adicional passou a ser
// o último lugar da configuração de lint por onde `carregar()`,
// `(() => { ... })()`, `(await import("x")).default` e `(globalThis.__PWN__ = 1)`
// atravessavam intactos — e tudo isso roda com o privilégio da ferramenta no
// instante em que o ESLint carrega o arquivo.
//
// A verificação de `complexity` não muda. Para as DEMAIS regras o contrato passa
// a ser: o valor precisa ser descrito inteiramente por literais estáticos.
const EXECUTAR_NA_REGRA = '(() => { throw new Error("NÃO_EXECUTAR_CONFIGURAÇÃO"); })()';

const regraAdicional = (valor) =>
  arrayLint(`{ files: ["src/**/*.ts"], ${BLINDAGEM_NO_BLOCO}, ${regrasComRuido(valor)} }`);

function assertRegraNaoLiteral(valor) {
  const eslint = regraAdicional(valor);
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertClasseDoLint(result, fx, eslint, NAO_CANONICO_LINT);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /NÃO_EXECUTAR_CONFIGURAÇÃO|__PWN__/u);
}

// Fatia 1. Valor executável ou identificador livre escrito DIRETAMENTE na regra.
const VALORES_DE_REGRA_NAO_LITERAIS = [
  ["chamada de função", "eqeqeq: executar()"],
  ["expressão imediatamente invocada", "eqeqeq: (() => 1)()"],
  ["expressão imediatamente invocada que lança", `eqeqeq: ${EXECUTAR_NA_REGRA}`],
  ["importação dinâmica aguardada", 'eqeqeq: (await import("x")).default'],
  ["importação dinâmica", 'eqeqeq: import("x")'],
  ["acesso por membro", "eqeqeq: modulo.regra"],
  ["identificador livre", "eqeqeq: minhaRegra"],
  ["identificador undefined", "eqeqeq: undefined"],
  ["identificador NaN", "eqeqeq: NaN"],
  ["identificador Infinity", "eqeqeq: Infinity"],
  ["atribuição em objeto global", "eqeqeq: (globalThis.__PWN__ = 1)"]
];

for (const [nome, valor] of VALORES_DE_REGRA_NAO_LITERAIS) {
  test(`recusa valor de regra adicional fora da forma literal — ${nome}`, () => {
    assertRegraNaoLiteral(valor);
  });
}

// Fatia 2. A mesma recusa EM QUALQUER PROFUNDIDADE. Sem isto o array e o objeto
// do valor da regra continuariam sendo apenas delimitadores equilibrados, e a
// chamada mudaria de endereço em vez de desaparecer: `["error", executar()]` é
// exatamente o mesmo primitivo de execução do vetor da Fatia 1, uma camada
// abaixo. Espalhamento, acessador, método e chave computada entram aqui pelo
// mesmo motivo que já os recusa no bloco: o valor efetivo só existiria depois de
// avaliar o módulo.
const VALORES_DE_REGRA_NAO_LITERAIS_ANINHADOS = [
  ["chamada dentro do array da regra", 'eqeqeq: ["error", executar()]'],
  ["identificador livre dentro do array da regra", 'eqeqeq: ["error", livre]'],
  ["chamada dentro do objeto de opções", 'eqeqeq: ["error", { opcao: executar() }]'],
  ["importação dinâmica dentro do objeto de opções", 'eqeqeq: ["error", { opcao: (await import("x")).default }]'],
  ["expressão que lança dentro do objeto de opções", `eqeqeq: ["error", { opcao: ${EXECUTAR_NA_REGRA} }]`],
  ["acessador dentro do objeto de opções", 'eqeqeq: ["error", { get opcao() { return 1; } }]'],
  ["método dentro do objeto de opções", 'eqeqeq: ["error", { opcao() { return 1; } }]'],
  ["espalhamento dentro do objeto de opções", 'eqeqeq: ["error", { ...base }]'],
  ["espalhamento dentro do array da regra", 'eqeqeq: ["error", ...extras]'],
  ["chave computada por concatenação nas opções", 'eqeqeq: ["error", { ["op" + "cao"]: 1 }]'],
  ["chamada em objeto três níveis abaixo", 'eqeqeq: ["error", { a: { b: { c: executar() } } }]'],
  ["atribuição em objeto global dentro do array", 'eqeqeq: ["error", (globalThis.__PWN__ = 1)]'],
  ["opção declarada duas vezes no mesmo objeto", 'eqeqeq: ["error", { opcao: 1, opcao: 2 }]']
];

for (const [nome, valor] of VALORES_DE_REGRA_NAO_LITERAIS_ANINHADOS) {
  test(`recusa valor aninhado de regra adicional fora da forma literal — ${nome}`, () => {
    assertRegraNaoLiteral(valor);
  });
}

// Fatia 3. CONTROLES POSITIVOS, um por tipo literal da gramática aceita. Fechar
// a forma do valor não pode custar a configuração legítima: uma regra adicional
// continua podendo declarar severidade, opções textuais, números, palavras
// reservadas, arrays e objetos aninhados. E uma STRING continua sendo dado —
// nem `processor` nem os marcadores de comentário escritos dentro dela viram
// propriedade da configuração.
const VALORES_DE_REGRA_LITERAIS = [
  ["array canônico de severidade e opção", 'eqeqeq: ["error", "always"]'],
  ["nome de regra citado", '"@typescript-eslint/no-explicit-any": "error"'],
  ["objeto de opções aninhado", OPCOES_ANINHADAS],
  ["número inteiro", "maxLen: 120"],
  ["número negativo", "deslocamento: -1"],
  ["número com parte fracionária", "fator: 1.5"],
  ["palavra true", "flag: true"],
  ["palavra false", "flagFalsa: false"],
  ["palavra null", "desligada: null"],
  ["array misto de literais", 'mista: ["error", 2, true, null]'],
  ["aspas simples", "aspas: 'error'"],
  ["array vazio", "vazia: []"],
  ["objeto vazio", "objetoVazio: {}"],
  ["vírgula final no array e no objeto", 'final: ["error", { opcao: 1, },]'],
  ["chave citada dentro do objeto de opções", 'citada: ["error", { "opcao": 1 }]'],
  ["string com a palavra do processador é dado", 'nota: "processor: markdown/markdown"'],
  ["string com marcadores de comentário é dado", 'nota2: "/* files: [\\"src/**\\"] */"'],
  ["aspas escapadas dentro do valor textual", 'nota3: "diz \\"error\\" e segue"']
];

for (const [nome, valor] of VALORES_DE_REGRA_LITERAIS) {
  test(`aceita valor de regra adicional em forma literal — ${nome}`, () => {
    const result = runComFusivel(fixture({ eslint: regraAdicional(valor) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

test("aceita o bloco de complexidade sem nenhuma regra adicional", () => {
  const result = runComFusivel(fixture({ eslint: arrayLint(BLOCO_LINT) }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

// A classe de `complexity` é a ANTERIOR e precisa continuar sendo: o leitor novo
// não pode sequestrar o diagnóstico da regra medida. As três formas abaixo são
// defeitos da REGRA DE COMPLEXIDADE, não da forma do valor de uma regra
// adicional, e a distinção diz ao autor onde está o erro.
const COMPLEXIDADE_COM_CLASSE_PRESERVADA = [
  ["regra desligada", blocoRegras('complexity: "off"')],
  ["máximo acima da política", blocoRegras('complexity: ["error", { max: 99, variant: "classic" }]')],
  ["objeto de regras sem a regra de complexidade", blocoRegras('eqeqeq: ["error", "always"]')]
];

for (const [nome, corpo] of COMPLEXIDADE_COM_CLASSE_PRESERVADA) {
  test(`preserva a classe da regra de complexidade ao lado do leitor de regras — ${nome}`, () => {
    const eslint = arrayLint(corpo);
    const fx = fixture({ eslint });
    assertClasseDoLint(runComFusivel(fx), fx, eslint, COMPLEXIDADE_INCOMPATIVEL);
  });
}

// Fatia 4. SEPARADORES, TEXTO RESIDUAL E LIMITE DE PROFUNDIDADE.
//
// Um literal completo não basta: o valor precisa TERMINAR onde o literal
// termina. Operador, condicional, sufixo numérico, separador ausente e texto
// solto depois do literal descrevem um valor que só existiria depois de avaliar
// o módulo, e é por aí que `"er" + "ror"` entregaria uma severidade que a
// leitura estrutural nunca viu.
const VALORES_DE_REGRA_COM_RESIDUO = [
  ["concatenação entre literais textuais", 'eqeqeq: "er" + "ror"'],
  ["concatenação com literal vazio", 'eqeqeq: "error" + ""'],
  ["template sem interpolação", "eqeqeq: `error`"],
  ["condicional entre literais", 'eqeqeq: true ? "error" : "off"'],
  ["separador ausente entre literais do array", 'eqeqeq: ["error" "always"]'],
  ["vírgula sem elemento no array", 'eqeqeq: ["error",, "always"]'],
  ["texto residual depois do array", 'eqeqeq: ["error"] extra'],
  ["array sem fechamento", 'eqeqeq: ["error", { opcao: 1 }'],
  ["expoente depois dos dígitos", "maxLen: 1e1"],
  ["hexadecimal", "maxLen: 0x10"],
  ["separador de milhar", "maxLen: 1_000"],
  ["sufixo de inteiro grande", "maxLen: 10n"],
  ["negação de literal", "flag: !0"],
  ["ponto sem parte fracionária", "fator: 1."]
];

for (const [nome, valor] of VALORES_DE_REGRA_COM_RESIDUO) {
  test(`recusa resíduo depois do literal no valor da regra — ${nome}`, () => {
    assertRegraNaoLiteral(valor);
  });
}

// Profundidade. A leitura é um LAÇO com pilha própria: não há recursão, e por
// isso nenhuma estrutura derruba o processo. O limite declarado é 10000 níveis,
// com folga sobre a estrutura mais profunda que já aprovava.
const objetoAninhado = (niveis) => `${"{ a: ".repeat(niveis)}1${" }".repeat(niveis)}`;

for (const niveis of [10, 50, 200, 1000, 5000]) {
  test(`aceita objeto estático aninhado no valor da regra — ${niveis} níveis`, () => {
    const result = runComFusivel(fixture({ eslint: regraAdicional(`profunda: ${objetoAninhado(niveis)}`) }));
    assert.notEqual(result.signal, "SIGKILL", "processo não terminou dentro do fusível");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

const SEM_ESTOURO_DE_PILHA = /RangeError|Maximum call stack|stack size exceeded/u;

test("recusa objeto estático aninhado acima do limite declarado de profundidade", () => {
  const eslint = regraAdicional(`profunda: ${objetoAninhado(10_001)}`);
  const result = runComFusivel(fixture({ eslint }));
  assert.notEqual(result.signal, "SIGKILL", "processo não terminou dentro do fusível");
  assertReprova(result, NAO_CANONICO_LINT);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, SEM_ESTOURO_DE_PILHA, "a leitura estourou a pilha");
});

// Prova do teto: um arquivo logo abaixo de 1 MiB, todo ele estrutura aninhada,
// reprova pelo LIMITE de profundidade — não por tamanho, não por estouro de
// pilha e não por processo morto pelo fusível.
test("decide arquivo próximo de 1 MiB de estrutura aninhada sem estourar a pilha", () => {
  const eslint = regraAdicional(`profunda: ${objetoAninhado(145_000)}`);
  assert.ok(Buffer.byteLength(eslint, "utf8") < 1024 * 1024, "a fixture precisa caber sob o teto de tamanho");
  assert.ok(Buffer.byteLength(eslint, "utf8") > 1_000_000, "a fixture precisa se aproximar do teto de tamanho");
  const result = runComFusivel(fixture({ eslint }));
  assert.notEqual(result.signal, "SIGKILL", "processo não terminou dentro do fusível");
  assertReprova(result, NAO_CANONICO_LINT);
  assert.doesNotMatch(result.stderr, LIMITE_ARQUIVO, "a decisão veio do tamanho, não do limite de profundidade");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, SEM_ESTOURO_DE_PILHA, "a leitura estourou a pilha");
});

// --- H3b2b.1. FORMA DECIMAL CANÔNICA DO NÚMERO NO VALOR DA REGRA.
//
// O leitor de número do H3b2b parava nos dígitos e aceitava qualquer sequência
// deles. Isso deixava passar duas famílias que NÃO descrevem um número decimal
// canônico, e em nenhuma delas o valor lido pela ferramenta é o valor que o
// consumidor veria:
//
// 1. NÃO FINITO. `9` repetido 400 vezes e `1` seguido de 309 zeros são literais
//    válidos de JavaScript cujo valor é `Infinity`. A ferramenta registrava um
//    número onde o ESLint receberia um infinito, e o limite declarado na regra
//    deixava de ser um limite.
// 2. ZERO À ESQUERDA. `01`, `007` e `00.5` não são só grafia incomum: em módulo
//    ES, que é ESTRITO por definição, o literal octal legado é `SyntaxError`. O
//    consumidor real nem carregaria o arquivo, e a ferramenta o aprovava — o
//    pior desfecho possível, porque a aprovação afirma compatibilidade com uma
//    configuração que não existe. `00` e `-01` entram pela mesma porta.
//
// A gramática aceita passa a ser exatamente:
//   numero  := "-"? inteiro ( "." digitos )?
//   inteiro := "0" | [1-9][0-9]*
//   digitos := [0-9]+
// e, sobre o literal COMPLETO, `Number.isFinite(Number(literal))`.
//
// `0.0` continua canônico: o zero à esquerda proibido é o que PRECEDE outro
// algarismo da parte inteira, não o zero que é a própria parte inteira.
//
// A recusa usa a classe genérica de forma, e a mensagem não ecoa o literal —
// senão os 400 algarismos voltariam no diagnóstico.
const NUMERO_NAO_FINITO = "9".repeat(400);
const NUMERO_ACIMA_DO_MAXIMO = `1${"0".repeat(309)}`;

function assertNumeroForaDaForma(literal) {
  const eslint = regraAdicional(`maxLen: ${literal}`);
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertClasseDoLint(result, fx, eslint, NAO_CANONICO_LINT);
  assert.ok(!result.stderr.includes("maxLen"), "mensagem ecoou o nome da regra da candidata");
}

// Os OITO vetores que a leitura anterior aprovava.
const NUMEROS_DE_REGRA_FORA_DA_FORMA = [
  ["não finito por 400 algarismos", NUMERO_NAO_FINITO],
  ["não finito negativo por 400 algarismos", `-${NUMERO_NAO_FINITO}`],
  ["não finito por expoente escrito por extenso", NUMERO_ACIMA_DO_MAXIMO],
  ["zero à esquerda de um algarismo", "01"],
  ["zero à esquerda com sinal", "-01"],
  ["dois zeros", "00"],
  ["zero à esquerda de dois algarismos", "007"],
  ["zero à esquerda com parte fracionária", "00.5"]
];

for (const [nome, literal] of NUMEROS_DE_REGRA_FORA_DA_FORMA) {
  test(`recusa número fora da forma decimal canônica no valor da regra — ${nome}`, () => {
    assertNumeroForaDaForma(literal);
  });
}

// A mesma recusa EM PROFUNDIDADE: o número dentro do array e dentro do objeto de
// opções é lido pelo mesmo leitor, e sem estes vetores a correção poderia valer
// só no topo do valor da regra.
const NUMEROS_ANINHADOS_FORA_DA_FORMA = [
  ["zero à esquerda dentro do array da regra", 'mista: ["error", 01]'],
  ["não finito dentro do objeto de opções", `mista: ["error", { opcao: ${NUMERO_NAO_FINITO} }]`]
];

for (const [nome, valor] of NUMEROS_ANINHADOS_FORA_DA_FORMA) {
  test(`recusa número aninhado fora da forma decimal canônica — ${nome}`, () => {
    assertRegraNaoLiteral(valor);
  });
}

// O caso dos 400 algarismos é o teste de ECO: se o diagnóstico citasse o literal
// recusado, a candidata escolheria o conteúdo da saída da ferramenta.
test("recusa número não finito sem devolver o literal no diagnóstico", () => {
  const eslint = regraAdicional(`maxLen: ${NUMERO_NAO_FINITO}`);
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertReprova(result, NAO_CANONICO_LINT);
  const saida = `${result.stdout}${result.stderr}`;
  assert.ok(!saida.includes(NUMERO_NAO_FINITO), "diagnóstico devolveu os 400 algarismos da candidata");
  assert.ok(!saida.includes("99999"), "diagnóstico devolveu parte do literal da candidata");
  assert.ok(saida.length < 400, "diagnóstico cresceu com o tamanho do literal recusado");
});

// CONTROLES POSITIVOS da gramática. `0.0` está aqui de propósito: ele tem um zero
// antes do ponto e precisa continuar aprovando.
const NUMEROS_DE_REGRA_CANONICOS = ["0", "-0", "1", "-1", "0.5", "1.5", "0.0", "1.7976931348623157"];

for (const literal of NUMEROS_DE_REGRA_CANONICOS) {
  test(`aceita número na forma decimal canônica no valor da regra — ${literal}`, () => {
    const result = runComFusivel(fixture({ eslint: regraAdicional(`maxLen: ${literal}`) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// FRONTEIRAS que a leitura anterior JÁ recusava e que a nova precisa continuar
// recusando — pela gramática, quando o literal nunca chega a se formar, ou pelo
// separador exigido adiante, quando sobra resíduo. Estes vetores nascem verdes:
// são guarda de regressão, não prova de defeito.
const NUMEROS_DE_REGRA_JA_RECUSADOS = [
  ["sem parte inteira", ".5"],
  ["sem parte inteira e com sinal", "-.5"],
  ["zero com ponto e sem parte fracionária", "0."],
  ["sinal sozinho", "-"],
  ["sinal duplicado", "--1"],
  ["sinal positivo explícito", "+1"],
  ["dois pontos decimais", "1.2.3"]
];

for (const [nome, literal] of NUMEROS_DE_REGRA_JA_RECUSADOS) {
  test(`mantém a recusa de número fora da forma decimal — ${nome}`, () => {
    assertNumeroForaDaForma(literal);
  });
}

// --- H3b2c. FORMA DECIMAL CANÔNICA DO INTEIRO COMPARTILHADO.
//
// `readInteiroDecimal` é o leitor de DOIS consumidores: o `max` da regra de
// complexidade e os quatro limiares de cobertura. Ele parava nos dígitos e
// aceitava qualquer sequência deles, inclusive com ZERO À ESQUERDA.
//
// Não é preferência de grafia. O arquivo candidato é um módulo ES, logo estrito,
// e ali `007`, `010`, `080`, `0080` e `0100` são `SyntaxError` de literal octal
// legado; `09` e `090` caem na variante decimal não octal, igualmente proibida no
// modo estrito. O consumidor real — ESLint, Vitest — NÃO CONSEGUIRIA CARREGAR o
// arquivo, e a ferramenta o aprovava: o desfecho mais grave, porque a aprovação
// afirma compatibilidade com uma configuração que não existe.
//
// A correção é a mesma família do H3b2b.1, aplicada ao OUTRO leitor. Os dois
// continuam distintos e continuam sendo dois: `readNumeroDecimal` lê o número do
// valor de regra adicional, com sinal e parte fracionária; este lê o inteiro sem
// sinal do `max` e dos limiares.
//
// O zero proibido é o que PRECEDE outro algarismo. `0` sozinho continua
// SINTATICAMENTE válido, e a recusa de `max: 0` continua vindo da regra de VALOR
// que já existia — o mínimo do `max` é 1 —, não da gramática.
const complexidadeComMaximo = (literal) =>
  arrayLint(blocoRegras(`complexity: ["error", { max: ${literal}, variant: "classic" }]`));

// A classe é a do CONSUMIDOR. `assertClasseDoLint` já exige a ausência de rastro
// de pilha, da linha de aprovação e de eco da candidata, e já recusa as classes
// vizinhas do lint; falta negar a classe do OUTRO dono do leitor, para provar que
// o diagnóstico não migrou de consumidor.
function assertMaximoRecusado(literal) {
  const eslint = complexidadeComMaximo(literal);
  const fx = fixture({ eslint });
  const result = runComFusivel(fx);
  assertClasseDoLint(result, fx, eslint, COMPLEXIDADE_INCOMPATIVEL);
  assert.doesNotMatch(result.stderr, COBERTURA_LIMIAR, "diagnóstico migrou para o dono do limiar de cobertura");
}

const LIMIARES_CANONICOS = "{ lines: 80, branches: 75, functions: 80, statements: 80 }";
const vitestComLimiares = (corpo) => VITEST.replace(LIMIARES_CANONICOS, corpo);

function assertLimiarRecusado(corpo) {
  const vitest = vitestComLimiares(corpo);
  const fx = fixture({ vitest });
  const result = runComFusivel(fx);
  assertCobertura(result, COBERTURA_LIMIAR, fx, vitest);
  assert.doesNotMatch(result.stderr, COMPLEXIDADE_INCOMPATIVEL, "diagnóstico migrou para o dono da complexidade");
}

// Os QUATRO vetores do `max` que a leitura anterior aprovava. Todos com valor
// dentro da política (1..10) depois da conversão, e todos irrecuperáveis no
// carregamento real do módulo.
const MAXIMOS_COM_ZERO_A_ESQUERDA = [
  ["zero à esquerda de um algarismo", "007"],
  ["zero à esquerda do máximo da política", "010"],
  ["zero à esquerda de algarismo não octal", "09"],
  ["dois zeros à esquerda", "0010"]
];

for (const [nome, literal] of MAXIMOS_COM_ZERO_A_ESQUERDA) {
  test(`recusa máximo de complexidade com zero à esquerda — ${nome}`, () => {
    assertMaximoRecusado(literal);
  });
}

// Os SEIS vetores do limiar que a leitura anterior aprovava, um por métrica
// alcançada e um por grafia do zero à esquerda.
const LIMIARES_COM_ZERO_A_ESQUERDA = [
  ["lines com zero à esquerda", "{ lines: 080, branches: 75, functions: 80, statements: 80 }"],
  ["branches com zero à esquerda", "{ lines: 80, branches: 075, functions: 80, statements: 80 }"],
  ["functions e statements com zero à esquerda", "{ lines: 80, branches: 75, functions: 080, statements: 080 }"],
  ["lines com dois zeros à esquerda", "{ lines: 0080, branches: 75, functions: 80, statements: 80 }"],
  ["lines com zero à esquerda de algarismo não octal", "{ lines: 090, branches: 75, functions: 80, statements: 80 }"],
  ["lines com zero à esquerda de cem", "{ lines: 0100, branches: 75, functions: 80, statements: 80 }"]
];

for (const [nome, corpo] of LIMIARES_COM_ZERO_A_ESQUERDA) {
  test(`recusa limiar de cobertura com zero à esquerda — ${nome}`, () => {
    assertLimiarRecusado(corpo);
  });
}

// A prova de que `0` continua SINTATICAMENTE válido não pode vir do `max`, onde
// a regra de valor reprova o zero por outro motivo. Ela vem do OUTRO consumidor,
// que não tem mínimo próprio: com uma política que exige zero, o limiar `0` da
// candidata só aprova se o leitor devolver o inteiro zero. Se o zero passasse a
// reprovar pela grafia, este teste ficaria vermelho.
test("lê o inteiro zero como valor válido no limiar de cobertura", () => {
  const policy = { ...POLICY, coverage: { ...POLICY.coverage, lines: 0, branches: 0, functions: 0, statements: 0 } };
  const vitest = vitestComLimiares("{ lines: 0, branches: 0, functions: 0, statements: 0 }");
  const result = runComFusivel(fixture({ vitest, policy }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

// E o contraste no `max`: `0` reprova pela regra de VALOR, `00` pela GRAMÁTICA, e
// a classe é a mesma nos dois — porque o dono do diagnóstico não mudou.
const MAXIMOS_ZERO = [
  ["zero canônico, reprovado pela regra de valor", "0"],
  ["zero duplicado, reprovado pela grafia", "00"]
];

for (const [nome, literal] of MAXIMOS_ZERO) {
  test(`mantém a classe da complexidade no máximo zero — ${nome}`, () => {
    assertMaximoRecusado(literal);
  });
}

// FRONTEIRAS que a leitura anterior JÁ recusava e que a nova precisa continuar
// recusando, pela mesma classe. Nascem verdes: são guarda de regressão.
const MAXIMOS_JA_RECUSADOS = [
  ["hexadecimal", "0x0A"],
  ["separador de milhar", "1_0"],
  ["sufixo de inteiro grande", "10n"],
  ["expoente", "1e1"]
];

for (const [nome, literal] of MAXIMOS_JA_RECUSADOS) {
  test(`mantém a recusa de máximo de complexidade fora da forma inteira — ${nome}`, () => {
    assertMaximoRecusado(literal);
  });
}

// CONTROLES POSITIVOS dos dois consumidores, com inteiros decimais canônicos.
const MAXIMOS_CANONICOS = ["1", "10"];

for (const literal of MAXIMOS_CANONICOS) {
  test(`aceita máximo de complexidade na forma inteira canônica — ${literal}`, () => {
    const result = runComFusivel(fixture({ eslint: complexidadeComMaximo(literal) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

const LIMIARES_ACEITOS = [
  ["exatamente na política", LIMIARES_CANONICOS],
  ["acima da política", "{ lines: 100, branches: 100, functions: 100, statements: 100 }"]
];

for (const [nome, corpo] of LIMIARES_ACEITOS) {
  test(`aceita limiar de cobertura na forma inteira canônica — ${nome}`, () => {
    const result = runComFusivel(fixture({ vitest: vitestComLimiares(corpo) }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), APROVACAO);
  });
}

// --- Fronteira de confiança (M2). A raiz confiável precisa ser inequívoca e
// jamais indicável pela árvore candidata. Enquanto a raiz confiável for derivada
// de um argumento que o candidato controla, uma árvore candidata pode suprir a
// própria configuração "confiável" e o gate se autoaprova — três regras de
// dependência a menos, limiares zerados e complexidade ilimitada passando como
// compatíveis. A recusa da fronteira tem CLASSE PRÓPRIA — nem limiar, nem
// dependência, nem argumento inválido — para que a mensagem aponte o defeito
// real: raízes sobrepostas, não valor.
const RAIZES_SOBREPOSTAS =
  /Configuração candidata reprovada: raízes confiável e candidata não podem coincidir nem se sobrepor/u;

// Uma política deliberadamente enfraquecida: uma única regra de dependência no
// lugar das quatro que a base exige, limiares de cobertura zerados e complexidade
// praticamente ilimitada, com o `dependency-cruiser.json` afrouxado na mesma
// proporção. Os dois são internamente coerentes, de modo que — se a raiz confiável
// fosse a própria árvore candidata — o gate leria esse par afrouxado como confiável
// e aprovaria três regras a menos sem sinal algum.
const REGRA_UNICA = "domain-not-to-ui";
const POLITICA_ENFRAQUECIDA = {
  ...POLICY,
  coverage: { ...POLICY.coverage, lines: 0, branches: 0, functions: 0, statements: 0 },
  complexity: { maxCyclomaticPerFunction: 9999 },
  dependencies: { rules: [REGRA_UNICA] }
};
const DEPENDENCIA_ENFRAQUECIDA = {
  forbidden: [{ name: REGRA_UNICA, severity: "error", from: {}, to: {} }],
  options: {}
};
const ESLINT_ENFRAQUECIDO = ESLINT.replace("max: 10", "max: 9999");

// Monta uma árvore ÚNICA que serve simultaneamente de candidata e de "confiável":
// além dos arquivos candidatos, escreve, sob a MESMA raiz, uma `quality/policy.json`
// e um `tooling/toolchain/dependency-cruiser.json` enfraquecidos, coerentes entre si.
// Se a raiz confiável pudesse ser esta árvore, o gate leria o par afrouxado como
// confiável e se autoaprovaria.
function arvoreCandidataComConfiguracaoPropria() {
  const root = mkdtempSync(join(tmpdir(), "candidate-selfapprove-"));
  mkdirSync(join(root, "quality"), { recursive: true });
  mkdirSync(join(root, "tooling", "toolchain"), { recursive: true });
  writeFileSync(join(root, "vitest.config.ts"), VITEST);
  writeFileSync(join(root, "eslint.config.mjs"), ESLINT_ENFRAQUECIDO);
  writeFileSync(join(root, "quality", "policy.json"), JSON.stringify(POLITICA_ENFRAQUECIDA));
  writeFileSync(
    join(root, "tooling", "toolchain", "dependency-cruiser.json"),
    JSON.stringify(DEPENDENCIA_ENFRAQUECIDA)
  );
  return root;
}

// Fatia B, migração do RED. Raízes COINCIDENTES: `--candidate` e `--trusted` apontam
// a MESMA árvore afrouxada. Antes da correção esta era a autoaprovação M2; depois, a
// fronteira recusa por classe própria, antes de ler qualquer arquivo confiável, e
// nenhuma linha de aprovação é emitida.
test("recusa quando a raiz confiável coincide com a árvore candidata", () => {
  const root = arvoreCandidataComConfiguracaoPropria();
  const result = spawnSync(
    process.execPath,
    [cli, "--candidate", root, "--trusted", root],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0, "gate se autoaprovou com raízes coincidentes");
  assert.match(result.stderr, RAIZES_SOBREPOSTAS, "a recusa não foi da classe própria de fronteira");
  assert.doesNotMatch(result.stdout, /compatível com a política confiável/u, "linha de aprovação foi emitida");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at\s/u);
});

// Fatia B, migração do RED. Raízes SOBREPOSTAS: `--trusted` aponta um subdiretório
// da árvore candidata. Nenhuma invocação pode fazer a árvore candidata servir de
// fonte confiável. A rejeição precisa ser da CLASSE PRÓPRIA da fronteira, não um
// genérico `status != 0` que "argumento inválido" satisfaria por acidente — e por
// isso exigimos a classe própria e a ausência da linha de aprovação.
test("nenhuma invocação faz a árvore candidata servir de fonte confiável", () => {
  const root = arvoreCandidataComConfiguracaoPropria();
  const result = spawnSync(
    process.execPath,
    [cli, "--candidate", root, "--trusted", join(root, "quality")],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0, "candidato apontou a própria configuração como confiável e o gate aprovou");
  assert.match(result.stderr, RAIZES_SOBREPOSTAS, "a recusa não foi da classe própria de fronteira");
  assert.doesNotMatch(result.stdout, /compatível com a política confiável/u, "linha de aprovação foi emitida");
});

// Fronteira por SEGMENTO, não por prefixo textual: `candidate` e `candidate-2` são
// irmãos legítimos. Uma raiz confiável irmã, cujo NOME apenas começa com o nome da
// candidata, não é sobreposição e precisa ser aceita — do contrário a checagem
// recusaria árvores disjuntas por mera coincidência de texto. Aqui a confiável irmã
// é bem formada, então o gate APROVA.
test("aceita raízes irmãs cujo nome apenas coincide como prefixo textual", () => {
  const base = mkdtempSync(join(tmpdir(), "irmas-"));
  const candidate = join(base, "candidate");
  const trusted = join(base, "candidate-2");
  mkdirSync(join(candidate, "tooling", "toolchain"), { recursive: true });
  mkdirSync(join(trusted, "quality"), { recursive: true });
  mkdirSync(join(trusted, "tooling", "toolchain"), { recursive: true });
  writeFileSync(join(candidate, "vitest.config.ts"), VITEST);
  writeFileSync(join(candidate, "eslint.config.mjs"), ESLINT);
  writeFileSync(join(trusted, "quality", "policy.json"), JSON.stringify(POLICY));
  writeFileSync(
    join(trusted, "tooling", "toolchain", "dependency-cruiser.json"),
    JSON.stringify(dependencyConfig())
  );
  const result = spawnSync(process.execPath, [cli, "--candidate", candidate, "--trusted", trusted], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

// Colisão de CAIXA em filesystem case-insensitive. Só existe como defeito onde o
// filesystem trata `Candidate` e `candidate` como o MESMO diretório físico — em
// win32, a plataforma corrente. Ali, `--candidate <base>/Candidate` e
// `--trusted <base>/candidate` apontam a mesma árvore afrouxada por duas grafias
// que diferem apenas na caixa: a comparação por segmento case-sensitive as via
// como disjuntas e o gate lia a política enfraquecida da própria candidata como
// confiável — a autoaprovação M2 reaberta. A fronteira precisa recusar por classe
// própria, antes de ler qualquer arquivo confiável, e sem emitir aprovação.
//
// Skip nominal fora de win32: em filesystem case-sensitive (Linux, o CI de
// governance em Ubuntu) `Candidate` e `candidate` são diretórios GENUINAMENTE
// distintos, e apontar `--trusted` para uma árvore confiável válida distinta é
// aprovação legítima, não defeito. Este caso simplesmente não existe lá; forçá-lo
// mascararia irmãos legítimos como sobreposição. Precedente do skip por
// plataforma: os vetores de FIFO em `snapshot.test.mjs`.
function colisaoDeCaixaSkip() {
  return process.platform === "win32" ? false : "colisão de caixa só ocorre em filesystem case-insensitive (win32)";
}

test(
  "recusa colisão de caixa em filesystem case-insensitive",
  { skip: colisaoDeCaixaSkip() },
  () => {
    const base = mkdtempSync(join(tmpdir(), "colisao-caixa-"));
    // UMA árvore física afrouxada, criada com a grafia em caixa alta.
    const root = join(base, "Candidate");
    mkdirSync(join(root, "quality"), { recursive: true });
    mkdirSync(join(root, "tooling", "toolchain"), { recursive: true });
    writeFileSync(join(root, "vitest.config.ts"), VITEST);
    writeFileSync(join(root, "eslint.config.mjs"), ESLINT_ENFRAQUECIDO);
    writeFileSync(join(root, "quality", "policy.json"), JSON.stringify(POLITICA_ENFRAQUECIDA));
    writeFileSync(
      join(root, "tooling", "toolchain", "dependency-cruiser.json"),
      JSON.stringify(DEPENDENCIA_ENFRAQUECIDA)
    );
    // A MESMA árvore, acessada por uma grafia que difere só na caixa.
    const trustedPorColisao = join(base, "candidate");
    const result = spawnSync(
      process.execPath,
      [cli, "--candidate", root, "--trusted", trustedPorColisao],
      { encoding: "utf8" }
    );
    assert.notEqual(result.status, 0, "gate se autoaprovou por colisão de caixa");
    assert.match(result.stderr, RAIZES_SOBREPOSTAS, "a recusa não foi da classe própria de fronteira");
    assert.doesNotMatch(result.stdout, /compatível com a política confiável/u, "linha de aprovação foi emitida");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at\s/u);
  }
);

// --- Fatia C. Inércia da configuração candidata.
//
// Prova NEGATIVA: uma cópia candidata de `dependency-cruiser.json` e `policy.json`
// enfraquecida é INERTE quando existe uma raiz confiável válida e disjunta. O gate lê
// a confiável, ignora por completo qualquer `quality/` ou `tooling/toolchain/` sob a
// candidata, e aprova. Se o afrouxamento candidato tivesse qualquer efeito, o gate
// reprovaria — três regras de dependência a menos.
test("cópia candidata enfraquecida é inerte quando a confiável válida existe", () => {
  const fx = fixture();
  // Semeia, sob a árvore CANDIDATA, um par afrouxado que só teria efeito se a candidata
  // fosse tratada como fonte confiável.
  mkdirSync(join(fx.candidate, "quality"), { recursive: true });
  writeFileSync(join(fx.candidate, "quality", "policy.json"), JSON.stringify(POLITICA_ENFRAQUECIDA));
  writeFileSync(
    join(fx.candidate, "tooling", "toolchain", "dependency-cruiser.json"),
    JSON.stringify(DEPENDENCIA_ENFRAQUECIDA)
  );
  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), APROVACAO);
});

// Prova SIMÉTRICA: com a raiz confiável AUSENTE de configuração, um candidato
// perfeitamente válido reprova. A autoridade é unilateral — a confiável decide, e a
// sua ausência não é aprovação.
test("confiável ausente reprova mesmo com candidato válido", () => {
  const root = mkdtempSync(join(tmpdir(), "confiavel-ausente-"));
  const candidate = join(root, "candidate");
  const trusted = join(root, "trusted");
  mkdirSync(join(candidate, "tooling", "toolchain"), { recursive: true });
  mkdirSync(trusted, { recursive: true });
  writeFileSync(join(candidate, "vitest.config.ts"), VITEST);
  writeFileSync(join(candidate, "eslint.config.mjs"), ESLINT);
  const result = spawnSync(process.execPath, [cli, "--candidate", candidate, "--trusted", trusted], {
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0, "confiável sem política aprovou candidato válido");
  assert.doesNotMatch(result.stdout, /compatível com a política confiável/u, "linha de aprovação foi emitida");
});
