import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve(import.meta.dirname, "validate-execution-plan.mjs");

function run(plan) {
  const dir = mkdtempSync(join(tmpdir(), "sublims-plan-"));
  const file = join(dir, "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  return spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
}

test("aceita análises paralelas seguidas por um único escritor", () => {
  const result = run({
    version: 1,
    steps: [
      { id: "product", agent: "product", mode: "read", dependsOn: [], reads: ["specs/**"], writes: [] },
      { id: "security", agent: "security-data-reviewer", mode: "read", dependsOn: [], reads: ["**"], writes: [] },
      { id: "consolidate", agent: "orchestrator", mode: "read", dependsOn: ["product", "security"], reads: ["**"], writes: [] },
      { id: "implement", agent: "developer", mode: "write", dependsOn: ["consolidate"], reads: ["**"], writes: ["tooling/**"] }
    ]
  });
  assert.equal(result.status, 0, result.stderr);
});

test("rejeita dois escritores que podem executar em paralelo", () => {
  const result = run({
    version: 1,
    steps: [
      { id: "write-a", agent: "developer", mode: "write", dependsOn: [], reads: [], writes: ["src/a.ts"] },
      { id: "write-b", agent: "platform-devops", mode: "write", dependsOn: [], reads: [], writes: ["infra/a.yml"] }
    ]
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /escritores.*paralelo/i);
});

test("rejeita ciclo no DAG de execução", () => {
  const result = run({
    version: 1,
    steps: [
      { id: "a", agent: "product", mode: "read", dependsOn: ["b"], reads: [], writes: [] },
      { id: "b", agent: "architect", mode: "read", dependsOn: ["a"], reads: [], writes: [] }
    ]
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ciclo/i);
});
