#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { FAILURE_MESSAGES, classifyFailure, classifyReview, formatReport, sanitizeFailureClass } from "./enforce-claude-review.mjs";
import { fetchPullState } from "./materialize-diff.mjs";

const CHECK_NAME = "claude-critical-review";

async function githubJson(url, token, fetchImpl, body) {
  const response = await fetchImpl(url, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status ?? "erro"}`);
  return response.json();
}

export async function publishReviewCheck({ repo, prNumber, headSha, baseSha, protectedBranch, token, identity, verdict, gatesOutcome = "success", gatesFailureClass, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isInteger(prNumber) || prNumber < 1 ||
      !/^[0-9a-f]{40}$/.test(headSha) || !/^[0-9a-f]{40}$/.test(baseSha) || !token) {
    throw new Error("metadados do PR ou token inválidos");
  }
  const root = `https://api.github.com/repos/${repo}`;
  let state = "inconclusive";
  let failureClass = "verdict_missing";
  let review;
  if (gatesOutcome !== "success") {
    failureClass = sanitizeFailureClass(gatesFailureClass || "gates_not_passed");
  } else if (verdict?.review) {
    const checked = classifyReview(verdict.review);
    if (checked.state === "inconclusive") {
      failureClass = "model_output_invalid";
    } else if (checked.state === verdict.state) {
      state = checked.state;
      review = verdict.review;
    } else {
      failureClass = "verdict_mismatch";
    }
  } else if (verdict && typeof verdict === "object" && verdict.failure_class !== undefined) {
    // Apenas a classe do enum fechado é aceita; texto livre do veredito é descartado.
    failureClass = sanitizeFailureClass(verdict.failure_class);
  }
  if (state === "approved" || state === "critical") {
    if (!/^[0-9a-f]{64}$/.test(identity ?? "")) {
      state = "inconclusive";
      failureClass = "identity_missing";
    } else {
      try {
        const fresh = await fetchPullState({ repo, prNumber, baseSha, headSha, protectedBranch, token, fetchImpl });
        if (fresh.identity.digest !== identity) {
          state = "inconclusive";
          failureClass = "identity_changed";
        }
      } catch (error) {
        state = "inconclusive";
        const classified = classifyFailure(error);
        failureClass = ["head_changed", "base_not_authorized"].includes(classified) ? classified : "diff_unavailable";
      }
    }
  }
  // Rebaixado a inconclusivo: o relatório anterior (aprovação ou achados) está obsoleto e é descartado.
  if (state === "inconclusive") review = undefined;
  const conclusion = state === "approved" ? "success" : "failure";
  const title = state === "approved" ? "Revisão aprovada" : state === "critical" ? "Achado crítico" : "Revisão inconclusiva";
  const report = review ? formatReport(review) : undefined;
  const reason = state === "inconclusive" ? failureClass : checkedReason(state);
  const summary = state === "inconclusive"
    ? `Causa: ${failureClass} — ${FAILURE_MESSAGES[failureClass]}`
    : state === "critical" ? report.summary : "Nenhum achado crítico.";
  await githubJson(`${root}/check-runs`, token, fetchImpl, {
    name: CHECK_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion,
    output: { title, summary, ...(report ? { text: report.text } : {}) }
  });
  return { state, reason, conclusion };
}

function checkedReason(state) {
  return state === "critical" ? "critical_findings" : "no_critical_findings";
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const encoded = process.env.REVIEW_VERDICT_B64;
    let verdict;
    if (encoded) {
      try {
        verdict = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      } catch {
        verdict = { state: "inconclusive", failure_class: "payload_invalid" };
      }
    } else if (argument("--failure-class")) {
      // Job anterior falhou ou foi pulado: só a classe do enum é aceita.
      verdict = { state: "inconclusive", failure_class: argument("--failure-class") };
    }
    const result = await publishReviewCheck({
      repo: argument("--repo"),
      prNumber: Number(argument("--pr")),
      baseSha: argument("--base"),
      headSha: argument("--head"),
      identity: argument("--identity"),
      protectedBranch: argument("--protected-base"),
      token: process.env.GITHUB_TOKEN,
      verdict,
      gatesOutcome: process.env.GATES_OUTCOME,
      gatesFailureClass: process.env.GATES_CLASS
    });
    process.stdout.write(`${result.state}: ${result.reason}\n`);
    if (result.conclusion !== "success") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Falha ao publicar parecer: ${error.message}\n`);
    process.exitCode = 1;
  }
}
