import assert from "node:assert/strict";
import test from "node:test";

import { assertSpecIdentity, canonicalSpecId, parseSpecMeta } from "./spec-meta.mjs";

// Valores esperados são literais: o teste não reconstrói o bloco nem repete o
// algoritmo do módulo, apenas afirma o que um markdown concreto deve produzir.
const BLOCO_UNICO = [
  "# Especificação 3 — exemplo",
  "",
  "<!-- spec-meta",
  '{"id":"3","issue":"github:#3","status":"approved"}',
  "-->",
  "",
  "## Status",
  "Texto."
].join("\n");

test("parseSpecMeta devolve o objeto do único bloco spec-meta", () => {
  assert.deepEqual(parseSpecMeta(BLOCO_UNICO), { id: "3", issue: "github:#3", status: "approved" });
});

test("parseSpecMeta rejeita markdown sem bloco spec-meta", () => {
  assert.throws(
    () => parseSpecMeta("# Sem metadados\n\n## Status\nTexto.\n"),
    { message: "metadados spec-meta ausentes ou duplicados" }
  );
});

test("parseSpecMeta rejeita dois blocos spec-meta", () => {
  const duplicado = `${BLOCO_UNICO}\n\n<!-- spec-meta\n{"id":"9","issue":"github:#9","status":"approved"}\n-->\n`;
  assert.throws(() => parseSpecMeta(duplicado), { message: "metadados spec-meta ausentes ou duplicados" });
});

test("parseSpecMeta rejeita bloco cujo conteúdo não é JSON válido", () => {
  const invalido = "<!-- spec-meta\n{id: 3, status: approved}\n-->\n";
  assert.throws(() => parseSpecMeta(invalido), { message: "metadados spec-meta não são JSON válido" });
});

// Canonização puramente textual: cada entrada tem sua saída literal declarada.
for (const [entrada, esperado] of [
  ["3", "3"],
  ["03", "3"],
  ["003", "3"],
  ["0003", "3"],
  ["0000", "0"],
  ["0", "0"],
  ["10", "10"],
  ["0010", "10"],
  ["123456789012345678901234567890", "123456789012345678901234567890"],
  ["000123456789012345678901234567890", "123456789012345678901234567890"]
]) {
  test(`canonicalSpecId("${entrada}") devolve "${esperado}"`, () => {
    assert.equal(canonicalSpecId(entrada), esperado);
  });
}

// A comparação nome↔`id` é textual e estrita: `004` só casa com `004-…`, e a
// canonização não participa. Mensagens literais, iguais às do validador atual.
test("assertSpecIdentity aceita id textualmente igual ao prefixo do arquivo", () => {
  const metadata = { id: "004", issue: "local:tasks/004-x.md", status: "approved" };
  assert.doesNotThrow(() => assertSpecIdentity(metadata, "004-ai-engineering-system.md"));
});

test("assertSpecIdentity aceita id sem zeros com arquivo sem zeros", () => {
  const metadata = { id: "3", issue: "github:#3", status: "approved" };
  assert.doesNotThrow(() => assertSpecIdentity(metadata, "3-governance-hardening.md"));
});

test("assertSpecIdentity rejeita id 4 com arquivo 004-…: zeros à esquerda não são equivalentes", () => {
  assert.throws(
    () => assertSpecIdentity({ id: "4" }, "004-ai-engineering-system.md"),
    { message: "id 4 não corresponde ao nome do arquivo" }
  );
});

test("assertSpecIdentity rejeita arquivo sem prefixo decimal", () => {
  assert.throws(
    () => assertSpecIdentity({ id: "3" }, "governance-hardening.md"),
    { message: "id 3 não corresponde ao nome do arquivo" }
  );
});

test("assertSpecIdentity rejeita metadado sem id", () => {
  assert.throws(
    () => assertSpecIdentity({ issue: "github:#3" }, "3-governance-hardening.md"),
    { message: "id ausente não corresponde ao nome do arquivo" }
  );
});

test("assertSpecIdentity rejeita id numérico mesmo que pareça igual", () => {
  assert.throws(
    () => assertSpecIdentity({ id: 3 }, "3-governance-hardening.md"),
    { message: "id 3 não corresponde ao nome do arquivo" }
  );
});
