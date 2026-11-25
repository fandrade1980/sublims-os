import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { REQUIRED_GATES, materializePullRequest, waitForGates } from "./materialize-diff.mjs";

// Blobs reais: o hash Git ("blob <len>\0"+bytes) de cada conteúdo é o SHA usado nas árvores e na lista.
const gitSha = (content) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
const blobBody = (content) => ({ encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) });
const blobA = gitSha("new\n");
const blobBase = gitSha("old\n");
const DEFAULT_BLOBS = { [blobA]: blobBody("new\n"), [blobBase]: blobBody("old\n") };

const pr = { number: 7, changed_files: 1, base: { sha: "a".repeat(40), ref: "main", repo: { full_name: "owner/repo" } }, head: { sha: "b".repeat(40) } };
const file = { filename: "src/a.js", status: "modified", sha: blobA, additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-old\n+new" };
const args = { repo: "owner/repo", prNumber: 7, baseSha: pr.base.sha, headSha: pr.head.sha, token: "test", protectedBranch: "main" };

// Mock de compatibilidade: deriva as árvores a partir dos arquivos informados (base "old\n" -> head "new\n").
function githubFetch(prData, pages) {
  const all = pages.flat();
  const headTree = all.filter((f) => f.status !== "removed").map((f) => ({ path: f.filename, mode: "100644", type: "blob", sha: f.sha }));
  const baseTree = all.filter((f) => f.status !== "added").map((f) => ({ path: f.filename, mode: "100644", type: "blob", sha: blobBase }));
  return richApi({ prs: [prData], pages, headTree, baseTree }).fetchImpl;
}

test("materializa diff completo e vinculado ao SHA do evento", async () => {
  const result = await materializePullRequest({ ...args, fetchImpl: githubFetch(pr, [[file]]) });
  assert.match(result.diff, /-old\n\+new/);
  assert.equal(result.meta.headSha, args.headSha);
});

test("reprova patch ausente ou truncado", async () => {
  await assert.rejects(materializePullRequest({ ...args, fetchImpl: githubFetch(pr, [[{ ...file, patch: undefined }]]) }), /patch ausente/);
  await assert.rejects(materializePullRequest({ ...args, fetchImpl: githubFetch(pr, [[{ ...file, patch: "@@ -1 +1 @@\n-old" }]]) }), /incompleto/);
});

test("reprova contagem incompleta de arquivos e SHA alterado", async () => {
  await assert.rejects(materializePullRequest({ ...args, fetchImpl: githubFetch({ ...pr, changed_files: 2 }, [[file]]) }), /changed_files/);
  await assert.rejects(materializePullRequest({ ...args, fetchImpl: githubFetch({ ...pr, head: { sha: "c".repeat(40) } }, [[file]]) }), /SHA/);
});

test("reprova binário sem patch e arquivo renomeado", async () => {
  await assert.rejects(materializePullRequest({ ...args, fetchImpl: githubFetch(pr, [[{ ...file, patch: undefined, filename: "img/a.png" }]]) }), /patch ausente/);
  await assert.rejects(materializePullRequest({ ...args, fetchImpl: githubFetch(pr, [[{ ...file, status: "renamed" }]]) }), /status/);
});

test("arquivo adicionado sem patch também reprova, mesmo com blob íntegro", async () => {
  const content = "new\n";
  const sha = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
  const added = { filename: "src/new.js", status: "added", additions: 1, deletions: 0, changes: 1, sha };
  const blobBody = { encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) };
  const fetchImpl = richApi({ files: [added], headTree: [{ path: "src/new.js", mode: "100644", type: "blob", sha }], baseTree: [], blobs: { [sha]: blobBody } }).fetchImpl;
  await assert.rejects(materializePullRequest({ ...args, fetchImpl }), /patch ausente/);
});

// ---------- API rica (F2 em diante): PR, commits, árvores, branch protegida, comparação ----------
const HEAD_TREE = "d".repeat(40);
const BASE_TREE = "e".repeat(40);

