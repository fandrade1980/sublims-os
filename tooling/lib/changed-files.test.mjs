import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTED_STATUSES,
  assertChangedFilesNotEmpty,
  changedFilesArguments,
  parseChangedFiles,
  readChangedFiles
} from "./changed-files.mjs";

const BASE = "e730e18c2775391e6a2090b4d820be340388b3a3";
const HEAD = "7a4feb73af8a5e899f19f58a72d958cd8e708201";

function fields(...parts) {
  return Buffer.from(parts.map((part) => `${part}\0`).join(""), "utf8");
}

test("os status aceitos são exatamente A, M e D", () => {
  assert.deepEqual([...ACCEPTED_STATUSES], ["A", "M", "D"]);
});

test("os argumentos reproduzem a invocação confiável de git diff", () => {
  assert.deepEqual(changedFilesArguments(BASE, HEAD), [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    BASE,
    HEAD
  ]);
});

test("os SHAs precisam vir do contexto confiável, em formato hexadecimal", () => {
  for (const invalid of ["", "HEAD", "origin/main", "../etc", "zz30e18", `${BASE};rm`]) {
    assert.throws(
      () => changedFilesArguments(invalid, HEAD),
      /SHA inválido/,
      `deveria recusar o SHA de base ${JSON.stringify(invalid)}`
    );
    assert.throws(
      () => changedFilesArguments(BASE, invalid),
      /SHA inválido/,
      `deveria recusar o SHA de head ${JSON.stringify(invalid)}`
    );
  }
});

test("o parsing exige Buffer, nunca texto já convertido", () => {
  assert.throws(() => parseChangedFiles("A\0AGENTS.md\0"), /esperado Buffer/);
  assert.throws(() => parseChangedFiles(null), /esperado Buffer/);
});

test("alterna status e caminho, preservando o status", () => {
  const entries = parseChangedFiles(
    fields("A", ".nvmrc", "M", "package.json", "D", "orchestration/plans/9.json")
  );
  assert.deepEqual(entries, [
    { status: "A", path: ".nvmrc" },
    { status: "M", path: "package.json" },
    { status: "D", path: "orchestration/plans/9.json" }
  ]);
});

test("aceita caminho com espaços", () => {
  const entries = parseChangedFiles(fields("M", "docs/relatório final do evento.md"));
  assert.deepEqual(entries, [{ status: "M", path: "docs/relatório final do evento.md" }]);
});

test("preserva caminho multibyte separando por 0x00 no Buffer", () => {
  const path = "docs/ação-preço-ção.md";
  const entries = parseChangedFiles(fields("A", path));
  assert.deepEqual(entries, [{ status: "A", path }]);
});

test("rejeita mudança de tipo e qualquer status desconhecido", () => {
  for (const status of ["T", "R", "C", "U", "X", "B", "AM", "a", "", "R100"]) {
    assert.throws(
      () => parseChangedFiles(fields(status, "AGENTS.md")),
      /status não aceito/,
      `deveria recusar o status ${JSON.stringify(status)}`
    );
  }
});

test("rejeita número ímpar de campos", () => {
  assert.throws(() => parseChangedFiles(fields("A")), /número ímpar de campos/);
  assert.throws(
    () => parseChangedFiles(fields("A", "AGENTS.md", "M")),
    /número ímpar de campos/
  );
});

test("rejeita saída não vazia sem terminador NUL", () => {
  assert.throws(
    () => parseChangedFiles(Buffer.from("A\0AGENTS.md", "utf8")),
    /terminada por NUL/
  );
});

test("rejeita caminho vazio, absoluto, com .. ou com barra invertida", () => {
  assert.throws(() => parseChangedFiles(fields("A", "")), /caminho vazio/);
  assert.throws(() => parseChangedFiles(fields("A", "/etc/passwd")), /caminho absoluto/);
  assert.throws(() => parseChangedFiles(fields("A", "C:/Windows/system32")), /caminho absoluto/);
  assert.throws(() => parseChangedFiles(fields("A", "../fora.json")), /componente `\.\.`/);
  assert.throws(
    () => parseChangedFiles(fields("A", "orchestration/../../fora.json")),
    /componente `\.\.`/
  );
  assert.throws(() => parseChangedFiles(fields("A", "docs\\nota.md")), /barra invertida/);
});

test("rejeita caminho relativo a unidade e grafias ambíguas do mesmo caminho", () => {
  // `C:x` não é absoluto pela grafia, mas `resolve` descarta a raiz do mesmo jeito.
  assert.throws(() => parseChangedFiles(fields("A", "C:orchestration/plans/3.json")), /caminho absoluto/);
  assert.throws(() => parseChangedFiles(fields("A", "c:plans/3.json")), /caminho absoluto/);
  assert.throws(() => parseChangedFiles(fields("A", "./AGENTS.md")), /componente `\.`/);
  assert.throws(() => parseChangedFiles(fields("A", "docs/./nota.md")), /componente `\.`/);
  assert.throws(() => parseChangedFiles(fields("A", "docs//nota.md")), /componente vazio/);
  assert.throws(() => parseChangedFiles(fields("A", "orchestration/plans/")), /barra final/);
});

test("representa renomeação como exclusão mais adição, nunca como R", () => {
  const entries = parseChangedFiles(
    fields("D", "orchestration/plans/3.json", "A", "orchestration/plans/4.json")
  );
  assert.deepEqual(entries, [
    { status: "D", path: "orchestration/plans/3.json" },
    { status: "A", path: "orchestration/plans/4.json" }
  ]);
  // Um registro de renomeação do git tem três campos, então a guarda de paridade
  // dispara primeiro. Com duas renomeações a contagem fica par e a rejeição
  // acontece pelo status, provando que ambas as guardas cobrem o caso.
  assert.throws(
    () => parseChangedFiles(fields("R100", "de.json", "para.json")),
    /número ímpar de campos/
  );
  assert.throws(
    () => parseChangedFiles(fields("R100", "de.json", "para.json", "R090", "outro.json", "novo.json")),
    /status não aceito/
  );
});

test("saída vazia produz lista vazia, que não é prova de aprovação", () => {
  assert.deepEqual(parseChangedFiles(Buffer.alloc(0)), []);
  assert.throws(
    () => assertChangedFilesNotEmpty([], "lista de alterações"),
    /lista de alterações está vazia/
  );
  assert.doesNotThrow(() =>
    assertChangedFilesNotEmpty([{ status: "A", path: "AGENTS.md" }], "lista de alterações")
  );
});

test("a leitura invoca git no repositório informado e devolve as entradas", () => {
  const calls = [];
  const entries = readChangedFiles({
    repository: "/repo/trusted",
    baseSha: BASE,
    headSha: HEAD,
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: fields("M", "AGENTS.md"), stderr: Buffer.alloc(0) };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "git");
  assert.deepEqual(calls[0].args, ["-C", "/repo/trusted", ...changedFilesArguments(BASE, HEAD)]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.encoding, "buffer");
  assert.deepEqual(entries, [{ status: "M", path: "AGENTS.md" }]);
});

test("a leitura falha explicitamente quando git não conclui", () => {
  assert.throws(
    () =>
      readChangedFiles({
        repository: "/repo/trusted",
        baseSha: BASE,
        headSha: HEAD,
        run: () => ({ status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: bad object") })
      }),
    /git diff falhou/
  );
});
