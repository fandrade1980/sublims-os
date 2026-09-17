import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const VITEST = `export default defineConfig({
  test: {
    coverage: {
      include: ["src/modules/**", "src/shared/**"],
      exclude: [],
      thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 }
    }
  }
});\n`;

const ESLINT = `export default [{
  files: ["src/**/*.ts"],
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
  return { candidate, policy: join(trusted, "quality", "policy.json") };
}

function run(fx, extras = []) {
  return spawnSync(process.execPath, [cli, "--candidate", fx.candidate, "--policy", fx.policy, ...extras], {
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

test("não importa nem avalia a configuração candidata", () => {
  const vitest = `throw new Error("NÃO_EXECUTAR_CONFIGURAÇÃO");\n${VITEST}`;
  const result = run(fixture({ vitest }));
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /NÃO_EXECUTAR_CONFIGURAÇÃO/u);
});

test("não conta padrões em propriedade alheia à cobertura", () => {
  const vitest = VITEST
    .replace('["src/modules/**", "src/shared/**"]', "[]")
    .replace("exclude: []", 'exclude: [], note: ["src/modules/**", "src/shared/**"]');
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

const exportDefault = (body) => `export default defineConfig(${body});\n`;
const withCoverage = (body) => exportDefault(`{ test: { coverage: ${body} } }`);

function assertAmbiguidade(result, ancora, fx, vitest) {
  assert.notEqual(result.status, 0, "configuração ambígua foi aprovada indevidamente");
  assert.match(result.stderr, /Configuração candidata reprovada: configuração ambígua/u);
  assert.match(result.stderr, new RegExp(`âncora "${ancora}"`, "u"));
  assert.match(result.stderr, /deslocamentos? \d/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at\s/u);
  for (const vazamento of ["src/modules", "src/shared", "src/**", "defineConfig", "__DOC__", fx.candidate]) {
    assert.ok(!result.stderr.includes(vazamento), "mensagem vazou conteúdo inspecionado");
  }
  for (const linha of vitest.split("\n")) {
    const texto = linha.trim();
    if (texto.length > 8) assert.ok(!result.stderr.includes(texto), "mensagem ecoou trecho da candidata");
  }
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
  [
    "test: chamariz antes",
    "test",
    exportDefault(
      `{ define: { __DOC__: { test: { coverage: ${STRONG_COVERAGE} } } }, test: { coverage: ${WEAK_COVERAGE} } }`
    )
  ],
  [
    "test: chamariz depois",
    "test",
    exportDefault(
      `{ test: { coverage: ${WEAK_COVERAGE} }, define: { __DOC__: { test: { coverage: ${STRONG_COVERAGE} } } } }`
    )
  ],
  [
    "test: chave duplicada",
    "test",
    exportDefault(`{ test: { coverage: ${STRONG_COVERAGE} }, test: { coverage: ${WEAK_COVERAGE} } }`)
  ],
  [
    "coverage: chamariz antes",
    "coverage",
    exportDefault(`{ test: { docs: { coverage: ${STRONG_COVERAGE} }, coverage: ${WEAK_COVERAGE} } }`)
  ],
  [
    "coverage: chamariz depois",
    "coverage",
    exportDefault(`{ test: { coverage: ${WEAK_COVERAGE}, docs: { coverage: ${STRONG_COVERAGE} } } }`)
  ],
  [
    "coverage: chave duplicada",
    "coverage",
    exportDefault(`{ test: { coverage: ${STRONG_COVERAGE}, coverage: ${WEAK_COVERAGE} } }`)
  ],
  [
    "include: chamariz antes",
    "include",
    withCoverage(`{ docs: { ${STRONG_INCLUDE} }, ${WEAK_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} }`)
  ],
  [
    "include: chamariz depois",
    "include",
    withCoverage(`{ ${WEAK_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}, docs: { ${STRONG_INCLUDE} } }`)
  ],
  [
    "include: chave duplicada",
    "include",
    withCoverage(`{ ${STRONG_INCLUDE}, ${WEAK_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS} }`)
  ],
  [
    "exclude: chamariz antes",
    "exclude",
    withCoverage(`{ ${STRONG_INCLUDE}, docs: { ${STRONG_EXCLUDE} }, ${WEAK_EXCLUDE}, ${STRONG_THRESHOLDS} }`)
  ],
  [
    "exclude: chamariz depois",
    "exclude",
    withCoverage(`{ ${STRONG_INCLUDE}, ${WEAK_EXCLUDE}, ${STRONG_THRESHOLDS}, docs: { ${STRONG_EXCLUDE} } }`)
  ],
  [
    "exclude: chave duplicada",
    "exclude",
    withCoverage(`{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${WEAK_EXCLUDE}, ${STRONG_THRESHOLDS} }`)
  ],
  [
    "thresholds: chamariz antes",
    "thresholds",
    withCoverage(`{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, docs: { ${STRONG_THRESHOLDS} }, ${WEAK_THRESHOLDS} }`)
  ],
  [
    "thresholds: chamariz depois",
    "thresholds",
    withCoverage(`{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${WEAK_THRESHOLDS}, docs: { ${STRONG_THRESHOLDS} } }`)
  ],
  [
    "thresholds: chave duplicada",
    "thresholds",
    withCoverage(`{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, ${STRONG_THRESHOLDS}, ${WEAK_THRESHOLDS} }`)
  ]
];

const LIMIARES = { lines: 80, branches: 75, functions: 80, statements: 80 };

for (const [metric, valor] of Object.entries(LIMIARES)) {
  const pares = Object.entries(LIMIARES).map(([nome, limite]) => `${nome}: ${nome === metric ? 0 : limite}`);
  const variantes = [
    [`${metric}: chamariz antes`, `{ docs: { ${metric}: ${valor} }, ${pares.join(", ")} }`],
    [`${metric}: chamariz depois`, `{ ${pares.join(", ")}, docs: { ${metric}: ${valor} } }`],
    [
      `${metric}: chave duplicada`,
      `{ ${pares.map((par) => (par.startsWith(`${metric}:`) ? `${metric}: ${valor}, ${par}` : par)).join(", ")} }`
    ]
  ];
  for (const [nome, thresholds] of variantes) {
    AMBIGUOS.push([
      nome,
      metric,
      withCoverage(`{ ${STRONG_INCLUDE}, ${STRONG_EXCLUDE}, thresholds: ${thresholds} }`)
    ]);
  }
}

for (const [nome, ancora, vitest] of AMBIGUOS) {
  test(`recusa âncora ambígua — ${nome}`, () => {
    const fx = fixture({ vitest });
    assertAmbiguidade(run(fx), ancora, fx, vitest);
  });
}

// --- Arrays "ignores" do ESLint: a delimitação precisa ser sensível a aspas.
// Um "]" dentro de uma string é bracket expression legítima de glob e não pode
// encerrar o array inspecionado. Todos os arrays "ignores" do arquivo precisam
// ser lidos, porque flat config admite vários blocos.

const REGRAS_LINT = 'rules: { complexity: ["error", { max: 10, variant: "classic" }] }';

function eslintComIgnores(...listas) {
  const blocos = listas.map((lista, indice) =>
    indice === 0
      ? `{ ignores: [${lista}], files: ["src/**/*.ts"], ${REGRAS_LINT} }`
      : `{ ignores: [${lista}] }`
  );
  return `export default [\n  ${blocos.join(",\n  ")}\n];\n`;
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

const ESLINT_ARRAY_MALFORMADO = `export default [{
  ignores: ["docs/**",
  files: ["src/**/*.ts"],
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
    indice === 0 ? `{ ${propriedade}, files: ["src/**/*.ts"], ${REGRAS_LINT} }` : `{ ${propriedade} }`
  );
  return `export default [\n  ${blocos.join(",\n  ")}\n];\n`;
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
  ["nenhuma propriedade de padrões ignorados", eslintComPropriedades('files: ["docs/**/*.ts"]')]
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
  return spawnSync(process.execPath, [cli, "--candidate", fx.candidate, "--policy", fx.policy], {
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
