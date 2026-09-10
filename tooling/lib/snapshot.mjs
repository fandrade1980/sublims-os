import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const PLAN_PATTERN = /^orchestration\/plans\/[0-9]+\.json$/;
export const SPEC_PATTERN = /^specs\/[0-9]+-[a-z0-9-]+\.md$/;

export function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath === "") {
    throw new Error("caminho vazio não é aceito");
  }
  if (relativePath.includes("\\")) {
    throw new Error(`caminho com barra invertida não é portável: ${relativePath}`);
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:\//.test(relativePath)) {
    throw new Error(`caminho absoluto não é aceito: ${relativePath}`);
  }
  if (relativePath.split("/").includes("..")) {
    throw new Error(`caminho com componente \`..\` não é aceito: ${relativePath}`);
  }
  return relativePath;
}

// `lstat` em cada componente, sem seguir o link: um symlink no meio do caminho
// permitiria apontar para fora da árvore confiável sem que o caminho pareça inválido.
export function assertNoSymlinkInPath(root, relativePath) {
  assertSafeRelativePath(relativePath);
  let current = resolve(root);
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return relativePath;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`symlink não é seguido: ${relativePath}`);
    }
  }
  return relativePath;
}

function assertInsideDirectory(directory, relativePath) {
  if (!relativePath.startsWith(`${directory}/`)) {
    throw new Error(`caminho fora do diretório ${directory}: ${relativePath}`);
  }
  return relativePath;
}

function entryFor(root, relativePath) {
  return Object.freeze({
    path: relativePath,
    absolutePath: resolve(root, relativePath),
    root: resolve(root)
  });
}

function assertRegularFile(root, relativePath) {
  let stats;
  try {
    stats = lstatSync(resolve(root, relativePath));
  } catch {
    throw new Error(`arquivo candidato ausente ou não regular: ${relativePath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`arquivo candidato ausente ou não regular: ${relativePath}`);
  }
  return relativePath;
}

export function buildBaseSnapshot({
  root,
  directory,
  pattern,
  allowEmpty = false
}) {
  assertSafeRelativePath(directory);
  assertNoSymlinkInPath(root, directory);
  const absoluteDirectory = resolve(root, directory);
  const snapshot = new Map();

  let names = [];
  try {
    names = readdirSync(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  for (const item of names.sort((left, right) => left.name.localeCompare(right.name, "en-US"))) {
    const relativePath = `${directory}/${item.name}`;
    if (item.isSymbolicLink()) {
      throw new Error(`symlink não é seguido: ${relativePath}`);
    }
    if (item.isDirectory()) {
      throw new Error(`subdiretório não permitido em ${directory}: ${item.name}`);
    }
    if (!pattern.test(relativePath)) {
      throw new Error(`nome fora do padrão em ${directory}: ${item.name}`);
    }
    if (!item.isFile()) continue;
    assertNoSymlinkInPath(root, relativePath);
    snapshot.set(relativePath, entryFor(root, relativePath));
  }

  if (!allowEmpty && snapshot.size === 0) {
    throw new Error(`nenhuma entrada aplicável em ${directory}; enumeração vazia não é aprovação`);
  }
  return snapshot;
}

// O snapshot candidato efetivo parte da base: `A` e `M` substituem ou acrescentam,
// `D` remove. Nunca se valida pela união bruta dos dois conjuntos.
export function applyChanges({
  base,
  changes,
  root,
  directory,
  pattern,
  allowDeletion = false
}) {
  const effective = new Map(base);
  for (const change of changes) {
    const { status, path: relativePath } = change;
    // Segurança do caminho é verificada sempre, antes de qualquer filtro de escopo:
    // travessia precisa reprovar, nunca ser silenciosamente ignorada.
    assertSafeRelativePath(relativePath);
    // Caminho seguro fora do diretório é apenas outro arquivo do PR, não uma entrada
    // deste snapshot. O prefixo exige a barra para não confundir `plans` com `planos`.
    if (!relativePath.startsWith(`${directory}/`)) continue;
    assertInsideDirectory(directory, relativePath);
    if (!pattern.test(relativePath)) {
      throw new Error(`nome fora do padrão em ${directory}: ${relativePath}`);
    }
    if (status === "D") {
      if (!allowDeletion && base.has(relativePath)) {
        throw new Error(
          `exclusão de entrada presente na base não é aceita: ${relativePath}; renomeação chega como exclusão mais adição`
        );
      }
      effective.delete(relativePath);
      continue;
    }
    if (status !== "A" && status !== "M") {
      throw new Error(`status não aceito ao montar o snapshot candidato: ${status}`);
    }
    assertNoSymlinkInPath(root, relativePath);
    assertRegularFile(root, relativePath);
    effective.set(relativePath, entryFor(root, relativePath));
  }
  return effective;
}

export function readEntryText(entry) {
  assertNoSymlinkInPath(entry.root, entry.path);
  return readFileSync(entry.absolutePath, "utf8");
}

// Conteúdo do candidato é dado: `JSON.parse`, jamais `import`.
export function readEntryJson(entry) {
  const text = readEntryText(entry);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON inválido em ${entry.path}: ${error.message}`);
  }
}

// Unicidade é sempre verificada dentro de um único snapshot íntegro.
export function findDuplicates(snapshot, keyOf) {
  const byKey = new Map();
  for (const [relativePath, entry] of snapshot) {
    const key = keyOf(entry, relativePath);
    if (key === undefined || key === null) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(relativePath);
  }
  const duplicates = [];
  for (const [key, paths] of byKey) {
    if (paths.length > 1) duplicates.push({ key, paths: paths.slice().sort() });
  }
  return duplicates.sort((left, right) => String(left.key).localeCompare(String(right.key), "en-US"));
}

export const separator = sep;
