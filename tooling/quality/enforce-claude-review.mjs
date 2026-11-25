#!/usr/bin/env node
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const allowedSeverities = new Set(["critical", "high", "medium", "low"]);
const MAX_EXECUTION_BYTES = 16 * 1024 * 1024;

// Padrões de formato conhecido. Heurística: não substitui varredura dedicada de segredos.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{32,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b[sr]k_live_[A-Za-z0-9]{16,}/,
  // Token de tunnel Cloudflare: JSON {"a":...} em base64.
  /\beyJhIjoi[A-Za-z0-9+/=_-]{40,}/,
  // URL com usuário e senha literais (referência ${VAR}, <x> ou vazia não conta).
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:@/]+:[^\s@/$<{][^\s@/]*@/i,
  // Atribuição literal inequívoca: nome sensível = "valor" com 10+ caracteres sem espaço e sem aparência de marcador.
  /(?:api[_-]?key|apikey|passw(?:or)?d|secret|token|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["'](?![^"']*(?:change|your|example|placeholder|redacted|dummy|sample|xxxx|\*\*\*|todo))[A-Za-z0-9+/_.=~!@#%^&-]{10,}["']/i
];

export function containsSecret(text) {
  return typeof text === "string" && SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function redactSecrets(text) {
  let result = String(text);
  for (const pattern of SECRET_PATTERNS) result = result.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), "[segredo removido]");
  return result;
}

// Classes fechadas de falha técnica. Nenhuma delas é achado crítico; todas bloqueiam (fail-closed).
// Texto livre de erro nunca chega ao check: só a classe e a mensagem fixa correspondente.
export const FAILURE_MESSAGES = Object.freeze({
  diff_unavailable: "não foi possível materializar o diff completo e vinculado ao head",
  preflight_blocked: "caminho ou padrão sensível bloqueou o envio ao modelo",
  gates_not_passed: "governance e quality-gate do mesmo SHA não foram aprovados antes da IA",
  base_not_authorized: "base do PR não autorizada",
  head_changed: "SHA do PR mudou durante a revisão",
  identity_missing: "identidade do material revisado não registrada",
  identity_changed: "identidade do head mudou desde a revisão",
  model_unavailable: "serviço do modelo indisponível, sem credencial ou sem resposta",
  model_output_invalid: "parecer estruturado ausente, incompleto, cortado ou inválido",
  verdict_missing: "parecer ausente",
  verdict_mismatch: "estado do parecer diverge da validação",
  payload_invalid: "parecer codificado inválido",
  unknown: "falha técnica não classificada"
});

export const FAILURE_CLASSES = Object.freeze(Object.keys(FAILURE_MESSAGES));

export function sanitizeFailureClass(value) {
  return typeof value === "string" && Object.hasOwn(FAILURE_MESSAGES, value) ? value : "unknown";
}

const FAILURE_RULES = [
  [/^(caminho (inválido|proibido)|padrão de segredo|diff contém o delimitador)/, "preflight_blocked"],
  [/^gate/, "gates_not_passed"],
  [/^SHA do PR/, "head_changed"],
  [/^(base|branch)/, "base_not_authorized"],
  [/^(Anthropic HTTP|ANTHROPIC_API_KEY)/, "model_unavailable"],
  [/^(structured_output|revisão inconclusiva: stop_reason|diff vazio|regras de revisão)/, "model_output_invalid"],
  [/^(GitHub HTTP|changed_files|patch|blob|árvore|tipo ou modo|diff excede|status|arquivo|caminho duplicado|repositório)/, "diff_unavailable"]
];

export function classifyFailure(error) {
  const message = String(error?.message ?? error ?? "");
  const rule = FAILURE_RULES.find(([pattern]) => pattern.test(message));
  return rule ? rule[1] : "unknown";
}

// Escreve somente a classe do enum no GITHUB_OUTPUT; nunca a mensagem do erro.
export function writeFailureClass(error, outputFile = process.env.GITHUB_OUTPUT) {
  const failureClass = classifyFailure(error);
  if (outputFile) appendFileSync(outputFile, `failure_class=${failureClass}\n`);
  return failureClass;
}

