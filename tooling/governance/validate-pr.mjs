#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function field(body, name) {
  return body.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim();
}

function safeSpecPath(path) {
  return typeof path === "string" && /^specs\/[0-9]+-[a-z0-9-]+\.md$/.test(path) && !isAbsolute(path) && !path.includes("..") && !path.includes("\\");
}

function validateSpec(specPath) {
  const validator = resolve(fileURLToPath(new URL(".", import.meta.url)), "validate-spec.mjs");
  const result = spawnSync(process.execPath, [validator, specPath], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim());
}

function specMetadata(markdown) {
  const raw = markdown.match(/<!-- spec-meta\s*\r?\n([\s\S]*?)\r?\n-->/)?.[1];
  if (!raw) throw new Error("metadados da Spec ausentes");
  return JSON.parse(raw);
}

function hasTddEvidence(body) {
  const section = body.match(/^## Evidência TDD\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/im)?.[1] ?? "";
  return section.split(/\r?\n/).some((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return cells.length >= 3 && /^\d+$/.test(cells[0]) && cells[1].length > 0 && cells[2].length > 0;
  });
}

try {
  const trustedRoot = resolve(argument("--trusted") ?? "");
  const candidateRoot = resolve(argument("--candidate") ?? "");
  const bodyFile = argument("--body");
  const changedFile = argument("--changed");
  if (!bodyFile || !changedFile || !existsSync(trustedRoot) || !existsSync(candidateRoot)) {
    throw new Error("argumentos --trusted, --candidate, --body e --changed são obrigatórios");
  }
  const body = readFileSync(bodyFile, "utf8");
  const type = field(body, "Tipo")?.toLocaleLowerCase("pt-BR");
  const issue = field(body, "Issue");
  const spec = field(body, "Spec");
  if (!type || !issue || !spec) throw new Error("Tipo, Issue e Spec são obrigatórios no PR");
  if (!/^#\d+$/.test(issue) && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(issue)) {
    throw new Error("Issue deve ser #número ou URL de issue do GitHub");
  }
  if (!safeSpecPath(spec)) throw new Error("Spec deve apontar para specs/<id>-<nome>.md");
  const issueNumber = issue.match(/(?:#|issues\/)(\d+)$/)?.[1];
  const specId = spec.match(/^specs\/(\d+)-/)?.[1];
  if (!issueNumber || issueNumber !== specId) throw new Error("Issue e Spec não correspondem ao mesmo id");

  const trustedSpec = resolve(trustedRoot, spec);
  const candidateSpec = resolve(candidateRoot, spec);
  const changed = readFileSync(changedFile, "utf8").split(/\r?\n/).filter(Boolean);

  if (type === "implementação" || type === "implementacao") {
    if (!existsSync(trustedSpec) || !existsSync(candidateSpec)) throw new Error("Spec aprovada deve existir na branch base e no candidato");
    validateSpec(trustedSpec);
    const metadata = specMetadata(readFileSync(trustedSpec, "utf8"));
    if (metadata.issue !== `github:#${issueNumber}`) throw new Error("Issue do PR não corresponde a spec-meta.issue");
    if (readFileSync(trustedSpec, "utf8") !== readFileSync(candidateSpec, "utf8") || changed.includes(spec)) {
      throw new Error("PR de implementação deve manter a spec imutável; alterações de spec usam PR separado");
    }
    if (!hasTddEvidence(body)) throw new Error("Evidência TDD precisa registrar vermelho e verde não vazios");
  } else if (type === "spec") {
    if (!existsSync(candidateSpec)) throw new Error("Spec proposta não existe no candidato");
    validateSpec(candidateSpec);
    const metadata = specMetadata(readFileSync(candidateSpec, "utf8"));
    if (metadata.issue !== `github:#${issueNumber}`) throw new Error("spec-meta.issue não corresponde à Issue do PR");
    const unrelated = changed.filter((path) => path !== spec && !path.startsWith("tasks/"));
    if (unrelated.length) throw new Error(`PR de spec contém implementação: ${unrelated.join(", ")}`);
  } else {
    throw new Error("Tipo deve ser spec ou implementação");
  }

  process.stdout.write(`PR válido: ${type}, ${issue}, ${spec}.\n`);
} catch (error) {
  process.stderr.write(`PR inválido: ${error.message}\n`);
  process.exitCode = 1;
}
