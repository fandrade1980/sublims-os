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