// Texto vindo do modelo é dado não confiável: remove segredos e controles, neutraliza marcação e limita o tamanho.
export function sanitizeText(value, max) {
  let text = redactSecrets(String(value ?? ""))
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/`/g, "'");
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 14))} …[truncado]`;
  return text;
}

const FIELD_LIMIT = 1_500;
const SUMMARY_LIMIT = 30_000;
const TEXT_LIMIT = 60_000;

function renderFinding(finding) {
  const where = `${sanitizeText(finding.file ?? "arquivo não indicado", 300)}${finding.line ? `:${finding.line}` : ""}`;
  return `[${finding.severity}] ${where}: ${sanitizeText(finding.title, 300)}\nEvidência: ${sanitizeText(finding.evidence, FIELD_LIMIT)}\nRecomendação: ${sanitizeText(finding.recommendation, FIELD_LIMIT)}`;
}

function joinLimited(items, limit) {
  let out = "";
  for (const item of items) {
    const next = out ? `${out}\n\n${item}` : item;
    if (next.length > limit) return `${out}\n\n…[relatório truncado: há mais achados]`.trim();
    out = next;
  }
  return out;
}

// Relatório do check: críticos com evidência e recomendação no resumo; todos os achados no texto.
export function formatReport(review) {
  const critical = review.findings.filter((finding) => finding.severity === "critical").map(renderFinding);
  return {
    summary: joinLimited(critical, SUMMARY_LIMIT),
    text: joinLimited([`Resumo: ${sanitizeText(review.summary, FIELD_LIMIT)}`, ...review.findings.map(renderFinding)], TEXT_LIMIT)
  };
}

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

function validate(review, { blockCritical = true } = {}) {
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
  if (actualCritical > 0 && blockCritical) throw new CriticalFinding(`${actualCritical} achado crítico bloqueia o merge`);
  return actualCritical;
}

export function classifyReview(review) {
  try {
    return { state: validate(review, { blockCritical: false }) > 0 ? "critical" : "approved", review };
  } catch {
    return { state: "inconclusive" };
  }
}

// O publisher recebe apenas o parecer já validado e a identidade produzida pelo
// materializador confiável. Nenhuma mensagem intermediária da ação é fallback.
export function executionVerdict({ diffOutcome, actionOutcome, diffFailureClass, metaFile } = {}) {
  if (diffOutcome !== "success") {
    return { verdict: { state: "inconclusive", failure_class: sanitizeFailureClass(diffFailureClass || "diff_unavailable") }, identity: "" };
  }
  if (actionOutcome !== "success") {
    return { verdict: { state: "inconclusive", failure_class: "model_unavailable" }, identity: "" };
  }
  try {
    const review = readExecutionInput();
    const checked = classifyReview(review);
    if (checked.state === "inconclusive") throw new Error("veredito inválido");
    const root = process.env.RUNNER_TEMP;
    if (!root || !metaFile || !isAbsolute(root) || !isAbsolute(metaFile)) throw new Error("identidade ausente");
    const within = relative(resolve(root), resolve(metaFile));
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("identidade fora da área temporária");
    const info = lstatSync(metaFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Error("identidade insegura");
    const identity = JSON.parse(readFileSync(metaFile, "utf8"))?.identity?.digest;
    if (!/^[0-9a-f]{64}$/.test(identity ?? "")) throw new Error("identidade inválida");
    return { verdict: { state: checked.state, review: checked.review }, identity };
  } catch {
    return { verdict: { state: "inconclusive", failure_class: "model_output_invalid" }, identity: "" };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
if (process.argv.includes("--emit-verdict")) {
  try {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT ausente");
    const { verdict, identity } = executionVerdict({
      diffOutcome: process.env.DIFF_OUTCOME,
      actionOutcome: process.env.CLAUDE_STEP_OUTCOME,
      diffFailureClass: process.env.DIFF_CLASS,
      metaFile: process.env.REVIEW_META_FILE
    });
    const payload = Buffer.from(JSON.stringify(verdict)).toString("base64");
    appendFileSync(process.env.GITHUB_OUTPUT, `payload=${payload}\nidentity=${identity}\n`);
    process.stdout.write(`Parecer classificado: ${verdict.state}.\n`);
  } catch {
    process.stderr.write("Não foi possível codificar o parecer para publicação.\n");
    process.exitCode = 1;
  }
} else {
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
}
}
