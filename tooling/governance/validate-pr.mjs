#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseSpecMeta } from "../lib/spec-meta.mjs";

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

// Item 25 da spec: `.gitignore` evita inclusão acidental, mas não impede inclusão
// deliberada — `git add -f` existe. Por isso a defesa é dupla, e este gate reprova
// quando a lista de alterações contém caminho proibido. A enumeração acompanha
// `.gitignore` linhas 6-8, 14 e 16-39.
//
// Nome literal e ancorado na raiz, igual a `.gitignore:14`.
const DOCUMENTO_DE_TRABALHO_DA_RAIZ =
  "Prompt avançado — Engenharia reversa autorizada de plataforma SaaS.md";

// As regras se aplicam a CADA COMPONENTE do caminho, não apenas ao último.
//
// No `.gitignore`, um padrão também casa diretórios, e tudo abaixo de um diretório
// ignorado permanece ignorado. Ancorar a verificação no fim do caminho permitiria
// contornar qualquer proibição acrescentando um componente permitido ao final:
// `.npmrc/.env.example` passaria, e `certs/tls.key/leia-me.md` também.
//
// Regras de ambiente, separadas porque são as ÚNICAS que a exceção `.env.example`
// neutraliza.
const AMBIENTE_PROIBIDO = [/^\.env$/u, /^\.env\./u];

// Aplicadas a um componente isolado. Não admitem exceção alguma.
const COMPONENTE_PROIBIDO = [
  // Chaves, certificados e material criptográfico.
  /\.(pem|key|crt|p12|pfx)$/iu,
  /^id_rsa/u,
  /^id_ed25519/u,
  // Credenciais de ferramenta.
  /^\.npmrc$/u,
  /^\.yarnrc$/u,
  /^\.pgpass$/u,
  // Dumps, bancos locais e backups.
  /\.dump$/iu,
  /\.sql\.gz$/iu,
  /\.sqlite3?$/iu,
  /^(backups|dumps|secrets)$/u,
  /\.secret\./u
];

// Regra de dois componentes, avaliada sobre cada prefixo do caminho.
const PREFIXO_PROIBIDO = [/(^|\/)\.claude\/settings\.local\.json$/u];

// O produtor atual é `git diff --name-only`, que aplica C-style quoting a caminhos com
// bytes fora do ASCII imprimível: a entrada chega entre aspas e com escapes octais.
// Nessa forma a comparação textual contra os padrões proibidos deixa de valer —
// inclusive para o próprio documento protegido, cujo nome tem acentuação e travessão.
//
// Barra invertida também torna a entrada ambígua: `apps\web\.npmrc` não casa
// `(^|\/)\.npmrc$`, e decidir se é separador ou caractere do nome depende do produtor.
//
// Enquanto a migração NUL-safe não acontece — Item 9 e Regra 12, pertencentes ao PR 6 —
// a postura é fail-closed: entrada não canônica reprova, em vez de ser comparada como
// se fosse literal. Desquotar aqui seria reimplementar o parser do Git em um gate.
function nonCanonicalEntry(path) {
  return (path.startsWith('"') && path.endsWith('"') && path.length >= 2) || path.includes("\\");
}

function forbiddenPath(path) {
  if (path === DOCUMENTO_DE_TRABALHO_DA_RAIZ) return true;

  const componentes = path.split("/");
  for (let indice = 0; indice < componentes.length; indice += 1) {
    const componente = componentes[indice];

    // Regra composta, sobre o prefixo acumulado até aqui. Assim
    // `.claude/settings.local.json` proíbe também seus descendentes.
    const prefixo = componentes.slice(0, indice + 1).join("/");
    if (PREFIXO_PROIBIDO.some((pattern) => pattern.test(prefixo))) return true;

    // As proibições sem exceção são avaliadas antes. Devolver "permitido" por causa do
    // nome antes desta conferência liberaria `secrets/.env.example`: o nome viraria um
    // passe livre para qualquer diretório proibido.
    if (COMPONENTE_PROIBIDO.some((pattern) => pattern.test(componente))) return true;

    // `.env.example` é o único arquivo de ambiente versionável, e a exceção vale
    // somente quando ele é o ARQUIVO FINAL. Como diretório — `.env.example/arquivo.txt`
    // — não isenta nada, e continua sujeito às regras de ambiente.
    if (indice === componentes.length - 1 && componente === ".env.example") continue;
    if (AMBIENTE_PROIBIDO.some((pattern) => pattern.test(componente))) return true;
  }
  return false;
}

