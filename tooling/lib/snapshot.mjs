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
  // `C:/x` é absoluto e `C:x` é relativo à unidade. Ambos descartam a raiz em `resolve`,
  // então nenhuma das duas formas pode passar.
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error(`caminho absoluto não é aceito: ${relativePath}`);
  }
  if (relativePath.endsWith("/")) {
    throw new Error(`caminho com barra final é ambíguo: ${relativePath}`);
  }
  const components = relativePath.split("/");
  if (components.includes("..")) {
    throw new Error(`caminho com componente \`..\` não é aceito: ${relativePath}`);
  }
  // Componente vazio (`a//b`) e `.` denotam o mesmo arquivo por outra grafia. Duas grafias
  // para o mesmo caminho permitiriam escapar de comparações textuais de prefixo.
  if (components.includes("")) {
    throw new Error(`caminho com componente vazio é ambíguo: ${relativePath}`);
  }
  if (components.includes(".")) {
    throw new Error(`caminho com componente \`.\` é ambíguo: ${relativePath}`);
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
    } catch (error) {
      // Não conseguir inspecionar um componente não é evidência de ausência de symlink.
      // Retornar aqui aprovaria por omissão e deixaria os componentes seguintes sem verificação.
      throw new Error(
        `não foi possível verificar o caminho ${relativePath}: ${error.code ?? error.message}`
      );
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

// Contenção por resolução, não apenas por texto: o caminho absoluto precisa cair dentro
// da raiz. Também é a única fonte de verdade do caminho em disco — a entrada guarda
// somente `root` e `path`, e o absoluto é sempre derivado no momento do uso.
export function entryAbsolutePath(entry) {
  const absoluteRoot = resolve(entry.root);
  assertSafeRelativePath(entry.path);
  const absolute = resolve(absoluteRoot, entry.path);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`caminho resolve fora da raiz: ${entry.path}`);
  }
  return absolute;
}

function entryFor(root, relativePath) {
  const entry = Object.freeze({ path: relativePath, root: resolve(root) });
  entryAbsolutePath(entry);
  return entry;
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
  const absoluteDirectory = entryAbsolutePath({ root, path: directory });

  // Diretório ausente é distinto de diretório vazio, e reprova sempre: `allowEmpty`
  // autoriza no máximo um diretório existente e sem entradas aplicáveis.
  let directoryStats;
  try {
    directoryStats = lstatSync(absoluteDirectory);
  } catch (error) {
    throw new Error(
      `diretório ausente ou ilegível: ${directory} (${error.code ?? error.message}); ausência não é aprovação`
    );
  }
  if (directoryStats.isSymbolicLink()) {
    throw new Error(`symlink não é seguido: ${directory}`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`caminho não é diretório: ${directory}`);
  }
  assertNoSymlinkInPath(root, directory);

  const snapshot = new Map();
  const names = readdirSync(absoluteDirectory, { withFileTypes: true });

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
    // FIFO, socket ou device com nome de plano válido: reprova, nunca é descartado em silêncio.
    if (!item.isFile()) {
      throw new Error(`entrada não regular em ${directory}: ${item.name}`);
    }
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
  allowDeletion = false,
  allowEmpty = false
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
    // `assertRegularFile` primeiro: dá a mensagem específica para ausente ou não regular,
    // e já recusa symlink no componente final, porque `lstat` não segue o link.
    // `assertNoSymlinkInPath` cobre em seguida todos os componentes ancestrais.
    assertRegularFile(root, relativePath);
    assertNoSymlinkInPath(root, relativePath);
    effective.set(relativePath, entryFor(root, relativePath));
  }
  // Conjunto vazio por exclusão seria lido por um verificador de unicidade como
  // "nenhuma duplicação", isto é, aprovação. Exige decisão explícita.
  if (!allowEmpty && effective.size === 0) {
    throw new Error(
      `snapshot candidato ficou vazio em ${directory}; conjunto vazio não é aprovação`
    );
  }
  return effective;
}

export function readEntryText(entry) {
  assertNoSymlinkInPath(entry.root, entry.path);
  return readFileSync(entryAbsolutePath(entry), "utf8");
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
    // Descartar entrada sem chave faria a unicidade ser declarada sobre um conjunto menor
    // do que o snapshot, e "nenhuma duplicação" passaria a significar "não verifiquei".
    if (typeof key !== "string" || key === "") {
      throw new Error(
        `chave de unicidade ausente ou inválida em ${relativePath}: ${JSON.stringify(key) ?? String(key)}`
      );
    }
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
