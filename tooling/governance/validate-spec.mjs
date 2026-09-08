#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const REQUIRED_HEADINGS = [
  "Status",
  "Problema",
  "Resultado esperado",
  "Escopo",
  "Fora de escopo",
  "Regras",
  "Superfícies de teste",
  "Critérios de aceite",
  "Riscos e decisões pendentes",
  "Evidência de conclusão"
];

function sections(markdown) {
  const result = new Map();
  const pattern = /^##\s+(.+?)\s*$\r?\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm;
  for (const match of markdown.matchAll(pattern)) {
    result.set(match[1].trim(), match[2].trim());
  }
  return result;
}

function validate(file) {
  const markdown = readFileSync(file, "utf8");
  const metadataMatches = [...markdown.matchAll(/<!-- spec-meta\s*\r?\n([\s\S]*?)\r?\n-->/g)];
  if (metadataMatches.length !== 1) {
    throw new Error("metadados spec-meta ausentes ou duplicados");
  }
  let metadata;
  try {
    metadata = JSON.parse(metadataMatches[0][1]);
  } catch {
    throw new Error("metadados spec-meta não são JSON válido");
  }
  const fileId = basename(file).match(/^(\d+)-/)?.[1];
  if (!fileId || metadata.id !== fileId) {
    throw new Error(`id ${metadata.id ?? "ausente"} não corresponde ao nome do arquivo`);
  }
  if (metadata.status !== "approved") {
    throw new Error("a especificação não está aprovada nos metadados");
  }
  if (typeof metadata.issue !== "string" || !metadata.issue) {
    throw new Error("a especificação não informa a issue de origem");
  }
  if (metadata.issue.startsWith("local:")) {
    const projectRoot = basename(dirname(file)).toLowerCase() === "specs" ? resolve(dirname(file), "..") : dirname(file);
    const localPath = metadata.issue.slice("local:".length);
    if (!/^tasks\/[0-9]+-[a-z0-9-]+\.md$/.test(localPath) || localPath.includes("..") || localPath.includes("\\")) {
      throw new Error(`issue local inválida: ${metadata.issue}`);
    }
    const localIssue = resolve(projectRoot, localPath);
    if (!existsSync(localIssue)) throw new Error(`issue local inexistente: ${metadata.issue}`);
  } else if (!/^github:#\d+$/.test(metadata.issue)) {
    throw new Error(`referência de issue inválida: ${metadata.issue}`);
  }
  const parsed = sections(markdown);
  const missing = REQUIRED_HEADINGS.filter((heading) => !parsed.get(heading));
  if (missing.length) {
    throw new Error(`seções obrigatórias ausentes: ${missing.join(", ")}`);
  }
}

const files = process.argv.slice(2);

try {
  if (!files.length) throw new Error("informe ao menos um arquivo de especificação");
  for (const file of files) {
    validate(file);
    process.stdout.write(`Especificação válida: ${basename(file)}\n`);
  }
} catch (error) {
  process.stderr.write(`Especificação inválida: ${error.message}\n`);
  process.exitCode = 1;
}
