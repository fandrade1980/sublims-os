import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PLAN_PATTERN,
  SPEC_PATTERN,
  applyChanges,
  assertNoSymlinkInPath,
  assertSafeRelativePath,
  buildBaseSnapshot,
  findDuplicates,
  readEntryJson,
  readEntryText
} from "./snapshot.mjs";

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "sublims-snapshot-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function plan(task) {
  return JSON.stringify({ version: 1, task, steps: [] });
}

function supportsSymlink() {
  const probe = mkdtempSync(join(tmpdir(), "sublims-symlink-"));
  try {
    writeFileSync(join(probe, "alvo.json"), "{}");
    symlinkSync(join(probe, "alvo.json"), join(probe, "link.json"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

test("os padrões aceitos são estritos para planos e specs", () => {
  assert.ok(PLAN_PATTERN.test("orchestration/plans/3.json"));
  assert.ok(!PLAN_PATTERN.test("orchestration/plans/3.JSON"));
  assert.ok(!PLAN_PATTERN.test("orchestration/plans/3a.json"));
  assert.ok(!PLAN_PATTERN.test("orchestration/plans/sub/3.json"));
  assert.ok(SPEC_PATTERN.test("specs/3-governance-hardening.md"));
  assert.ok(SPEC_PATTERN.test("specs/004-ai-engineering-system.md"));
  assert.ok(!SPEC_PATTERN.test("specs/3-Governance.md"));
});

test("caminho relativo inseguro é recusado", () => {
  assert.throws(() => assertSafeRelativePath(""), /caminho vazio/);
  assert.throws(() => assertSafeRelativePath("/etc/passwd"), /caminho absoluto/);
  assert.throws(() => assertSafeRelativePath("C:/Windows"), /caminho absoluto/);
  assert.throws(() => assertSafeRelativePath("a/../../fora"), /componente `\.\.`/);
  assert.throws(() => assertSafeRelativePath("a\\b"), /barra invertida/);
  assert.doesNotThrow(() => assertSafeRelativePath("orchestration/plans/3.json"));
});

test("o snapshot da base enumera apenas nomes que casam o padrão", () => {
  const root = workspace({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/004.json": plan("task:004")
  });
  const snapshot = buildBaseSnapshot({ root, directory: "orchestration/plans", pattern: PLAN_PATTERN });
  assert.deepEqual([...snapshot.keys()].sort(), [
    "orchestration/plans/004.json",
    "orchestration/plans/3.json"
  ]);
});

test("subdiretório no diretório de planos reprova em vez de ser ignorado", () => {
  const root = workspace({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/sub/9.json": plan("spec:9")
  });
  assert.throws(
    () => buildBaseSnapshot({ root, directory: "orchestration/plans", pattern: PLAN_PATTERN }),
    /subdiretório não permitido/
  );
});

test("nome fora do padrão no diretório de planos reprova em vez de ser ignorado", () => {
  const root = workspace({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/3.json.bak": plan("spec:3")
  });
  assert.throws(
    () =>
      buildBaseSnapshot({
        root,
        directory: "orchestration/plans",
        pattern: PLAN_PATTERN
      }),
    /nome fora do padrão/
  );
});

test("snapshot da base sem nenhuma entrada aplicável retorna erro", () => {
  const root = workspace({});
  assert.throws(
    () => buildBaseSnapshot({ root, directory: "orchestration/plans", pattern: PLAN_PATTERN }),
    /nenhuma entrada aplicável/
  );
  assert.doesNotThrow(() =>
    buildBaseSnapshot({
      root,
      directory: "orchestration/plans",
      pattern: PLAN_PATTERN,
      allowEmpty: true
    })
  );
});

test("o candidato efetivo substitui em M, acrescenta em A e remove em D", () => {
  const base = workspace({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/004.json": plan("task:004")
  });
  const candidate = workspace({
    "orchestration/plans/3.json": plan("spec:3-revisado"),
    "orchestration/plans/5.json": plan("spec:5")
  });
  const baseSnapshot = buildBaseSnapshot({
    root: base,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  const effective = applyChanges({
    base: baseSnapshot,
    changes: [
      { status: "M", path: "orchestration/plans/3.json" },
      { status: "A", path: "orchestration/plans/5.json" },
      { status: "D", path: "orchestration/plans/004.json" }
    ],
    root: candidate,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN,
    allowDeletion: true
  });

  assert.deepEqual([...effective.keys()].sort(), [
    "orchestration/plans/3.json",
    "orchestration/plans/5.json"
  ]);
  assert.equal(readEntryJson(effective.get("orchestration/plans/3.json")).task, "spec:3-revisado");
  assert.equal(readEntryJson(baseSnapshot.get("orchestration/plans/3.json")).task, "spec:3");
  assert.match(readEntryText(effective.get("orchestration/plans/5.json")), /spec:5/);
});

test("alteração legítima não vira duplicação, porque cada snapshot é íntegro", () => {
  const base = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const baseSnapshot = buildBaseSnapshot({
    root: base,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  const effective = applyChanges({
    base: baseSnapshot,
    changes: [{ status: "M", path: "orchestration/plans/3.json" }],
    root: candidate,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });

  assert.equal(effective.size, 1, "a alteração substitui a entrada, não acrescenta outra");
  for (const snapshot of [baseSnapshot, effective]) {
    assert.deepEqual(findDuplicates(snapshot, (entry) => readEntryJson(entry).task), []);
  }
});

test("duplicação real dentro de um mesmo snapshot é detectada", () => {
  const root = workspace({
    "orchestration/plans/3.json": plan("spec:3"),
    "orchestration/plans/4.json": plan("spec:3")
  });
  const snapshot = buildBaseSnapshot({
    root,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  assert.deepEqual(findDuplicates(snapshot, (entry) => readEntryJson(entry).task), [
    { key: "spec:3", paths: ["orchestration/plans/3.json", "orchestration/plans/4.json"] }
  ]);
});

test("exclusão de entrada presente na base é recusada por padrão", () => {
  const base = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = workspace({});
  const baseSnapshot = buildBaseSnapshot({
    root: base,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  assert.throws(
    () =>
      applyChanges({
        base: baseSnapshot,
        changes: [{ status: "D", path: "orchestration/plans/3.json" }],
        root: candidate,
        directory: "orchestration/plans",
        pattern: PLAN_PATTERN
      }),
    /exclusão de entrada presente na base/
  );
});

test("renomeação chega como exclusão mais adição e recai na recusa de exclusão", () => {
  const base = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = workspace({ "orchestration/plans/4.json": plan("spec:3") });
  const baseSnapshot = buildBaseSnapshot({
    root: base,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  assert.throws(
    () =>
      applyChanges({
        base: baseSnapshot,
        changes: [
          { status: "D", path: "orchestration/plans/3.json" },
          { status: "A", path: "orchestration/plans/4.json" }
        ],
        root: candidate,
        directory: "orchestration/plans",
        pattern: PLAN_PATTERN
      }),
    /exclusão de entrada presente na base/
  );
});

test("caminho candidato fora do diretório ou fora do padrão é recusado", () => {
  const base = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const baseSnapshot = buildBaseSnapshot({
    root: base,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  const attempt = (path) =>
    applyChanges({
      base: baseSnapshot,
      changes: [{ status: "A", path }],
      root: candidate,
      directory: "orchestration/plans",
      pattern: PLAN_PATTERN
    });

  assert.throws(() => attempt("orchestration/plans/3.json.bak"), /nome fora do padrão/);
  assert.throws(() => attempt("orchestration/plans/sub/3.json"), /nome fora do padrão/);
  // Travessia reprova mesmo estando fora do diretório: segurança é verificada antes do filtro.
  assert.throws(() => attempt("../fora/3.json"), /componente `\.\.`/);
  assert.throws(() => attempt("orchestration/plans/../../fora.json"), /componente `\.\.`/);
  // Caminho seguro em outro diretório é apenas outro arquivo do PR, e não entra no snapshot.
  // O prefixo exige barra para que `planos` não seja confundido com `plans`.
  assert.equal(attempt("orchestration/planos/3.json").size, 1);
  assert.equal(attempt("AGENTS.md").size, 1);
});

test("entrada adicionada ou modificada precisa existir como arquivo regular no candidato", () => {
  const base = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = workspace({});
  const baseSnapshot = buildBaseSnapshot({
    root: base,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });

  for (const status of ["A", "M"]) {
    assert.throws(
      () =>
        applyChanges({
          base: baseSnapshot,
          changes: [{ status, path: "orchestration/plans/4.json" }],
          root: candidate,
          directory: "orchestration/plans",
          pattern: PLAN_PATTERN
        }),
      /arquivo candidato ausente ou não regular/
    );
  }
});

test("symlink em qualquer componente é recusado sem ser seguido", { skip: !supportsSymlink() }, () => {
  const root = workspace({
    "real/plans/3.json": plan("spec:3"),
    "orchestration/marcador.txt": "presente"
  });
  symlinkSync(join(root, "real/plans"), join(root, "orchestration/plans"), "junction");

  assert.throws(
    () => buildBaseSnapshot({ root, directory: "orchestration/plans", pattern: PLAN_PATTERN }),
    /symlink/
  );
  assert.throws(() => assertNoSymlinkInPath(root, "orchestration/plans/3.json"), /symlink/);
  assert.doesNotThrow(() => assertNoSymlinkInPath(root, "orchestration/marcador.txt"));
});

test("o conteúdo do candidato é lido como dado, nunca importado", () => {
  const root = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const snapshot = buildBaseSnapshot({
    root,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  const entry = snapshot.get("orchestration/plans/3.json");
  assert.equal(readEntryJson(entry).task, "spec:3");

  const invalid = workspace({ "orchestration/plans/9.json": "{ isto não é json" });
  const invalidSnapshot = buildBaseSnapshot({
    root: invalid,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  assert.throws(
    () => readEntryJson(invalidSnapshot.get("orchestration/plans/9.json")),
    /JSON inválido/
  );
});

test("specs recebem o mesmo tratamento de snapshot", () => {
  const root = workspace({
    "specs/3-governance-hardening.md": "# spec 3\n",
    "specs/004-ai-engineering-system.md": "# spec 004\n"
  });
  const snapshot = buildBaseSnapshot({ root, directory: "specs", pattern: SPEC_PATTERN });
  assert.deepEqual([...snapshot.keys()].sort(), [
    "specs/004-ai-engineering-system.md",
    "specs/3-governance-hardening.md"
  ]);
});
