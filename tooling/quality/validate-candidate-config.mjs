#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--candidate" && flag !== "--policy") {
      throw new Error(flag.startsWith("--") ? "argumento inválido" : "uso: informe --candidate e --policy");
    }
    if (values.has(flag)) throw new Error(`argumento repetido: ${flag}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.trim() === "") {
      throw new Error(`${flag} exige um valor`);
    }
    values.set(flag, value);
    index += 1;
  }
  if (!values.has("--candidate") || !values.has("--policy")) {
    throw new Error("uso: informe --candidate e --policy");
  }
  return values;
}

function readText(file) {
  if (!existsSync(file)) throw new Error("configuração obrigatória ausente ou ilegível");
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error("configuração obrigatória ausente ou ilegível");
  }
}

function readJson(file) {
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("configuração obrigatória inválida");
  }
}

function assertCoverage(vitest, policy) {
  vitest = exportedConfig(withoutComments(vitest));
  if (vitest === null) throw new Error("escopo de cobertura incompatível com a política");
  const testConfig = objectProperty(vitest, "test");
  const coverage = testConfig === null ? null : objectProperty(testConfig, "coverage");
  const included = coverage === null ? null : stringArrayProperty(coverage, "include");
  const excluded = coverage === null ? null : stringArrayProperty(coverage, "exclude");
  const required = policy?.coverage?.include;
  if (
    !Array.isArray(required) ||
    included === null ||
    !required.every((pattern) => typeof pattern === "string" && included.includes(pattern))
  ) {
    throw new Error("escopo de cobertura incompatível com a política");
  }
  const protectedPaths = ["src/modules/__candidate__.ts", "src/shared/__candidate__.ts"];
  if (excluded === null || excluded.some((pattern) => protectedPaths.some((path) => globMatches(pattern, path)))) {
    throw new Error("exclusão de cobertura incompatível com a política");
  }
  const thresholds = objectProperty(coverage, "thresholds");
  for (const metric of ["lines", "branches", "functions", "statements"]) {
    const expected = policy?.coverage?.[metric];
    const match = singleAnchor(thresholds, new RegExp(`\\b${metric}\\s*:\\s*(\\d+)`, "gu"), metric);
    if (!Number.isFinite(expected) || !match || Number(match[1]) < expected) {
      throw new Error("limiar de cobertura incompatível com a política");
    }
  }
}

function singleAnchor(source, pattern, name) {
  if (typeof source !== "string") return null;
  const matches = [...source.matchAll(pattern)];
  if (matches.length > 1) {
    const positions = matches.map((match) => match.index).join(", ");
    throw new Error(
      `configuração ambígua: âncora "${name}" ocorre ${matches.length} vezes no trecho inspecionado (deslocamentos ${positions})`
    );
  }
  return matches.length === 1 ? matches[0] : null;
}

function objectProperty(source, name) {
  const match = singleAnchor(source, new RegExp(`\\b${name}\\s*:\\s*\\{`, "gu"), name);
  if (match === null) return null;
  return balancedContent(source, match.index + match[0].lastIndexOf("{"), "{", "}");
}

function stringArrayProperty(source, name) {
  const match = singleAnchor(source, new RegExp(`\\b${name}\\s*:\\s*\\[`, "gu"), name);
  if (match === null) return null;
  const content = balancedContent(source, match.index + match[0].lastIndexOf("["), "[", "]");
  if (content === null) return null;
  const values = [];
  const literal = /(["'])((?:\\.|(?!\1)[^\\])*)\1/gu;
  for (const item of content.matchAll(literal)) values.push(item[2]);
  const residue = content.replace(literal, "").replace(/[\s,]/gu, "");
  return residue === "" ? values : null;
}

function balancedContent(source, start, open, close) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  return null;
}

function globMatches(pattern, path) {
  if (typeof pattern !== "string") return false;
  const source = pattern
    .replace(/[|\\{}()[\]^$+?.]/gu, "\\$&")
    .replace(/\*\*/gu, "@@GLOBSTAR@@")
    .replace(/\*/gu, "[^/]*")
    .replace(/@@GLOBSTAR@@/gu, ".*");
  return new RegExp(`^${source}$`, "u").test(path);
}

function literalStrings(content) {
  if (typeof content !== "string") return null;
  const values = [];
  const literal = /(["'])((?:\\.|(?!\1)[^\\])*)\1/gu;
  for (const item of content.matchAll(literal)) values.push(item[2]);
  const residue = content.replace(literal, "").replace(/[\s,]/gu, "");
  return residue === "" ? values : null;
}

const IGNORES_KEY = /(?:\[\s*(["'])ignores\1\s*\]|(["'])ignores\2|\bignores\b)\s*:/gu;

function significantIndex(source, from) {
  let index = from;
  while (index < source.length && /\s/u.test(source[index])) index += 1;
  return index;
}

function assertIgnores(eslint) {
  const protectedPaths = ["src/__candidate__.ts", "src/modules/__candidate__.ts", "src/shared/__candidate__.ts"];
  for (const match of eslint.matchAll(IGNORES_KEY)) {
    const start = significantIndex(eslint, match.index + match[0].length);
    if (eslint[start] !== "[") throw new Error("lista de padrões ignorados não é um array literal");
    const patterns = literalStrings(balancedContent(eslint, start, "[", "]"));
    if (patterns === null) throw new Error("lista de padrões ignorados ilegível ou não textual");
    if (patterns.some((pattern) => protectedPaths.some((path) => globMatches(pattern, path)))) {
      throw new Error("ignorar src é proibido");
    }
  }
}

function assertLint(eslint, policy) {
  eslint = exportedConfig(withoutComments(eslint));
  if (eslint === null) throw new Error("regra de complexidade incompatível com a política");
  assertIgnores(eslint);
  const max = policy?.complexity?.maxCyclomaticPerFunction;
  const occurrences = [...eslint.matchAll(/\bcomplexity\s*:/gu)];
  const configured = [
    ...eslint.matchAll(/\bcomplexity\s*:\s*\[\s*["']error["']\s*,\s*\{\s*max\s*:\s*(\d+)/gu)
  ];
  if (
    !Number.isFinite(max) ||
    !configured.length ||
    configured.length !== occurrences.length ||
    configured.some((match) => Number(match[1]) > max)
  ) {
    throw new Error("regra de complexidade incompatível com a política");
  }
}

function exportedConfig(source) {
  const match = singleAnchor(source, /\bexport\s+default\b/gu, "export default");
  return match === null ? null : source.slice(match.index + match[0].length);
}

function withoutComments(source) {
  let result = "";
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      result += character;
      if (character === "\\") {
        result += source[index + 1] ?? "";
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      result += character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index === -1) break;
      result += "\n";
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) break;
      result += source.slice(index, end + 2).replace(/[^\n]/gu, " ");
      index = end + 1;
      continue;
    }
    result += character;
  }
  return result;
}

function assertDependencies(config, policy) {
  const required = policy?.dependencies?.rules;
  const rules = config?.forbidden;
  if (!Array.isArray(required) || !required.length || !Array.isArray(rules) || !rules.length) {
    throw new Error("regras de dependência incompatíveis com a política");
  }
  for (const name of required) {
    if (!rules.some((rule) => rule?.name === name && rule?.severity === "error")) {
      throw new Error("regras de dependência incompatíveis com a política");
    }
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const candidate = resolve(options.get("--candidate"));
  const policyFile = resolve(options.get("--policy"));
  const policy = readJson(policyFile);
  const vitest = readText(join(candidate, "vitest.config.ts"));
  const eslint = readText(join(candidate, "eslint.config.mjs"));
  const trustedRoot = resolve(dirname(policyFile), "..");
  const dependencyConfig = readJson(join(trustedRoot, "tooling", "toolchain", "dependency-cruiser.json"));
  assertCoverage(vitest, policy);
  assertLint(eslint, policy);
  assertDependencies(dependencyConfig, policy);
  process.stdout.write("Configuração candidata compatível com a política confiável.\n");
} catch (error) {
  process.stderr.write(`Configuração candidata reprovada: ${error.message}\n`);
  process.exitCode = 1;
}
