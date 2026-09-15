#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertSpecIdentity, parseSpecMeta } from "../lib/spec-meta.mjs";
import { buildBaseSnapshot, readEntryText, SPEC_PATTERN } from "../lib/snapshot.mjs";

// Interface externa fechada: exatamente duas raízes, ambas obrigatórias. O registro
// de exceções NUNCA é indicável por argumento — ele é resolvido internamente sob a
// raiz confiável, para que nenhuma invocação possa apontá-lo para outro lugar.
const FLAGS_COM_VALOR = new Set(["--trusted", "--candidate"]);

// Versão do registro, deliberadamente independente da versão de `quality/policy.json`:
// registro e política evoluem em cadências próprias.
const VERSAO_DO_REGISTRO = 1;

// Já ordenado, para comparar com `Object.keys(...).sort()` sem reordenar a cada carga.
const CHAVES_DO_REGISTRO = Object.freeze(["exceptions", "version"]);

// Os sete campos obrigatórios de cada entrada, já em ordem lexicográfica pelo mesmo
// motivo. A ordem em que aparecem NO ARQUIVO é irrelevante; esta sequência existe
// apenas para a comparação de conjuntos.
const CAMPOS_DA_ENTRADA = Object.freeze([
  "changeClass",
  "expiresOn",
  "id",
  "issue",
  "spec",
  "target",
  "value"
]);

// Kebab-case ASCII: segmentos de letras minúsculas e dígitos, separados por um único
// hífen. Exclui maiúscula, acento, underscore, ponto, barra, hífen inicial, hífen
// final e hífen duplo.
//
// ASCII é deliberado. Com Unicode, `а` cirílico e `a` latino produzem identificadores
// visualmente idênticos e textualmente distintos: a unicidade viraria teatro, e duas
// entradas indistinguíveis na revisão humana conviveriam no mesmo registro. Restringir
// a ASCII também torna a normalização NFC um no-op, e a comparação textual suficiente.
const FORMATO_DO_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMPRIMENTO_MAXIMO_DO_ID = 64;

// Tabela explícita classe → alvos admissíveis. Conjunto FECHADO: o que não está aqui
// não é excetuável.
//
// Os nomes são declarados literalmente e nunca derivados da política candidata. Se a
// tabela fosse montada a partir do que o candidato escreveu, ele escolheria o que é
// afrouxável — e o registro deixaria de ser autoridade da base.
//
// Não existe classe para diferença de COMANDO. Nome, executável, origem, ordem,
// quantidade e argumentos são inegociáveis, e uma tentativa de excetuá-los cai em
// classe desconhecida.
//
// `Map`, não objeto literal: `Map.get` não consulta cadeia de protótipos. Com um
// objeto, `changeClass: "toString"` devolveria uma função e seria tratado como classe
// existente.
const ALVOS_POR_CLASSE = new Map([
  ["enabled-disabled", Object.freeze(["enabled"])],
  [
    "coverage-threshold-lowered",
    Object.freeze(["coverage.lines", "coverage.branches", "coverage.functions", "coverage.statements"])
  ],
  ["complexity-max-raised", Object.freeze(["complexity.maxCyclomaticPerFunction"])],
  ["coverage-exclusion-added", Object.freeze(["coverage.exclude"])],
  ["canonical-pattern-removed", Object.freeze(["appliesWhenChanged"])],
  ["allowed-rebuild-added", Object.freeze(["allowedRebuilds"])]
]);

// Nome de pacote npm em forma canônica, simples ou com escopo.
//
// PENDÊNCIA REGISTRADA: esta expressão é idêntica à de `validate-lockfile.mjs:32`, que
// não exporta nada. Extraí-la para `tooling/lib/` exigiria um caminho novo em `writes`
// do plano, e o plano não o autoriza. A duplicação é deliberada e temporária.
const NOME_DE_PACOTE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// Data civil UTC, exatamente `YYYY-MM-DD`. Ancorado nas duas pontas e com contagem
// fixa de dígitos: horário, sufixo de fuso, espaço periférico, ano com quantidade
// diferente de quatro dígitos e mês ou dia sem zero à esquerda não entram.
//
// Uma data sem fuso é deliberada. Admitir horário obrigaria a decidir qual fuso julga
// a vigência, e a mesma autorização passaria a valer ou não conforme a máquina onde o
// gate roda.
const FORMATO_DA_DATA_CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;
const FORMATO_DA_ISSUE_GITHUB = /^github:#\d+$/;
const FORMATO_DA_ISSUE_LOCAL = /^local:tasks\/[0-9]+-[a-z0-9-]+\.md$/;