// Item 15 da spec. A classificação como atualização automatizada vem EXCLUSIVAMENTE
// dos metadados confiáveis do evento, entregues pelo workflow. O campo `Tipo:` do
// corpo não participa: o corpo é escrito pelo próprio bot e é dado não confiável.
const FLAGS_DE_METADADOS = Object.freeze(["--author", "--head-ref", "--head-repo", "--base-repo"]);
const AUTOR_AUTOMATIZADO = "dependabot[bot]";
const BRANCH_AUTOMATIZADA = /^dependabot\//u;
// Dependabot nomeia o ecossistema npm como `npm_and_yarn` no segundo segmento da
// branch. Aceitar só esse literal é fail-closed: se o nome mudar, o gate reprova e
// exige o fluxo com issue e spec, em vez de isentar um ecossistema desconhecido.
const ECOSSISTEMA_NPM = /^dependabot\/npm_and_yarn\//u;
const ARQUIVOS_DE_DEPENDENCIA = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json"]);

// As quatro flags são OPCIONAIS: a invocação atual do workflow passa apenas
// `--trusted`, `--candidate`, `--body` e `--changed`, e precisa continuar válida.
// Presentes, porém, são indivisíveis e exatas.
//
// Devolve `null` quando NENHUMA está presente — e somente nesse caso. Presença é
// apurada pela ocorrência da flag em `argv`, nunca pelo valor: quatro flags com valor
// vazio são metadados inutilizáveis, não ausência de metadados, e devolver `null` ali
// jogaria o PR de volta ao fluxo legado justamente quando o evento se declarou.
//
// Nenhuma mensagem ecoa autor, branch ou repositório.
function parseEventMetadata(argv) {
  const ocorrencias = new Map(
    FLAGS_DE_METADADOS.map((flag) => [flag, argv.reduce((total, item) => (item === flag ? total + 1 : total), 0)])
  );
  const presentes = FLAGS_DE_METADADOS.filter((flag) => ocorrencias.get(flag) > 0);
  if (presentes.length === 0) return null;

  // Repetição é contradição, não preferência. Um parser que resolve por "a primeira
  // vence" aceitaria `--author dependabot[bot] --author atacante` e classificaria o PR
  // pela primeira, ignorando a segunda em silêncio.
  if (FLAGS_DE_METADADOS.some((flag) => ocorrencias.get(flag) > 1)) {
    throw new Error("metadado do evento repetido; cada flag deve aparecer exatamente uma vez");
  }
  if (presentes.length !== FLAGS_DE_METADADOS.length) {
    throw new Error("metadados do evento incompletos; a classificação exige autor, branch e os dois repositórios");
  }

  const valores = new Map();
  for (const flag of FLAGS_DE_METADADOS) {
    const value = argv[argv.indexOf(flag) + 1];
    // Ausente, vazio, só espaços, ou outra flag capturada como se fosse valor.
    if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) {
      throw new Error("metadado do evento sem valor utilizável; valor omitido do relatório");
    }
    valores.set(flag, value);
  }
  return valores;
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

  const eventMetadata = parseEventMetadata(process.argv);
  const automatedPullRequest = eventMetadata !== null && eventMetadata.get("--author") === AUTOR_AUTOMATIZADO;

  const changed = readFileSync(changedFile, "utf8").split(/\r?\n/).filter(Boolean);

  // Canonicidade primeiro: uma entrada quoted ou com barra invertida não pode ser
  // comparada como se fosse literal, sob pena de o documento protegido passar
  // disfarçado pela própria forma que o Git usou para exibi-lo.
  if (changed.some(nonCanonicalEntry)) {
    throw new Error("lista de alterações contém caminho ambíguo ou não canônico; valor omitido do relatório");
  }

  // Antes de qualquer ramo por tipo: a proibição vale para todo PR, inclusive o
  // automatizado. Antes também da mensagem de "PR de spec contém implementação", que
  // ecoa caminhos — um caminho proibido não pode escapar por ali. A mensagem declara a
  // classe e nunca o caminho: nome de arquivo privado, ambiente e material
  // criptográfico não pertencem ao log público de um gate.
  if (changed.some(forbiddenPath)) {
    throw new Error("lista de alterações contém caminho proibido; valor omitido do relatório");
  }

  if (automatedPullRequest) {
    const headRef = eventMetadata.get("--head-ref");
    // Condições cumulativas. A falha de qualquer uma reprova IMEDIATAMENTE como tipo
    // automatizado, sem conversão para o fluxo por `Tipo:`. Lista vazia também reprova:
    // enumeração vazia nunca é aprovação. Os metadados ficam fora da mensagem.
    if (
      !BRANCH_AUTOMATIZADA.test(headRef) ||
      !ECOSSISTEMA_NPM.test(headRef) ||
      eventMetadata.get("--head-repo") !== eventMetadata.get("--base-repo") ||
      !changed.length ||
      !changed.every((path) => ARQUIVOS_DE_DEPENDENCIA.has(path))
    ) {
      throw new Error(
        "PR automatizado não satisfaz as condições de isenção; metadados omitidos do relatório"
      );
    }
    // A isenção alcança somente `Issue` e `Spec`. Nenhum gate, verificação de lockfile,
    // revisão ou aprovação humana é dispensado.
    //
    // Saída por `throw`/fim natural do bloco, nunca `process.exit`: encerrar o processo
    // logo após `process.stdout.write` pode truncar a escrita quando a saída é um pipe.
    process.stdout.write("PR válido: atualização automatizada de dependências.\n");
  } else {
    validateDeclaredPullRequest({ body, changed, trustedRoot, candidateRoot });
  }
} catch (error) {
  process.stderr.write(`PR inválido: ${error.message}\n`);
  process.exitCode = 1;
}