function richApi(options = {}) {
  const prs = options.prs ?? [pr];
  const tracked = { calls: [], prGets: 0 };
  const pages = options.pages ?? [options.files ?? [{ ...file, sha: blobA }]];
  const headTree = options.headTree ?? [{ path: "src/a.js", mode: "100644", type: "blob", sha: blobA }];
  const baseTree = options.baseTree ?? [{ path: "src/a.js", mode: "100644", type: "blob", sha: blobBase }];
  const branch = options.branch ?? { name: "main", protected: true, commit: { sha: pr.base.sha } };
  const compare = options.compare ?? { status: "identical" };
  const respond = (value) => ({ ok: true, json: async () => value });
  const fetchImpl = async (url) => {
    tracked.calls.push(url);
    if (url.endsWith("/pulls/7")) return respond(prs[Math.min(tracked.prGets++, prs.length - 1)]);
    if (url.includes("/pulls/7/files")) return respond(pages[Number(new URL(url).searchParams.get("page")) - 1] ?? []);
    if (url.includes("/git/commits/")) {
      const sha = url.split("/").pop();
      return respond({ sha, tree: { sha: sha === pr.base.sha ? BASE_TREE : HEAD_TREE } });
    }
    if (url.includes("/git/trees/")) {
      const sha = url.split("/trees/")[1].split("?")[0];
      return respond({ sha, truncated: options.truncated ?? false, tree: sha === BASE_TREE ? baseTree : headTree });
    }
    if (url.includes("/branches/")) return respond(branch);
    if (url.includes("/compare/")) return respond(compare);
    if (url.includes("/git/blobs/")) {
      const body = { ...DEFAULT_BLOBS, ...options.blobs }[url.split("/").pop()];
      if (body) return respond(body);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, tracked };
}

const baseArgs = { ...args, protectedBranch: "main" };

// ---------- F2: diff ancorado em árvore e blobs imutáveis ----------
test("F2: expõe identidade (head, árvore, blobs) derivada de objetos imutáveis", async () => {
  const mock = richApi();
  const result = await materializePullRequest({ ...baseArgs, fetchImpl: mock.fetchImpl });
  assert.equal(result.meta.identity.headSha, pr.head.sha);
  assert.equal(result.meta.identity.treeSha, HEAD_TREE);
  assert.deepEqual(result.meta.identity.blobs, { "src/a.js": blobA });
  assert.match(result.meta.identity.digest, /^[0-9a-f]{64}$/);
});

test("F2: A→B→A com mesmo conteúdo mas outra identidade de commit reprova", async () => {
  const headAPrime = { ...pr, head: { sha: "f".repeat(40) } };
  const mock = richApi({ prs: [pr, headAPrime] });
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: mock.fetchImpl }), /head.*mudou|SHA do PR mudou/);
});

test("F2: blob estranho ao head reprova", async () => {
  const mock = richApi({ files: [{ ...file, sha: "9".repeat(40) }] });
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: mock.fetchImpl }), /blob.*head/);
});

test("F2: arquivo removido ainda presente no head reprova", async () => {
  const removed = { ...file, status: "removed", sha: blobBase, additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-old" };
  const mock = richApi({ files: [removed] });
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: mock.fetchImpl }), /removido.*head|head.*removido/);
});

test("F2: árvore truncada reprova em vez de ancorar parcialmente", async () => {
  const mock = richApi({ truncated: true });
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: mock.fetchImpl }), /truncada/);
});

// ---------- F4: modos e tipos de arquivo preservados ou recusados ----------
const entry = (path, mode, sha = blobA, type = "blob") => ({ path, mode, type, sha });

// ---------- F2 (rodada 2): conjunto completo de diferenças derivado das árvores, hunks conferidos contra blobs ----------
// Semântica do par: diferença DIRETA entre as árvores de base.sha e head.sha (não merge-base).
test("F2r2: patch de OUTRA base com SHA correto do blob do head reprova", async () => {
  const wrongBase = { ...file, patch: "@@ -1 +1 @@\n-zzz\n+new" };
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ files: [wrongBase] }).fetchImpl }), /patch não corresponde aos blobs/);
  const wrongTarget = { ...file, patch: "@@ -1 +1 @@\n-old\n+outro" };
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ files: [wrongTarget] }).fetchImpl }), /patch não (corresponde|reproduz)/);
});