// Sentinela de rejeição. `undefined` e `null` seriam ambíguos, e um retorno booleano
// colidiria com o valor canônico legítimo `false` da classe `enabled-disabled`: um
// `if (!canonico)` trataria a autorização válida como inválida.
const VALOR_INVALIDO = Symbol("valor inválido");

// Primitiva de glob, compartilhada pelas duas classes de padrão.
function canonicalGlobPattern(valor) {
  if (typeof valor !== "string") return VALOR_INVALIDO;
  const canonico = valor.normalize("NFC").trim();
  return canonico === "" ? VALOR_INVALIDO : canonico;
}

// Uma função nomeada por classe. `coverage-exclusion-added` e `canonical-pattern-removed`
// delegam hoje à mesma primitiva, mas mantêm identidades separadas: se um dia as regras
// divergirem, a mudança fica local e não arrasta a outra.
function canonicalDisabledFlag(valor) {
  // Só o booleano `false`. `"false"`, `0` e `null` são falsos por coerção — e é
  // justamente por isso que precisam ser recusados: coerção transformaria valores
  // distintos na mesma autorização.
  return valor === false ? false : VALOR_INVALIDO;
}

function canonicalThreshold(valor) {
  // `Number.isInteger(-0)` é verdadeiro e `-0 < 0` é falso: sem a checagem explícita,
  // `-0` atravessaria a faixa e conviveria com `0` como duas autorizações distintas
  // para o mesmo limiar.
  if (!Number.isInteger(valor) || Object.is(valor, -0)) return VALOR_INVALIDO;
  return valor >= 0 && valor <= 100 ? valor : VALOR_INVALIDO;
}

function canonicalComplexityMax(valor) {
  // `isSafeInteger`, não `isInteger`. Acima de `Number.MAX_SAFE_INTEGER`, números JSON
  // distintos colapsam para o mesmo valor em JavaScript, e a correspondência exata
  // exigida pela spec deixaria de existir: duas autorizações diferentes casariam o
  // mesmo afrouxamento. `-0` é recusado por `< 1`.
  if (!Number.isSafeInteger(valor)) return VALOR_INVALIDO;
  return valor >= 1 ? valor : VALOR_INVALIDO;
}

function canonicalCoverageExclusion(valor) {
  return canonicalGlobPattern(valor);
}

function canonicalAppliesPattern(valor) {
  return canonicalGlobPattern(valor);
}

function canonicalRebuildPackage(valor) {
  if (typeof valor !== "string") return VALOR_INVALIDO;
  // Sem recorte: espaço periférico torna a entrada INVÁLIDA, nunca é removido em
  // silêncio. Nome de pacote não tem espaço periférico legítimo, e recortar faria
  // `" esbuild"` e `"esbuild"` designarem a mesma autorização sob aparências distintas.
  if (valor !== valor.trim()) return VALOR_INVALIDO;
  return NOME_DE_PACOTE.test(valor) ? valor : VALOR_INVALIDO;
}

// Tabela classe → função canônica. Os detectores de afrouxamento consumirão estas
// MESMAS funções: um único caminho de normalização para o valor observado no candidato
// e para o valor gravado no registro. Dois caminhos divergiriam, e a correspondência
// exata passaria a depender de qual lado normalizou o quê.
const CANONICALIZADOR_POR_CLASSE = new Map([
  ["enabled-disabled", canonicalDisabledFlag],
  ["coverage-threshold-lowered", canonicalThreshold],
  ["complexity-max-raised", canonicalComplexityMax],
  ["coverage-exclusion-added", canonicalCoverageExclusion],
  ["canonical-pattern-removed", canonicalAppliesPattern],
  ["allowed-rebuild-added", canonicalRebuildPackage]
]);

