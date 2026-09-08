import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve(import.meta.dirname, "run-trusted-application-gates.mjs");

function run(policy) {
  const root = mkdtempSync(join(tmpdir(), "sublims-trusted-gates-"));
  const candidate = join(root, "candidate");
  mkdirSync(candidate);
  const policyFile = join(root, "policy.json");
  writeFileSync(policyFile, JSON.stringify(policy));
  return spawnSync(process.execPath, [cli, "--policy", policyFile, "--candidate", candidate], { encoding: "utf8" });
}

test("estado desativado é explícito e não executa comandos do candidato", () => {
  const result = run({ version: 1, enabled: false, reason: "Fundação ainda não concluída.", commands: [] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /desativados/i);
});

test("executa somente os comandos declarados na política confiável", () => {
  const result = run({
    version: 1,
    enabled: true,
    commands: [{ name: "pass", executable: process.execPath, args: ["-e", "process.exit(0)"] }]
  });
  assert.equal(result.status, 0, result.stderr);
});

test("falha quando um comando confiável reprova", () => {
  const result = run({
    version: 1,
    enabled: true,
    commands: [{ name: "fail", executable: process.execPath, args: ["-e", "process.exit(3)"] }]
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fail.*falhou/i);
});
