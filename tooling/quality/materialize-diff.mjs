#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { containsSecret, FAILURE_MESSAGES, writeFailureClass } from "./enforce-claude-review.mjs";

const MAX_FILES = 50;
const MAX_PATCH_BYTES = 300_000;
const MAX_TOTAL_BYTES = 1_000_000;

function safePath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").includes("..") && !/[\x00-\x1f\x7f]/.test(path);
}

const FORBIDDEN_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".sql", ".dump", ".bak", ".backup", ".pgdump", ".tfstate", ".kdbx"]);
const FORBIDDEN_NAMES = new Set([".npmrc", ".netrc", ".pgpass", ".envrc", ".pypirc", ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);

export function forbiddenPath(path) {
  const name = path.split("/").pop().toLowerCase();
  if (FORBIDDEN_NAMES.has(name)) return true;
  if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && FORBIDDEN_EXTENSIONS.has(name.slice(dot));
}

// Mensagens nunca ecoam o caminho nem o conteúdo: apenas posição e classe.
function preflightPaths(files) {
  files.forEach((file, index) => {
    if (!safePath(file.filename)) throw new Error(`caminho inválido no arquivo #${index + 1}`);
    if (forbiddenPath(file.filename)) throw new Error(`caminho proibido no arquivo #${index + 1}`);
  });
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function completePatch(file) {
  if (typeof file.patch !== "string" || !file.patch.startsWith("@@ ")) throw new Error(`patch ausente: ${file.filename}`);
  if (Buffer.byteLength(file.patch, "utf8") > MAX_PATCH_BYTES) throw new Error(`patch excede limite: ${file.filename}`);
  const lines = file.patch.split("\n");
  let oldRemaining = 0;
  let newRemaining = 0;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) throw new Error(`patch incompleto: ${file.filename}`);
      const match = line.match(HUNK_HEADER);
      if (!match) throw new Error(`patch incompleto: ${file.filename}`);
      oldRemaining = Number(match[2] ?? 1);
      newRemaining = Number(match[4] ?? 1);
      inHunk = true;
    } else if (line.startsWith("+")) {
      newRemaining--;
      additions++;
    } else if (line.startsWith("-")) {
      oldRemaining--;
      deletions++;
    } else if (line.startsWith(" ")) {
      oldRemaining--;
      newRemaining--;
    } else if (line.startsWith("\\ No newline")) {
      continue;
    } else {
      throw new Error(`patch incompleto: ${file.filename}`);
    }
    if (oldRemaining < 0 || newRemaining < 0) throw new Error(`patch incompleto: ${file.filename}`);
  }
  if (!inHunk || oldRemaining !== 0 || newRemaining !== 0 || additions !== file.additions || deletions !== file.deletions) {
    throw new Error(`patch incompleto: ${file.filename}`);
  }
}

// Linhas preservam o terminador original: CRLF, BOM e ausência de newline final não são normalizados.
function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// Aplica os hunks ao conteúdo de ORIGEM (blob da base) e devolve o conteúdo resultante.
// Qualquer contexto ou linha removida que não coincida com o blob de origem aborta.
function applyPatch(oldText, patch, filename) {
  const fail = () => { throw new Error(`patch não corresponde aos blobs base/head: ${filename}`); };
  const oldLines = splitLines(oldText);
  const out = [];
  let cursor = 0;
  const patchLines = patch.split("\n");
  for (let index = 0; index < patchLines.length; index++) {
    const line = patchLines[index];
    if (line.startsWith("@@ ")) {
      const match = line.match(HUNK_HEADER);
      if (!match) fail();
      const oldStart = Number(match[1]);
      const oldCount = Number(match[2] ?? 1);
      const newStart = Number(match[3]);
      const newCount = Number(match[4] ?? 1);
      const at = oldCount === 0 ? oldStart : oldStart - 1;
      if (at < cursor || at > oldLines.length) fail();
      out.push(...oldLines.slice(cursor, at));
      cursor = at;
      if (out.length !== (newCount === 0 ? newStart : newStart - 1)) fail();
      continue;
    }
    if (line.startsWith("\\")) continue;
    const text = line.slice(1) + (patchLines[index + 1]?.startsWith("\\ No newline") ? "" : "\n");
    if (line[0] === "+") {
      out.push(text);
    } else {
      if (oldLines[cursor] !== text) fail();
      cursor++;
      if (line[0] === " ") out.push(text);
    }
  }
  out.push(...oldLines.slice(cursor));
  return out.join("");
}

