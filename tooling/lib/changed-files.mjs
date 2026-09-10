import { spawnSync } from "node:child_process";

const NUL = 0x00;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export const ACCEPTED_STATUSES = Object.freeze(["A", "M", "D"]);

// A lista vem sempre do contexto confiável do evento. SHA em formato livre
// permitiria injetar refs ou opções na invocação do git.
export function changedFilesArguments(baseSha, headSha) {
  for (const [name, value] of [
    ["base", baseSha],
    ["head", headSha]
  ]) {
    if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
      throw new Error(`SHA inválido para ${name}: ${JSON.stringify(value)}`);
    }
  }
  return ["diff", "--name-status", "-z", "--no-renames", baseSha, headSha];
}

function assertPath(path) {
  if (path === "") throw new Error("caminho vazio na lista de alterações");
  if (path.includes("\\")) {
    throw new Error(`caminho com barra invertida não é portável: ${path}`);
  }
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    throw new Error(`caminho absoluto não é aceito: ${path}`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`caminho com componente \`..\` não é aceito: ${path}`);
  }
}

// A separação acontece sobre o Buffer, campo a campo. Converter a saída inteira
// para texto antes de separar arriscaria corromper limites de campo.
function splitFields(buffer) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== NUL) continue;
    parts.push(buffer.subarray(start, index).toString("utf8"));
    start = index + 1;
  }
  if (start < buffer.length) parts.push(buffer.subarray(start).toString("utf8"));
  return parts;
}

export function parseChangedFiles(stdout) {
  if (!Buffer.isBuffer(stdout)) {
    throw new Error("esperado Buffer na saída de git diff --name-status -z");
  }
  if (stdout.length > 0 && stdout[stdout.length - 1] !== NUL) {
    throw new Error("saída de git diff --name-status -z não terminada por NUL");
  }
  const parts = splitFields(stdout);
  if (parts.length % 2 !== 0) {
    throw new Error(`número ímpar de campos na lista de alterações: ${parts.length}`);
  }
  const entries = [];
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index];
    const path = parts[index + 1];
    if (!ACCEPTED_STATUSES.includes(status)) {
      throw new Error(
        `status não aceito na lista de alterações: ${JSON.stringify(status)}; aceitos ${ACCEPTED_STATUSES.join(", ")}`
      );
    }
    assertPath(path);
    entries.push({ status, path });
  }
  return entries;
}

// Lista vazia é um fato, não um veredito. Quem depende de conteúdo precisa dizê-lo.
export function assertChangedFilesNotEmpty(entries, context) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${context} está vazia; ausência de entradas não é aprovação`);
  }
  return entries;
}

export function readChangedFiles({ repository, baseSha, headSha, run = spawnSync }) {
  if (typeof repository !== "string" || repository === "") {
    throw new Error("repositório inválido para git diff");
  }
  const args = ["-C", repository, ...changedFilesArguments(baseSha, headSha)];
  const result = run("git", args, { encoding: "buffer", shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git diff falhou: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
    throw new Error(`git diff falhou com código ${result.status ?? "indisponível"}: ${stderr}`);
  }
  return parseChangedFiles(result.stdout);
}
