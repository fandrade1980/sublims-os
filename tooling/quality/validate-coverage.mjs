#!/usr/bin/env node
import { readFileSync } from "node:fs";

const metrics = ["lines", "branches", "functions", "statements"];

try {
  const [coverageFile, policyFile] = process.argv.slice(2);
  if (!coverageFile || !policyFile) throw new Error("informe coverage-summary.json e a política");
  const coverage = JSON.parse(readFileSync(coverageFile, "utf8"));
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  for (const metric of metrics) {
    const actual = coverage?.total?.[metric]?.pct;
    const required = policy?.coverage?.[metric];
    if (typeof actual !== "number" || typeof required !== "number") {
      throw new Error(`métrica inválida: ${metric}`);
    }
    if (actual < required) throw new Error(`${metric}: ${actual}% abaixo de ${required}%`);
  }
  process.stdout.write("Cobertura aprovada pela política.\n");
} catch (error) {
  process.stderr.write(`Cobertura reprovada: ${error.message}\n`);
  process.exitCode = 1;
}
