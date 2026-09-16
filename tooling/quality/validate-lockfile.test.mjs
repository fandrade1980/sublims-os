import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve(import.meta.dirname, "validate-lockfile.mjs");

// Registry autorizado e não autorizado são literais desta suíte. Derivá-los da
// política em tempo de teste faria a expectativa acompanhar qualquer erro da
// implementação, e o teste passaria a confirmar a si mesmo.
const REGISTRY_AUTORIZADO = "https://registry.npmjs.org/";
const REGISTRY_NAO_AUTORIZADO = "https://registry.exemplo.com/";

function lockfile(resolvedUrl) {
  return {
    name: "fixture",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture", version: "0.0.0", dependencies: { "left-pad": "1.3.0" } },
      "node_modules/left-pad": {
        version: "1.3.0",
        resolved: resolvedUrl,
        integrity: "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA=="
      }
    }
  };
}

const ALGORITMOS_ACEITOS = ["sha512"];
const VERSOES_ACEITAS = [3];

const AUSENTE = Symbol("campo ausente na fixture");

function escrever({
  packages,
  allowedRegistries,
  acceptedIntegrityAlgorithms,
  acceptedLockfileVersions = VERSOES_ACEITAS,
  lockfileVersion = 3
}) {
  const root = mkdtempSync(join(tmpdir(), "sublims-lockfile-"));
  const lockfilePath = join(root, "package-lock.json");
  const policyPath = join(root, "policy.json");
  const conteudo = { name: "fixture", version: "0.0.0", requires: true, packages };
  if (lockfileVersion !== AUSENTE) conteudo.lockfileVersion = lockfileVersion;
  writeFileSync(lockfilePath, JSON.stringify(conteudo, null, 2));
  const lockfilePolicy = { allowedRegistries, acceptedIntegrityAlgorithms };
  if (acceptedLockfileVersions !== AUSENTE) {
    lockfilePolicy.acceptedLockfileVersions = acceptedLockfileVersions;
  }
  writeFileSync(policyPath, JSON.stringify({ version: 2, lockfile: lockfilePolicy }, null, 2));
  return { lockfilePath, policyPath };
}

function fixture(
  resolvedUrl,
  allowedRegistries = [REGISTRY_AUTORIZADO],
  acceptedIntegrityAlgorithms = ALGORITMOS_ACEITOS
) {
  return escrever({
    packages: lockfile(resolvedUrl).packages,
    allowedRegistries,
    acceptedIntegrityAlgorithms
  });
}

// Nomes privados e token ficam dentro de um `resolved` que ainda começa pelo prefixo
// autorizado: sem isso a entrada reprovaria por registry e nunca alcançaria a
// verificação de integridade que estas fatias exercitam.
const ORG_PRIVADA = "ORG_PRIVADA_NAO_EXIBIR";
const PACOTE_PRIVADO = "PACOTE_PRIVADO_NAO_EXIBIR";
const TOKEN_URL = "TOKEN_URL_NAO_EXIBIR";
const CAMINHO_PRIVADO = `node_modules/@${ORG_PRIVADA}/${PACOTE_PRIVADO}`;
const RESOLVED_PRIVADO =
  `${REGISTRY_AUTORIZADO}@${ORG_PRIVADA}/${PACOTE_PRIVADO}/-/${PACOTE_PRIVADO}-1.0.0.tgz?token=${TOKEN_URL}`;
const DIGEST_SHA512_VALIDO =
  "XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==";

// `integrity` omitido de verdade: atribuir `undefined` faria `JSON.stringify`
// descartar a chave, mas passar por aqui deixa a intenção explícita no teste.
function fixtureIntegridade(integrity, { omitir = false } = {}) {
  const entrada = { version: "1.0.0", resolved: RESOLVED_PRIVADO };
  if (!omitir) entrada.integrity = integrity;
  return escrever({
    packages: {
      "": { name: "fixture", version: "0.0.0" },
      [CAMINHO_PRIVADO]: entrada
    },
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
  });
}

// Marcadores que jamais podem aparecer em stdout ou stderr.
function assertSemVazamento(result, extras = []) {
  const saida = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  for (const marcador of [ORG_PRIVADA, PACOTE_PRIVADO, TOKEN_URL, RESOLVED_PRIVADO, CAMINHO_PRIVADO, ...extras]) {
    assert.ok(!saida.includes(marcador), `saída não pode conter ${marcador}`);
  }
}

function run({ lockfilePath, policyPath }) {
  return spawnSync(
    process.execPath,
    [cli, "--lockfile", lockfilePath, "--policy", policyPath],
    { encoding: "utf8" }
  );
}

// Ausência do módulo, erro de sintaxe ou stack trace são falha de infraestrutura,
// não reprovação de domínio. Sem esta guarda, o vermelho da fatia passaria por
// motivo errado e o verde não provaria nada.
function assertRejeicaoDeDominio(result, padraoEsperado) {
  const stderr = result.stderr ?? "";
  assert.doesNotMatch(stderr, /MODULE_NOT_FOUND|Cannot find module/, "CLI ausente não é reprovação de domínio");
  assert.doesNotMatch(stderr, /SyntaxError|ReferenceError|TypeError/, "erro de runtime não é reprovação de domínio");
  assert.doesNotMatch(stderr, /^\s+at\s/m, "stack trace não é reprovação de domínio");
  assert.notEqual(result.status, 0, "reprovação precisa de código de saída não zero");
  assert.match(stderr, padraoEsperado);
}