async function githubJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status ?? "erro"}`);
  return response.json();
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REGULAR_MODES = new Set(["100644", "100755"]);

// Blob imutável conferido por hash Git (SHA-1 de "blob <len>\0"+bytes). Binário e UTF-8 inválido são recusados;
// o BOM é preservado (ignoreBOM) e nenhum byte é normalizado.
async function fetchVerifiedBlob(sha, repo, token, fetchImpl, cache) {
  if (cache.has(sha)) return cache.get(sha);
  const blob = await githubJson(`https://api.github.com/repos/${repo}/git/blobs/${sha}`, token, fetchImpl);
  if (blob.encoding !== "base64" || typeof blob.content !== "string" || !Number.isInteger(blob.size)) throw new Error("blob indisponível");
  const raw = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
  const digest = createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex");
  if (raw.length !== blob.size || digest !== sha || raw.includes(0)) throw new Error("blob incompleto ou binário");
  if (raw.length > MAX_TOTAL_BYTES) throw new Error("blob excede limite; revisão manual necessária");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new Error("blob não é texto UTF-8");
  }
  cache.set(sha, text);
  return text;
}

async function loadTree(repo, commitSha, token, fetchImpl) {
  const base = `https://api.github.com/repos/${repo}/git`;
  const commit = await githubJson(`${base}/commits/${commitSha}`, token, fetchImpl);
  const treeSha = commit.tree?.sha;
  if (!SHA_PATTERN.test(treeSha ?? "")) throw new Error("árvore do commit indisponível");
  const tree = await githubJson(`${base}/trees/${treeSha}?recursive=1`, token, fetchImpl);
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error("árvore truncada ou inválida; revisão manual necessária");
  // Entradas "tree" (diretórios) não são arquivos: só blobs/links/submódulos participam da diferença.
  return { treeSha, entries: new Map(tree.tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry])) };
}

// Conjunto COMPLETO de diferenças base.sha -> head.sha (comparação direta de árvores, A/M/D, com modos).
function deriveChanges(baseEntries, headEntries) {
  const changes = [];
  for (const path of [...new Set([...baseEntries.keys(), ...headEntries.keys()])].sort((a, b) => (a < b ? -1 : 1))) {
    const base = baseEntries.get(path);
    const head = headEntries.get(path);
    if (base && head && base.sha === head.sha && base.mode === head.mode && base.type === head.type) continue;
    for (const item of [base, head]) {
      if (item && (!REGULAR_MODES.has(item.mode) || item.type !== "blob")) {
        throw new Error("tipo ou modo de arquivo não suportado (symlink, submódulo ou desconhecido); revisão manual necessária");
      }
    }
    changes.push({ path, status: !base ? "added" : !head ? "removed" : "modified", base, head });
  }
  return changes;
}