// "Possui exatamente estas chaves": nem a mais, nem a menos, em qualquer ordem.
//
// `Object.keys` enumera somente propriedades PRÓPRIAS e enumeráveis. `in` consultaria
// a cadeia de protótipos e daria por presente um campo herdado de `Object.prototype`,
// aceitando um objeto que não o declara.
//
// `esperadas` chega já ordenado e é congelado; a cópia com `[...]` existe para que
// `sort` não reordene o argumento do chamador.
function possuiExatamenteAsChaves(objeto, esperadas) {
  const encontradas = [...Object.keys(objeto)].sort();
  return (
    encontradas.length === esperadas.length &&
    encontradas.every((chave, indice) => chave === esperadas[indice])
  );
}

// Data civil UTC REALMENTE existente.
//
// O formato sozinho não basta: ele conta dígitos, não dias do mês, e aceitaria
// `2026-02-30`, `2026-04-31` e `2025-02-29`. `Date.parse` também não serve — é
// permissivo, aceita horário e fuso e normaliza dia fora da faixa em silêncio.
//
// A prova é a ida e volta: reconstruir a data em UTC e exigir que ela reimprima
// exatamente a string recebida. Um dia inexistente transborda para o mês seguinte e a
// comparação falha.
//
// `setUTCFullYear` é obrigatório aqui. `Date.UTC` e `new Date(ano, ...)` mapeiam anos
// de 0 a 99 para 1900 + ano: sem ele, `0026-09-15` seria reconstruída como 1926 e a
// ida e volta reprovaria uma data válida — ou, pior, aceitaria uma inválida vizinha.
function ehDataCivilUtcExistente(texto) {
  const partes = FORMATO_DA_DATA_CIVIL.exec(texto);
  if (partes === null) return false;
  const [, ano, mes, dia] = partes;
  // `new Date(0)` já está em 00:00:00.000Z; só os campos de calendário são alterados,
  // e nenhum resíduo de hora participa da reimpressão.
  const data = new Date(0);
  data.setUTCFullYear(Number(ano), Number(mes) - 1, Number(dia));
  return data.toISOString().slice(0, 10) === texto;
}

// O dia corrente em UTC, lido UMA vez por carregamento do registro. Duas leituras
// poderiam cair em lados opostos da meia-noite e fazer duas entradas do MESMO arquivo
// serem julgadas contra dias diferentes.
//
// Não existe `--now`, variável de ambiente nem relógio injetável: quem invoca o gate
// não pode deslocar a vigência de uma autorização vencida.
function diaUtcCorrente() {
  return new Date().toISOString().slice(0, 10);
}

function ehReferenciaDeIssueValida(valor) {
  return (
    typeof valor === "string" &&
    (FORMATO_DA_ISSUE_GITHUB.test(valor) || FORMATO_DA_ISSUE_LOCAL.test(valor))
  );
}

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    // Nenhuma mensagem interpola valor arbitrário de `argv`. Ecoar o argumento
    // transformaria a linha de comando em canal de saída: um caminho, um token ou um
    // segredo passado por engano apareceria no log do gate, que é público. A partir
    // daqui `value` já pertence a `FLAGS_COM_VALOR`, e só esses dois literais nossos
    // voltam a ser citados.
    if (!value.startsWith("--")) {
      throw new Error("argumento posicional não é aceito; valor omitido do relatório");
    }
    if (!FLAGS_COM_VALOR.has(value)) {
      throw new Error("argumento desconhecido; valor omitido do relatório");
    }
    // Repetição sobrescreveria o primeiro valor em silêncio: `--trusted a --trusted b`
    // faria o último vencer, e a raiz confiável poderia ser trocada sem sinal.
    if (options.has(value)) {
      throw new Error(`argumento repetido: ${value}`);
    }
    const next = argv[index + 1];
    // Valor vazio ou só com espaços degradaria o modo em silêncio: uma variável de
    // ambiente não exportada expande para vazio e o gate aprovaria sem examinar nada.
    if (next === undefined || next.startsWith("--") || next.trim() === "") {
      throw new Error(`${value} exige um valor`);
    }
    options.set(value, next);
    index += 1;
  }
  for (const flag of FLAGS_COM_VALOR) {
    if (!options.has(flag)) {
      throw new Error(`${flag} é obrigatório`);
    }
  }
  return options;
}