test("aceita lockfile cuja dependência resolve por registry autorizado", () => {
  const result = run(fixture(`${REGISTRY_AUTORIZADO}left-pad/-/left-pad-1.3.0.tgz`));
  assert.doesNotMatch(result.stderr ?? "", /MODULE_NOT_FOUND|Cannot find module/, "CLI precisa existir");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual((result.stdout ?? "").trim(), "", "aprovação precisa ser afirmada em stdout");
});

test("recusa lockfile cuja dependência resolve por registry não autorizado", () => {
  const result = run(fixture(`${REGISTRY_NAO_AUTORIZADO}left-pad/-/left-pad-1.3.0.tgz`));
  assertRejeicaoDeDominio(result, /registry não autorizado/i);
});

// Marcadores inequívocos: se aparecerem na saída, o valor veio da entrada, não de
// texto fixo do validador. Credencial em `userinfo` e token em query string são as
// duas formas mais comuns de segredo embutido numa URL de registry privado.
const SEGREDO_CREDENCIAL = "SEGREDO_NAO_EXIBIR";
const SEGREDO_QUERY = "OUTRO_SEGREDO";
const URL_COM_SEGREDOS =
  `https://usuario:${SEGREDO_CREDENCIAL}@registry.exemplo.com/pacote.tgz?token=${SEGREDO_QUERY}`;

// Marcadores inequívocos das partes de uma resolução Git. Se qualquer um aparecer
// na saída, o valor veio da entrada e não de texto fixo do validador.
const CREDENCIAL_GIT = "CREDENCIAL_GIT_NAO_EXIBIR";
const ORGANIZACAO = "ORGANIZACAO_PRIVADA";
const REPOSITORIO = "REPOSITORIO_PRIVADO";
const FRAGMENTO = "FRAGMENTO_COMMIT";

// Cada caso traz uma `allowedRegistries` deliberadamente permissiva, contendo um
// prefixo que casa a própria resolução Git. A proibição precisa prevalecer sobre a
// allowlist: política malformada não pode destravar Git.
const RESOLUCOES_GIT = [
  {
    forma: "git+https://",
    resolved: `git+https://${CREDENCIAL_GIT}@github.com/${ORGANIZACAO}/${REPOSITORIO}.git#${FRAGMENTO}`,
    allowedRegistries: ["git+https://"]
  },
  {
    forma: "git+ssh://",
    resolved: `git+ssh://git@github.com/${ORGANIZACAO}/${REPOSITORIO}.git#${FRAGMENTO}`,
    allowedRegistries: ["git+ssh://"]
  },
  {
    forma: "git://",
    resolved: `git://github.com/${ORGANIZACAO}/${REPOSITORIO}.git#${FRAGMENTO}`,
    allowedRegistries: ["git://"]
  },
  {
    forma: "ssh://",
    resolved: `ssh://git@github.com/${ORGANIZACAO}/${REPOSITORIO}.git#${FRAGMENTO}`,
    allowedRegistries: ["ssh://"]
  },
  {
    forma: "shorthand github:",
    resolved: `github:${ORGANIZACAO}/${REPOSITORIO}#${FRAGMENTO}`,
    allowedRegistries: [`github:${ORGANIZACAO}/`]
  },
  {
    forma: "SCP git@host:org/repo.git",
    resolved: `git@github.com:${ORGANIZACAO}/${REPOSITORIO}.git#${FRAGMENTO}`,
    allowedRegistries: [`git@github.com:${ORGANIZACAO}/`]
  },
  {
    forma: "HTTPS apontando para repositório .git",
    resolved: `https://github.com/${ORGANIZACAO}/${REPOSITORIO}.git#${FRAGMENTO}`,
    allowedRegistries: ["https://github.com/"]
  }
];

for (const { forma, resolved, allowedRegistries } of RESOLUCOES_GIT) {
  test(`recusa resolução Git mesmo com allowlist permissiva: ${forma}`, () => {
    const result = run(fixture(resolved, allowedRegistries));
    const saida = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assertRejeicaoDeDominio(result, /resolução Git proibida/i);

    for (const marcador of [CREDENCIAL_GIT, ORGANIZACAO, REPOSITORIO, FRAGMENTO, resolved, "github.com"]) {
      assert.ok(!saida.includes(marcador), `saída não pode conter ${marcador}`);
    }
  });
}

// Tarball hospedado fora dos registries autorizados. Não é Git — não casa nenhuma
// das formas do microciclo anterior — e por isso precisa cair na regra de registry.
const SEGREDO_TARBALL = "SEGREDO_TARBALL_NAO_EXIBIR";
const TARBALL_EXTERNO =
  `https://artefatos.exemplo.com/privado/pacote-1.0.0.tgz?assinatura=${SEGREDO_TARBALL}`;

test("recusa tarball hospedado fora dos registries autorizados", () => {
  const result = run(fixture(TARBALL_EXTERNO));
  const saida = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assertRejeicaoDeDominio(result, /não autorizad|proibid/i);

  for (const marcador of [SEGREDO_TARBALL, TARBALL_EXTERNO, "artefatos.exemplo.com", "privado"]) {
    assert.ok(!saida.includes(marcador), `saída não pode conter ${marcador}`);
  }
});

