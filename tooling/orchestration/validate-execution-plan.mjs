#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { assertChangedFilesNotEmpty, parseChangedFiles } from "../lib/changed-files.mjs";
import {
  PLAN_PATTERN,
  applyChanges,
  buildBaseSnapshot,
  findDuplicates,
  readEntryJson
} from "../lib/snapshot.mjs";

const PLANS_DIRECTORY = "orchestration/plans";

// Afrouxamento nunca vem da linha de comando nem de dado do candidato. Quando o
// registro determinístico de exceções do Item 7 existir, a autorização virá dele,
// lido do snapshot da base. Até lá, as duas invariantes são incondicionais.
const TRUSTED_RELAXATIONS = Object.freeze({ allowDeletion: false, allowEmpty: false });

function validate(plan) {
  if (plan.version !== 1 || !Array.isArray(plan.steps) || !plan.steps.length) {
    throw new Error("plano inválido: version 1 e steps são obrigatórios");
  }
  // Exigido em ambos os modos: o modo posicional não pode aceitar um plano que o modo
  // snapshot reprova, sob pena de o gate e a linha de base divergirem.
  if (typeof plan.task !== "string" || plan.task === "") {
    throw new Error("plano sem `task`: `task` precisa ser string não vazia");
  }
  const byId = new Map();
  for (const step of plan.steps) {
    if (!step?.id || !step?.agent || !["read", "write"].includes(step.mode)) {
      throw new Error("passo inválido: id, agent e mode read|write são obrigatórios");
    }
    if (!Array.isArray(step.dependsOn) || !Array.isArray(step.reads) || !Array.isArray(step.writes)) {
      throw new Error(`passo ${step.id}: dependsOn, reads e writes devem ser listas`);
    }
    if (step.mode === "read" && step.writes.length) {
      throw new Error(`passo de leitura não pode escrever: ${step.id}`);
    }
    if (byId.has(step.id)) throw new Error(`passo duplicado: ${step.id}`);
    byId.set(step.id, step);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`dependência inexistente: ${step.id} -> ${dependency}`);
    }
  }
  assertAcyclic(byId);
  assertWritersSerialized(plan.steps, byId);
}

function assertAcyclic(byId) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail) {
    if (visiting.has(id)) throw new Error(`ciclo no DAG: ${[...trail, id].join(" -> ")}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id, []);
}

function dependsOn(start, target, byId, seen = new Set()) {
  if (seen.has(start)) return false;
  seen.add(start);
  for (const dependency of byId.get(start).dependsOn) {
    if (dependency === target || dependsOn(dependency, target, byId, seen)) return true;
  }
  return false;
}

function assertWritersSerialized(steps, byId) {
  const writers = steps.filter((step) => step.mode === "write");
  for (let left = 0; left < writers.length; left += 1) {
    for (let right = left + 1; right < writers.length; right += 1) {
      const a = writers[left].id;
      const b = writers[right].id;
      if (!dependsOn(a, b, byId) && !dependsOn(b, a, byId)) {
        throw new Error(`escritores podem executar em paralelo: ${a}, ${b}`);
      }
    }
  }
}

// Cada snapshot é verificado por inteiro e isoladamente. Unicidade nunca é apurada
// pela união de base e candidato: alterar um plano existente produziria duas entradas
// com a mesma `task` e uma mudança legítima seria reprovada como duplicação.
function validateSnapshot(snapshot, label) {
  const paths = new Map();
  for (const relativePath of snapshot.keys()) {
    const normalized = relativePath.toLocaleLowerCase("en-US");
    if (paths.has(normalized)) {
      throw new Error(`${label}: caminho duplicado: ${relativePath} e ${paths.get(normalized)}`);
    }
    paths.set(normalized, relativePath);
  }

  // Uma única leitura por entrada. Validar e apurar unicidade a partir de leituras
  // distintas permitiria que as duas vissem conteúdos diferentes, e ampliaria sem
  // necessidade a janela entre verificação e uso.
  const parsed = new Map();
  for (const [relativePath, entry] of snapshot) {
    // Conteúdo do candidato é dado: `readEntryJson`, jamais `import`.
    let plan;
    try {
      plan = readEntryJson(entry);
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
    try {
      validate(plan);
    } catch (error) {
      throw new Error(`${label}: ${relativePath}: ${error.message}`);
    }
    parsed.set(relativePath, plan);
  }

  const duplicates = findDuplicates(snapshot, (_entry, relativePath) => parsed.get(relativePath).task);
  if (duplicates.length) {
    const [first] = duplicates;
    throw new Error(`${label}: task duplicada \`${first.key}\` em ${first.paths.join(", ")}`);
  }
  return snapshot.size;
}

