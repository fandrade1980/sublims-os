#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const allowedSeverities = new Set(["critical", "high", "medium", "low"]);
const MAX_EXECUTION_BYTES = 16 * 1024 * 1024;

class InconclusiveReview extends Error {}
class CriticalFinding extends Error {}

function readExecutionInput() {
  if (process.env.CLAUDE_ACTION_CONCLUSION !== "success") {
    throw new InconclusiveReview("execução técnica não concluiu com sucesso");
  }
  const root = process.env.RUNNER_TEMP;
  const file = process.env.CLAUDE_EXECUTION_FILE;
  if (!root || !file || !isAbsolute(root) || !isAbsolute(file)) {
    throw new InconclusiveReview("arquivo de execução ausente ou inválido");
  }
  const trustedRoot = resolve(root);
  const target = resolve(file);
  const within = relative(trustedRoot, target);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new InconclusiveReview("arquivo de execução fora da área temporária");
  }

  let descriptor;
  let raw;
  try {
    const { root: volume, dir } = parse(target);
    let component = volume;
    for (const part of relative(volume, dir).split(sep).filter(Boolean)) {
      component = join(component, part);
      const info = lstatSync(component);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe directory");
    }
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > MAX_EXECUTION_BYTES) {
      throw new Error("unsafe file");
    }
    descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_EXECUTION_BYTES) throw new Error("unsafe file");
    const buffer = Buffer.allocUnsafe(MAX_EXECUTION_BYTES + 1);
    let bytes = 0;
    let received;
    while (bytes <= MAX_EXECUTION_BYTES && (received = readSync(descriptor, buffer, bytes, buffer.length - bytes, null)) > 0) {
      bytes += received;
    }
    if (bytes < 1 || bytes > MAX_EXECUTION_BYTES) throw new Error("unsafe file");
    raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } catch {
    throw new InconclusiveReview("arquivo de execução ausente, ilegível ou inseguro");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        throw new InconclusiveReview("arquivo de execução não pôde ser fechado");
      }
    }
  }

  let events;
  try {
    events = JSON.parse(raw);
  } catch {
    throw new InconclusiveReview("arquivo de execução não contém JSON válido");
  }
  if (!Array.isArray(events) || events.length === 0) {
    throw new InconclusiveReview("evento final ausente");
  }
  const results = events.filter((event) => event?.type === "result");
  const final = events.at(-1);
  if (results.length !== 1 || results[0] !== final || final.subtype !== "success" || final.is_error !== false || typeof final.result !== "string" || !final.result.trim()) {
    throw new InconclusiveReview("evento final ausente, repetido ou incompatível");
  }
  let review;
  try {
    review = JSON.parse(final.result);
  } catch {
    throw new InconclusiveReview("resultado final não contém JSON completo");
  }
  if (review === null || typeof review !== "object" || Array.isArray(review)) {
    throw new InconclusiveReview("resultado final não é objeto JSON");
  }
  return review;
}

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
  if (actualCritical > 0) throw new CriticalFinding(`${actualCritical} achado crítico bloqueia o merge`);
}

try {
  const executionMode = process.env.CLAUDE_EXECUTION_FILE !== undefined || process.env.CLAUDE_ACTION_CONCLUSION !== undefined;
  const review = executionMode ? readExecutionInput() : readInput(process.argv[2]);
  try {
    validate(review);
  } catch (error) {
    if (executionMode && !(error instanceof CriticalFinding)) throw new InconclusiveReview("veredito fora do contrato");
    throw error;
  }
  process.stdout.write(`Revisão Claude aprovada: ${review.findings.length} achados, nenhum crítico.\n`);
} catch (error) {
  const category = error instanceof InconclusiveReview ? "inconclusiva" : "inválida ou bloqueadora";
  process.stderr.write(`Revisão Claude ${category}: ${error.message}\n`);
  process.exitCode = 1;
}