test("não ecoa credencial, query string nem URL ao recusar registry não autorizado", () => {
  const result = run(fixture(URL_COM_SEGREDOS));
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const saida = `${stdout}${stderr}`;

  assertRejeicaoDeDominio(result, /registry não autorizado/i);

  assert.ok(!saida.includes(SEGREDO_CREDENCIAL), "credencial da URL não pode aparecer na saída");
  assert.ok(!saida.includes(SEGREDO_QUERY), "token da query string não pode aparecer na saída");
  assert.ok(!saida.includes(URL_COM_SEGREDOS), "URL completa não pode aparecer na saída");
  assert.ok(!saida.includes("registry.exemplo.com"), "host da URL não pode aparecer na saída");
});

// --- Fatia 3A: integridade ausente ---

test("recusa entrada externa com `resolved` e sem `integrity`", () => {
  const result = run(fixtureIntegridade(undefined, { omitir: true }));
  assertRejeicaoDeDominio(result, /integridade ausente/i);
  assertSemVazamento(result);
});

// Substitui o controle positivo anterior: `link: true` sem `resolved` não é a forma
// que o npm emite para workspace, e aceitá-la dispensava um link sem alvo de toda
// verificação. A forma real está coberta em "aceita workspace na forma real do npm v3".
test("recusa link sem `resolved`: não representa um workspace real", () => {
  const fx = escrever({
    packages: {
      "": { name: "fixture", version: "0.0.0" },
      "pacotes/interno": { name: "interno", version: "1.0.0" },
      "node_modules/interno": { link: true }
    },
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
  });
  const result = run(fx);
  assertRejeicaoDeDominio(result, /link inválido/i);
});

// --- Fatia 3B: integridade malformada ---

const INTEGRIDADES_MALFORMADAS = [
  { caso: "string vazia", integrity: "" },
  { caso: "somente espaços", integrity: "   " },
  { caso: "sem separador entre algoritmo e digest", integrity: `sha512${DIGEST_SHA512_VALIDO}` },
  { caso: "digest vazio", integrity: "sha512-" },
  { caso: "caractere impossível em Base64", integrity: `sha512-${"!".repeat(86)}==` },
  { caso: "padding no meio do digest", integrity: `sha512-${"A".repeat(40)}==${"A".repeat(44)}` },
  { caso: "padding excessivo", integrity: `sha512-${"A".repeat(86)}===` },
  { caso: "comprimento não canônico para Base64", integrity: `sha512-${"A".repeat(87)}==` },
  { caso: "tipo numérico", integrity: 512 },
  { caso: "tipo objeto", integrity: { sha512: DIGEST_SHA512_VALIDO } },
  { caso: "tipo nulo", integrity: null },
  { caso: "token válido escondendo token malformado", integrity: `sha512-${DIGEST_SHA512_VALIDO} sha512-!!!` }
];

for (const { caso, integrity } of INTEGRIDADES_MALFORMADAS) {
  test(`recusa integridade malformada: ${caso}`, () => {
    const result = run(fixtureIntegridade(integrity));
    assertRejeicaoDeDominio(result, /integridade malformada/i);
    assertSemVazamento(result, [DIGEST_SHA512_VALIDO]);
  });
}

// --- Fatia 3C: algoritmo de integridade não autorizado ---

// Digests sintaticamente válidos: 27 bytes em sha1 e 32 em sha256 dariam outro
// comprimento, mas a allowlist precisa reprovar pelo algoritmo, não pelo formato.
const DIGEST_SHA1_VALIDO = "2jmj7l5rSw0yVb/vlWAYkK/YBwk=";
const DIGEST_SHA256_VALIDO = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

test("controle positivo: aceita integridade sha512 válida", () => {
  const result = run(fixtureIntegridade(`sha512-${DIGEST_SHA512_VALIDO}`));
  assert.equal(result.status, 0, result.stderr);
});

for (const { caso, integrity } of [
  { caso: "sha1", integrity: `sha1-${DIGEST_SHA1_VALIDO}` },
  { caso: "sha256", integrity: `sha256-${DIGEST_SHA256_VALIDO}` },
  { caso: "md5", integrity: `md5-${DIGEST_SHA1_VALIDO}` }
]) {
  test(`recusa algoritmo de integridade fora da allowlist: ${caso}`, () => {
    const result = run(fixtureIntegridade(integrity));
    assertRejeicaoDeDominio(result, /algoritmo de integridade não autorizado/i);
    assertSemVazamento(result, [DIGEST_SHA1_VALIDO, DIGEST_SHA256_VALIDO]);
  });
}

test("token autorizado não esconde token com algoritmo não autorizado", () => {
  const result = run(fixtureIntegridade(`sha512-${DIGEST_SHA512_VALIDO} sha1-${DIGEST_SHA1_VALIDO}`));
  assertRejeicaoDeDominio(result, /algoritmo de integridade não autorizado/i);
  assertSemVazamento(result, [DIGEST_SHA512_VALIDO, DIGEST_SHA1_VALIDO]);
});

