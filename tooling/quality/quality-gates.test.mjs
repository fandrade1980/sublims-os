import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const reviewCli = resolve(import.meta.dirname, "enforce-claude-review.mjs");
const coverageCli = resolve(import.meta.dirname, "validate-coverage.mjs");

function jsonFile(prefix, value) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, "input.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

test("aprova revisão Claude estruturada sem achados críticos", () => {
  const file = jsonFile("sublims-review-", {
    summary: "Sem bloqueadores.",
    critical_count: 0,
    findings: [{ severity: "medium", title: "Exemplo", evidence: "Linha validada", recommendation: "Revisar" }]
  });
  const result = spawnSync(process.execPath, [reviewCli, file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("bloqueia revisão com achado crítico", () => {
  const file = jsonFile("sublims-review-", {
    summary: "Há bloqueador.",
    critical_count: 1,
    findings: [{ severity: "critical", title: "Falha", evidence: "Cenário", recommendation: "Corrigir" }]
  });
  const result = spawnSync(process.execPath, [reviewCli, file], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /crítico/i);
});

test("bloqueia contagem crítica divergente", () => {
  const file = jsonFile("sublims-review-", {
    summary: "Saída inconsistente.",
    critical_count: 0,
    findings: [{ severity: "critical", title: "Falha", evidence: "Cenário", recommendation: "Corrigir" }]
  });
  const result = spawnSync(process.execPath, [reviewCli, file], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /diverge/i);
});

test("bloqueia saída inválida ou incompleta", () => {
  const file = jsonFile("sublims-review-", { critical_count: 0, findings: [] });
  const result = spawnSync(process.execPath, [reviewCli, file], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inválida/i);
});

test("bloqueia tipos errados e propriedades extras na revisão", () => {
  const file = jsonFile("sublims-review-", {
    summary: "Saída suspeita.",
    critical_count: 0,
    findings: [{ severity: "low", title: 123, evidence: "x", recommendation: "y", unexpected: true }]
  });
  const result = spawnSync(process.execPath, [reviewCli, file], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inválida/i);
});

test("aprova cobertura que atende a política", () => {
  const coverage = jsonFile("sublims-coverage-", {
    total: {
      lines: { pct: 85 }, branches: { pct: 80 }, functions: { pct: 84 }, statements: { pct: 86 }
    }
  });
  const policy = jsonFile("sublims-policy-", {
    coverage: { lines: 80, branches: 75, functions: 80, statements: 80 }
  });
  const result = spawnSync(process.execPath, [coverageCli, coverage, policy], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("bloqueia cobertura abaixo da política", () => {
  const coverage = jsonFile("sublims-coverage-", {
    total: {
      lines: { pct: 79 }, branches: { pct: 80 }, functions: { pct: 84 }, statements: { pct: 86 }
    }
  });
  const policy = jsonFile("sublims-policy-", {
    coverage: { lines: 80, branches: 75, functions: 80, statements: 80 }
  });
  const result = spawnSync(process.execPath, [coverageCli, coverage, policy], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lines.*79.*80/i);
});
