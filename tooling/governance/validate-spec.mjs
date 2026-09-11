#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { assertChangedFilesNotEmpty, parseChangedFiles } from "../lib/changed-files.mjs";
import {
  SPEC_PATTERN,
  applyChanges,
  assertNoSymlinkInPath,
  buildBaseSnapshot,
  findDuplicates,
  readEntryText
} from "../lib/snapshot.mjs";

const SPECS_DIRECTORY = "specs";

// Afrouxamento nunca vem da linha de comando nem de dado do candidato. Quando o
// registro determinístico de exceções do Item 7 existir, a autorização virá dele,
// lido do snapshot da base. Até lá, as duas invariantes são incondicionais.
const TRUSTED_RELAXATIONS = Object.freeze({ allowDeletion: false, allowEmpty: false });

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

function specMetadata(markdown) {
  const metadataMatches = [...markdown.matchAll(/<!-- spec-meta\s*\r?\n([\s\S]*?)\r?\n-->/g)];
  if (metadataMatches.length !== 1) {
    throw new Error("metadados spec-meta ausentes ou duplicados");
  }
  try {
    return JSON.parse(metadataMatches[0][1]);
  } catch {
    throw new Error("metadados spec-meta não são JSON válido");
  }
}

// Validação de conteúdo, independente de onde o texto veio: arquivo solto na invocação
// por caminho, ou entrada de snapshot lida por `readEntryText`.
function validateSpecContent(markdown, fileName, projectRoot) {
  const metadata = specMetadata(markdown);
  const fileId = fileName.match(/^(\d+)-/)?.[1];
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
    const localPath = metadata.issue.slice("local:".length);
    if (!/^tasks\/[0-9]+-[a-z0-9-]+\.md$/.test(localPath) || localPath.includes("..") || localPath.includes("\\")) {
      throw new Error(`issue local inválida: ${metadata.issue}`);
    }
    // `existsSync` seguiria symlink e aceitaria diretório, ao contrário de todo o
    // resto do pipeline. A tarefa referenciada precisa ser arquivo regular, e nenhum
    // componente do caminho pode ser symlink.
    // `lstat` primeiro: dá a mensagem específica para tarefa ausente, e não segue link.
    let stats;
    try {
      stats = lstatSync(resolve(projectRoot, localPath));
    } catch {
      throw new Error(`issue local inexistente: ${metadata.issue}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`issue local por symlink não é aceita: ${metadata.issue}`);
    }
    if (!stats.isFile()) {
      throw new Error(`issue local não é arquivo regular: ${metadata.issue}`);
    }
    // Cobre os componentes ancestrais do caminho da tarefa.
    assertNoSymlinkInPath(projectRoot, localPath);
  } else if (!/^github:#\d+$/.test(metadata.issue)) {
    throw new Error(`referência de issue inválida: ${metadata.issue}`);
  }
  const parsed = sections(markdown);
  const missing = REQUIRED_HEADINGS.filter((heading) => !parsed.get(heading));
  if (missing.length) {
    throw new Error(`seções obrigatórias ausentes: ${missing.join(", ")}`);
  }
  return metadata;
}

function validateFile(file) {
  const projectRoot = basename(dirname(file)).toLocaleLowerCase("en-US") === "specs"
    ? resolve(dirname(file), "..")
    : dirname(file);
  validateSpecContent(readFileSync(file, "utf8"), basename(file), projectRoot);
}

// Identidade canônica usada EXCLUSIVAMENTE para apurar unicidade. `3`, `03`, `003` e
// `0003` designam a mesma issue e precisam colidir. A remoção dos zeros é textual: usar
// `Number` ou `parseInt` perderia precisão em identificadores longos.
// A comparação entre o prefixo do arquivo e `metadata.id` permanece estrita e textual,
// para que ids legados como `004` continuem válidos enquanto o nome corresponder.
function canonicalSpecId(id) {
  return String(id).replace(/^0+(?=\d)/, "");
}

// Cada snapshot é verificado por inteiro e isoladamente. Unicidade nunca é apurada pela
// união de base e candidato: alterar uma spec existente produziria duas entradas com o
// mesmo `id` e a mudança legítima seria reprovada como duplicação.
function validateSnapshot(snapshot, root, label) {
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
  const identifiers = new Map();
  for (const [relativePath, entry] of snapshot) {
    // Conteúdo do candidato é dado: `readEntryText`, jamais `import`.
    try {
      const metadata = validateSpecContent(readEntryText(entry), basename(relativePath), root);
      identifiers.set(relativePath, canonicalSpecId(metadata.id));
    } catch (error) {
      throw new Error(`${label}: ${relativePath}: ${error.message}`);
    }
  }

  const duplicates = findDuplicates(snapshot, (_entry, relativePath) => identifiers.get(relativePath));
  if (duplicates.length) {
    const [first] = duplicates;
    throw new Error(`${label}: id duplicado \`${first.key}\` em ${first.paths.join(", ")}`);
  }
  return snapshot.size;
}

const FLAGS_WITH_VALUE = new Set(["--trusted", "--candidate", "--changed"]);

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

function plural(count) {
  return count === 1 ? "especificação" : "especificações";
}

function runSnapshotMode(trusted, candidate, changedFile) {
  const base = buildBaseSnapshot({
    root: trusted,
    directory: SPECS_DIRECTORY,
    pattern: SPEC_PATTERN,
    allowEmpty: TRUSTED_RELAXATIONS.allowEmpty
  });
  const baseCount = validateSnapshot(base, trusted, "base");
  if (candidate === undefined) return `Especificações válidas — base: ${baseCount} ${plural(baseCount)}.`;

  if (changedFile === undefined) throw new Error("--changed é obrigatório quando --candidate é informado");
  const effective = applyChanges({
    base,
    // Buffer, não texto: a separação por NUL acontece sobre os bytes. Lista vazia faria
    // `applyChanges` devolver cópia da base, e o CLI afirmaria ter validado o candidato
    // sem ter lido um único byte dele.
    changes: assertChangedFilesNotEmpty(
      parseChangedFiles(readFileSync(changedFile)),
      "lista de alterações do candidato"
    ),
    root: candidate,
    directory: SPECS_DIRECTORY,
    pattern: SPEC_PATTERN,
    allowDeletion: TRUSTED_RELAXATIONS.allowDeletion,
    allowEmpty: TRUSTED_RELAXATIONS.allowEmpty
  });
  // A entrada da base continua apontando para a raiz da base; a do candidato, para a dele.
  const candidateCount = validateSnapshot(effective, candidate, "candidato");
  return `Especificações válidas — base: ${baseCount} ${plural(baseCount)}; candidato: ${candidateCount} ${plural(candidateCount)}.`;
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
    // Modo por arquivo preservado: `validate-pr.mjs` e o workflow ainda invocam assim.
    if (!files.length) throw new Error("informe ao menos um arquivo de especificação ou use --trusted");
    for (const file of files) {
      validateFile(file);
      process.stdout.write(`Especificação válida: ${basename(file)}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`Especificação inválida: ${error.message}\n`);
  process.exitCode = 1;
}