for (const { caso, acceptedIntegrityAlgorithms } of [
  { caso: "ausente", acceptedIntegrityAlgorithms: undefined },
  { caso: "lista vazia", acceptedIntegrityAlgorithms: [] },
  { caso: "item vazio", acceptedIntegrityAlgorithms: ["sha512", "  "] },
  { caso: "item não textual", acceptedIntegrityAlgorithms: ["sha512", 512] }
]) {
  test(`recusa política com acceptedIntegrityAlgorithms ${caso}`, () => {
    const fx = escrever({
      packages: {
        "": { name: "fixture", version: "0.0.0" },
        [CAMINHO_PRIVADO]: {
          version: "1.0.0",
          resolved: RESOLVED_PRIVADO,
          integrity: `sha512-${DIGEST_SHA512_VALIDO}`
        }
      },
      allowedRegistries: [REGISTRY_AUTORIZADO],
      acceptedIntegrityAlgorithms
    });
    const result = run(fx);
    assertRejeicaoDeDominio(result, /acceptedIntegrityAlgorithms/i);
  });
}

// --- Fatia 4A: versão aceita do formato ---

function fixtureVersao({ lockfileVersion, acceptedLockfileVersions = VERSOES_ACEITAS }) {
  return escrever({
    packages: {
      "": { name: "fixture", version: "0.0.0" },
      [CAMINHO_PRIVADO]: {
        version: "1.0.0",
        resolved: RESOLVED_PRIVADO,
        integrity: `sha512-${DIGEST_SHA512_VALIDO}`
      }
    },
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS,
    acceptedLockfileVersions,
    lockfileVersion
  });
}

test("aceita lockfileVersion 3 declarado na allowlist", () => {
  const result = run(fixtureVersao({ lockfileVersion: 3 }));
  assert.equal(result.status, 0, result.stderr);
});

for (const { caso, lockfileVersion } of [
  { caso: "versão 1 fora da allowlist", lockfileVersion: 1 },
  { caso: "versão 2 fora da allowlist", lockfileVersion: 2 },
  { caso: "versão 9 fora da allowlist", lockfileVersion: 9 },
  { caso: "ausente", lockfileVersion: AUSENTE },
  { caso: "tipo textual", lockfileVersion: "3" },
  { caso: "tipo nulo", lockfileVersion: null },
  { caso: "não inteiro", lockfileVersion: 3.5 }
]) {
  test(`recusa lockfileVersion: ${caso}`, () => {
    const result = run(fixtureVersao({ lockfileVersion }));
    assertRejeicaoDeDominio(result, /lockfileVersion/i);
    assertSemVazamento(result);
  });
}

for (const { caso, acceptedLockfileVersions } of [
  { caso: "ausente", acceptedLockfileVersions: AUSENTE },
  { caso: "lista vazia", acceptedLockfileVersions: [] },
  { caso: "item textual", acceptedLockfileVersions: [3, "4"] },
  { caso: "item não inteiro", acceptedLockfileVersions: [3, 4.5] }
]) {
  test(`recusa política com acceptedLockfileVersions ${caso}`, () => {
    const result = run(fixtureVersao({ lockfileVersion: 3, acceptedLockfileVersions }));
    assertRejeicaoDeDominio(result, /acceptedLockfileVersions/i);
  });
}

// --- Fatia 4B/4C/4D: expectativas de ferramenta ---

const DIGEST_ESLINT = "NPXn6r5zl4uET1DAVPaOwzX3rut4c0wcmw3dWJAfOsTM5+TogXo0DDjz8pwm/hL8cyVNpHqeK4JpN0NjnyFFNw==";
const DIGEST_PARSER = "zYvrmj9Yxd63UGaXw+kdt6A0F0s0qveJyuatIM77bYC2DE4pgmg7a50u8LR7PRtXd0x+h+Tl3eXabGm06SWd3Q==";

// Entradas com a forma real de um `package-lock.json` v3, chaves exatas incluídas.
function pacotesToolchain(sobrescritas = {}) {
  return {
    "": { name: "fixture", version: "0.0.0" },
    "node_modules/eslint": {
      version: "10.10.0",
      resolved: `${REGISTRY_AUTORIZADO}eslint/-/eslint-10.10.0.tgz`,
      integrity: `sha512-${DIGEST_ESLINT}`
    },
    "node_modules/@typescript-eslint/parser": {
      version: "8.70.0",
      resolved: `${REGISTRY_AUTORIZADO}@typescript-eslint/parser/-/parser-8.70.0.tgz`,
      integrity: `sha512-${DIGEST_PARSER}`
    },
    ...sobrescritas
  };
}

function fixtureToolchain(sobrescritas) {
  return escrever({
    packages: pacotesToolchain(sobrescritas),
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
  });
}