function modeHeader(change) {
  if (change.status === "added") return `new file mode ${change.head.mode}\n`;
  if (change.status === "removed") return `deleted file mode ${change.base.mode}\n`;
  return change.head.mode !== change.base.mode ? `old mode ${change.base.mode}\nnew mode ${change.head.mode}\n` : "";
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Identidade do material revisado: par base/head, árvores, lista completa com status/modos/blobs e o digest dos bytes
// efetivamente revisados (diff). Nada aqui depende da ordem ou do conteúdo mutável da lista /pulls/N/files.
export function computeIdentity({ baseSha, headSha, baseTreeSha, treeSha, changes, diff }) {
  const list = changes.map((change) => ({
    path: change.path,
    status: change.status,
    baseMode: change.baseMode ?? null,
    headMode: change.headMode ?? null,
    baseBlob: change.baseBlob ?? null,
    headBlob: change.headBlob ?? null
  })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const blobs = Object.fromEntries(list.filter((item) => item.headBlob).map((item) => [item.path, item.headBlob]));
  const canonical = { baseSha, headSha, baseTreeSha, treeSha, changes: list, diffSha256: sha256(diff) };
  return { ...canonical, blobs, digest: sha256(JSON.stringify(canonical)) };
}

// Consulta nova e completa do estado do PR, ancorada em objetos imutáveis (commit, árvore e blobs).
// base.sha só é aceito se o PR mira a branch protegida autorizada, ainda protegida, e se base.sha pertence ao seu histórico.
async function authorizeBase({ repo, pr, baseSha, protectedBranch, token, fetchImpl }) {
  if (typeof protectedBranch !== "string" || !/^[A-Za-z0-9._\/-]+$/.test(protectedBranch)) throw new Error("branch protegida autorizada ausente");
  if (pr.base?.ref !== protectedBranch || pr.base?.repo?.full_name !== repo) throw new Error("base do PR não autorizada");
  const api = `https://api.github.com/repos/${repo}`;
  const branch = await githubJson(`${api}/branches/${encodeURIComponent(protectedBranch)}`, token, fetchImpl);
  if (branch.protected !== true || !SHA_PATTERN.test(branch.commit?.sha ?? "")) throw new Error("branch autorizada não está protegida");
  const comparison = await githubJson(`${api}/compare/${baseSha}...${branch.commit.sha}`, token, fetchImpl);
  if (!["identical", "ahead"].includes(comparison.status)) throw new Error("base.sha fora do histórico da branch protegida");
}

// Leituras do PR são mutáveis (head pode ir A -> B -> A). Cada fronteira entre etapas relê e exige o mesmo par e a
// mesma contagem; qualquer leitura divergente invalida o material, mesmo que uma leitura posterior volte ao SHA original.
async function assertPrStable({ root, pr, baseSha, headSha, token, fetchImpl }) {
  const again = await githubJson(root, token, fetchImpl);
  if (again.head?.sha !== headSha || again.base?.sha !== baseSha || again.changed_files !== pr.changed_files) {
    throw new Error("SHA do PR mudou durante a materialização (head não é mais o avaliado)");
  }
}

// SEMÂNTICA DO PAR (spec 3): o material é a diferença DIRETA entre as árvores de base.sha e head.sha, não merge-base.
// Se /pulls/N/files (que o GitHub calcula contra o merge-base) divergir dessa diferença direta, o material é
// inconclusivo e bloqueante; nunca se troca silenciosamente para merge-base nem se aceita patch de outra base.
export async function fetchPullState({ repo, prNumber, baseSha, headSha, protectedBranch, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isInteger(prNumber) || prNumber < 1 || !token) {
    throw new Error("repositório, PR ou token inválido");
  }
  const root = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  const pr = await githubJson(root, token, fetchImpl);
  if (pr.base?.sha !== baseSha || pr.head?.sha !== headSha) throw new Error("SHA do PR diverge do evento");
  const stable = () => assertPrStable({ root, pr, baseSha, headSha, token, fetchImpl });
  await authorizeBase({ repo, pr, baseSha, protectedBranch, token, fetchImpl });
  if (!Number.isInteger(pr.changed_files) || pr.changed_files < 1 || pr.changed_files > MAX_FILES) {
    throw new Error("changed_files excede limite ou é inválido");
  }
  const files = [];
  for (let page = 1; files.length < pr.changed_files; page++) {
    const batch = await githubJson(`${root}/files?per_page=100&page=${page}`, token, fetchImpl);
    if (!Array.isArray(batch) || batch.length === 0 || page > MAX_FILES) throw new Error("changed_files diverge da lista paginada");
    files.push(...batch);
    if (files.length > pr.changed_files || files.length > MAX_FILES) throw new Error("changed_files diverge da lista paginada");
  }
  if (files.length !== pr.changed_files) throw new Error("changed_files diverge da lista paginada");
  preflightPaths(files);
  const listed = new Map();
  for (const file of files) {
    if (listed.has(file.filename)) throw new Error("caminho duplicado");
    if (!["added", "modified", "removed"].includes(file.status)) throw new Error(`status não suportado: ${file.filename}`);
    listed.set(file.filename, file);
  }
  await stable();
  const head = await loadTree(repo, headSha, token, fetchImpl);
  const base = await loadTree(repo, baseSha, token, fetchImpl);
  const changes = deriveChanges(base.entries, head.entries);
  // Lista do GitHub conferida CONTRA o derivado das árvores: caminho extra, omitido, status ou blob divergente reprova.
  for (const file of files) {
    const headEntry = head.entries.get(file.filename);
    const baseEntry = base.entries.get(file.filename);
    if (file.status === "removed" && headEntry) throw new Error("arquivo removido ainda presente no head");
    if (file.status === "added" && baseEntry) throw new Error("arquivo adicionado já existe na base");
    if (file.status !== "added" && !baseEntry) throw new Error("arquivo alterado ou removido ausente na base");
    const change = changes.find((item) => item.path === file.filename);
    if (!change) throw new Error("arquivo listado sem diferença nas árvores base/head");
    if (change.status !== file.status) throw new Error("status do arquivo diverge das árvores base/head");
    if (file.status !== "removed" && change.head.sha !== file.sha) throw new Error("blob do arquivo não pertence ao head avaliado");
  }
  if (changes.some((change) => !listed.has(change.path)) || changes.length !== pr.changed_files) {
    throw new Error("arquivo alterado nas árvores omitido da lista do PR; changed_files incoerente com as árvores");
  }
  await stable();
  const cache = new Map();
  const parts = [];
  for (const change of changes) {
    const file = listed.get(change.path);
    const header = modeHeader(change);
    if (change.head && change.base && change.head.sha === change.base.sha) {
      if (file.patch !== undefined || file.additions !== 0 || file.deletions !== 0 || file.changes !== 0) throw new Error(`patch inesperado em mudança somente de modo: ${change.path}`);
      // O conteúdo não vai ao modelo, mas o blob é conferido (hash Git, NUL, UTF-8): binário continua inconclusivo.
      await fetchVerifiedBlob(change.head.sha, repo, token, fetchImpl, cache);
      parts.push(`diff --git a/${change.path} b/${change.path}\n${header}`);
      continue;
    }
    const oldText = change.base ? await fetchVerifiedBlob(change.base.sha, repo, token, fetchImpl, cache) : "";
    const newText = change.head ? await fetchVerifiedBlob(change.head.sha, repo, token, fetchImpl, cache) : "";
    const patch = file.patch;
    if (patch === undefined) throw new Error(`patch ausente: ${change.path}`);
    if (containsSecret(patch)) throw new Error("padrão de segredo detectado no material; revisão bloqueada sem envio");
    completePatch({ filename: change.path, additions: file.additions, deletions: file.deletions, patch });
    if (applyPatch(oldText, patch, change.path) !== newText) throw new Error(`patch não reproduz o blob do head a partir do blob da base: ${change.path}`);
    const oldPath = change.status === "added" ? "/dev/null" : `a/${change.path}`;
    const newPath = change.status === "removed" ? "/dev/null" : `b/${change.path}`;
    parts.push(`diff --git a/${change.path} b/${change.path}\n${header}--- ${oldPath}\n+++ ${newPath}\n${patch}\n`);
  }
  await stable();
  const diff = parts.join("\n");
  if (containsSecret(diff)) throw new Error("padrão de segredo detectado no material; revisão bloqueada sem envio");
  if (Buffer.byteLength(diff, "utf8") > MAX_TOTAL_BYTES) throw new Error("diff excede limite de 1 MB; revisão manual necessária");
  const identity = computeIdentity({
    baseSha,
    headSha,
    baseTreeSha: base.treeSha,
    treeSha: head.treeSha,
    diff,
    changes: changes.map((change) => ({
      path: change.path,
      status: change.status,
      baseMode: change.base?.mode,
      headMode: change.head?.mode,
      baseBlob: change.base?.sha,
      headBlob: change.head?.sha
    }))
  });
  return { root, pr, files, head, base, changes, diff, identity };
}

export async function materializePullRequest(options) {
  const { repo, prNumber, baseSha, headSha } = options;
  const { diff, files, identity } = await fetchPullState(options);
  return { diff, meta: { repo, prNumber, baseSha, headSha, files: files.length, identity } };
}

// Gates determinísticos que precisam estar verdes no MESMO head antes de qualquer chamada à IA.
// O check da própria revisão estruturada nunca entra aqui: sem ciclo entre workflows.
export const REQUIRED_GATES = Object.freeze(["governance", "quality-gate"]);

export async function waitForGates({ repo, prNumber, baseSha, headSha, token, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 70, intervalMs = 30_000 }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "") || !Number.isSafeInteger(prNumber) || prNumber < 1 || !SHA_PATTERN.test(baseSha ?? "") || !SHA_PATTERN.test(headSha ?? "") || !token) {
    throw new Error("gates: repositório, PR, base, SHA ou token inválido");
  }
  const workflowPath = ".github/workflows/pr-gates.yml";
  const api = `https://api.github.com/repos/${repo}`;
  const [baseFile, headFile, workflow, pull] = await Promise.all([
    githubJson(`${api}/contents/${workflowPath}?ref=${baseSha}`, token, fetchImpl),
    githubJson(`${api}/contents/${workflowPath}?ref=${headSha}`, token, fetchImpl),
    githubJson(`${api}/actions/workflows/pr-gates.yml`, token, fetchImpl),
    githubJson(`${api}/pulls/${prNumber}`, token, fetchImpl)
  ]);
  if (pull.number !== prNumber || pull.head?.sha !== headSha || pull.base?.sha !== baseSha || pull.base?.ref !== "main") {
    throw new Error("gates: identidade do PR diverge do evento");
  }
  // Um candidato que modifica o workflow dos gates pode publicar checks homônimos.
  if (baseFile.type !== "file" || !SHA_PATTERN.test(baseFile.sha ?? "") || headFile.sha !== baseFile.sha ||
      workflow.path !== workflowPath || !Number.isSafeInteger(workflow.id) || workflow.state !== "active") {
    throw new Error("gates: workflow protegido não comprovado");
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const [data, runsData] = await Promise.all([
      githubJson(`${api}/commits/${headSha}/check-runs?per_page=100`, token, fetchImpl),
      githubJson(`${api}/actions/workflows/${workflow.id}/runs?head_sha=${headSha}&event=pull_request&per_page=100`, token, fetchImpl)
    ]);
    if (!Array.isArray(data.check_runs) || data.total_count > data.check_runs.length) throw new Error("gates: lista de checks incompleta");
    if (!Array.isArray(runsData.workflow_runs) || runsData.total_count > runsData.workflow_runs.length) throw new Error("gates: lista de workflows incompleta");
    const matchingRuns = runsData.workflow_runs.filter((item) => item.workflow_id === workflow.id &&
      item.path === workflowPath && item.event === "pull_request" && item.head_sha === headSha &&
      Number.isSafeInteger(item.check_suite_id) && Number.isSafeInteger(item.id) &&
      Array.isArray(item.pull_requests) && item.pull_requests.some((linked) => linked.number === prNumber &&
        linked.head?.sha === headSha && linked.base?.sha === baseSha));
    const latestRun = matchingRuns.sort((a, b) => b.id - a.id)[0];
    if (latestRun?.status === "completed" && latestRun.conclusion !== "success") throw new Error("gates não aprovados antes da IA");
    let pending = !latestRun || latestRun.status !== "completed";
    for (const gate of REQUIRED_GATES) {
      const runs = data.check_runs.filter((item) => item.name === gate);
      // O check deve pertencer à suite de um run do workflow protegido, além de ter nome e SHA esperados.
      const latest = runs.filter((item) => item.head_sha === headSha && item.app?.slug === "github-actions" &&
        item.check_suite?.id === latestRun?.check_suite_id).sort((a, b) => b.id - a.id)[0];
      // Uma execução mais recente ainda pode não ter criado seus checks. Checks
      // de suites anteriores não a aprovam; aguardamos a suite atual até o prazo.
      if (!latest || latest.status !== "completed") {
        pending = true;
      } else if (latest.conclusion !== "success") {
        throw new Error("gates não aprovados antes da IA");
      }
    }
    if (!pending) return;
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error("gates do mesmo SHA não concluídos a tempo");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--verify-gates")) {
      await waitForGates({ repo: argument("--repo"), prNumber: Number(argument("--pr")), baseSha: argument("--base"), headSha: argument("--head"), token: process.env.GITHUB_TOKEN });
      process.stdout.write("Gates governance e quality-gate aprovados no mesmo SHA.\n");
      process.exit(0);
    }
    const output = argument("--output");
    const metaFile = argument("--meta");
    if (!output || !metaFile) throw new Error("--output e --meta são obrigatórios");
    const result = await materializePullRequest({
      repo: argument("--repo"),
      prNumber: Number(argument("--pr")),
      baseSha: argument("--base"),
      headSha: argument("--head"),
      protectedBranch: argument("--protected-base"),
      token: process.env.GITHUB_TOKEN
    });
    writeFileSync(output, result.diff, { flag: "wx", mode: 0o600 });
    writeFileSync(metaFile, `${JSON.stringify(result.meta)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`Diff integral materializado: ${result.meta.files} arquivos.\n`);
  } catch (error) {
    const failureClass = writeFailureClass(error);
    process.stderr.write(`Revisão inconclusiva (${failureClass}): ${FAILURE_MESSAGES[failureClass]}\n`);
    process.exitCode = 1;
  }
}