test("F2r2: caminho alterado nas árvores e omitido da lista reprova; caminho extra sem diferença reprova", async () => {
  const otherNew = gitSha("x\n");
  const trees = {
    headTree: [entry("src/a.js", "100644", blobA), entry("src/b.js", "100644", otherNew)],
    baseTree: [entry("src/a.js", "100644", blobBase), entry("src/b.js", "100644", blobBase)],
    blobs: { [otherNew]: blobBody("x\n") }
  };
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ ...trees }).fetchImpl }), /omitido da lista/);
  const same = { ...trees, headTree: [entry("src/a.js", "100644", blobA), entry("src/b.js", "100644", blobBase)] };
  const extra = { ...file, filename: "src/b.js", sha: blobBase };
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ ...same, files: [file, extra], prs: [{ ...pr, changed_files: 2 }] }).fetchImpl }), /sem diferença/);
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ ...same, prs: [{ ...pr, changed_files: 2 }] }).fetchImpl }), /changed_files/);
});

test("F2r2: mudança somente de modo omitida da lista reprova e altera a identidade", async () => {
  const trees = (mode) => ({ headTree: [entry("src/a.js", "100644", blobA), entry("bin/x", mode, blobA)], baseTree: [entry("src/a.js", "100644", blobBase), entry("bin/x", "100644", blobA)] });
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi(trees("100755")).fetchImpl }), /omitido da lista/);
  const modeOnly = { filename: "bin/x", status: "modified", sha: blobA, additions: 0, deletions: 0, changes: 0 };
  const two = (mode) => richApi({ ...trees(mode), files: [file, modeOnly], prs: [{ ...pr, changed_files: 2 }] }).fetchImpl;
  const withMode = await materializePullRequest({ ...baseArgs, fetchImpl: two("100755") });
  assert.match(withMode.diff, /old mode 100644\nnew mode 100755/);
  const noMode = await materializePullRequest({ ...baseArgs, fetchImpl: richApi().fetchImpl });
  assert.notEqual(withMode.meta.identity.digest, noMode.meta.identity.digest);
  const withPatch = { ...modeOnly, patch: "@@ -1 +1 @@\n-new\n+new", additions: 1, deletions: 1, changes: 2 };
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ ...trees("100755"), files: [file, withPatch], prs: [{ ...pr, changed_files: 2 }] }).fetchImpl }), /patch inesperado/);
});

test("F2r2: A->B->A em leituras mutáveis do PR reprova em qualquer fronteira entre etapas", async () => {
  const headB = { ...pr, head: { sha: "f".repeat(40) } };
  for (const position of [1, 2, 3]) {
    const sequence = [pr, pr, pr, pr, pr];
    sequence[position] = headB;
    await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ prs: sequence }).fetchImpl }), /SHA do PR mudou/, `B na leitura ${position}`);
  }
  const countChanged = [pr, pr, { ...pr, changed_files: 2 }, pr];
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ prs: countChanged }).fetchImpl }), /SHA do PR mudou/);
});

test("F2r2: identidade amarra base, árvores, lista completa, modos e bytes revisados", async () => {
  const { identity } = (await materializePullRequest({ ...baseArgs, fetchImpl: richApi().fetchImpl })).meta;
  assert.equal(identity.baseSha, pr.base.sha);
  assert.equal(identity.baseTreeSha, BASE_TREE);
  assert.deepEqual(identity.changes, [{ path: "src/a.js", status: "modified", baseMode: "100644", headMode: "100644", baseBlob: blobBase, headBlob: blobA }]);
  assert.match(identity.diffSha256, /^[0-9a-f]{64}$/);
});

test("F2r2: BOM e CRLF são preservados; UTF-8 inválido e binário são recusados sem normalização", async () => {
  const bom = "﻿a\r\n";
  const bomSha = gitSha(bom);
  const added = { filename: "src/bom.txt", status: "added", sha: bomSha, additions: 1, deletions: 0, changes: 1, patch: `@@ -0,0 +1 @@\n+${bom.slice(0, -1)}` };
  const ok = await materializePullRequest({ ...baseArgs, fetchImpl: richApi({ files: [added], headTree: [entry("src/bom.txt", "100644", bomSha)], baseTree: [], blobs: { [bomSha]: blobBody(bom) } }).fetchImpl });
  assert.ok(ok.diff.includes("+﻿a\r\n") || ok.diff.includes("+﻿a\r"));
  const bad = Buffer.from([0xff, 0xfe, 0x41, 0x0a]);
  const badSha = createHash("sha1").update(`blob ${bad.length}\0`).update(bad).digest("hex");
  const rawBody = { encoding: "base64", content: bad.toString("base64"), size: bad.length };
  const invalid = { ...added, sha: badSha };
  const run = (extra) => materializePullRequest({ ...baseArgs, fetchImpl: richApi({ files: [invalid], headTree: [entry("src/bom.txt", "100644", badSha)], baseTree: [], blobs: { [badSha]: rawBody }, ...extra }).fetchImpl });
  await assert.rejects(run(), /UTF-8/);
  const nul = Buffer.from([0x41, 0x00, 0x0a]);
  const nulSha = createHash("sha1").update(`blob ${nul.length}\0`).update(nul).digest("hex");
  const nulBody = { encoding: "base64", content: nul.toString("base64"), size: nul.length };
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ files: [{ ...added, sha: nulSha }], headTree: [entry("src/bom.txt", "100644", nulSha)], baseTree: [], blobs: { [nulSha]: nulBody } }).fetchImpl }), /binário/);
});