function runComExpect({ lockfilePath, policyPath }, expectativas) {
  const args = [cli, "--lockfile", lockfilePath, "--policy", policyPath];
  for (const expectativa of expectativas) args.push("--expect", expectativa);
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

function assertSemVazamentoToolchain(result, extras = []) {
  const saida = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  for (const marcador of [DIGEST_ESLINT, DIGEST_PARSER, `${REGISTRY_AUTORIZADO}eslint`, ...extras]) {
    assert.ok(!saida.includes(marcador), `saída não pode conter ${marcador}`);
  }
}

test("sem --expect o comportamento anterior é preservado", () => {
  const result = runComExpect(fixtureToolchain(), []);
  assert.equal(result.status, 0, result.stderr);
});

test("aceita duas expectativas simultâneas, simples e com escopo", () => {
  const result = runComExpect(fixtureToolchain(), [
    "eslint@10.10.0",
    "@typescript-eslint/parser@8.70.0"
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test("recusa expectativa cujo pacote está ausente", () => {
  const result = runComExpect(fixtureToolchain(), ["dependency-cruiser@18.2.0"]);
  assertRejeicaoDeDominio(result, /expectativa não satisfeita/i);
  assertSemVazamentoToolchain(result, ["dependency-cruiser"]);
});

test("recusa expectativa cuja versão difere", () => {
  const result = runComExpect(fixtureToolchain(), ["eslint@9.0.0"]);
  assertRejeicaoDeDominio(result, /expectativa não satisfeita/i);
  assertSemVazamentoToolchain(result, ["10.10.0", "9.0.0"]);
});

test("pacote transitivo aninhado não satisfaz expectativa de topo", () => {
  const fx = escrever({
    packages: {
      "": { name: "fixture", version: "0.0.0" },
      "node_modules/host": {
        version: "1.0.0",
        resolved: `${REGISTRY_AUTORIZADO}host/-/host-1.0.0.tgz`,
        integrity: `sha512-${DIGEST_SHA512_VALIDO}`
      },
      "node_modules/host/node_modules/eslint": {
        version: "10.10.0",
        resolved: `${REGISTRY_AUTORIZADO}eslint/-/eslint-10.10.0.tgz`,
        integrity: `sha512-${DIGEST_ESLINT}`
      }
    },
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
  });
  const result = runComExpect(fx, ["eslint@10.10.0"]);
  assertRejeicaoDeDominio(result, /expectativa não satisfeita/i);
});

test("recusa duas expectativas para o mesmo pacote como ambíguas", () => {
  const result = runComExpect(fixtureToolchain(), ["eslint@10.10.0", "eslint@10.10.0"]);
  assertRejeicaoDeDominio(result, /expectativa duplicada/i);
});

for (const { caso, expectativa } of [
  { caso: "sem @", expectativa: "eslint" },
  { caso: "pacote vazio", expectativa: "@10.10.0" },
  { caso: "versão vazia", expectativa: "eslint@" },
  { caso: "somente @", expectativa: "@" },
  { caso: "espaço no pacote", expectativa: "es lint@10.10.0" },
  { caso: "espaço na versão", expectativa: "eslint@10.10.0 " },
  { caso: "caminho absoluto", expectativa: "/etc/passwd@1.0.0" },
  { caso: "separador de caminho", expectativa: "node_modules/eslint@10.10.0" },
  // Construída por código: escrita como literal, a barra invertida seria consumida
  // pelo escape do JavaScript e o caso testaria um nome válido por engano.
  { caso: "barra invertida", expectativa: `node_modules${String.fromCharCode(92)}eslint@10.10.0` },
  { caso: "travessia", expectativa: "../../etc@1.0.0" }
]) {
  test(`recusa formato inválido de --expect: ${caso}`, () => {
    const result = runComExpect(fixtureToolchain(), [expectativa]);
    assertRejeicaoDeDominio(result, /--expect inválido/i);
  });
}

// Link na forma real e válida — alvo relativo existente com descritor próprio —,
// para que a recusa venha de `--expect` e não de o link em si ser inválido.
test("link local com nome e versão coincidentes não satisfaz --expect", () => {
  const result = runComExpect(
    fixtureToolchain({
      "pacotes/eslint": { name: "eslint", version: "10.10.0" },
      "node_modules/eslint": { resolved: "pacotes/eslint", link: true }
    }),
    ["eslint@10.10.0"]
  );
  assertRejeicaoDeDominio(result, /expectativa não satisfeita/i);
});

// --- Fatia 4E: entrada instalada sem `resolved` e descritores malformados ---

function fixtureDescritor(descritor) {
  return escrever({
    packages: {
      "": { name: "fixture", version: "0.0.0" },
      [CAMINHO_PRIVADO]: descritor
    },
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
  });
}

for (const { caso, descritor } of [
  { caso: "sem resolved e sem integrity", descritor: { version: "1.0.0" } },
  { caso: "integridade válida mas sem resolved", descritor: { version: "1.0.0", integrity: `sha512-${DIGEST_SHA512_VALIDO}` } },
  { caso: "resolved vazio", descritor: { version: "1.0.0", resolved: "", integrity: `sha512-${DIGEST_SHA512_VALIDO}` } },
  { caso: "resolved só com espaços", descritor: { version: "1.0.0", resolved: "   ", integrity: `sha512-${DIGEST_SHA512_VALIDO}` } }
]) {
  test(`recusa entrada instalada com origem não verificável: ${caso}`, () => {
    const result = run(fixtureDescritor(descritor));
    assertRejeicaoDeDominio(result, /origem não verificável/i);
    assertSemVazamento(result, [DIGEST_SHA512_VALIDO, "1.0.0"]);
  });
}

for (const { caso, descritor } of [
  { caso: "nulo", descritor: null },
  { caso: "string", descritor: `${REGISTRY_AUTORIZADO}${PACOTE_PRIVADO}/-/${PACOTE_PRIVADO}-1.0.0.tgz` },
  { caso: "array", descritor: [{ version: "1.0.0", resolved: RESOLVED_PRIVADO }] }
]) {
  test(`recusa descritor que não é objeto: ${caso}`, () => {
    const result = run(fixtureDescritor(descritor));
    assertRejeicaoDeDominio(result, /descritor inválido/i);
    assertSemVazamento(result);
  });
}

test("aceita workspace na forma real do npm v3: link com resolved relativo", () => {
  const fx = escrever({
    packages: {
      "": { name: "fixture", version: "0.0.0" },
      "pacotes/interno": { name: "interno", version: "1.0.0" },
      "node_modules/interno": { resolved: "pacotes/interno", link: true }
    },
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
  });
  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);
});

// --- Fatia 4F: `link: true` não dispensa a validação de `resolved` ---

const ALVO_PRIVADO = "ALVO_PRIVADO_NAO_EXIBIR";

// O link fica sob o caminho privado; um alvo legítimo existe para provar que a
// recusa vem do `resolved` do link, não da ausência de qualquer workspace.
function fixtureLink(resolvedDoLink, extras = {}) {
  return escrever({
    packages: {
      "": { name: "fixture", version: "0.0.0" },
      "pacotes/interno": { name: "interno", version: "1.0.0" },
      [CAMINHO_PRIVADO]: { link: true, resolved: resolvedDoLink },
      ...extras
    },
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
  });
}

test("link com resolved Git é reprovado como resolução Git, não dispensado", () => {
  const result = run(fixtureLink(`git+https://${CREDENCIAL_GIT}@github.com/${ORGANIZACAO}/${REPOSITORIO}.git#${FRAGMENTO}`));
  assertRejeicaoDeDominio(result, /resolução Git proibida/i);
  assertSemVazamento(result, [CREDENCIAL_GIT, ORGANIZACAO, REPOSITORIO, FRAGMENTO, "github.com"]);
});

for (const { caso, resolvedDoLink, extras } of [
  { caso: "tarball HTTP externo", resolvedDoLink: `https://artefatos.exemplo.com/${ALVO_PRIVADO}.tgz` },
  { caso: "URL do registry autorizado", resolvedDoLink: `${REGISTRY_AUTORIZADO}${ALVO_PRIVADO}/-/${ALVO_PRIVADO}-1.0.0.tgz` },
  { caso: "caminho absoluto POSIX", resolvedDoLink: `/${ALVO_PRIVADO}/interno` },
  { caso: "caminho absoluto Windows", resolvedDoLink: `C:/${ALVO_PRIVADO}/interno` },
  { caso: "travessia ..", resolvedDoLink: `../${ALVO_PRIVADO}` },
  { caso: "travessia no meio", resolvedDoLink: `pacotes/../${ALVO_PRIVADO}` },
  { caso: "componente .", resolvedDoLink: "./pacotes/interno" },
  { caso: "barra invertida", resolvedDoLink: `pacotes${String.fromCharCode(92)}interno` },
  { caso: "componente vazio", resolvedDoLink: "pacotes//interno" },
  { caso: "barra final", resolvedDoLink: "pacotes/interno/" },
  { caso: "alvo inexistente em packages", resolvedDoLink: `pacotes/${ALVO_PRIVADO}` },
  { caso: "alvo com descritor nulo", resolvedDoLink: "pacotes/quebrado", extras: { "pacotes/quebrado": null } },
  { caso: "alvo com descritor array", resolvedDoLink: "pacotes/quebrado", extras: { "pacotes/quebrado": [] } },
  { caso: "resolved vazio", resolvedDoLink: "" },
  { caso: "resolved só com espaços", resolvedDoLink: "   " },
  { caso: "resolved não textual", resolvedDoLink: 42 }
]) {
  test(`recusa link inválido: ${caso}`, () => {
    const result = run(fixtureLink(resolvedDoLink, extras));
    assertRejeicaoDeDominio(result, /link inválido/i);
    assertSemVazamento(result, [ALVO_PRIVADO, "1.0.0"]);
  });
}

// Descritor fora de `node_modules/` que declara origem externa não é workspace e
// precisa cair nas mesmas classificações de uma entrada instalada.
for (const { caso, resolved, padrao, extras } of [
  {
    caso: "resolução Git",
    resolved: `git+ssh://git@github.com/${ORGANIZACAO}/${REPOSITORIO}.git#${FRAGMENTO}`,
    padrao: /resolução Git proibida/i,
    extras: [ORGANIZACAO, REPOSITORIO, FRAGMENTO]
  },
  {
    caso: "tarball externo",
    resolved: `https://artefatos.exemplo.com/${ALVO_PRIVADO}.tgz`,
    padrao: /registry não autorizado/i,
    extras: [ALVO_PRIVADO]
  }
]) {
  test(`descritor fora de node_modules com ${caso} não é ignorado`, () => {
    const fx = escrever({
      packages: {
        "": { name: "fixture", version: "0.0.0" },
        [`pacotes/${PACOTE_PRIVADO}`]: { name: PACOTE_PRIVADO, version: "1.0.0", resolved }
      },
      allowedRegistries: [REGISTRY_AUTORIZADO],
      acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
    });
    const result = run(fx);
    assertRejeicaoDeDominio(result, padrao);
    assertSemVazamento(result, extras);
  });
}

// --- Fatia 4G: links autorreferentes, cíclicos e encadeados ---

function fixtureLinks(packagesExtras) {
  return escrever({
    packages: { "": { name: "fixture", version: "0.0.0" }, ...packagesExtras },
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
  });
}

test("recusa link autorreferente", () => {
  const result = run(fixtureLinks({ [CAMINHO_PRIVADO]: { resolved: CAMINHO_PRIVADO, link: true } }));
  assertRejeicaoDeDominio(result, /link inválido/i);
  assertSemVazamento(result);
});

test("recusa ciclo de dois links", () => {
  const a = `node_modules/${PACOTE_PRIVADO}-a`;
  const b = `node_modules/${PACOTE_PRIVADO}-b`;
  const result = run(fixtureLinks({ [a]: { resolved: b, link: true }, [b]: { resolved: a, link: true } }));
  assertRejeicaoDeDominio(result, /link inválido/i);
  assertSemVazamento(result);
});

test("recusa link que aponta para outro link, mesmo terminando em descritor local válido", () => {
  const result = run(fixtureLinks({
    "pacotes/interno": { name: "interno", version: "1.0.0" },
    [`node_modules/${PACOTE_PRIVADO}-ponte`]: { resolved: "pacotes/interno", link: true },
    [CAMINHO_PRIVADO]: { resolved: `node_modules/${PACOTE_PRIVADO}-ponte`, link: true }
  }));
  assertRejeicaoDeDominio(result, /link inválido/i);
  assertSemVazamento(result, ["pacotes/interno"]);
});

test("controle positivo: link direto para descritor local sem link continua aceito", () => {
  const result = run(fixtureLinks({
    "pacotes/interno": { name: "interno", version: "1.0.0" },
    "node_modules/interno": { resolved: "pacotes/interno", link: true }
  }));
  assert.equal(result.status, 0, result.stderr);
});

// Lockfile legítimo sem dependências externas.
//
// Um projeto pode não ter dependência alguma — é o caso do próprio repositório. Nesse
// cenário, "conjunto externo vazio" é a verdade declarada, não uma enumeração perdida.
// A distinção que importa: vazio porque nada foi declarado, contra vazio porque a
// lista foi esvaziada. A segunda continua reprovando.

const RAIZ_SEM_DEPENDENCIAS = { name: "fixture", version: "0.0.0" };

function semDependencias(raiz = RAIZ_SEM_DEPENDENCIAS) {
  return escrever({
    packages: { "": raiz },
    allowedRegistries: [REGISTRY_AUTORIZADO],
    acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
  });
}

test("lockfile v3 sem dependência alguma é aceito", () => {
  const result = run(semDependencias());
  assert.doesNotMatch(result.stderr ?? "", /MODULE_NOT_FOUND|Cannot find module/, "CLI precisa existir");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout ?? "", /0 dependências resolvidas por registry autorizado/);
});

// Coleções presentes e vazias continuam sendo ausência de dependência declarada.
for (const campo of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  test(`lockfile sem dependências com \`${campo}\` vazio é aceito`, () => {
    const result = run(semDependencias({ ...RAIZ_SEM_DEPENDENCIAS, [campo]: {} }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout ?? "", /0 dependências resolvidas por registry autorizado/);
  });
}

test("as quatro coleções vazias ao mesmo tempo são aceitas", () => {
  const result = run(
    semDependencias({
      ...RAIZ_SEM_DEPENDENCIAS,
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      peerDependencies: {}
    })
  );
  assert.equal(result.status, 0, result.stderr);
});

// Deliberadamente NÃO existe aqui um teste contra o `package-lock.json` real do
// repositório. O contrato é provado por fixture; o artefato real é estado, não
// contrato. Hoje ele não tem dependência alguma, mas a fundação da aplicação
// acrescentará dependências legítimas, e um teste que exigisse permanentemente
// "0 dependências" passaria a falhar sem defeito algum no validador.
//
// A prova operacional contra o artefato real continua existindo — executada fora da
// suíte, junto dos demais validadores diretos.

// --- negativos ---

test("packages sem a entrada raiz reprova", () => {
  const result = run(
    escrever({
      packages: {},
      allowedRegistries: [REGISTRY_AUTORIZADO],
      acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS
    })
  );
  assertRejeicaoDeDominio(result, /lockfile sem descritor da raiz/i);
});

for (const [nome, raiz] of [
  ["null", null],
  ["string", "fixture"],
  ["array", []],
  ["número", 1],
  ["booleano", true]
]) {
  test(`descritor da raiz como ${nome} reprova`, () => {
    const result = run(semDependencias(raiz));
    assertRejeicaoDeDominio(result, /descritor da raiz inválido/i);
  });
}

// Dependência declarada sem entrada correspondente: a enumeração está incompleta, e
// aprovar seria aprovar o que não foi verificado.
for (const campo of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  test(`\`${campo}\` não vazio sem entrada enumerada reprova`, () => {
    const result = run(
      semDependencias({ ...RAIZ_SEM_DEPENDENCIAS, [campo]: { [PACOTE_PRIVADO]: "1.0.0" } })
    );
    assertRejeicaoDeDominio(result, /lockfile declara dependências sem entradas enumeradas/i);
    assertSemVazamento(result);
  });
}

for (const [nome, valor] of [
  ["array", []],
  ["string", "left-pad"],
  ["número", 1],
  ["null", null],
  ["booleano", true]
]) {
  test(`coleção de dependências da raiz como ${nome} reprova`, () => {
    const result = run(semDependencias({ ...RAIZ_SEM_DEPENDENCIAS, dependencies: valor }));
    assertRejeicaoDeDominio(result, /coleção de dependências inválida no descritor da raiz/i);
  });
}

test("dependencies legado no topo, não vazio e sem entradas enumeradas, reprova", () => {
  const root = mkdtempSync(join(tmpdir(), "sublims-lockfile-"));
  const lockfilePath = join(root, "package-lock.json");
  const policyPath = join(root, "policy.json");
  writeFileSync(
    lockfilePath,
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": RAIZ_SEM_DEPENDENCIAS },
      dependencies: { [PACOTE_PRIVADO]: { version: "1.0.0" } }
    })
  );
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 2,
      lockfile: {
        allowedRegistries: [REGISTRY_AUTORIZADO],
        acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS,
        acceptedLockfileVersions: VERSOES_ACEITAS
      }
    })
  );
  const result = run({ lockfilePath, policyPath });
  assertRejeicaoDeDominio(result, /lockfile declara dependências sem entradas enumeradas/i);
  assertSemVazamento(result);
});

