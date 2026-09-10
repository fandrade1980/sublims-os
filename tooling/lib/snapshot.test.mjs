import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  } catch (error) {
    // Fora de Windows, symlink sempre funciona. Falhar aqui é problema de ambiente,
    // e converter isso em teste pulado mascararia regressão de guarda de segurança.
    if (process.platform !== "win32") throw error;
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

// Pular só é admissível na plataforma que realmente não suporta o recurso.
function symlinkSkip() {
  return supportsSymlink() ? false : "symlink indisponível nesta plataforma";
}

function fifoSkip() {
  return process.platform === "win32" ? "FIFO não existe em Windows" : false;
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

test("componente que não pode ser inspecionado reprova em vez de aprovar por omissão", () => {
  const root = workspace({ "orchestration/plans/3.json": plan("spec:3") });

  // Não conseguir aplicar `lstat` não é evidência de ausência de symlink, e um componente
  // ausente no meio do caminho deixaria os seguintes sem verificação alguma.
  assert.throws(
    () => assertNoSymlinkInPath(root, "orchestration/plans/9.json"),
    /não foi possível verificar/
  );
  assert.throws(
    () => assertNoSymlinkInPath(root, "ausente/plans/3.json"),
    /não foi possível verificar/
  );
  assert.doesNotThrow(() => assertNoSymlinkInPath(root, "orchestration/plans/3.json"));
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

test("diretório ausente reprova sempre, mesmo com allowEmpty", () => {
  const root = workspace({});
  for (const allowEmpty of [false, true]) {
    assert.throws(
      () =>
        buildBaseSnapshot({ root, directory: "orchestration/plans", pattern: PLAN_PATTERN, allowEmpty }),
      /diretório ausente ou ilegível/,
      `diretório ausente não pode ser aprovado com allowEmpty: ${allowEmpty}`
    );
  }
});

test("diretório existente e vazio é distinto de diretório ausente", () => {
  const root = workspace({ "orchestration/plans/.manter": "" });
  rmSync(join(root, "orchestration/plans/.manter"));

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

test("caminho que não é diretório reprova com mensagem própria", () => {
  const root = workspace({ "orchestration/plans": "isto é um arquivo" });
  assert.throws(
    () => buildBaseSnapshot({ root, directory: "orchestration/plans", pattern: PLAN_PATTERN }),
    /não é diretório/
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
  // Grafias ambíguas do mesmo arquivo reprovam: duas formas para o mesmo caminho
  // permitiriam escapar da comparação textual de prefixo.
  assert.throws(() => attempt("orchestration/plans/./3.json"), /componente `\.`/);
  assert.throws(() => attempt("orchestration//plans/3.json"), /componente vazio/);
  assert.throws(() => attempt("./orchestration/plans/3.json"), /componente `\.`/);
  assert.throws(() => attempt("orchestration/plans/3.json/"), /barra final/);
  // Caminho relativo a unidade descarta a raiz em `resolve`, então é tratado como absoluto.
  assert.throws(() => attempt("C:orchestration/plans/3.json"), /caminho absoluto/);
  // Fronteira de prefixo: `plans-old` realmente começa com `plans`, e precisa da barra
  // separadora para não ser confundido com o diretório alvo. `planos` não serve de
  // contraexemplo porque sequer começa com `plans`.
  assert.ok("orchestration/plans-old/3.json".startsWith("orchestration/plans"));
  assert.equal(attempt("orchestration/plans-old/3.json").size, 1);
  // Caminho seguro em outro diretório é apenas outro arquivo do PR, e não entra no snapshot.
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

test("symlink em qualquer componente é recusado sem ser seguido", { skip: symlinkSkip() }, () => {
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

test("symlink como entrada dentro do diretório da base é recusado", { skip: symlinkSkip() }, () => {
  const root = workspace({
    "fora/alvo.json": plan("spec:9"),
    "orchestration/plans/3.json": plan("spec:3")
  });
  symlinkSync(join(root, "fora/alvo.json"), join(root, "orchestration/plans/9.json"));

  assert.throws(
    () => buildBaseSnapshot({ root, directory: "orchestration/plans", pattern: PLAN_PATTERN }),
    /symlink não é seguido/
  );
});

test("symlink na entrada candidata é recusado", { skip: symlinkSkip() }, () => {
  const base = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = workspace({
    "fora/alvo.json": plan("spec:9"),
    "orchestration/plans/3.json": plan("spec:3")
  });
  symlinkSync(join(candidate, "fora/alvo.json"), join(candidate, "orchestration/plans/9.json"));
  const baseSnapshot = buildBaseSnapshot({
    root: base,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });

  assert.throws(
    () =>
      applyChanges({
        base: baseSnapshot,
        changes: [{ status: "A", path: "orchestration/plans/9.json" }],
        root: candidate,
        directory: "orchestration/plans",
        pattern: PLAN_PATTERN
      }),
    /symlink não é seguido|não regular/
  );
});

test("symlink em componente intermediário do candidato é recusado", { skip: symlinkSkip() }, () => {
  const base = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = workspace({ "real/plans/3.json": plan("spec:3"), "orchestration/.manter": "" });
  symlinkSync(join(candidate, "real/plans"), join(candidate, "orchestration/plans"), "junction");
  const baseSnapshot = buildBaseSnapshot({
    root: base,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });

  assert.throws(
    () =>
      applyChanges({
        base: baseSnapshot,
        changes: [{ status: "M", path: "orchestration/plans/3.json" }],
        root: candidate,
        directory: "orchestration/plans",
        pattern: PLAN_PATTERN
      }),
    /symlink não é seguido/
  );
});

test("entrada não regular no diretório da base reprova em vez de ser ignorada", { skip: fifoSkip() }, () => {
  const root = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  execFileSync("mkfifo", [join(root, "orchestration/plans/9.json")]);

  assert.throws(
    () => buildBaseSnapshot({ root, directory: "orchestration/plans", pattern: PLAN_PATTERN }),
    /entrada não regular/
  );
});

test("leitura revalida symlink surgido depois da montagem do snapshot", { skip: symlinkSkip() }, () => {
  const root = workspace({
    "fora/alvo.json": plan("spec:trocado"),
    "orchestration/plans/3.json": plan("spec:3")
  });
  const snapshot = buildBaseSnapshot({
    root,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  const entry = snapshot.get("orchestration/plans/3.json");
  assert.equal(readEntryJson(entry).task, "spec:3");

  // A entrada foi montada de forma legítima e só depois virou symlink. Sem revalidação
  // na leitura, `readFileSync` seguiria o link e devolveria conteúdo de fora da árvore.
  rmSync(join(root, "orchestration/plans/3.json"));
  symlinkSync(join(root, "fora/alvo.json"), join(root, "orchestration/plans/3.json"));

  assert.throws(() => readEntryText(entry), /symlink não é seguido/);
  assert.throws(() => readEntryJson(entry), /symlink não é seguido/);
});

test("chave de unicidade ausente ou inválida reprova em vez de descartar a entrada", () => {
  const root = workspace({
    "orchestration/plans/3.json": JSON.stringify({ version: 1, steps: [] }),
    "orchestration/plans/4.json": plan("spec:4")
  });
  const snapshot = buildBaseSnapshot({
    root,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });

  assert.throws(
    () => findDuplicates(snapshot, (entry) => readEntryJson(entry).task),
    /chave de unicidade ausente ou inválida/
  );
  for (const invalid of [3, {}, [], true]) {
    assert.throws(() => findDuplicates(snapshot, () => invalid), /chave de unicidade ausente ou inválida/);
  }
});

test("snapshot candidato esvaziado por exclusões reprova sem decisão explícita", () => {
  const base = workspace({ "orchestration/plans/3.json": plan("spec:3") });
  const candidate = workspace({ "orchestration/.manter": "" });
  const baseSnapshot = buildBaseSnapshot({
    root: base,
    directory: "orchestration/plans",
    pattern: PLAN_PATTERN
  });
  const remove = (extra) =>
    applyChanges({
      base: baseSnapshot,
      changes: [{ status: "D", path: "orchestration/plans/3.json" }],
      root: candidate,
      directory: "orchestration/plans",
      pattern: PLAN_PATTERN,
      allowDeletion: true,
      ...extra
    });

  assert.throws(() => remove({}), /conjunto vazio não é aprovação/);
  assert.equal(remove({ allowEmpty: true }).size, 0);
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
