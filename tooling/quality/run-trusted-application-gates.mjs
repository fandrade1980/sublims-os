#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const policyFile = argument("--policy");
  const candidate = resolve(argument("--candidate") ?? "");
  if (!policyFile || !existsSync(policyFile) || !existsSync(candidate)) throw new Error("--policy e --candidate válidos são obrigatórios");
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  if (policy.version !== 1 || typeof policy.enabled !== "boolean" || !Array.isArray(policy.commands)) throw new Error("política inválida");
  if (!policy.enabled) {
    if (typeof policy.reason !== "string" || !policy.reason.trim()) throw new Error("política desativada precisa de motivo");
    process.stdout.write(`Gates de aplicação desativados na política confiável: ${policy.reason}\n`);
  } else {
    if (!policy.commands.length) throw new Error("política ativa sem comandos");
    for (const command of policy.commands) {
      if (typeof command?.name !== "string" || typeof command?.executable !== "string" || !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string")) {
        throw new Error("comando da política inválido");
      }
      const result = spawnSync(command.executable, command.args, { cwd: candidate, encoding: "utf8", shell: false, stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error(`${command.name} falhou com código ${result.status ?? "indisponível"}`);
    }
    process.stdout.write(`Gates de aplicação aprovados: ${policy.commands.length} comandos confiáveis.\n`);
  }
} catch (error) {
  process.stderr.write(`Quality gate confiável falhou: ${error.message}\n`);
  process.exitCode = 1;
}