// Consulta unilateral: o registro é lido sob a raiz confiável e em nenhum outro
// lugar. Não existe parâmetro para um registro candidato, e nada aqui compara dois
// registros — há uma fonte só. Disso decorre, sem regra adicional, que uma entrada
// introduzida pelo próprio PR não autoriza coisa alguma.
//
// A carga é incondicional: acontece antes de qualquer detecção de afrouxamento. O
// alternativo — carregar só quando houver afrouxamento — tornaria a existência do
// registro verificável apenas nas execuções que já estariam reprovando.
//
// Mensagens declaram a classe do problema e nunca o caminho nem o conteúdo: o texto
// do registro é dado sob revisão e não pertence à saída de um gate.
function carregarRegistroConfiavel(trusted) {
  let texto;
  try {
    texto = readFileSync(join(trusted, "quality", "policy-exceptions.json"), "utf8");
  } catch {
    throw new Error(
      "registro de exceções ausente ou ilegível na raiz confiável; ausência não é aprovação"
    );
  }
  // `JSON.parse` sobre texto, jamais `import`: o registro é dado, nunca instrução.
  let registro;
  try {
    registro = JSON.parse(texto);
  } catch {
    throw new Error("registro de exceções da raiz confiável não é JSON válido");
  }

  // `null`, array e primitivo atravessam `JSON.parse` sem erro. Sem esta afirmação,
  // um registro `[]` ou `null` seria lido como "carregou" e a ausência de entradas
  // viraria silêncio em vez de reprovação.
  if (registro === null || typeof registro !== "object" || Array.isArray(registro)) {
    throw new Error("registro de exceções da raiz confiável não é um objeto simples");
  }

  // Conjunto exato, sem ausências e sem extras. A ORDEM das chaves não participa da
  // validade: é matéria editorial, não semântica de autorização. `Object.keys` só
  // enumera propriedades próprias, e a comparação por conjunto ordenado evita que a
  // posição no arquivo influencie o veredito.
  //
  // A mensagem nomeia o esperado, que é constante nossa, e nunca o encontrado, que é
  // conteúdo de arquivo.
  if (!possuiExatamenteAsChaves(registro, CHAVES_DO_REGISTRO)) {
    throw new Error(
      "registro de exceções da raiz confiável com conjunto de chaves inválido; esperado exatamente `version` e `exceptions`"
    );
  }

  // Identidade estrita: `"1"`, `true` e `1.0000000000000002` não são a versão 1. O
  // valor encontrado fica fora da mensagem.
  if (registro.version !== VERSAO_DO_REGISTRO) {
    throw new Error("registro de exceções da raiz confiável com `version` não suportada");
  }

  if (!Array.isArray(registro.exceptions)) {
    throw new Error("registro de exceções da raiz confiável com `exceptions` não é um array");
  }

  // Array vazio é válido e significa NENHUMA autorização. É o oposto de aprovação por
  // enumeração vazia: nada está autorizado. O laço abaixo simplesmente não executa,
  // e nenhuma ordenação é imposta ao array.
  const identificadores = new Set();

  // Unicidade da tripla por estrutura ANINHADA: `changeClass` → `target` → conjunto
  // de valores canônicos.
  //
  // Nunca por chave serializada. Glob e nome de pacote podem conter qualquer
  // separador que escolhêssemos — `=`, `+=`, `|`, `{}`, espaço — e dois pares
  // distintos produziriam a mesma chave concatenada, criando colisão artificial onde
  // não há duplicação. A estrutura aninhada não tem essa fragilidade.
  //
  // `Set` é seguro aqui porque `NaN`, `-0` e inteiros inseguros já foram recusados
  // pelas funções canônicas, e os valores textuais já chegam canonicalizados.
  const autorizacoes = new Map();

  // O registro devolvido carrega os valores CANÔNICOS. Entradas novas, montadas por
  // cópia: os objetos vindos de `JSON.parse` nunca são mutados.
  const entradasCanonicas = [];

  // Uma leitura só, antes do laço, para que todas as entradas sejam julgadas contra o
  // mesmo dia. Fora do laço também porque o dia não depende de entrada alguma.
  const hojeUtc = diaUtcCorrente();
  let specsConfiaveis;
  const metadadosPorSpec = new Map();

  for (const [posicao, entrada] of registro.exceptions.entries()) {
    // `null` e array têm `typeof "object"`: os dois atravessariam uma checagem
    // ingênua de tipo e chegariam à conferência de campos como se fossem entradas.
    if (entrada === null || typeof entrada !== "object" || Array.isArray(entrada)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` não é um objeto simples`);
    }

    // A mensagem diz posição e classe do erro. Nenhuma chave encontrada, nenhum
    // valor, nenhuma spec, issue ou alvo: o conteúdo do registro é dado sob revisão
    // e não pertence ao log de um gate.
    if (!possuiExatamenteAsChaves(entrada, CAMPOS_DA_ENTRADA)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com conjunto de chaves inválido`);
    }

    // Sem coerção, sem recorte, sem normalização: `1` não vira `"1"` e `" a "` não
    // vira `"a"`. O que está escrito é o que vale.
    const { id } = entrada;
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > COMPRIMENTO_MAXIMO_DO_ID ||
      !FORMATO_DO_ID.test(id)
    ) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`id\` inválido`);
    }

    // Unicidade apurada DEPOIS do formato. Na ordem inversa, um `id` malformado
    // entraria no conjunto e passaria a competir por unicidade: duas entradas
    // igualmente inválidas seriam reportadas como duplicadas, escondendo a causa
    // real. `Set` de strings compara textualmente, sem coerção.
    //
    // A posição reportada é a da repetição, não a da primeira ocorrência: é ali que
    // está a entrada a remover. O identificador nunca aparece na mensagem.
    if (identificadores.has(id)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`id\` duplicado`);
    }
    identificadores.add(id);

    // `changeClass` ANTES de `target`. Uma classe desconhecida é erro de classe,
    // qualquer que seja o alvo — inclusive um alvo perfeitamente legítimo de outra
    // classe. Na ordem inversa, `classe-inexistente` com `enabled` seria reportada
    // como alvo inválido e esconderia a causa real.
    const { changeClass, target } = entrada;
    if (typeof changeClass !== "string" || !ALVOS_POR_CLASSE.has(changeClass)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`changeClass\` desconhecida`);
    }

    // Comparação textual exata. Sem coerção, sem `trim`, sem normalização Unicode e
    // sem ignorar caixa: `" enabled"` e `"ENABLED"` não são `"enabled"`. `includes`
    // compara por SameValueZero, que para strings é igualdade textual.
    if (typeof target !== "string" || !ALVOS_POR_CLASSE.get(changeClass).includes(target)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`target\` inválido para a classe`);
    }

    // `value` depois de classe e alvo: a classe já está estabelecida e determina qual
    // função canônica se aplica. Mensagem genérica — nem o valor, nem
    // o glob, nem o nome do pacote aparecem.
    //
    // Canonicalizado UMA vez. O resultado é o que entra na unicidade e o que o
    // registro devolve; recalcular em outro ponto abriria caminho para divergência.
    const valorCanonico = CANONICALIZADOR_POR_CLASSE.get(changeClass)(entrada.value);
    if (valorCanonico === VALOR_INVALIDO) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`value\` inválido para a classe`);
    }

    // `expiresOn` ANTES da unicidade da tripla. Uma entrada malformada ou vencida não
    // pode ocupar lugar no conjunto de autorizações canônicas — nem sequer para colidir
    // com outra. Na ordem inversa, uma autorização vencida ainda "reservaria" a tripla,
    // e a entrada legítima que viesse substituí-la seria reportada como duplicada,
    // escondendo a causa real.
    //
    // Sem coerção e sem recorte: a data é o que está escrito. Número, booleano, array e
    // objeto não viram data, e `" 2026-09-15"` não vira `"2026-09-15"`.
    const { expiresOn } = entrada;
    if (typeof expiresOn !== "string" || !ehDataCivilUtcExistente(expiresOn)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`expiresOn\` inválida`);
    }

    // Vigência INCLUSIVA: a autorização vale enquanto o dia corrente não PASSA da data
    // declarada, e expira a partir do dia seguinte. Expirar no próprio dia declarado
    // faria toda exceção durar um dia a menos do que a revisão humana aprovou.
    //
    // Comparação textual, não aritmética de datas: `YYYY-MM-DD` tem largura fixa e
    // ordena lexicograficamente na mesma ordem cronológica. Sem diferença de
    // milissegundos, sem horário de verão, sem fuso.
    //
    // Classe de mensagem própria: "inválida" e "expirada" pedem ações distintas —
    // corrigir o campo ou renovar a autorização sob revisão humana. A data não aparece:
    // ecoá-la publicaria o calendário interno de afrouxamentos da base.
    //
    // RISCO RESIDUAL REGISTRADO: a versão 1 não impõe horizonte máximo. `9999-12-31` é
    // sintaticamente válida e vigente. Limitar o horizonte é decisão de política, e
    // cabe à revisão humana da entrada — não ao comparador, sozinho e sem spec.
    if (hojeUtc > expiresOn) {
      throw new Error(`entrada ${posicao} de \`exceptions\` expirada`);
    }

    // Forma canônica compartilhada com o snapshot de especificações. Sem regex local,
    // sem recorte e sem normalização: duas grafias nunca designam a mesma autoridade.
    const { spec } = entrada;
    if (typeof spec !== "string" || !SPEC_PATTERN.test(spec)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`spec\` inválida`);
    }
    if (specsConfiaveis === undefined) {
      try {
        specsConfiaveis = buildBaseSnapshot({
          root: trusted,
          directory: "specs",
          pattern: SPEC_PATTERN,
          allowEmpty: true
        });
      } catch {
        throw new Error(
          `entrada ${posicao} de \`exceptions\` com snapshot confiável de specs inválido`
        );
      }
    }
    if (!specsConfiaveis.has(spec)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`spec\` ausente na base confiável`);
    }
    let metadata;
    if (metadadosPorSpec.has(spec)) {
      metadata = metadadosPorSpec.get(spec);
    } else {
      try {
        metadata = parseSpecMeta(readEntryText(specsConfiaveis.get(spec)));
        assertSpecIdentity(metadata, basename(spec));
      } catch {
        throw new Error(`entrada ${posicao} de \`exceptions\` com \`spec\` inválida na base confiável`);
      }
      metadadosPorSpec.set(spec, metadata);
    }
    if (metadata.status !== "approved") {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`spec\` não aprovada`);
    }
    if (!ehReferenciaDeIssueValida(metadata.issue)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`spec\` inválida na base confiável`);
    }
    const { issue } = entrada;
    if (!ehReferenciaDeIssueValida(issue)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com \`issue\` inválida`);
    }
    if (issue !== metadata.issue) {
      throw new Error(
        `entrada ${posicao} de \`exceptions\` com \`issue\` diferente da especificação confiável`
      );
    }

    // Unicidade apurada sobre o valor CANÔNICO e independentemente de `spec`, `issue`
    // e `expiresOn`. Uma autorização é atômica: duplicá-la variando a expiração
    // criaria vigências concorrentes para o mesmo afrouxamento, e a consulta não teria
    // como escolher entre elas.
    if (!autorizacoes.has(changeClass)) {
      autorizacoes.set(changeClass, new Map());
    }
    const porAlvo = autorizacoes.get(changeClass);
    if (!porAlvo.has(target)) {
      porAlvo.set(target, new Set());
    }
    const valoresDoAlvo = porAlvo.get(target);
    if (valoresDoAlvo.has(valorCanonico)) {
      throw new Error(`entrada ${posicao} de \`exceptions\` com autorização canônica duplicada`);
    }
    valoresDoAlvo.add(valorCanonico);

    // Ordem original preservada: as entradas são acrescentadas na sequência em que
    // aparecem no arquivo, sem ordenação.
    entradasCanonicas.push({ ...entrada, value: valorCanonico });
  }

  // Já validados até aqui: a forma estrutural de cada entrada, o contrato e a
  // unicidade de `id`, o conjunto fechado de classes com seus alvos admissíveis, o
  // tipo e a canonicalização de `value` por classe, o formato, a existência e a
  // vigência de `expiresOn`, a existência e aprovação da spec no snapshot confiável,
  // a forma e correspondência exata da issue, e a unicidade da tripla canônica
  // `changeClass` + `target` + `value`.
  //
  // Um registro que chega aqui está bem formado e canonicalizado. A consulta abaixo
  // ainda é unilateral e exata: somente estas entradas da base podem autorizar um
  // afrouxamento posteriormente detectado na política candidata.
  return { ...registro, exceptions: entradasCanonicas };
}

