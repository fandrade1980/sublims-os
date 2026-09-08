import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "../..");
const validateCli = join(projectRoot, "tooling/context/validate-context-graph.mjs");
const selectCli = join(projectRoot, "tooling/context/select-context.mjs");

function fixture(graph, files = []) {
  const root = mkdtempSync(join(tmpdir(), "sublims-context-"));
  mkdirSync(join(root, "context"), { recursive: true });
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, `# ${file}\n`);
  }
  const graphPath = join(root, "context/graph.json");
  writeFileSync(graphPath, JSON.stringify(graph));
  return { root, graphPath };
}

test("aceita um grafo válido e seleciona as dependências da tarefa", () => {
  const graph = {
    version: 1,
    nodes: [
      { id: "task:004", type: "task", path: "tasks/004.md" },
      { id: "spec:004", type: "spec", path: "specs/004.md" },
      { id: "context:domain", type: "context", path: "CONTEXT.md" }
    ],
    edges: [
      { from: "task:004", to: "spec:004", relation: "requires" },
      { from: "spec:004", to: "context:domain", relation: "requires" }
    ]
  };
  const fx = fixture(graph, ["tasks/004.md", "specs/004.md", "CONTEXT.md"]);

  const validation = spawnSync(process.execPath, [validateCli, fx.graphPath], {
    cwd: fx.root,
    encoding: "utf8"
  });
  assert.equal(validation.status, 0, validation.stderr);

  const selection = spawnSync(
    process.execPath,
    [selectCli, "task:004", "--graph", fx.graphPath, "--format", "json"],
    { cwd: fx.root, encoding: "utf8" }
  );
  assert.equal(selection.status, 0, selection.stderr);
  assert.deepEqual(JSON.parse(selection.stdout).files, [
    "CONTEXT.md",
    "specs/004.md",
    "tasks/004.md"
  ]);
});

test("rejeita referência de arquivo ausente", () => {
  const fx = fixture({
    version: 1,
    nodes: [{ id: "task:404", type: "task", path: "tasks/missing.md" }],
    edges: []
  });
  const result = spawnSync(process.execPath, [validateCli, fx.graphPath], {
    cwd: fx.root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /arquivo inexistente/i);
});

test("rejeita ciclo entre dependências requires", () => {
  const fx = fixture({
    version: 1,
    nodes: [
      { id: "a", type: "context", path: "a.md" },
      { id: "b", type: "context", path: "b.md" }
    ],
    edges: [
      { from: "a", to: "b", relation: "requires" },
      { from: "b", to: "a", relation: "requires" }
    ]
  }, ["a.md", "b.md"]);
  const result = spawnSync(process.execPath, [validateCli, fx.graphPath], {
    cwd: fx.root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ciclo/i);
});

test("rejeita caminhos que escapam da raiz do projeto", () => {
  const fx = fixture({
    version: 1,
    nodes: [{ id: "escape", type: "context", path: "../outside.md" }],
    edges: []
  });
  const result = spawnSync(process.execPath, [validateCli, fx.graphPath], {
    cwd: fx.root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fora da raiz/i);
});

test("rejeita caminhos duplicados mesmo com diferença de maiúsculas", () => {
  const fx = fixture({
    version: 1,
    nodes: [
      { id: "a", type: "context", path: "A.md" },
      { id: "b", type: "context", path: "a.md" }
    ],
    edges: []
  }, ["A.md", "a.md"]);
  const result = spawnSync(process.execPath, [validateCli, fx.graphPath], {
    cwd: fx.root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /caminho duplicado/i);
});

test("rejeita barra invertida para manter caminhos portáveis", () => {
  const fx = fixture({
    version: 1,
    nodes: [{ id: "a", type: "context", path: "docs\\a.md" }],
    edges: []
  });
  const result = spawnSync(process.execPath, [validateCli, fx.graphPath], {
    cwd: fx.root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /portável/i);
});

test("rejeita relação desconhecida em vez de ignorá-la", () => {
  const fx = fixture({
    version: 1,
    nodes: [
      { id: "a", type: "context", path: "a.md" },
      { id: "b", type: "context", path: "b.md" }
    ],
    edges: [{ from: "a", to: "b", relation: "require" }]
  }, ["a.md", "b.md"]);
  const result = spawnSync(process.execPath, [validateCli, fx.graphPath], {
    cwd: fx.root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /relação desconhecida/i);
});