// `--expect` permanece fail-closed: lockfile vazio não satisfaz expectativa alguma.
// O nome precisa ser canônico — minúsculo — senão `--expect` reprova antes, como
// argumento malformado, e o teste deixaria de exercitar a expectativa em si.
const PACOTE_PRIVADO_CANONICO = PACOTE_PRIVADO.toLowerCase();

test("expectativa contra lockfile sem dependências reprova", () => {
  const result = runComExpect(semDependencias(), [`${PACOTE_PRIVADO_CANONICO}@1.0.0`]);
  assertRejeicaoDeDominio(result, /expectativa não satisfeita/i);
  assertSemVazamento(result, [PACOTE_PRIVADO_CANONICO]);
});

test("mensagens do caminho vazio não ecoam nome, versão nem conteúdo", () => {
  const comDependencia = run(
    semDependencias({ ...RAIZ_SEM_DEPENDENCIAS, dependencies: { [PACOTE_PRIVADO]: "9.9.9" } })
  );
  assertSemVazamento(comDependencia, ["9.9.9"]);
  const colecaoInvalida = run(semDependencias({ ...RAIZ_SEM_DEPENDENCIAS, dependencies: PACOTE_PRIVADO }));
  assertSemVazamento(colecaoInvalida);
});

// Coleção legada no topo do lockfile.
//
// `dependencies` no topo é a forma anterior a `packages`. Presente e vazia é ausência
// de declaração; presente e malformada é erro de forma, com classe própria — colapsar
// as duas numa só mensagem esconderia qual ação corrige o arquivo.