const FLAGS_WITH_VALUE = new Set(["--trusted", "--candidate", "--changed"]);

// Um único passo de parsing: nomes conhecidos consomem o argumento seguinte, o resto
// é posicional. Sem isso, o valor de uma flag seria contado como arquivo de plano.
function parseArguments(argv) {
  const options = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      if (!FLAGS_WITH_VALUE.has(value)) throw new Error(`argumento desconhecido: ${value}`);
      // Repetição sobrescreveria o primeiro valor em silêncio: `--trusted a --trusted b`
      // faria o último vencer, e uma raiz confiável poderia ser trocada sem sinal.
      if (options.has(value)) throw new Error(`argumento repetido: ${value}`);
      const next = argv[index + 1];
      // Valor vazio ou só com espaços degradaria o modo em silêncio: uma variável de
      // ambiente não exportada expande para vazio e o gate aprovaria sem examinar nada.
      if (next === undefined || next.startsWith("--") || next.trim() === "") {
        throw new Error(`${value} exige um valor`);
      }
      options.set(value, next);
      index += 1;
      continue;
    }
    positional.push(value);
  }
  return { options, positional };
}

function readChangedEntries(changedFile) {
  // Buffer, não texto: a separação por NUL acontece sobre os bytes.
  const entries = parseChangedFiles(readFileSync(changedFile));
  // Lista vazia faria `applyChanges` devolver cópia da base, e o CLI afirmaria ter
  // validado o candidato sem ter lido um único byte dele.
  return assertChangedFilesNotEmpty(entries, "lista de alterações do candidato");
}

function runSnapshotMode(trusted, candidate, changedFile) {
  const base = buildBaseSnapshot({
    root: trusted,
    directory: PLANS_DIRECTORY,
    pattern: PLAN_PATTERN,
    allowEmpty: TRUSTED_RELAXATIONS.allowEmpty
  });
  const baseCount = validateSnapshot(base, "base");
  if (candidate === undefined) return `Planos válidos — base: ${baseCount} ${baseCount === 1 ? "plano" : "planos"}.`;

  if (changedFile === undefined) throw new Error("--changed é obrigatório quando --candidate é informado");
  const effective = applyChanges({
    base,
    changes: readChangedEntries(changedFile),
    root: candidate,
    directory: PLANS_DIRECTORY,
    pattern: PLAN_PATTERN,
    allowDeletion: TRUSTED_RELAXATIONS.allowDeletion,
    allowEmpty: TRUSTED_RELAXATIONS.allowEmpty
  });
  const candidateCount = validateSnapshot(effective, "candidato");
  return `Planos válidos — base: ${baseCount} ${baseCount === 1 ? "plano" : "planos"}; candidato: ${candidateCount} ${candidateCount === 1 ? "plano" : "planos"}.`;
}

// Modo por arquivo preservado: `validate-pr.mjs` e o workflow ainda invocam assim.
function runFileMode(files) {
  for (const file of files) {
    const plan = JSON.parse(readFileSync(file, "utf8"));
    validate(plan);
    process.stdout.write(`Plano de execução válido: ${plan.steps.length} passos (${basename(file)}).\n`);
  }
}

try {
  const { options, positional: files } = parseArguments(process.argv.slice(2));
  const trusted = options.get("--trusted");
  const candidate = options.get("--candidate");
  const changedFile = options.get("--changed");

  if (trusted !== undefined) {
    if (files.length) throw new Error("use modo por arquivo ou modo snapshot, nunca os dois");
    // Aceitar `--changed` sem `--candidate` ignoraria a lista de alterações e aprovaria
    // validando apenas a base: exclusão e adição do candidato passariam despercebidas.
    if (changedFile !== undefined && candidate === undefined) throw new Error("--changed exige --candidate");
    process.stdout.write(`${runSnapshotMode(trusted, candidate, changedFile)}\n`);
  } else if (candidate !== undefined || changedFile !== undefined) {
    throw new Error("--trusted é obrigatório no modo snapshot");
  } else {
    if (!files.length) throw new Error("informe o arquivo do plano ou use --trusted");
    runFileMode(files);
  }
} catch (error) {
  process.stderr.write(`Plano de execução inválido: ${error.message}\n`);
  process.exitCode = 1;
}