test("F4: symlink, submódulo e tipo desconhecido no head são recusados, nunca achatados", async () => {
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ headTree: [entry("src/a.js", "120000")] }).fetchImpl }), /tipo ou modo.*não suportado/);
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ headTree: [entry("src/a.js", "160000", blobA, "commit")] }).fetchImpl }), /tipo ou modo.*não suportado/);
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ headTree: [entry("src/a.js", "100664")] }).fetchImpl }), /tipo ou modo.*não suportado/);
});

test("F4: mudança de tipo na base (arquivo comum virando symlink e inverso) é recusada", async () => {
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ baseTree: [entry("src/a.js", "120000", blobBase)] }).fetchImpl }), /tipo ou modo.*não suportado/);
});

test("F4: arquivo executável novo preserva o modo no material", async () => {
  const runSha = gitSha("echo ok\n");
  const added = { filename: "bin/run.sh", status: "added", sha: runSha, additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+echo ok" };
  const api = richApi({ files: [added], headTree: [entry("bin/run.sh", "100755", runSha)], baseTree: [], blobs: { [runSha]: blobBody("echo ok\n") } });
  const result = await materializePullRequest({ ...baseArgs, fetchImpl: api.fetchImpl });
  assert.match(result.diff, /new file mode 100755/);
});

test("F4: mudança de modo 100644 para 100755 é preservada, inclusive sem patch", async () => {
  const modeOnly = { ...file, sha: blobA, additions: 0, deletions: 0, changes: 0, patch: undefined };
  const api = richApi({ files: [modeOnly], headTree: [entry("src/a.js", "100755", blobA)], baseTree: [entry("src/a.js", "100644", blobA)] });
  const result = await materializePullRequest({ ...baseArgs, fetchImpl: api.fetchImpl });
  assert.match(result.diff, /old mode 100644\nnew mode 100755/);
  const withContent = richApi({ headTree: [entry("src/a.js", "100755", blobA)] });
  assert.match((await materializePullRequest({ ...baseArgs, fetchImpl: withContent.fetchImpl })).diff, /old mode 100644\nnew mode 100755/);
});

test("F4r3: mudança somente de modo em blob binário ou não-UTF-8 é recusada; texto confere o blob sem enviá-lo", async () => {
  const modeOnlyApi = (bytes) => {
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const listed = { filename: "bin/x", status: "modified", sha, additions: 0, deletions: 0, changes: 0 };
    const body = { encoding: "base64", content: Buffer.from(bytes).toString("base64"), size: bytes.length };
    return richApi({ files: [listed], headTree: [entry("bin/x", "100755", sha)], baseTree: [entry("bin/x", "100644", sha)], blobs: { [sha]: body } });
  };
  const blobGets = (mock) => mock.tracked.calls.filter((url) => url.includes("/git/blobs/")).length;
  const binary = modeOnlyApi(Buffer.from([0, 1, 2, 3]));
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: binary.fetchImpl }), /binário/);
  assert.ok(blobGets(binary) >= 1, "o blob precisa ser conferido mesmo sem patch");
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: modeOnlyApi(Buffer.from([0xff, 0xfe, 0x41, 0x0a])).fetchImpl }), /UTF-8/);
  const text = modeOnlyApi(Buffer.from("echo ok\n"));
  const result = await materializePullRequest({ ...baseArgs, fetchImpl: text.fetchImpl });
  assert.match(result.diff, /old mode 100644\nnew mode 100755/);
  assert.doesNotMatch(result.diff, /echo ok/);
  assert.equal(blobGets(text), 1);
  const bom = modeOnlyApi(Buffer.from("﻿a\r\n"));
  assert.match((await materializePullRequest({ ...baseArgs, fetchImpl: bom.fetchImpl })).diff, /new mode 100755/);
});