function validateDeclaredPullRequest({ body, changed, trustedRoot, candidateRoot }) {
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
  if (type === "implementação" || type === "implementacao") {
    if (!existsSync(trustedSpec) || !existsSync(candidateSpec)) throw new Error("Spec aprovada deve existir na branch base e no candidato");
    validateSpec(trustedSpec);
    const metadata = parseSpecMeta(readFileSync(trustedSpec, "utf8"));
    if (metadata.issue !== `github:#${issueNumber}`) throw new Error("Issue do PR não corresponde a spec-meta.issue");
    if (readFileSync(trustedSpec, "utf8") !== readFileSync(candidateSpec, "utf8") || changed.includes(spec)) {
      throw new Error("PR de implementação deve manter a spec imutável; alterações de spec usam PR separado");
    }
    if (!hasTddEvidence(body)) throw new Error("Evidência TDD precisa registrar vermelho e verde não vazios");
  } else if (type === "spec") {
    if (!existsSync(candidateSpec)) throw new Error("Spec proposta não existe no candidato");
    validateSpec(candidateSpec);
    const metadata = parseSpecMeta(readFileSync(candidateSpec, "utf8"));
    if (metadata.issue !== `github:#${issueNumber}`) throw new Error("spec-meta.issue não corresponde à Issue do PR");
    const unrelated = changed.filter((path) => path !== spec && !path.startsWith("tasks/"));
    if (unrelated.length) throw new Error(`PR de spec contém implementação: ${unrelated.join(", ")}`);
  } else {
    throw new Error("Tipo deve ser spec ou implementação");
  }

  process.stdout.write(`PR válido: ${type}, ${issue}, ${spec}.\n`);
}