function carregarPolitica(root, origem) {
  let texto;
  try {
    texto = readFileSync(join(root, "quality", "policy.json"), "utf8");
  } catch {
    throw new Error(`política ${origem} ausente ou ilegível`);
  }
  let policy;
  try {
    policy = JSON.parse(texto);
  } catch {
    throw new Error(`política ${origem} não é JSON válido`);
  }
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error(`política ${origem} com forma inválida`);
  }
  return policy;
}

function assertQuantidadeDeComandos(trustedPolicy, candidatePolicy) {
  if (
    !Array.isArray(trustedPolicy.commands) ||
    !Array.isArray(candidatePolicy.commands) ||
    trustedPolicy.commands.length !== 6 ||
    candidatePolicy.commands.length !== 6
  ) {
    throw new Error("comandos da política candidata divergem da base confiável");
  }
  for (let index = 0; index < 6; index += 1) {
    const trustedCommand = trustedPolicy.commands[index];
    const candidateCommand = candidatePolicy.commands[index];
    if (
      trustedCommand === null ||
      typeof trustedCommand !== "object" ||
      Array.isArray(trustedCommand) ||
      candidateCommand === null ||
      typeof candidateCommand !== "object" ||
      Array.isArray(candidateCommand) ||
      typeof trustedCommand.name !== "string" ||
      typeof candidateCommand.name !== "string" ||
      trustedCommand.name !== candidateCommand.name ||
      typeof trustedCommand.executable !== "string" ||
      typeof candidateCommand.executable !== "string" ||
      trustedCommand.executable !== candidateCommand.executable ||
      typeof trustedCommand.origin !== "string" ||
      typeof candidateCommand.origin !== "string" ||
      trustedCommand.origin !== candidateCommand.origin ||
      !Array.isArray(trustedCommand.args) ||
      !Array.isArray(candidateCommand.args) ||
      trustedCommand.args.some((arg) => typeof arg !== "string") ||
      candidateCommand.args.some((arg) => typeof arg !== "string") ||
      trustedCommand.args.length !== candidateCommand.args.length ||
      trustedCommand.args.some((arg, argIndex) => arg !== candidateCommand.args[argIndex])
    ) {
      throw new Error("comandos da política candidata divergem da base confiável");
    }
  }
}