test("F4: arquivo sem patch e sem mudança de modo continua reprovado", async () => {
  const bare = { ...file, sha: blobA, additions: 0, deletions: 0, changes: 0, patch: undefined };
  const api = richApi({ files: [bare], baseTree: [entry("src/a.js", "100644", blobBase)] });
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: api.fetchImpl }), /patch ausente/);
});

test("F4: arquivo removido preserva o modo anterior e modificado ausente na base reprova", async () => {
  const removed = { ...file, status: "removed", sha: blobBase, additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-old" };
  const ok = richApi({ files: [removed], headTree: [], baseTree: [entry("src/a.js", "100755", blobBase)] });
  assert.match((await materializePullRequest({ ...baseArgs, fetchImpl: ok.fetchImpl })).diff, /deleted file mode 100755/);
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ baseTree: [] }).fetchImpl }), /ausente na base/);
});

// ---------- F3: base.sha só vale se a base for a branch protegida autorizada ----------
test("F3: PR contra base que não é a branch protegida autorizada reprova", async () => {
  const other = { ...pr, base: { ...pr.base, ref: "feature/x" } };
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ prs: [other] }).fetchImpl }), /base.*não autorizada/);
});

test("F3: branch autorizada sem proteção ativa reprova", async () => {
  const branch = { name: "main", protected: false, commit: { sha: pr.base.sha } };
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ branch }).fetchImpl }), /protegid/);
});

test("F3: base.sha fora do histórico da branch protegida reprova", async () => {
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ compare: { status: "diverged" } }).fetchImpl }), /histórico/);
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ compare: { status: "behind" } }).fetchImpl }), /histórico/);
});

test("F3: base de outro repositório reprova e ponta à frente do base.sha é aceita", async () => {
  const foreign = { ...pr, base: { ...pr.base, repo: { full_name: "evil/repo" } } };
  await assert.rejects(materializePullRequest({ ...baseArgs, fetchImpl: richApi({ prs: [foreign] }).fetchImpl }), /base.*não autorizada/);
  const ok = await materializePullRequest({ ...baseArgs, fetchImpl: richApi({ compare: { status: "ahead" } }).fetchImpl });
  assert.equal(ok.meta.baseSha, pr.base.sha);
});

test("F3: branch protegida autorizada é obrigatória", async () => {
  await assert.rejects(materializePullRequest({ ...args, protectedBranch: undefined, fetchImpl: richApi().fetchImpl }), /branch protegida/);
});

// ---------- F8: prova dos gates do MESMO SHA antes da IA ----------
const run = (name, overrides = {}) => ({ id: 1, name, head_sha: pr.head.sha, status: "completed", conclusion: "success", app: { slug: "github-actions" }, check_suite: { id: 9 }, ...overrides });

function checksApi(sequence, { provenance = true, headFileSha = "c".repeat(40), workflowRuns } = {}) {
  let polls = 0;
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes("/contents/.github/workflows/pr-gates.yml")) {
      return { ok: true, json: async () => ({ type: "file", sha: url.includes(`ref=${pr.base.sha}`) ? "c".repeat(40) : headFileSha }) };
    }
    if (url.endsWith("/actions/workflows/pr-gates.yml")) {
      return { ok: true, json: async () => ({ id: 3, path: ".github/workflows/pr-gates.yml", state: "active" }) };
    }
    if (url.includes("/actions/workflows/3/runs")) {
      const runs = workflowRuns ?? (provenance ? [{ id: 4, workflow_id: 3, path: ".github/workflows/pr-gates.yml", event: "pull_request", head_sha: pr.head.sha, check_suite_id: 9, status: "completed", conclusion: "success", pull_requests: [{ number: pr.number, head: { sha: pr.head.sha }, base: { sha: pr.base.sha } }] }] : []);
      return { ok: true, json: async () => ({ total_count: runs.length, workflow_runs: runs }) };
    }
    if (url.endsWith("/pulls/7")) return { ok: true, json: async () => pr };
    const runs = sequence[Math.min(polls++, sequence.length - 1)];
    return { ok: true, json: async () => ({ total_count: runs.length, check_runs: runs }) };
  };
  return { fetchImpl, urls };
}
const gateArgs = { repo: "owner/repo", prNumber: 7, baseSha: pr.base.sha, headSha: pr.head.sha, token: "test", sleep: async () => {}, attempts: 3 };

