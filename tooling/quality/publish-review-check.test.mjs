import assert from "node:assert/strict";
import test from "node:test";
import { FAILURE_CLASSES, FAILURE_MESSAGES } from "./enforce-claude-review.mjs";
import { createHash } from "node:crypto";
import { materializePullRequest } from "./materialize-diff.mjs";
import { publishReviewCheck } from "./publish-review-check.mjs";

const headSha = "b".repeat(40);
const baseSha = "a".repeat(40);
const headTreeSha = "d".repeat(40);
const baseTreeSha = "e".repeat(40);
const gitSha = (content) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
const body = (content) => ({ encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) });
const blobSha = gitSha("new\n");
const oldSha = gitSha("old\n");
const blobs = { [blobSha]: body("new\n"), [oldSha]: body("old\n"), [gitSha("zzz\n")]: body("zzz\n") };
const review = { summary: "Sem bloqueadores.", critical_count: 0, findings: [] };
const listing = { filename: "src/a.js", status: "modified", sha: blobSha, additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-old\n+new" };
const prNow = (overrides = {}) => ({ changed_files: 1, head: { sha: headSha }, base: { sha: baseSha, ref: "main", repo: { full_name: "owner/repo" } }, ...overrides });
const args = { repo: "owner/repo", prNumber: 7, headSha, baseSha, token: "test", identity: undefined, protectedBranch: "main" };

// Mock da API do GitHub: PR, lista, commits/árvores base e head, blobs e criação do check.
function api(pr, extra = {}) {
  let posted;
  const prCalls = [];
  const fetchImpl = async (url, options) => {
    const respond = (value) => ({ ok: true, json: async () => value });
    if (url.endsWith("/pulls/7")) { prCalls.push(url); return respond(Array.isArray(pr) ? pr[Math.min(prCalls.length - 1, pr.length - 1)] : pr); }
    if (url.includes("/pulls/7/files")) return respond(url.includes("page=1") ? (extra.files ?? [listing]) : []);
    if (url.includes("/branches/")) return respond({ name: "main", protected: extra.protected ?? true, commit: { sha: baseSha } });
    if (url.includes("/compare/")) return respond({ status: "identical" });
    if (url.includes("/git/commits/")) return respond({ tree: { sha: url.endsWith(baseSha) ? baseTreeSha : headTreeSha } });
    if (url.includes(`/git/trees/${baseTreeSha}`)) return respond({ truncated: false, tree: extra.baseTree ?? [{ path: "src/a.js", mode: "100644", type: "blob", sha: oldSha }] });
    if (url.includes("/git/trees/")) return respond({ truncated: false, tree: extra.tree ?? [{ path: "src/a.js", mode: "100644", type: "blob", sha: blobSha }] });
    if (url.includes("/git/blobs/") && blobs[url.split("/").pop()]) return respond(blobs[url.split("/").pop()]);
    if (url.includes("/check-runs") && options?.method === "POST") { posted = JSON.parse(options.body); return respond({ id: 1 }); }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, posted: () => posted, prCalls };
}

// Identidade registrada pela preparação: gerada pela mesma materialização que o publisher refaz.
const registered = (await materializePullRequest({ ...args, fetchImpl: api(prNow()).fetchImpl })).meta.identity.digest;
args.identity = registered;

test("publica aprovação somente para parecer válido no SHA conferido", async () => {
  const mock = api(prNow());
  await publishReviewCheck({ ...args, verdict: { state: "approved", review }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().name, "claude-critical-review");
  assert.equal(mock.posted().head_sha, headSha);
  assert.equal(mock.posted().conclusion, "success");
});

test("gate não aprovado torna inconclusivo até um parecer aparentemente aprovado", async () => {
  const mock = api(prNow());
  const result = await publishReviewCheck({ ...args, verdict: { state: "approved", review }, gatesOutcome: "failure", gatesFailureClass: "gates_not_passed", fetchImpl: mock.fetchImpl });
  assert.equal(result.state, "inconclusive");
  assert.equal(mock.posted().conclusion, "failure");
  assert.match(mock.posted().output.summary, /^Causa: gates_not_passed/);
});

test("publica falha inconclusiva se SHA mudou", async () => {
  const mock = api(prNow({ head: { sha: "c".repeat(40) } }));
  await publishReviewCheck({ ...args, verdict: { state: "approved", review }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "failure");
  assert.match(mock.posted().output.summary, /SHA/);
});

test("parecer ausente ou contagem crítica divergente não aprova", async () => {
  const mock = api(prNow());
  await publishReviewCheck({ ...args, verdict: undefined, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "failure");
  await publishReviewCheck({ ...args, verdict: { state: "approved", review: { ...review, critical_count: 1 } }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "failure");
});

test("achado crítico publica evidência e bloqueia", async () => {
  const mock = api(prNow());
  const critical = { summary: "Falha", critical_count: 1, findings: [{ severity: "critical", title: "Segredo exposto", file: "src/a.js", line: 2, evidence: "valor publicado", recommendation: "Remover" }] };
  await publishReviewCheck({ ...args, verdict: { state: "critical", review: critical }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "failure");
  assert.match(mock.posted().output.summary, /src\/a\.js:2/);
});

// ---------- F2: identidade (head + árvore + blobs) comparada com consulta nova ----------
test("F2: aprova somente quando a identidade registrada coincide com a consulta nova", async () => {
  const mock = api(prNow());
  await publishReviewCheck({ ...args, verdict: { state: "approved", review }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "success");
});

test("F2: blob do head diferente do registrado reprova mesmo com mesmo head SHA aparente", async () => {
  const other = gitSha("zzz\n");
  const changed = { ...listing, sha: other, patch: "@@ -1 +1 @@\n-old\n+zzz" };
  const mock = api(prNow(), { tree: [{ path: "src/a.js", mode: "100644", type: "blob", sha: other }], files: [changed] });
  await publishReviewCheck({ ...args, verdict: { state: "approved", review }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "failure");
  assert.match(mock.posted().output.summary, /identidade/);
});

// Cada cenário reprovado na materialização precisa impedir aprovação no publisher, que rematerializa sem confiar no digest.
test("F2r2: publisher não aprova patch de outra base, caminho omitido, modo omitido nem A->B->A", async () => {
  const cases = {
    "patch de outra base": { files: [{ ...listing, patch: "@@ -1 +1 @@\n-zzz\n+new" }] },
    "caminho omitido": { tree: [{ path: "src/a.js", mode: "100644", type: "blob", sha: blobSha }, { path: "src/b.js", mode: "100644", type: "blob", sha: blobSha }], baseTree: [{ path: "src/a.js", mode: "100644", type: "blob", sha: oldSha }, { path: "src/b.js", mode: "100644", type: "blob", sha: oldSha }] },
    "modo omitido": { tree: [{ path: "src/a.js", mode: "100644", type: "blob", sha: blobSha }, { path: "bin/x", mode: "100755", type: "blob", sha: blobSha }], baseTree: [{ path: "src/a.js", mode: "100644", type: "blob", sha: oldSha }, { path: "bin/x", mode: "100644", type: "blob", sha: blobSha }] }
  };
  for (const [name, extra] of Object.entries(cases)) {
    const mock = api(prNow(), extra);
    await publishReviewCheck({ ...args, verdict: { state: "approved", review }, fetchImpl: mock.fetchImpl });
    assert.equal(mock.posted().conclusion, "failure", name);
    assert.equal(mock.posted().output.title, "Revisão inconclusiva", name);
  }
  const headB = prNow({ head: { sha: "c".repeat(40) } });
  for (const position of [1, 2, 3]) {
    const sequence = [prNow(), prNow(), prNow(), prNow(), prNow()];
    sequence[position] = headB;
    const mock = api(sequence);
    await publishReviewCheck({ ...args, verdict: { state: "approved", review }, fetchImpl: mock.fetchImpl });
    assert.equal(mock.posted().conclusion, "failure", `A->B->A na leitura ${position}`);
  }
});

test("F4r3: publisher não aprova mudança somente de modo em blob binário", async () => {
  const bytes = Buffer.from([0, 1, 2, 3]);
  const binSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const binBody = { encoding: "base64", content: bytes.toString("base64"), size: bytes.length };
  const modeOnly = { filename: "bin/x", status: "modified", sha: binSha, additions: 0, deletions: 0, changes: 0 };
  const mock = api(prNow({ changed_files: 2 }), {
    files: [listing, modeOnly],
    tree: [{ path: "src/a.js", mode: "100644", type: "blob", sha: blobSha }, { path: "bin/x", mode: "100755", type: "blob", sha: binSha }],
    baseTree: [{ path: "src/a.js", mode: "100644", type: "blob", sha: oldSha }, { path: "bin/x", mode: "100644", type: "blob", sha: binSha }]
  });
  const withBinary = async (url, options) => (url.endsWith(`/git/blobs/${binSha}`) ? { ok: true, json: async () => binBody } : mock.fetchImpl(url, options));
  await publishReviewCheck({ ...args, verdict: { state: "approved", review }, fetchImpl: withBinary });
  assert.equal(mock.posted().conclusion, "failure");
  assert.equal(mock.posted().output.title, "Revisão inconclusiva");
  assert.match(mock.posted().output.summary, /^Causa: diff_unavailable/);
});

test("F3: publisher recusa PR cuja base não é a branch protegida autorizada", async () => {
  const mock = api(prNow({ base: { sha: baseSha, ref: "feature/x", repo: { full_name: "owner/repo" } } }));
  await publishReviewCheck({ ...args, verdict: { state: "approved", review }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "failure");
  assert.match(mock.posted().output.summary, /base/);
});

test("F2: parecer aprovado sem identidade registrada nunca aprova", async () => {
  const mock = api(prNow());
  await publishReviewCheck({ ...args, identity: undefined, verdict: { state: "approved", review }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "failure");
  assert.match(mock.posted().output.summary, /identidade/);
});

// ---------- F5: falha técnica sanitizada, inconclusiva e bloqueante; nunca crítica ----------
test("F5: toda classe de falha técnica publica inconclusivo bloqueante, sem linguagem de achado crítico", async () => {
  for (const failure_class of FAILURE_CLASSES) {
    const mock = api(prNow());
    const result = await publishReviewCheck({ ...args, verdict: { state: "inconclusive", failure_class }, fetchImpl: mock.fetchImpl });
    assert.equal(result.state, "inconclusive", failure_class);
    assert.equal(mock.posted().conclusion, "failure", failure_class);
    assert.equal(mock.posted().output.title, "Revisão inconclusiva");
    assert.match(mock.posted().output.summary, new RegExp(`^Causa: ${failure_class}`));
    assert.ok(mock.posted().output.summary.includes(FAILURE_MESSAGES[failure_class]));
    assert.doesNotMatch(mock.posted().output.summary, /crítico|critical/i);
  }
});

test("F5: texto livre e segredo no veredito técnico nunca chegam ao check", async () => {
  const secret = "sk-ant-" + "x9".repeat(20);
  const mock = api(prNow());
  await publishReviewCheck({ ...args, verdict: { state: "inconclusive", reason: `falha ${secret}`, failure_class: `livre ${secret}` }, fetchImpl: mock.fetchImpl });
  const posted = JSON.stringify(mock.posted());
  assert.ok(!posted.includes(secret));
  assert.match(mock.posted().output.summary, /^Causa: unknown/);
});

test("F5: estado crítico sem parecer validado vira inconclusivo, nunca crítico", async () => {
  const mock = api(prNow());
  const result = await publishReviewCheck({ ...args, verdict: { state: "critical", failure_class: "model_unavailable" }, fetchImpl: mock.fetchImpl });
  assert.equal(result.state, "inconclusive");
  assert.equal(mock.posted().output.title, "Revisão inconclusiva");
});

// ---------- Item 4: rebaixamento descarta o relatório anterior ----------
test("item 4: aprovado ou crítico rebaixado por identidade/head/base não publica texto obsoleto", async () => {
  const stale = "ACHADO-OBSOLETO-XYZ";
  const approvedStale = { summary: `APROVACAO-OBSOLETA-XYZ`, critical_count: 0, findings: [{ severity: "high", title: stale, evidence: stale, recommendation: stale }] };
  const criticalStale = { summary: "RESUMO-OBSOLETO-XYZ", critical_count: 1, findings: [{ severity: "critical", title: stale, file: "src/a.js", evidence: stale, recommendation: stale }] };
  const other = gitSha("zzz\n");
  const changed = { files: [{ ...listing, sha: other, patch: "@@ -1 +1 @@\n-old\n+zzz" }], tree: [{ path: "src/a.js", mode: "100644", type: "blob", sha: other }] };
  const scenarios = {
    identity_changed: { mock: () => api(prNow(), changed), identity: undefined, expect: /identidade/ },
    identity_missing: { mock: () => api(prNow()), identity: "", expect: /identidade/ },
    head_changed: { mock: () => api(prNow({ head: { sha: "c".repeat(40) } })), identity: undefined, expect: /SHA/ },
    base_not_authorized: { mock: () => api(prNow({ base: { sha: baseSha, ref: "feature/x", repo: { full_name: "owner/repo" } } })), identity: undefined, expect: /base/ }
  };
  for (const [cls, scenario] of Object.entries(scenarios)) {
    for (const [state, review] of [["approved", approvedStale], ["critical", criticalStale]]) {
      const mock = scenario.mock();
      const result = await publishReviewCheck({ ...args, identity: scenario.identity ?? args.identity, verdict: { state, review }, fetchImpl: mock.fetchImpl });
      const posted = mock.posted();
      assert.equal(result.state, "inconclusive", `${cls}/${state}`);
      assert.equal(posted.conclusion, "failure");
      assert.equal(posted.output.title, "Revisão inconclusiva");
      assert.match(posted.output.summary, scenario.expect);
      assert.equal(posted.output.text, undefined, `${cls}/${state}: text obsoleto`);
      assert.doesNotMatch(JSON.stringify(posted), /OBSOLET|Nenhum achado crítico|aprovad/i, `${cls}/${state}`);
    }
  }
});

// ---------- F6: evidência e recomendação preservadas, sanitizadas e limitadas ----------
const criticalReview = (overrides = {}) => ({
  summary: "Falha",
  critical_count: 1,
  findings: [{ severity: "critical", title: "Segredo exposto", file: "src/a.js", line: 2, evidence: "valor publicado na linha 2", recommendation: "Remover e rotacionar", ...overrides }]
});

test("F6: achado crítico publica evidência e recomendação no check", async () => {
  const mock = api(prNow());
  await publishReviewCheck({ ...args, verdict: { state: "critical", review: criticalReview() }, fetchImpl: mock.fetchImpl });
  assert.match(mock.posted().output.title, /crítico/i);
  assert.match(mock.posted().output.summary, /Evidência: valor publicado na linha 2/);
  assert.match(mock.posted().output.summary, /Recomendação: Remover e rotacionar/);
});

test("F6: evidência é sanitizada (segredo, marcação, controle) e limitada em tamanho", async () => {
  const secret = "sk-ant-" + "x9".repeat(20);
  const mock = api(prNow());
  const evidence = `chave ${secret} <script>alert(1)</script> \`\`\` \u0007 ${"x".repeat(50_000)}`;
  await publishReviewCheck({ ...args, verdict: { state: "critical", review: criticalReview({ evidence }) }, fetchImpl: mock.fetchImpl });
  const { summary, text } = mock.posted().output;
  for (const part of [summary, text]) {
    assert.ok(!part.includes(secret));
    assert.ok(!part.includes("<script>"));
    assert.ok(!part.includes("```"));
    assert.ok(!part.includes("\u0007"));
  }
  assert.match(summary, /\[segredo removido\]/);
  assert.ok(summary.length <= 30_000 && text.length <= 60_000);
  assert.match(summary, /truncado/);
});

test("F6: achados não críticos aparecem no relatório sem bloquear", async () => {
  const mock = api(prNow());
  const high = { summary: "Ok", critical_count: 0, findings: [{ severity: "high", title: "Nome ruim", evidence: "evid", recommendation: "rec" }] };
  await publishReviewCheck({ ...args, verdict: { state: "approved", review: high }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "success");
  assert.match(mock.posted().output.text, /\[high\].*Nome ruim\nEvidência: evid\nRecomendação: rec/);
});

test("F6: contagem crítica divergente reprova como inconclusivo, nunca como crítico nem aprovação", async () => {
  const mock = api(prNow());
  await publishReviewCheck({ ...args, verdict: { state: "approved", review: { ...criticalReview(), critical_count: 0 } }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().conclusion, "failure");
  assert.equal(mock.posted().output.title, "Revisão inconclusiva");
  await publishReviewCheck({ ...args, verdict: { state: "critical", review: { ...criticalReview(), critical_count: 3 } }, fetchImpl: mock.fetchImpl });
  assert.equal(mock.posted().output.title, "Revisão inconclusiva");
});