function exigirAutorizacao(registro, changeClass, target, valorObservado) {
  const canonicalizador = CANONICALIZADOR_POR_CLASSE.get(changeClass);
  const valorCanonico = canonicalizador(valorObservado);
  if (valorCanonico === VALOR_INVALIDO) {
    throw new Error("política com forma inválida");
  }
  const autorizada = registro.exceptions.some(
    (entrada) =>
      entrada.changeClass === changeClass &&
      entrada.target === target &&
      entrada.value === valorCanonico
  );
  if (!autorizada) {
    throw new Error("afrouxamento da política sem autorização confiável");
  }
}

function compararEnabled(trustedPolicy, candidatePolicy, registro) {
  if (typeof trustedPolicy.enabled !== "boolean" || typeof candidatePolicy.enabled !== "boolean") {
    throw new Error("política com forma inválida");
  }
  if (trustedPolicy.enabled === true && candidatePolicy.enabled === false) {
    exigirAutorizacao(registro, "enabled-disabled", "enabled", candidatePolicy.enabled);
  }
}

function compararLimiaresDeCobertura(trustedPolicy, candidatePolicy, registro) {
  const alvos = ["lines", "branches", "functions", "statements"];
  if (
    trustedPolicy.coverage === null ||
    typeof trustedPolicy.coverage !== "object" ||
    Array.isArray(trustedPolicy.coverage) ||
    candidatePolicy.coverage === null ||
    typeof candidatePolicy.coverage !== "object" ||
    Array.isArray(candidatePolicy.coverage)
  ) {
    throw new Error("política com forma inválida");
  }
  for (const target of alvos) {
    const trustedValue = canonicalThreshold(trustedPolicy.coverage[target]);
    const candidateValue = canonicalThreshold(candidatePolicy.coverage[target]);
    if (trustedValue === VALOR_INVALIDO || candidateValue === VALOR_INVALIDO) {
      throw new Error("política com forma inválida");
    }
    if (candidateValue < trustedValue) {
      exigirAutorizacao(
        registro,
        "coverage-threshold-lowered",
        `coverage.${target}`,
        candidateValue
      );
    }
  }
}