test("F8: aprova quando governance e quality-gate do mesmo SHA concluíram com sucesso", async () => {
  const api = checksApi([[run("governance"), run("quality-gate", { id: 2 })]]);
  await waitForGates({ ...gateArgs, fetchImpl: api.fetchImpl });
  assert.ok(api.urls.some((url) => url.includes(`/commits/${pr.head.sha}/check-runs`)));
});

test("F8: check homônimo sem proveniência de workflow protegido não libera a IA", async () => {
  // Um workflow controlado pelo candidato pode publicar nomes iguais pelo mesmo app.
  // Este mock oferece só check-runs; não oferece um workflow-run vinculável.
  const api = checksApi([[run("governance"), run("quality-gate", { id: 2 })]], { provenance: false });
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: api.fetchImpl }), /gates/);
});

test("F8: run verde de outro PR no mesmo head não libera este PR", async () => {
  const other = { id: 4, workflow_id: 3, path: ".github/workflows/pr-gates.yml", event: "pull_request", head_sha: pr.head.sha, check_suite_id: 9, status: "completed", conclusion: "success", pull_requests: [{ number: 8, head: { sha: pr.head.sha }, base: { sha: pr.base.sha } }] };
  const api = checksApi([[run("governance"), run("quality-gate", { id: 2 })]], { workflowRuns: [other] });
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: api.fetchImpl }), /não concluídos a tempo/);
});

test("F8: run do mesmo PR sobre outra base não libera este PR", async () => {
  const oldBase = { id: 4, workflow_id: 3, path: ".github/workflows/pr-gates.yml", event: "pull_request", head_sha: pr.head.sha, check_suite_id: 9, status: "completed", conclusion: "success", pull_requests: [{ number: pr.number, head: { sha: pr.head.sha }, base: { sha: "f".repeat(40) } }] };
  const api = checksApi([[run("governance"), run("quality-gate", { id: 2 })]], { workflowRuns: [oldBase] });
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: api.fetchImpl }), /não concluídos a tempo/);
});

test("F8: workflow de gates alterado pelo candidato não libera a IA", async () => {
  const api = checksApi([[run("governance"), run("quality-gate", { id: 2 })]], { headFileSha: "d".repeat(40) });
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: api.fetchImpl }), /workflow protegido/);
});

test("F8: dois checks de suites distintas não compõem aprovação", async () => {
  const api = checksApi([[run("governance"), run("quality-gate", { id: 2, check_suite: { id: 8 } })]]);
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: api.fetchImpl }), /gates/);
});

test("F8: run mais recente fracassado prevalece sobre suite antiga aprovada", async () => {
  const prior = { id: 4, workflow_id: 3, path: ".github/workflows/pr-gates.yml", event: "pull_request", head_sha: pr.head.sha, check_suite_id: 9, status: "completed", conclusion: "success", pull_requests: [{ number: pr.number, head: { sha: pr.head.sha }, base: { sha: pr.base.sha } }] };
  const latest = { ...prior, id: 5, check_suite_id: 8, conclusion: "failure" };
  const api = checksApi([[run("governance"), run("quality-gate", { id: 2 })]], { workflowRuns: [prior, latest] });
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: api.fetchImpl }), /gates.*não aprovados/);
});

test("F8: checks antigos não aprovam nem abortam prematuramente um run novo pendente", async () => {
  const prior = { id: 4, workflow_id: 3, path: ".github/workflows/pr-gates.yml", event: "pull_request", head_sha: pr.head.sha, check_suite_id: 9, status: "completed", conclusion: "success", pull_requests: [{ number: pr.number, head: { sha: pr.head.sha }, base: { sha: pr.base.sha } }] };
  const pending = { ...prior, id: 5, check_suite_id: 10, status: "in_progress", conclusion: null };
  const api = checksApi([[run("governance"), run("quality-gate", { id: 2 })]], { workflowRuns: [prior, pending] });
  await assert.rejects(waitForGates({ ...gateArgs, attempts: 2, fetchImpl: api.fetchImpl }), /não concluídos a tempo/);
  assert.equal(api.urls.filter((url) => url.includes("/check-runs?")).length, 2);
});

