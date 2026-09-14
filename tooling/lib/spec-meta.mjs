// Bloco estrito: comentário HTML `spec-meta`, JSON na(s) linha(s) seguinte(s), fecho
// em linha própria. `\r?\n` tolera CRLF sem relaxar a forma.
const BLOCO_SPEC_META = /<!-- spec-meta\s*\r?\n([\s\S]*?)\r?\n-->/g;

export function parseSpecMeta(markdown) {
  const blocos = [...markdown.matchAll(BLOCO_SPEC_META)];
  if (blocos.length !== 1) {
    throw new Error("metadados spec-meta ausentes ou duplicados");
  }
  try {
    return JSON.parse(blocos[0][1]);
  } catch {
    throw new Error("metadados spec-meta não são JSON válido");
  }
}

// Identidade canônica para unicidade: `3`, `03`, `003` e `0003` designam a mesma
// issue. Remoção puramente textual dos zeros à esquerda, preservando ao menos um
// dígito (`0000` → `0`). `Number`/`parseInt` perderiam precisão em identificadores
// longos, e não participam da comparação nome↔`id`, que permanece estrita.
export function canonicalSpecId(id) {
  return String(id).replace(/^0+(?=\d)/, "");
}

// Prefixo decimal antes do primeiro `-`, comparado textualmente com `metadata.id`:
// `004-…` casa com `"004"` e não com `"4"` nem com `4`. Mensagem preservada do
// validador atual; `ausente` quando não há `id`.
export function assertSpecIdentity(metadata, fileName) {
  const fileId = String(fileName).match(/^(\d+)-/)?.[1];
  if (!fileId || metadata?.id !== fileId) {
    throw new Error(`id ${metadata?.id ?? "ausente"} não corresponde ao nome do arquivo`);
  }
}
