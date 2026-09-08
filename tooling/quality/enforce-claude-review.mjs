#!/usr/bin/env node
import { readFileSync } from "node:fs";

const allowedSeverities = new Set(["critical", "high", "medium", "low"]);

function readInput(file) {
  const raw = file ? readFileSync(file, "utf8") : process.env.CLAUDE_REVIEW_JSON;
  if (!raw) throw new Error("saída vazia");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("JSON malformado");
  }
}

function validate(review) {
  const topKeys = Object.keys(review ?? {}).sort();
  if (topKeys.join(",") !== "critical_count,findings,summary") throw new Error("estrutura de revisão inválida");
  if (typeof review?.summary !== "string" || !review.summary.trim()) throw new Error("summary ausente");
  if (!Number.isInteger(review.critical_count) || review.critical_count < 0) throw new Error("critical_count inválido");
  if (!Array.isArray(review.findings)) throw new Error("findings inválido");
  for (const finding of review.findings) {
    const allowedKeys = new Set(["severity", "title", "file", "line", "evidence", "recommendation"]);
    if (Object.keys(finding ?? {}).some((key) => !allowedKeys.has(key))) throw new Error("finding inválido: propriedade extra");
    const requiredStrings = [finding?.title, finding?.evidence, finding?.recommendation];
    if (!allowedSeverities.has(finding?.severity) || requiredStrings.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("finding inválido ou incompleto");
    }
    if (finding.file !== undefined && (typeof finding.file !== "string" || !finding.file.trim())) throw new Error("finding inválido: file");
    if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) throw new Error("finding inválido: line");
  }
  const actualCritical = review.findings.filter((finding) => finding.severity === "critical").length;
  if (actualCritical !== review.critical_count) {
    throw new Error(`critical_count diverge dos findings: declarado ${review.critical_count}, calculado ${actualCritical}`);
  }
  if (actualCritical > 0) throw new Error(`${actualCritical} achado crítico bloqueia o merge`);
}

try {
  const review = readInput(process.argv[2]);
  validate(review);
  process.stdout.write(`Revisão Claude aprovada: ${review.findings.length} achados, nenhum crítico.\n`);
} catch (error) {
  process.stderr.write(`Revisão Claude inválida ou bloqueadora: ${error.message}\n`);
  process.exitCode = 1;
}