test("F8: espera gate pendente e aprova quando conclui", async () => {
  const api = checksApi([[run("governance")], [run("governance"), run("quality-gate", { id: 2, status: "in_progress", conclusion: null })], [run("governance"), run("quality-gate", { id: 2 })]]);
  await waitForGates({ ...gateArgs, fetchImpl: api.fetchImpl });
  assert.equal(api.urls.filter((url) => url.includes("/check-runs?")).length, 3);
});

test("F8: gate ausente após esgotar tentativas reprova", async () => {
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: checksApi([[run("governance")]]).fetchImpl }), /gates.*não concluídos/);
});

test("F8: gate com falha, SHA diferente ou origem diferente reprova imediatamente", async () => {
  const good = run("quality-gate", { id: 2 });
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: checksApi([[run("governance", { conclusion: "failure" }), good]]).fetchImpl }), /gates.*não aprovados/);
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: checksApi([[run("governance", { head_sha: "c".repeat(40) }), good]]).fetchImpl }), /gates/);
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: checksApi([[run("governance", { app: { slug: "outro" } }), good]]).fetchImpl }), /gates/);
});

test("F8: execução mais recente do gate prevalece sobre uma antiga aprovada", async () => {
  const runs = [run("governance", { id: 1 }), run("governance", { id: 5, conclusion: "failure" }), run("quality-gate", { id: 2 })];
  await assert.rejects(waitForGates({ ...gateArgs, fetchImpl: checksApi([runs]).fetchImpl }), /gates.*não aprovados/);
});

test("F8: o gate de revisão estruturada nunca é pré-requisito dele mesmo (sem ciclo)", () => {
  assert.deepEqual([...REQUIRED_GATES].sort(), ["governance", "quality-gate"]);
});

// ---------- F1: preflight de caminhos e segredos antes de qualquer chamada adicional ----------
const fakeKey = () => "sk-ant-" + "x9".repeat(20);

function recordingFetch(prData, pages) {
  const urls = [];
  const inner = githubFetch(prData, pages);
  const fetchImpl = async (url, options) => {
    urls.push(url);
    if (url.includes("/git/blobs/")) return { ok: true, json: async () => ({}) };
    return inner(url, options);
  };
  return { fetchImpl, urls };
}

test("F1: caminho proibido bloqueia antes de buscar qualquer blob", async () => {
  const content = "new\n";
  const sha = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
  const added = { filename: "src/new.js", status: "added", additions: 1, deletions: 0, changes: 1, sha };
  const env = { ...file, filename: ".env", patch: "@@ -1 +1 @@\n-a\n+b" };
  const mock = recordingFetch({ ...pr, changed_files: 2 }, [[added, env]]);
  await assert.rejects(materializePullRequest({ ...args, fetchImpl: mock.fetchImpl }), /caminho proibido/);
  assert.equal(mock.urls.filter((url) => url.includes("/git/blobs/")).length, 0);
});

test("F1: classes de caminho proibido e inseguro são recusadas sem eco do caminho", async () => {
  const bad = [".env", ".env.production", "config/.env", "id_rsa", "keys/server.pem", "a.key", "db/backup.sql", "x.dump", ".npmrc", ".envrc", "app/.pypirc", ".git-credentials", "infra/terraform.tfstate", "vault.kdbx", "/etc/passwd", "../x", "a\\b", "a/../b"];
  for (const filename of bad) {
    const mock = recordingFetch(pr, [[{ ...file, filename }]]);
    await assert.rejects(materializePullRequest({ ...args, fetchImpl: mock.fetchImpl }), (error) => {
      assert.match(error.message, /caminho (proibido|inválido)/);
      assert.ok(!error.message.includes(filename), `mensagem ecoa o caminho ${filename}`);
      return true;
    });
  }
  const ok = await materializePullRequest({ ...args, fetchImpl: githubFetch(pr, [[{ ...file, filename: ".env.example" }]]) });
  assert.match(ok.diff, /\.env\.example/);
});

test("F1: padrão de segredo no material bloqueia sem vazar o valor", async () => {
  const secret = fakeKey();
  const leaked = { ...file, patch: `@@ -1 +1 @@\n-old\n+key=${secret}` };
  await assert.rejects(materializePullRequest({ ...args, fetchImpl: githubFetch(pr, [[leaked]]) }), (error) => {
    assert.match(error.message, /segredo/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