function comLegado(valorLegado, { omitir = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sublims-lockfile-"));
  const lockfilePath = join(root, "package-lock.json");
  const policyPath = join(root, "policy.json");
  const conteudo = {
    name: "fixture",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": RAIZ_SEM_DEPENDENCIAS }
  };
  if (!omitir) conteudo.dependencies = valorLegado;
  writeFileSync(lockfilePath, JSON.stringify(conteudo));
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 2,
      lockfile: {
        allowedRegistries: [REGISTRY_AUTORIZADO],
        acceptedIntegrityAlgorithms: ALGORITMOS_ACEITOS,
        acceptedLockfileVersions: VERSOES_ACEITAS
      }
    })
  );
  return { lockfilePath, policyPath };
}

test("dependencies legado vazio com conjunto externo vazio é aceito", () => {
  const result = run(comLegado({}));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout ?? "", /0 dependências resolvidas por registry autorizado/);
});

test("dependencies legado não vazio reprova como dependências sem entradas enumeradas", () => {
  const result = run(comLegado({ [PACOTE_PRIVADO]: { version: "9.9.9" } }));
  assertRejeicaoDeDominio(result, /lockfile declara dependências sem entradas enumeradas/i);
  assertSemVazamento(result, ["9.9.9"]);
});

for (const [nome, valor] of [
  ["null", null],
  ["string", "left-pad"],
  ["número", 1],
  ["booleano", true],
  ["array", []]
]) {
  test(`dependencies legado como ${nome} reprova por forma inválida`, () => {
    const result = run(comLegado(valor));
    assertRejeicaoDeDominio(result, /coleção de dependências legada inválida/i);
  });
}

test("mensagens da coleção legada não ecoam conteúdo candidato", () => {
  const naoVazio = run(comLegado({ [PACOTE_PRIVADO]: { version: "9.9.9" } }));
  assertSemVazamento(naoVazio, ["9.9.9"]);
  const formaInvalida = run(comLegado(PACOTE_PRIVADO));
  assertSemVazamento(formaInvalida);
  const arrayComConteudo = run(comLegado([PACOTE_PRIVADO]));
  assertSemVazamento(arrayComConteudo);
});