function compararComplexidade(trustedPolicy, candidatePolicy, registro) {
  const trustedValue = canonicalComplexityMax(
    trustedPolicy.complexity?.maxCyclomaticPerFunction
  );
  const candidateValue = canonicalComplexityMax(
    candidatePolicy.complexity?.maxCyclomaticPerFunction
  );
  if (trustedValue === VALOR_INVALIDO || candidateValue === VALOR_INVALIDO) {
    throw new Error("política com forma inválida");
  }
  if (candidateValue > trustedValue) {
    exigirAutorizacao(
      registro,
      "complexity-max-raised",
      "complexity.maxCyclomaticPerFunction",
      candidateValue
    );
  }
}

function canonicalizarLista(valores, canonicalizador) {
  if (!Array.isArray(valores)) throw new Error("política com forma inválida");
  const canonicos = valores.map((valor) => canonicalizador(valor));
  if (canonicos.some((valor) => valor === VALOR_INVALIDO)) {
    throw new Error("política com forma inválida");
  }
  return canonicos;
}

function compararExclusoesDeCobertura(trustedPolicy, candidatePolicy, registro) {
  const trustedValues = new Set(
    canonicalizarLista(trustedPolicy.coverage?.exclude, canonicalCoverageExclusion)
  );
  const candidateValues = new Set(
    canonicalizarLista(candidatePolicy.coverage?.exclude, canonicalCoverageExclusion)
  );
  for (const value of candidateValues) {
    if (!trustedValues.has(value)) {
      exigirAutorizacao(registro, "coverage-exclusion-added", "coverage.exclude", value);
    }
  }
}

