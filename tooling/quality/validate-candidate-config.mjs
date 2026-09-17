#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_CANDIDATE_BYTES = 1024 * 1024;
const MAX_IGNORE_ARRAYS = 50;
const MAX_PATTERNS_PER_ARRAY = 1000;
const MAX_PATTERN_LENGTH = 1024;
const MAX_PATTERN_SEGMENTS = 32;

const NAO_CANONICO = "padrão de caminho em forma não canônica";
const LIMITE_PADRAO = "padrão de caminho excede os limites estruturais";
const LIMITE_LISTA = "lista de padrões excede os limites estruturais";
const LIMITE_ARQUIVO = "arquivo de configuração candidata excede o tamanho máximo";

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

// Leitor exclusivo da candidata: o limite de tamanho não se aplica à política confiável.
function readCandidateText(file) {
  let info;
  try {
    info = statSync(file);
  } catch {
    throw new Error("configuração obrigatória ausente ou ilegível");
  }
  if (!info.isFile()) throw new Error("configuração obrigatória ausente ou ilegível");
  if (info.size > MAX_CANDIDATE_BYTES) throw new Error(LIMITE_ARQUIVO);
  return readText(file);
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
  if (excluded !== null && excluded.length > MAX_PATTERNS_PER_ARRAY) throw new Error(LIMITE_LISTA);
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
  return literalStringArray(balancedContent(source, match.index + match[0].lastIndexOf("["), "[", "]"));
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

// Classe de caracteres POSIX: "]" logo após "[", "[!" ou "[^" é literal e não fecha
// a classe. Classe sem fechamento ou com intervalo invertido não tem semântica
// inequívoca e reprova. "\" dentro da classe é caractere comum, como em POSIX.
function compileClass(segment, start, tokens) {
  let index = start + 1;
  let negated = false;
  if (segment[index] === "!" || segment[index] === "^") {
    negated = true;
    index += 1;
  }
  const ranges = [];
  let first = true;
  while (index < segment.length) {
    const character = segment[index];
    if (character === "]" && !first) {
      tokens.push({ type: "class", negated, ranges });
      return index;
    }
    first = false;
    if (segment[index + 1] === "-" && index + 2 < segment.length && segment[index + 2] !== "]") {
      const upper = segment[index + 2];
      if (upper < character) throw new Error(NAO_CANONICO);
      ranges.push([character, upper]);
      index += 3;
      continue;
    }
    ranges.push([character, character]);
    index += 1;
  }
  throw new Error(NAO_CANONICO);
}

function compileSegment(segment) {
  const tokens = [];
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === "*") {
      if (tokens.length === 0 || tokens[tokens.length - 1].type !== "star") tokens.push({ type: "star" });
      continue;
    }
    if (character === "?") {
      tokens.push({ type: "any" });
      continue;
    }
    if (character === "[") {
      index = compileClass(segment, index, tokens);
      continue;
    }
    tokens.push({ type: "char", value: character });
  }
  return tokens;
}

function compilePattern(pattern) {
  if (pattern.startsWith("!")) throw new Error(NAO_CANONICO);
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(LIMITE_PADRAO);
  let normalized = pattern;
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  const segments = normalized.split("/");
  if (segments.length > MAX_PATTERN_SEGMENTS) throw new Error(LIMITE_PADRAO);
  return segments.map((segment) =>
    segment === "**" ? { globstar: true } : { globstar: false, tokens: compileSegment(segment) }
  );
}

function matchesToken(token, character) {
  if (token.type === "any") return true;
  if (token.type === "char") return token.value === character;
  const inside = token.ranges.some(([low, high]) => character >= low && character <= high);
  return token.negated ? !inside : inside;
}

// Autômato por programação dinâmica: cada caractere avança um conjunto de estados
// limitado pelo número de tokens. Não há retrocesso.
function matchSegment(tokens, text) {
  const total = tokens.length;
  let row = new Array(total + 1).fill(false);
  row[0] = true;
  for (let index = 0; index < total; index += 1) {
    if (row[index] && tokens[index].type === "star") row[index + 1] = true;
  }
  for (const character of text) {
    const next = new Array(total + 1).fill(false);
    for (let index = 0; index < total; index += 1) {
      if (!row[index]) continue;
      if (tokens[index].type === "star") next[index] = true;
      else if (matchesToken(tokens[index], character)) next[index + 1] = true;
    }
    for (let index = 0; index < total; index += 1) {
      if (next[index] && tokens[index].type === "star") next[index + 1] = true;
    }
    row = next;
  }
  return row[total];
}