function compararPadroesCanonicos(trustedPolicy, candidatePolicy, registro) {
  const trustedValues = new Set(
    canonicalizarLista(trustedPolicy.appliesWhenChanged, canonicalAppliesPattern)
  );
  const candidateValues = new Set(
    canonicalizarLista(candidatePolicy.appliesWhenChanged, canonicalAppliesPattern)
  );
  for (const value of trustedValues) {
    if (!candidateValues.has(value)) {
      exigirAutorizacao(registro, "canonical-pattern-removed", "appliesWhenChanged", value);
    }
  }
}

function compararAllowedRebuilds(trustedPolicy, candidatePolicy, registro) {
  const trustedValues = new Set(
    canonicalizarLista(trustedPolicy.allowedRebuilds, canonicalRebuildPackage)
  );
  const candidateValues = new Set(
    canonicalizarLista(candidatePolicy.allowedRebuilds, canonicalRebuildPackage)
  );
  for (const value of candidateValues) {
    if (!trustedValues.has(value)) {
      exigirAutorizacao(registro, "allowed-rebuild-added", "allowedRebuilds", value);
    }
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const registro = carregarRegistroConfiavel(options.get("--trusted"));
  const trustedPolicy = carregarPolitica(options.get("--trusted"), "confiável");
  const candidatePolicy = carregarPolitica(options.get("--candidate"), "candidata");
  assertQuantidadeDeComandos(trustedPolicy, candidatePolicy);
  compararEnabled(trustedPolicy, candidatePolicy, registro);
  compararLimiaresDeCobertura(trustedPolicy, candidatePolicy, registro);
  compararComplexidade(trustedPolicy, candidatePolicy, registro);
  compararExclusoesDeCobertura(trustedPolicy, candidatePolicy, registro);
  compararPadroesCanonicos(trustedPolicy, candidatePolicy, registro);
  compararAllowedRebuilds(trustedPolicy, candidatePolicy, registro);
  process.stdout.write("Política candidata compatível com a política confiável.\n");
} catch (error) {
  process.stderr.write(`Política reprovada: ${error.message}\n`);
  process.exitCode = 1;
}