// Retorna, para cada prefixo do caminho, se o padrão inteiro o cobre.
function matchSegments(patternSegments, pathSegments) {
  const total = pathSegments.length;
  let row = new Array(total + 1).fill(false);
  row[0] = true;
  for (const segment of patternSegments) {
    const next = new Array(total + 1).fill(false);
    if (segment.globstar) {
      let reached = false;
      for (let index = 0; index <= total; index += 1) {
        if (row[index]) reached = true;
        next[index] = reached;
      }
    } else {
      for (let index = 0; index < total; index += 1) {
        if (row[index] && matchSegment(segment.tokens, pathSegments[index])) next[index + 1] = true;
      }
    }
    row = next;
  }
  return row;
}

function globMatches(pattern, path) {
  if (typeof pattern !== "string") return false;
  const compiled = compilePattern(pattern);
  const pathSegments = path.split("/");
  const row = matchSegments(compiled, pathSegments);
  if (row[pathSegments.length]) return true;
  // Prefixo casado é diretório alcançado: o padrão também alcança os descendentes.
  for (let index = 1; index < pathSegments.length; index += 1) {
    if (row[index]) return true;
  }
  return false;
}

// Escapes com semântica explícita. Qualquer outro caractere após "\" vale por si
// mesmo, como em `"[\]]"`, exceto dígito decimal (forma octal legada), "x"/"u"
// (tratados adiante) e quebra de linha (continuação de linha não é canônica aqui).
const ESCAPES_SIMPLES = new Map([
  ["\\", "\\"],
  ['"', '"'],
  ["'", "'"],
  ["/", "/"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"]
]);

function decodeHex(source, start, length) {
  const digits = source.slice(start, start + length);
  if (digits.length !== length || !/^[0-9a-fA-F]+$/u.test(digits)) return null;
  return String.fromCharCode(Number.parseInt(digits, 16));
}

// Leitor determinístico de literal de string: sem avaliação, sem execução e sem
// eco do valor lido. Retorna o valor DECODIFICADO e a posição após a aspa final.
// "\u{...}" é recusado por não ser forma canônica de literal de padrão.
function readStringLiteral(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === quote) return { value, end: index + 1 };
    if (character === "\n" || character === "\r") return null;
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    const escape = source[index + 1];
    if (escape === undefined || escape === "\n" || escape === "\r") return null;
    if (ESCAPES_SIMPLES.has(escape)) {
      value += ESCAPES_SIMPLES.get(escape);
      index += 2;
      continue;
    }
    if (escape === "x" || escape === "u") {
      const decoded = decodeHex(source, index + 2, escape === "x" ? 2 : 4);
      if (decoded === null) return null;
      value += decoded;
      index += escape === "x" ? 4 : 6;
      continue;
    }
    if (escape >= "0" && escape <= "9") return null;
    value += escape;
    index += 2;
  }
  return null;
}

// Analisador único de array literal textual, compartilhado por cobertura e lint.
// Separadores e espaços são tolerados; qualquer outro conteúdo reprova.
function literalStringArray(content) {
  if (typeof content !== "string") return null;
  const values = [];
  let index = 0;
  while (index < content.length) {
    const character = content[index];
    if (character === "," || /\s/u.test(character)) {
      index += 1;
      continue;
    }
    const literal = readStringLiteral(content, index);
    if (literal === null) return null;
    values.push(literal.value);
    index = literal.end;
  }
  return values;
}

const IGNORES_KEY = /(?:\[\s*(["'])ignores\1\s*\]|(["'])ignores\2|\bignores\b)\s*:/gu;

function significantIndex(source, from) {
  let index = from;
  while (index < source.length && /\s/u.test(source[index])) index += 1;
  return index;
}

function assertIgnores(eslint) {
  const protectedPaths = ["src/__candidate__.ts", "src/modules/__candidate__.ts", "src/shared/__candidate__.ts"];
  const declarations = [...eslint.matchAll(IGNORES_KEY)];
  if (declarations.length > MAX_IGNORE_ARRAYS) throw new Error(LIMITE_LISTA);
  for (const match of declarations) {
    const start = significantIndex(eslint, match.index + match[0].length);
    if (eslint[start] !== "[") throw new Error("lista de padrões ignorados não é um array literal");
    const patterns = literalStringArray(balancedContent(eslint, start, "[", "]"));
    if (patterns === null) throw new Error("lista de padrões ignorados ilegível ou não textual");
    if (patterns.length > MAX_PATTERNS_PER_ARRAY) throw new Error(LIMITE_LISTA);
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
  const vitest = readCandidateText(join(candidate, "vitest.config.ts"));
  const eslint = readCandidateText(join(candidate, "eslint.config.mjs"));
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
