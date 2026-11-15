#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const MAX_CANDIDATE_BYTES = 1024 * 1024;
const MAX_IGNORE_ARRAYS = 50;
const MAX_PATTERNS_PER_ARRAY = 1000;
const MAX_PATTERN_LENGTH = 1024;
const MAX_PATTERN_SEGMENTS = 32;

const NAO_CANONICO = "padrão de caminho em forma não canônica";
const SINTAXE_NAO_SUPORTADA = "padrão de caminho usa sintaxe não suportada pelo verificador";
const LIMITE_PADRAO = "padrão de caminho excede os limites estruturais";
const LIMITE_LISTA = "lista de padrões excede os limites estruturais";
const LIMITE_ARQUIVO = "arquivo de configuração candidata excede o tamanho máximo";
const TOKEN_NAO_CANONICO = "token fora da gramática canônica da configuração";
const COMENTARIO_SEM_FECHAMENTO = "comentário de bloco sem fechamento";
const PREAMBULO_NAO_CANONICO = "apenas espaços e comentários podem preceder export default";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--candidate" && flag !== "--trusted") {
      throw new Error(flag.startsWith("--") ? "argumento inválido" : "uso: informe --candidate e --trusted");
    }
    if (values.has(flag)) throw new Error(`argumento repetido: ${flag}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.trim() === "") {
      throw new Error(`${flag} exige um valor`);
    }
    values.set(flag, value);
    index += 1;
  }
  if (!values.has("--candidate") || !values.has("--trusted")) {
    throw new Error("uso: informe --candidate e --trusted");
  }
  return values;
}

// Filesystem sem distinção de caixa. Em win32 `Candidate` e `candidate` são o MESMO
// diretório no disco; comparar segmentos por texto exato os veria como disjuntos e a
// árvore candidata, acessada por uma grafia que difere só na caixa, poderia suprir a
// configuração que o gate trata como confiável — a autoaprovação por colisão de caixa.
// A dobra é CONDICIONADA à plataforma: em filesystem case-sensitive (Linux, o CI de
// governance em Ubuntu) as duas grafias são diretórios genuinamente distintos e
// precisam continuar disjuntos. Decisão de plano: dobra de caixa, NÃO `realpath` —
// symlink e UNC permanecem fora de escopo. `toLowerCase` é determinístico e
// suficiente aqui; nenhuma comparação depende de locale.
const FILESYSTEM_INSENSIVEL_A_CAIXA = process.platform === "win32";

function dobraDeCaixa(segmento) {
  return FILESYSTEM_INSENSIVEL_A_CAIXA ? segmento.toLowerCase() : segmento;
}

// Segmentos de caminho canônicos de uma raiz já resolvida. Divide pelo separador da
// plataforma e descarta segmentos vazios — o resíduo de barras repetidas ou finais —,
// de modo que a comparação seja por NOME de componente, nunca por texto. Em filesystem
// sem distinção de caixa cada segmento é dobrado, para que a comparação enxergue o
// mesmo diretório sob grafias que diferem só na caixa. Symlink e realpath ficam fora
// de escopo: as raízes chegam apenas por `resolve`, e uma junção via link simbólico
// não é normalizada aqui.
function segmentosDaRaiz(root) {
  return root
    .split(sep)
    .filter((segmento) => segmento !== "")
    .map(dobraDeCaixa);
}

// Uma raiz é prefixo POR SEGMENTO da outra quando toda a sequência de componentes da
// mais curta reaparece, na mesma ordem e desde o início, na mais longa. É a checagem
// que distingue sobreposição real de mera coincidência textual: `candidate-2` não é
// prefixo de `candidate`, porque `["candidate-2"]` e `["candidate"]` diferem no
// primeiro segmento — enquanto uma comparação por prefixo de string aceitaria a
// coincidência e recusaria irmãos legítimos. Raízes idênticas caem aqui também, pois
// cada uma é prefixo da outra. Os segmentos já chegam dobrados quando o filesystem é
// case-insensitive, de modo que a igualdade `===` fica sem distinção de caixa lá.
function prefixoPorSegmento(curta, longa) {
  if (curta.length > longa.length) return false;
  return curta.every((segmento, indice) => segmento === longa[indice]);
}

// A raiz confiável e a candidata precisam ser inequívocas e disjuntas. Se uma contém
// a outra — ou se coincidem —, a árvore candidata pode suprir a configuração que o
// gate trata como confiável, e a verificação se autoaprova. A recusa é por segmentos
// canônicos, nunca por prefixo textual, e tem classe própria para descrever o defeito
// real: fronteira violada, não valor incompatível.
function assertRaizesDisjuntas(trusted, candidate) {
  const segmentosTrusted = segmentosDaRaiz(trusted);
  const segmentosCandidate = segmentosDaRaiz(candidate);
  const curta = segmentosTrusted.length <= segmentosCandidate.length ? segmentosTrusted : segmentosCandidate;
  const longa = curta === segmentosTrusted ? segmentosCandidate : segmentosTrusted;
  if (prefixoPorSegmento(curta, longa)) {
    throw new Error("raízes confiável e candidata não podem coincidir nem se sobrepor");
  }
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

// A decisão de cobertura é ESTRUTURAL: ver a seção "leitura estrutural da
// configuração de cobertura". Nenhuma âncora textual participa dela.
//
// A política confiável é verificada ANTES da candidata. Sem isso a decisão
// degrada em silêncio: com `coverage.include` vazio, `assertInclude` aprova
// qualquer escopo (nenhum padrão exigido para conferir) e `assertExclude` não
// deriva raiz protegida nenhuma, de modo que uma exclusão de "src/**" passa
// intacta e o gate de cobertura fica sem objeto. Quem não pode decidir precisa
// reprovar, e a reprovação precisa dizer que o defeito está na política.
function assertCoverage(source, policy) {
  assertPoliticaDeCobertura(policy);
  source = withoutComments(source);
  const exportada = exportedConfig(source);
  if (exportada === null) throw new Error(ESCOPO_INCOMPATIVEL);
  const cadeia = lerCadeiaDeCobertura(exportada);
  assertResiduoDaCobertura(exportada.slice(cadeia.fim));
  assertInclude(exportada, cadeia.cobertura.get("include"), policy);
  assertExclude(exportada, cadeia.cobertura.get("exclude"), policy);
  assertLimiares(exportada, cadeia.cobertura.get("thresholds"), policy);
  assertPreambulo(source);
}

// Âncora textual restrita ao único marcador que não tem estrutura para ser lido:
// "export default". Declarar o módulo duas vezes é ambíguo e reprova.
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

// Marcadores de classe ANINHADA dentro de uma classe de caracteres: "[:" abre
// classe nomeada, "[." abre símbolo de colação e "[=" abre classe de
// equivalência. Este verificador não implementa nenhuma das três, e lê-las como
// membros literais é a mesma divergência de dialeto das chaves e do parêntese:
// em "[[:alpha:]]rc" a primeira "]" interna fecharia a classe externa, o "]"
// seguinte viraria caractere comum e o padrão casaria "a]rc", enquanto minimatch
// casa "src" — a raiz protegida inteira sairia do gate com o verificador
// aprovando. A recusa é por FAMÍLIA SINTÁTICA, pelo caractere que ABRE o
// marcador: nenhum nome de classe é enumerado, nada é interpretado e o marcador
// truncado recebe o mesmo tratamento do completo, porque reconhecer o fechamento
// exigiria justamente o vocabulário que esta regra se recusa a ter.
const MARCADOR_DE_CLASSE_ANINHADA = new Set([":", ".", "="]);

// O dialeto canônico usa "/" como separador e NÃO oferece sintaxe de escape
// dentro do glob. Uma contrabarra no valor DECODIFICADO do padrão é, portanto,
// a mesma divergência de dialeto das chaves, do extglob e da classe aninhada,
// e da pior espécie: em "src/\*/**/*.ts" este verificador lê "\" como caractere
// comum e "*" como coringa, conclui que o escopo alcança arquivos sob a raiz
// protegida e APROVA, enquanto picomatch lê "\*" como asterisco literal
// escapado, o ESLint procura um diretório chamado literalmente "*", não encontra
// nada e o gate de complexidade cobre zero arquivo. O verificador acredita em um
// alcance que o consumidor não tem.
//
// A recusa NÃO interpreta escapes, NÃO converte "\" em "/" e NÃO tenta
// distinguir separador de Windows de caractere de escape: cada uma dessas
// leituras seria uma divergência NOVA, com a mesma origem. A regra é só esta:
// valor decodificado com contrabarra não é canônico.
//
// Ponto ÚNICO de rejeição, chamado de todos os lugares em que um caractere do
// valor decodificado é CONSUMIDO — o laço de `compileSegment`, o laço de
// `compileClass` e a leitura do limite superior de um intervalo. Os dois últimos
// são necessários porque `compileClass` consome o conteúdo da classe sem
// devolver o controle ao laço do segmento, e medimos que sem eles
// "src/[\]m]odules/**" continuava aprovando como exclusão de cobertura: este
// verificador fecha a classe na primeira "]" e lê o resto como "m]odules",
// enquanto picomatch lê a classe {"]", "m"} e casa "modules".
const CONTRABARRA = "\\";

function assertSemContrabarra(character) {
  if (character === CONTRABARRA) throw new Error(SINTAXE_NAO_SUPORTADA);
}

// Classe de caracteres POSIX: "]" logo após "[", "[!" ou "[^" é literal e não fecha
// a classe. Classe sem fechamento ou com intervalo invertido não tem semântica
// inequívoca e reprova.
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
    assertSemContrabarra(character);
    if (character === "]" && !first) {
      tokens.push({ type: "class", negated, ranges });
      return index;
    }
    // Decisão tomada ANTES do intervalo e antes de empilhar o membro literal: são
    // os dois únicos ramos capazes de consumir este "[" como dado, e depois de
    // qualquer um deles a posição do marcador já não é conhecida. Depois da
    // checagem de "]" para que o fechamento e o "]" literal logo após a abertura
    // mantenham a semântica que já tinham.
    if (character === "[" && MARCADOR_DE_CLASSE_ANINHADA.has(segment[index + 1])) {
      throw new Error(SINTAXE_NAO_SUPORTADA);
    }
    first = false;
    if (segment[index + 1] === "-" && index + 2 < segment.length && segment[index + 2] !== "]") {
      const upper = segment[index + 2];
      assertSemContrabarra(upper);
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

// Formas de glob que este verificador NÃO implementa e que os consumidores reais
// — ESLint e Vitest, via minimatch e picomatch — interpretam como SINTAXE. Tratá-las
// como sequência literal é uma divergência de dialeto explorável: "{src,vendor}/**"
// pareceria nomear um diretório literal chamado "{src,vendor}" e o consumidor o
// expandiria para "src". Implementar o dialeto aumentaria a superfície do matcher;
// a decisão é recusar, fail-closed.
//
// O parêntese fora de classe é a mesma divergência, e não depende de um operador
// de extglob antes dele: em picomatch ele entra na expressão regular gerada como
// GRUPO, de modo que "docs/(nota)/**" casaria "docs/nota" no consumidor enquanto
// aqui casaria o nome literal "(nota)". Recusar o parêntese cobre também "@(",
// "+(", "?(", "*(" e "!(" em segmento posterior: o operador vira caractere comum e
// o lançamento ocorre um caractere adiante, com a mesma classe e a mesma mensagem.
// Por isso a guarda de lookahead por operador foi removida — era redundante, e a
// equivalência foi medida vetor a vetor antes e depois da remoção.
const CHAVE_DE_EXPANSAO = new Set(["{", "}"]);
const PARENTESE_DE_GRUPO = new Set(["(", ")"]);

function compileSegment(segment) {
  const tokens = [];
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    // Decisão tomada no próprio laço de lexing, onde a posição já é conhecida: o
    // conteúdo de uma classe de caracteres é consumido por `compileClass` e nunca
    // chega aqui, então "[{}]", "[@+?!]" e "[()]" permanecem caracteres comuns.
    // Fora da classe, "?" e "*" seguem coringas e "@", "+" e "!" seguem literais;
    // quem reprova é o parêntese, sem lookahead nenhum. A contrabarra reprova
    // antes de tudo, e também sem lookahead: o que ela precede é irrelevante,
    // porque a própria presença dela já não é canônica.
    assertSemContrabarra(character);
    if (CHAVE_DE_EXPANSAO.has(character)) throw new Error(SINTAXE_NAO_SUPORTADA);
    if (PARENTESE_DE_GRUPO.has(character)) throw new Error(SINTAXE_NAO_SUPORTADA);
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

// Precedência fixa, e nesta ordem. PRIMEIRO o extglob de negação: "!(docs)/**" não
// é um padrão de negação escrito fora da convenção, é um extglob que este
// verificador não interpreta, e reprovar pela classe de negação descreveria o
// defeito errado. DEPOIS a negação comum: "!src/**" reprova por forma não canônica.
// SÓ ENTÃO os limites estruturais, porque um padrão negado longo ou profundo
// continua sendo, antes de tudo, um padrão negado, e o diagnóstico de limite
// esconderia a negação. Por último a compilação dos segmentos, em que "!(" em
// segmento POSTERIOR volta a ser dialeto não suportado.
function compilePattern(pattern) {
  if (pattern.startsWith("!(")) throw new Error(SINTAXE_NAO_SUPORTADA);
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

// Estados iniciais do autômato de um segmento, já com a passagem livre pelas
// estrelas, que casam a sequência vazia.
function linhaInicial(tokens) {
  const row = new Array(tokens.length + 1).fill(false);
  row[0] = true;
  for (let index = 0; index < tokens.length; index += 1) {
    if (row[index] && tokens[index].type === "star") row[index + 1] = true;
  }
  return row;
}

// Um passo do autômato: consome um caractere e devolve o novo conjunto de
// estados. Não há retrocesso.
function avancarCaractere(tokens, row, character) {
  const total = tokens.length;
  const next = new Array(total + 1).fill(false);
  for (let index = 0; index < total; index += 1) {
    if (!row[index]) continue;
    if (tokens[index].type === "star") next[index] = true;
    else if (matchesToken(tokens[index], character)) next[index + 1] = true;
  }
  for (let index = 0; index < total; index += 1) {
    if (next[index] && tokens[index].type === "star") next[index + 1] = true;
  }
  return next;
}

// Autômato por programação dinâmica: cada caractere avança um conjunto de estados
// limitado pelo número de tokens.
function matchSegment(tokens, text) {
  let row = linhaInicial(tokens);
  for (const character of text) row = avancarCaractere(tokens, row, character);
  return row[tokens.length];
}

const RAIZ_PROTEGIDA = "src";
const SEGMENTO_ATUAL = ".";
const SEGMENTO_PAI = "..";

function segmentoLiteral(segment, texto) {
  return (
    !segment.globstar &&
    segment.tokens.length === texto.length &&
    segment.tokens.every((token, posicao) => token.type === "char" && token.value === texto[posicao])
  );
}

// Decide o alcance de "src/**" pela GRAMÁTICA do padrão, não por uma lista finita
// de caminhos-testemunha: o contrato fala de QUALQUER caminho sob a raiz
// protegida, e nenhuma lista de caminhos concretos cobre os nomes que ainda não
// existem. Um padrão só fica comprovadamente fora de src quando o primeiro
// segmento significativo não casa "src": nesse caso nenhum caminho casado, nem
// mesmo um prefixo de diretório, começa por "src". Quando o primeiro segmento
// pode casar "src", os segmentos seguintes casam nomes de descendentes e o alcance
// existe. Globstar inicial casa em qualquer profundidade, e ".." reescreve o
// caminho: ambos alcançam. Padrão sem segmento significativo não prova nada e
// reprova, como o padrão vazio ou ".", que alcançam a árvore inteira.
function alcancaSrc(pattern) {
  const segments = compilePattern(pattern);
  if (segments.some((segment) => segmentoLiteral(segment, SEGMENTO_PAI))) return true;
  for (const segment of segments) {
    if (segment.globstar) return true;
    if (segment.tokens.length === 0 || segmentoLiteral(segment, SEGMENTO_ATUAL)) continue;
    return matchSegment(segment.tokens, RAIZ_PROTEGIDA);
  }
  return true;
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

// Leitura estrutural da configuração de lint, limitada ao contrato aceito: um
// único "export default" cuja expressão é um array literal de objetos literais,
// com a propriedade de padrões ignorados escrita literalmente no nível superior
// do objeto. Toda forma indireta — chamada, identificador, espalhamento,
// acessador, método, chave computada dinâmica, identificador escapado ou chave
// citada com escape — só teria valor conhecido depois de avaliar o módulo, e
// avaliar a candidata é proibido. Nada aqui interpreta JavaScript além disso.
const NAO_CANONICO_LINT = "configuração de lint em forma não canônica";
const COBERTURA_NAO_CANONICA = "configuração de cobertura em forma não canônica";
const POLITICA_SEM_ESCOPO = "política confiável não define escopo de cobertura utilizável";
const COBERTURA_DUPLICADA = "configuração ambígua: propriedade de cobertura declarada duas vezes no mesmo objeto";
const ESCOPO_INCOMPATIVEL = "escopo de cobertura incompatível com a política";
const EXCLUSAO_INCOMPATIVEL = "exclusão de cobertura incompatível com a política";
const LIMIAR_INCOMPATIVEL = "limiar de cobertura incompatível com a política";
const IGNORES_NAO_LITERAL = "lista de padrões ignorados não é um array literal";
const IGNORES_ILEGIVEL = "lista de padrões ignorados ilegível ou não textual";
const IGNORES_DUPLICADO = "configuração ambígua: padrões ignorados declarados duas vezes no mesmo bloco";
const COMPLEXIDADE_INCOMPATIVEL = "regra de complexidade incompatível com a política";
const COMPLEXIDADE_SEM_ALCANCE = "regra de complexidade não alcança os arquivos de src";
const REGRA_COMPLEXIDADE = "complexity";
const PROPRIEDADE_ESCOPO = "files";
const PROPRIEDADE_REGRAS = "rules";
const SEVERIDADE_EXIGIDA = "error";
const VARIANTE_EXIGIDA = "classic";

// --- H3a. Importação canônica, vínculo com o analisador e propriedade proibida.
//
// As três mensagens descrevem a CLASSE do defeito e nada mais: nenhum nome de
// chave, pacote, caminho ou expressão da candidata volta ao autor do arquivo.
const IMPORTACAO_NAO_CANONICA = "preâmbulo da configuração de lint fora da gramática canônica";
const ANALISADOR_SEM_IMPORTACAO = "analisador declarado sem a importação canônica";
const ANALISADOR_AUSENTE = "bloco de complexidade não declara o analisador exigido";
const PROPRIEDADE_PROIBIDA = "propriedade proibida na configuração de lint";

// --- H3b1. Proteções locais do bloco de complexidade.
//
// Declarar a regra e deixar o bloco sem proteções locais é ter o gate no papel e
// não no efeito: uma diretiva escrita em comentário DENTRO do código analisado
// desliga a regra arquivo a arquivo, e uma diretiva de desativação que sobrou
// deixa de ser reportada. A mensagem descreve a CLASSE do defeito e nada mais:
// nenhum nome de propriedade, valor ou expressão da candidata volta ao autor.
const PROTECOES_INCOMPATIVEIS = "proteções locais da configuração de lint ausentes ou incompatíveis";

const PROPRIEDADE_PROTECOES = "linterOptions";
const PROTECAO_INLINE = "noInlineConfig";
const PROTECAO_DIRETIVAS = "reportUnusedDisableDirectives";
const VERDADEIRO = "true";

const PROPRIEDADE_ANALISADOR = "languageOptions";
const PROPRIEDADE_PROCESSADOR = "processor";
const ANALISADOR = "parser";
const PACOTE_DO_ANALISADOR = "@typescript-eslint/parser";
const PALAVRA_IMPORT = "import";
const PALAVRA_FROM = "from";

const IDENTIFICADOR_INICIO = /[A-Za-z_$]/u;
const IDENTIFICADOR_CORPO = /[A-Za-z0-9_$]/u;
const FECHAMENTOS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"]
]);

function significantIndex(source, from) {
  let index = from;
  while (index < source.length && /\s/u.test(source[index])) index += 1;
  return index;
}

// Avança até depois da aspa final. Retorna -1 quando o literal não fecha.
function skipQuoted(source, start) {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === quote) return index + 1;
  }
  return -1;
}

function readIdentifier(source, start) {
  if (!IDENTIFICADOR_INICIO.test(source[start] ?? "")) return null;
  let end = start;
  while (end < source.length && IDENTIFICADOR_CORPO.test(source[end])) end += 1;
  return { name: source.slice(start, end), end };
}

// Chave citada: usa o leitor do G1 e recusa qualquer escape, porque a grafia
// canônica da chave é textual.
function readQuotedKey(source, start) {
  const literal = readStringLiteral(source, start);
  if (literal === null) return null;
  if (source.slice(start, literal.end).includes("\\")) return null;
  return { name: literal.value, end: literal.end };
}

// Dialetos de leitura estrutural. Cada superfície tem a própria classe de erro, e
// a cobertura não admite chave entre colchetes: o contrato do lint aceita
// `["ignores"]` desde o G2 e permanece intacto, mas a cadeia de cobertura exige a
// grafia direta da chave, porque ali qualquer colchete é o mesmo primitivo usado
// para montar a chave por concatenação ou por template.
const ERROS_LINT = {
  naoCanonico: NAO_CANONICO_LINT,
  duplicado: (name) => (name === "ignores" ? IGNORES_DUPLICADO : NAO_CANONICO_LINT),
  chaveComputada: true
};

const ERROS_COBERTURA = {
  naoCanonico: COBERTURA_NAO_CANONICA,
  duplicado: () => COBERTURA_DUPLICADA,
  chaveComputada: false
};

// Dialeto das proteções locais do bloco: nível FECHADO e chave DIRETA. Aqui nem
// a grafia citada é canônica — ao contrário de `ignores`, que a admite desde o
// G2 —, porque este nível tem exatamente duas chaves conhecidas e qualquer
// grafia indireta delas é indistinguível de uma chave montada em tempo de
// execução. Chave repetida, acessador, método e espalhamento também reprovam
// aqui, e todos pela MESMA classe: o defeito é a forma do nível inteiro.
const ERROS_PROTECOES = {
  naoCanonico: PROTECOES_INCOMPATIVEIS,
  duplicado: () => PROTECOES_INCOMPATIVEIS,
  chaveComputada: false,
  chaveCitada: false
};

// A GRAFIA da chave acompanha o nome decodificado. Dois nomes iguais podem vir
// de formas diferentes — `x`, `"x"` e `["x"]` — e nem toda propriedade aceita as
// três: `ignores` aceita desde o G2 e as proteções locais do bloco não. Sem esta
// informação a única saída seria endurecer o dialeto INTEIRO do lint, o que
// revogaria a tolerância histórica de `ignores`. O dado é acrescentado ao
// resultado da leitura; nenhum campo existente muda de nome ou de significado.
const GRAFIA_DIRETA = "direta";
const GRAFIA_CITADA = "citada";
const GRAFIA_COMPUTADA = "computada";

const comGrafia = (key, grafia) => (key === null ? null : { name: key.name, end: key.end, grafia });

function readPropertyKey(source, start, erros = ERROS_LINT) {
  const character = source[start];
  if (character === '"' || character === "'") {
    return erros.chaveCitada === false ? null : comGrafia(readQuotedKey(source, start), GRAFIA_CITADA);
  }
  if (character !== "[") return comGrafia(readIdentifier(source, start), GRAFIA_DIRETA);
  if (!erros.chaveComputada) return null;
  const key = readQuotedKey(source, significantIndex(source, start + 1));
  if (key === null) return null;
  const close = significantIndex(source, key.end);
  return source[close] === "]" ? { name: key.name, end: close + 1, grafia: GRAFIA_COMPUTADA } : null;
}

// Percorre o valor de uma propriedade não inspecionada até o separador ou o
// fechamento do objeto. Retorna -1 quando os delimitadores não se equilibram.
function skipValue(source, start) {
  const stack = [];
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index);
      if (index === -1) return -1;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (FECHAMENTOS.has(character)) {
      if (!stack.length) return character === "}" ? index : -1;
      if (stack.pop() !== FECHAMENTOS.get(character)) return -1;
    } else if (character === "," && !stack.length) return index;
    index += 1;
  }
  return -1;
}

// Entrega o conteúdo do array ao leitor do G1 e devolve a posição após o "]".
function readIgnoresArray(source, start, listas) {
  if (source[start] !== "[") throw new Error(IGNORES_NAO_LITERAL);
  const content = balancedContent(source, start, "[", "]");
  const patterns = literalStringArray(content);
  if (patterns === null) throw new Error(IGNORES_ILEGIVEL);
  listas.push(patterns);
  return start + content.length + 2;
}

// Uma propriedade canônica é chave simples ou citada sem escape, seguida de ":".
// Espalhamento, acessador e método não passam por aqui: "..." não é chave, e
// "get x()" ou "x()" não têm o separador exigido.
function readProperty(source, start, erros = ERROS_LINT) {
  const key = readPropertyKey(source, start, erros);
  const colon = key === null ? -1 : significantIndex(source, key.end);
  if (key === null || source[colon] !== ":") throw new Error(erros.naoCanonico);
  return { name: key.name, value: significantIndex(source, colon + 1), grafia: key.grafia };
}

// Percorre as propriedades de nível superior de um objeto literal e delega cada
// valor ao leitor informado, que devolve a posição após o valor. O leitor recebe
// o nome, a posição do valor e a GRAFIA da chave; os dois primeiros parâmetros
// são os de sempre, e quem não precisa da grafia simplesmente a ignora. Chave
// repetida reprova em qualquer ordem, porque a última declaração venceria em
// silêncio, e reprova qualquer que seja a grafia: o nome decodificado é o mesmo.
// Devolve a posição após o "}".
function readObjectProperties(source, start, readValue, erros = ERROS_LINT) {
  if (source[start] !== "{") throw new Error(erros.naoCanonico);
  const vistas = new Set();
  let index = significantIndex(source, start + 1);
  while (index < source.length) {
    if (source[index] === "}") return index + 1;
    const property = readProperty(source, index, erros);
    if (vistas.has(property.name)) throw new Error(erros.duplicado(property.name));
    vistas.add(property.name);
    index = significantIndex(source, readValue(property.name, property.value, property.grafia));
    if (source[index] === "}") return index + 1;
    if (source[index] !== ",") throw new Error(erros.naoCanonico);
    index = significantIndex(source, index + 1);
  }
  throw new Error(erros.naoCanonico);
}

function readSkippedValue(source, start, erros = ERROS_LINT) {
  const end = skipValue(source, start);
  if (end === -1) throw new Error(erros.naoCanonico);
  return end;
}

// H3b3. Aqui vivia `readValorEstatico`, o leitor de valor de propriedade NÃO
// INSPECIONADA dos níveis exportado e `test`. Ele saiu junto com a tolerância
// que servia: sem nível aberto, nenhuma propriedade desconhecida chega a ter o
// valor lido, e o código ficaria inalcançável. Saíram com ele
// `fimDeValorEstatico` e os conjuntos `ABRE_LITERAL`, `ABRE_DELIMITADOR` e
// `PARENTESE_DE_CHAMADA`, que não tinham outro chamador. `FECHAMENTOS` e
// `skipQuoted` continuam, porque são compartilhados com `skipValue`.
//
// O registro da retirada importa: o critério dele era a ausência de parêntese,
// e essa era a garantia fraca que o fechamento substituiu.

// Literal textual sem escape: a grafia canônica da severidade e da variante é
// direta, e "\x65rror" só seria conhecido depois de avaliar o módulo.
function readTextoExato(source, start, esperado) {
  const literal = readStringLiteral(source, start);
  if (literal === null || source.slice(start, literal.end).includes("\\")) return null;
  return literal.value === esperado ? literal.end : null;
}

// Inteiro decimal sem sinal, expoente, separador, ponto ou sufixo: o que vier
// depois dos dígitos é recusado pelo separador exigido no objeto.
//
//   inteiro := "0" | [1-9][0-9]*
//
// H3b2c. O zero à esquerda não é grafia incomum: o arquivo candidato é um módulo
// ES, logo estrito, e ali `007`, `010` e `080` são SyntaxError de literal octal
// legado — `09` e `090` caem na variante decimal não octal, proibida pelo mesmo
// motivo. O consumidor real não carregaria o arquivo, e a leitura anterior o
// aprovava: o desfecho mais grave, porque a aprovação afirma compatibilidade com
// uma configuração inexistente. O zero proibido é o que PRECEDE outro algarismo;
// `0` sozinho continua canônico, porque ali o zero É o inteiro, e a recusa de
// `max: 0` continua vindo da regra de valor de cada consumidor.
function readInteiroDecimal(source, start) {
  let end = start;
  while (end < source.length && source[end] >= "0" && source[end] <= "9") end += 1;
  if (end === start) return null;
  if (source[start] === "0" && end - start > 1) return null;
  const value = Number(source.slice(start, end));
  return Number.isSafeInteger(value) ? { value, end } : null;
}

// O valor da opção precisa terminar onde o literal termina: sufixo, expoente ou
// concatenação depois dele descreveria outro valor.
function fimDeOpcao(source, end) {
  const proximo = source[significantIndex(source, end)];
  return proximo === "," || proximo === "}";
}

function readComplexityOptions(source, start, max) {
  const lidas = new Set();
  const end = readObjectProperties(source, start, (name, value) => {
    if (name === "max") {
      const numero = readInteiroDecimal(source, value);
      if (numero === null || numero.value < 1 || numero.value > max || !fimDeOpcao(source, numero.end)) {
        throw new Error(COMPLEXIDADE_INCOMPATIVEL);
      }
      lidas.add(name);
      return numero.end;
    }
    if (name === "variant") {
      const fim = readTextoExato(source, value, VARIANTE_EXIGIDA);
      if (fim === null || !fimDeOpcao(source, fim)) throw new Error(COMPLEXIDADE_INCOMPATIVEL);
      lidas.add(name);
      return fim;
    }
    throw new Error(COMPLEXIDADE_INCOMPATIVEL);
  });
  if (lidas.size !== 2) throw new Error(COMPLEXIDADE_INCOMPATIVEL);
  return end;
}

// Forma aceita: ["error", { max: N, variant: "classic" }], com aspas simples ou
// duplas e com as opções em qualquer ordem. Exatamente dois elementos, para que
// nenhum terceiro argumento altere a regra.
function readComplexityRule(source, start, max) {
  if (!Number.isFinite(max) || source[start] !== "[") throw new Error(COMPLEXIDADE_INCOMPATIVEL);
  const severidade = readTextoExato(source, significantIndex(source, start + 1), SEVERIDADE_EXIGIDA);
  if (severidade === null) throw new Error(COMPLEXIDADE_INCOMPATIVEL);
  let index = significantIndex(source, severidade);
  if (source[index] !== ",") throw new Error(COMPLEXIDADE_INCOMPATIVEL);
  index = significantIndex(source, index + 1);
  if (source[index] !== "{") throw new Error(COMPLEXIDADE_INCOMPATIVEL);
  index = significantIndex(source, readComplexityOptions(source, index, max));
  if (source[index] !== "]") throw new Error(COMPLEXIDADE_INCOMPATIVEL);
  return index + 1;
}

// --- H3b2b. Valor de REGRA ADICIONAL.
//
// A verificação de `complexity` permanece exatamente como está. Para toda OUTRA
// regra dentro de `rules`, o valor precisa ser descrito inteiramente por
// literais estáticos. Antes ele era percorrido por `readSkippedValue`, que só
// equilibra delimitadores: depois que o H3b2a fechou o nível do bloco e o
// escopo, a regra adicional era o ÚLTIMO lugar da configuração de lint por onde
// `carregar()`, `(() => { ... })()`, `(await import("x")).default` e
// `(globalThis.__PWN__ = 1)` atravessavam intactos — e todos rodam com o
// privilégio da ferramenta no instante em que o ESLint carrega o arquivo.
//
// A recusa não é um parser de JavaScript e não enumera nomes: o leitor aceita a
// gramática fechada dos literais estáticos e reprova tudo o que sobra, pela
// classe genérica de forma. Identificador livre entra na recusa junto com a
// chamada, e `undefined`, `NaN` e `Infinity` não são exceção: são ligações
// globais cujo valor depende do ambiente que carrega o módulo, não literais.
const PALAVRAS_LITERAIS = new Set(["true", "false", "null"]);

// Número decimal na forma canônica:
//
//   numero  := "-"? inteiro ( "." digitos )?
//   inteiro := "0" | [1-9][0-9]*
//   digitos := [0-9]+
//
// Expoente, hexadecimal, separador de milhar e sufixo ficam de fora: o leitor
// para nos dígitos e o resíduo reprova adiante, como em qualquer outro texto
// depois de um literal.
//
// H3b2b.1. Duas exigências foram acrescentadas, e as duas nascem do mesmo
// princípio: o número que a ferramenta LÊ tem de ser o número que o consumidor
// receberia.
//
// A primeira é a FINITUDE do literal completo. `9` repetido 400 vezes e `1`
// seguido de 309 zeros são literais válidos cujo valor é `Infinity`; aprová-los
// registraria um número onde o ESLint receberia um infinito, e o limite escrito
// na regra deixaria de ser um limite.
//
// A segunda é a AUSÊNCIA de zero à esquerda na parte inteira. Não é preferência
// de grafia: o arquivo candidato é um módulo ES, logo estrito, e ali `01`, `007`
// e `00.5` são `SyntaxError` de literal octal legado. O consumidor real não
// carregaria o arquivo, e a leitura anterior o aprovava — o desfecho mais grave,
// porque a aprovação afirma compatibilidade com uma configuração inexistente.
// O zero proibido é o que PRECEDE outro algarismo da parte inteira; `0` e `0.0`
// seguem canônicos, porque ali o zero É a parte inteira.
function readDigitosDecimais(source, start) {
  let index = start;
  while (index < source.length && source[index] >= "0" && source[index] <= "9") index += 1;
  return index;
}

function readParteInteira(source, start) {
  const end = readDigitosDecimais(source, start);
  if (end === start) return null;
  return source[start] === "0" && end - start > 1 ? null : end;
}

function readNumeroDecimal(source, start) {
  const inteiro = readParteInteira(source, source[start] === "-" ? start + 1 : start);
  if (inteiro === null) return null;
  let index = inteiro;
  if (source[index] === PONTO) {
    index = readDigitosDecimais(source, inteiro + 1);
    if (index === inteiro + 1) return null;
  }
  return Number.isFinite(Number(source.slice(start, index))) ? index : null;
}

// Um literal estático escalar. Template literal não entra: a crase é o mesmo
// primitivo que monta o valor por interpolação, e `\`error\`` só seria
// distinguível de `\`err${x}or\`` depois de avaliar o módulo.
function readLiteralDeRegra(source, start) {
  const character = source[start];
  if (character === '"' || character === "'") {
    const literal = readStringLiteral(source, start);
    if (literal === null) throw new Error(NAO_CANONICO_LINT);
    return literal.end;
  }
  const numero = readNumeroDecimal(source, start);
  if (numero !== null) return numero;
  const palavra = readIdentifier(source, start);
  if (palavra === null || !PALAVRAS_LITERAIS.has(palavra.name)) throw new Error(NAO_CANONICO_LINT);
  return palavra.end;
}

// Dialeto do valor de regra: chave direta ou citada sem escape, e NADA de chave
// computada — `["op" + "cao"]` é indistinguível de `["opcao"]` na leitura
// estrutural, e o nome efetivo só existiria depois de avaliar o módulo. Chave
// repetida reprova pela mesma classe: a última declaração venceria em silêncio.
const ERROS_REGRA = {
  naoCanonico: NAO_CANONICO_LINT,
  duplicado: () => NAO_CANONICO_LINT,
  chaveComputada: false
};

// Limite de profundidade do valor de regra. A leitura é um LAÇO com pilha
// PRÓPRIA — não há recursão, e por isso nenhuma profundidade derruba o processo
// por estouro de pilha. O limite existe mesmo assim, para que uma estrutura
// absurda reprove por forma em vez de consumir memória proporcional ao arquivo:
// 10000 fica com folga acima da estrutura mais profunda que já aprovava (5000
// níveis) e é alcançável por um arquivo de ~40 KiB, muito abaixo do teto de
// 1 MiB da candidata — de modo que é sempre o LIMITE que decide, nunca a pilha.
const MAX_PROFUNDIDADE_DE_REGRA = 10000;

const FECHA_CONTAINER = new Map([
  ["[", "]"],
  ["{", "}"]
]);

// Leitor do valor de uma regra adicional. Laço determinístico de um passo para
// frente, com pilha explícita dos containers abertos, alternando entre dois
// estados: esperar um valor e decidir o que vem DEPOIS dele. Devolve a posição
// logo após o valor; o separador exigido pelo objeto que contém a regra é
// conferido por quem chamou, e é ele que reprova `"er" + "ror"`, `1e1` e
// qualquer outro resíduo depois de um literal completo.
// Um passo no estado "esperando um valor". Fechar aqui cobre o container vazio e
// a vírgula final, as duas formas canônicas em que nenhum valor vem a seguir.
// Dentro de um objeto, a chave é lida ANTES do valor, pelo mesmo leitor
// estrutural de propriedades usado no resto do arquivo.
function avancarParaValorDeRegra(source, start, pilha) {
  const index = significantIndex(source, start);
  const topo = pilha[pilha.length - 1];
  if (topo !== undefined && source[index] === topo.fecha) {
    pilha.pop();
    return { index: index + 1, esperandoValor: false };
  }
  let posicao = index;
  if (topo !== undefined && topo.objeto) {
    const propriedade = readProperty(source, posicao, ERROS_REGRA);
    if (topo.vistas.has(propriedade.name)) throw new Error(NAO_CANONICO_LINT);
    topo.vistas.add(propriedade.name);
    posicao = propriedade.value;
  }
  const fecha = FECHA_CONTAINER.get(source[posicao]);
  if (fecha === undefined) return { index: readLiteralDeRegra(source, posicao), esperandoValor: false };
  if (pilha.length >= MAX_PROFUNDIDADE_DE_REGRA) throw new Error(NAO_CANONICO_LINT);
  pilha.push({ fecha, objeto: fecha === "}", vistas: new Set() });
  return { index: posicao + 1, esperandoValor: true };
}

// Um passo no estado "acabei de ler um valor": ou o container fecha, ou vem a
// vírgula que introduz o próximo elemento. Qualquer outra coisa é operador,
// separador ausente ou texto residual, e reprova.
function avancarAposValorDeRegra(source, start, pilha) {
  const index = significantIndex(source, start);
  const topo = pilha[pilha.length - 1];
  if (source[index] === topo.fecha) {
    pilha.pop();
    return { index: index + 1, esperandoValor: false };
  }
  if (source[index] !== ",") throw new Error(NAO_CANONICO_LINT);
  return { index: index + 1, esperandoValor: true };
}

function readValorDeRegra(source, start) {
  const pilha = [];
  let estado = { index: start, esperandoValor: true };
  while (estado.esperandoValor || pilha.length > 0) {
    estado = estado.esperandoValor
      ? avancarParaValorDeRegra(source, estado.index, pilha)
      : avancarAposValorDeRegra(source, estado.index, pilha);
  }
  return estado.index;
}

// Só o objeto efetivamente associado à chave "rules" pode satisfazer a política:
// uma regra escrita em propriedade alheia, em string ou em comentário não compõe
// a configuração aplicada pelo ESLint.
function readRulesObject(source, start, estado, bloco) {
  return readObjectProperties(source, start, (name, value) => {
    if (name !== REGRA_COMPLEXIDADE) return readValorDeRegra(source, value);
    const end = readComplexityRule(source, value, estado.max);
    estado.complexidades += 1;
    bloco.complexidade = true;
    return end;
  });
}

// Escopo do bloco: ausente é global; presente, é ESTRITAMENTE um array literal
// não vazio de literais textuais, e nada além disso.
//
// H3b2a, Fatia 4. Antes, qualquer outra forma virava "escopo desconhecido":
// o valor era percorrido por `readSkippedValue` e o bloco apenas deixava de
// provar alcance. Isso errava em duas frentes. Na primeira, o diagnóstico
// descrevia um defeito que o arquivo não tinha — `files: carregar()` saía como
// "a regra não alcança src", quando o alcance não foi NEGADO, e sim não foi
// LIDO. Na segunda, `readSkippedValue` só equilibra delimitadores, de modo que
// o escopo era o último lugar do bloco por onde `(() => { ... })()` e
// `(await import("x")).default` passavam intactos e rodariam com o privilégio
// da ferramenta assim que o ESLint carregasse a configuração — a mesma porta
// que as Fatias 1 e 2 fecharam para as propriedades desconhecidas.
//
// Array VAZIO reprova aqui, e por forma: ele não é um escopo que erra o alvo, é
// a ausência de escopo escrita com a sintaxe de escopo, e o próprio ESLint
// recusa `files` sem nenhum padrão.
//
// A distinção com a classe de ALCANCE é deliberada e precisa continuar de pé:
// um escopo literal VÁLIDO que não alcança `src` — `["docs/**/*.ts"]` — segue
// reprovando por alcance, porque ali o valor foi lido e a resposta foi não. A
// classe de forma responde outra pergunta: o valor não pôde ser lido.
function readFilesValue(source, start, bloco) {
  if (source[start] !== "[") throw new Error(NAO_CANONICO_LINT);
  const content = balancedContent(source, start, "[", "]");
  const patterns = content === null ? null : literalStringArray(content);
  if (patterns === null || patterns.length === 0) throw new Error(NAO_CANONICO_LINT);
  bloco.escopo = patterns;
  return start + content.length + 2;
}

// Analisador do bloco, nas DUAS grafias em que o valor é estaticamente
// demonstrável sem avaliar o módulo: a propriedade abreviada `{ parser }` e a
// forma explícita `{ parser: parser }`, em que a chave estrutural e o valor são
// o MESMO identificador estático `parser`, ligado à importação canônica do
// preâmbulo — a igualdade textual entre chave e valor prova a ligação sem
// precisar executar nada. Qualquer outra forma — literal textual, outro
// identificador, membro de objeto, chamada, IIFE, importação dinâmica,
// acessador, método, espalhamento — só teria valor depois de avaliar a
// candidata, e avaliar a candidata é proibido. Chave repetida e propriedade
// adicional também reprovam: o nível é FECHADO, com a mesma disciplina já
// aplicada a `coverage` e a `thresholds`.
function readLanguageOptions(source, start, bloco) {
  if (source[start] !== "{") throw new Error(NAO_CANONICO_LINT);
  const nome = readIdentifier(source, significantIndex(source, start + 1));
  if (nome === null || nome.name !== ANALISADOR) throw new Error(NAO_CANONICO_LINT);
  let index = significantIndex(source, nome.end);
  if (source[index] === ":") {
    const valor = readIdentifier(source, significantIndex(source, index + 1));
    if (valor === null || valor.name !== ANALISADOR) throw new Error(NAO_CANONICO_LINT);
    index = significantIndex(source, valor.end);
  }
  if (source[index] === ",") index = significantIndex(source, index + 1);
  if (source[index] !== "}") throw new Error(NAO_CANONICO_LINT);
  bloco.parser = true;
  return index + 1;
}

// Palavra-chave escrita diretamente, lida pelo MESMO leitor de identificadores
// usado nas chaves. `true` é a única grafia aceita: `1`, `"true"`, `!0`,
// `Boolean(1)` e qualquer identificador ou expressão só teriam valor depois de
// avaliar o módulo, e avaliar a candidata é proibido.
function readPalavraExata(source, start, esperada) {
  const lido = readIdentifier(source, start);
  return lido !== null && lido.name === esperada ? lido.end : null;
}

// Cada proteção tem UM valor canônico, e só a grafia direta dele é aceita:
// `true` como palavra-chave e `"error"` como literal textual sem escape. O valor
// precisa ainda TERMINAR onde o literal termina — sufixo, operador ou
// concatenação depois dele descreveriam outro valor, conhecido só após avaliar
// o módulo.
const PROTECOES_EXIGIDAS = new Map([
  [PROTECAO_INLINE, (source, start) => readPalavraExata(source, start, VERDADEIRO)],
  [PROTECAO_DIRETIVAS, (source, start) => readTextoExato(source, start, SEVERIDADE_EXIGIDA)]
]);

function readProtecao(source, name, value, lidas) {
  const leitor = PROTECOES_EXIGIDAS.get(name);
  if (leitor === undefined) throw new Error(PROTECOES_INCOMPATIVEIS);
  const fim = leitor(source, value);
  if (fim === null || !fimDeOpcao(source, fim)) throw new Error(PROTECOES_INCOMPATIVEIS);
  lidas.add(name);
  return fim;
}

// Proteções locais do bloco. O valor precisa ser um objeto literal, e AS DUAS
// propriedades precisam estar lá: uma sozinha deixa metade da porta aberta —
// sem `noInlineConfig` uma diretiva em comentário desliga a regra arquivo a
// arquivo, e sem a exigência de diretivas não usadas uma desativação esquecida
// nunca é reportada.
function readLinterOptions(source, start, bloco) {
  if (source[start] !== "{") throw new Error(PROTECOES_INCOMPATIVEIS);
  const lidas = new Set();
  const fim = readObjectProperties(
    source,
    start,
    (name, value) => readProtecao(source, name, value, lidas),
    ERROS_PROTECOES
  );
  if (lidas.size !== PROTECOES_EXIGIDAS.size) throw new Error(PROTECOES_INCOMPATIVEIS);
  bloco.protecoes = true;
  return fim;
}

// Só a grafia DIRETA da chave introduz as proteções; a citada e a computada
// reprovam antes de qualquer leitura do valor, pela mesma classe.
function readProtecoesDoBloco(source, start, bloco, grafia) {
  if (grafia !== GRAFIA_DIRETA) throw new Error(PROTECOES_INCOMPATIVEIS);
  return readLinterOptions(source, start, bloco);
}

// H3b2a, Fatia 3. A mesma exigência das proteções, estendida às demais
// propriedades CONHECIDAS do bloco — `files`, `languageOptions` e `rules`. São
// exatamente as chaves cujo valor o validador LÊ para comparar com a política;
// se a chave só é conhecida depois de decodificar um literal, a mesma posição
// sintática aceita `["fi" + "les"]`, e o escopo, o analisador ou as regras
// efetivamente aplicados pelo ESLint deixariam de ser os comparados, sem que
// nada no arquivo denunciasse a troca. A recusa acontece ANTES de ler o valor,
// pela classe genérica de forma, e não ecoa a chave.
//
// A exigência NÃO alcança `ignores`: a tolerância que o G2 lhe concedeu é
// histórica e deliberada, e suas cinco grafias continuam aceitas. `processor`
// também permanece intacto — ele reprova pela PRESENÇA, em qualquer grafia, e
// pela classe própria, que descreve melhor o defeito.
function exigeGrafiaDireta(grafia) {
  if (grafia !== GRAFIA_DIRETA) throw new Error(NAO_CANONICO_LINT);
}

// Um bloco por objeto de configuração: o escopo, o analisador e a regra de
// complexidade lidos aqui pertencem ao MESMO objeto. Agregar escopos e regras em
// listas separadas aprovaria um arquivo em que o bloco de src não declara a
// regra e o bloco que declara a regra não alcança src.
//
// `processor` reprova pela PRESENÇA, qualquer que seja o valor: um processador
// substitui o texto efetivamente analisado pelo ESLint, de modo que a regra de
// complexidade passaria a medir outro código — o gate continuaria declarado e
// deixaria de valer sobre os arquivos protegidos. A recusa não ecoa a chave.
//
// A chave que INTRODUZ as proteções locais precisa ser o identificador escrito
// diretamente, e a decisão vem da MESMA leitura estrutural da propriedade: a
// grafia chega junto do nome, sem varredura textual paralela. `"linterOptions"`,
// `'linterOptions'` e as duas formas computadas por literal reprovam pela classe
// das proteções, porque ali a chave só é conhecida depois de decodificar um
// literal e a mesma posição sintática aceitaria a chave montada em tempo de
// execução — a mesma disciplina que a Fatia 4 já aplica DENTRO do nível. A
// exigência não alcança as vizinhas: `ignores` mantém a tolerância que o G2 lhe
// concedeu, e o dialeto compartilhado do lint continua intacto.
//
// H3b2a. O nível é FECHADO: só `files`, `ignores`, `languageOptions`,
// `linterOptions` e `rules` são admitidas. Uma propriedade desconhecida não é
// inspecionada, e o que não é inspecionado não é comparado com a política — ela
// é uma opção do ESLint aplicada ao MESMO bloco por fora de toda comparação.
// `plugins` troca a implementação da própria regra medida; `settings`, `name` e
// qualquer chave inventada abrem a mesma porta. Ser estática não torna a
// propriedade conhecida, e por isso a recusa vale qualquer que seja o valor —
// literal, identificador, objeto, array, chamada ou atribuição. A mensagem é a
// genérica de forma: nome, valor e expressão da candidata não voltam ao autor.
function readConfigObject(source, start, estado) {
  const bloco = { escopo: ESCOPO_GLOBAL, complexidade: false, parser: false, protecoes: false };
  estado.blocos.push(bloco);
  return readObjectProperties(source, start, (name, value, grafia) => {
    if (name === PROPRIEDADE_PROCESSADOR) throw new Error(PROPRIEDADE_PROIBIDA);
    if (name === "ignores") return readIgnoresArray(source, value, estado.listas);
    if (name === PROPRIEDADE_ESCOPO) {
      exigeGrafiaDireta(grafia);
      return readFilesValue(source, value, bloco);
    }
    if (name === PROPRIEDADE_ANALISADOR) {
      exigeGrafiaDireta(grafia);
      return readLanguageOptions(source, value, bloco);
    }
    if (name === PROPRIEDADE_PROTECOES) return readProtecoesDoBloco(source, value, bloco, grafia);
    if (name === PROPRIEDADE_REGRAS) {
      exigeGrafiaDireta(grafia);
      return readRulesObject(source, value, estado, bloco);
    }
    throw new Error(NAO_CANONICO_LINT);
  });
}

function readExportedArray(source, estado) {
  let index = significantIndex(source, 0);
  if (source[index] !== "[") throw new Error(NAO_CANONICO_LINT);
  index = significantIndex(source, index + 1);
  while (index < source.length) {
    if (source[index] === "]") return index + 1;
    if (source[index] !== "{") throw new Error(NAO_CANONICO_LINT);
    index = significantIndex(source, readConfigObject(source, index, estado));
    if (source[index] === "]") return index + 1;
    if (source[index] !== ",") throw new Error(NAO_CANONICO_LINT);
    index = significantIndex(source, index + 1);
  }
  throw new Error(NAO_CANONICO_LINT);
}

// Trecho residual depois do array exportado: nada ali compõe a configuração
// efetiva, e por isso o resíduo reprova. Antes disso, uma lista de padrões
// ignorados ilegível continua sendo reprovada pela leitura, como no G1.
function scanResidual(source, listas) {
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const key = readPropertyKey(source, index);
    const colon = key === null ? -1 : significantIndex(source, key.end);
    if (key !== null && key.name === "ignores" && source[colon] === ":") {
      index = readIgnoresArray(source, significantIndex(source, colon + 1), listas);
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index);
      if (index === -1) return;
      continue;
    }
    index = key === null ? index + 1 : key.end;
  }
}

function assertIgnores(listas) {
  if (listas.length > MAX_IGNORE_ARRAYS) throw new Error(LIMITE_LISTA);
  for (const patterns of listas) {
    if (patterns.length > MAX_PATTERNS_PER_ARRAY) throw new Error(LIMITE_LISTA);
    if (patterns.some((pattern) => alcancaSrc(pattern))) throw new Error("ignorar src é proibido");
  }
}

// O comando de lint opera sobre "src": uma regra declarada apenas em blocos cujo
// escopo não alcança src deixaria o gate sem efeito. Aqui a direção é oposta à
// dos padrões ignorados, porque só conta o escopo cujo alcance é demonstrável.
// A pergunta respondida NÃO é "o padrão casa um exemplo conhecido?" — uma lista
// de caminhos-testemunha seria uma allowlist fechada de diretórios e reprovaria
// subárvores legítimas como "src/app" — e sim: EXISTE algum caminho de arquivo
// de código, com uma das extensões analisadas, sob "src", que este padrão
// alcança? A decisão é tomada sobre a gramática compilada. Só as extensões são
// uma lista fixa, porque elas são o contrato do gate de complexidade da base.
// H3b2a, Fatia 4. O estado "escopo desconhecido" deixou de existir: um escopo
// que o validador não consegue ler reprova na leitura, pela classe de forma, em
// vez de sobreviver como bloco que apenas não prova alcance.
const ESCOPO_GLOBAL = "escopo global";
const EXTENSOES_ANALISADAS = ["js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx"];
const DOMINIO_DE_CARACTERES = 0x10000;
const SEPARADOR = "/";
const PONTO = ".";
// Nome de arquivo ou diretório não contém separador.
const PROIBIDOS_EM_NOME = new Set([SEPARADOR]);

// Quantidade de caracteres cobertos pelos intervalos da classe, sem enumerar o
// alfabeto: os intervalos são ordenados e as sobreposições, descontadas.
function totalCoberto(ranges) {
  const ordenados = ranges.map(([baixo, alto]) => [baixo.charCodeAt(0), alto.charCodeAt(0)]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let fim = -1;
  for (const [baixo, alto] of ordenados) {
    const inicio = Math.max(baixo, fim + 1);
    if (alto >= inicio) total += alto - inicio + 1;
    if (alto > fim) fim = alto;
  }
  return total;
}

// O token aceita ao menos um caractere utilizável em um nome de caminho?
function aceitaAlgumCaractere(token, proibidos) {
  if (token.type === "star" || token.type === "any") return true;
  if (token.type === "char") return !proibidos.has(token.value);
  const cobertos = totalCoberto(token.ranges);
  const aceitos = token.negated ? DOMINIO_DE_CARACTERES - cobertos : cobertos;
  const descartados = [...proibidos].filter((caractere) => matchesToken(token, caractere)).length;
  return aceitos > descartados;
}

// Existe nome NÃO VAZIO casado pelo segmento sem usar caractere proibido? Cada
// token obrigatório precisa de um caractere disponível; as estrelas cobrem o
// resto e um segmento sem token nenhum só casaria o nome vazio.
function nomeSatisfazivel(tokens, proibidos) {
  return tokens.length > 0 && tokens.every((token) => aceitaAlgumCaractere(token, proibidos));
}

// Estados alcançáveis depois de consumir um prefixo arbitrário do nome. As
// transições só avançam, então um único passo para frente basta.
function estadosAposPrefixo(tokens) {
  const row = new Array(tokens.length + 1).fill(false);
  row[0] = true;
  for (let index = 0; index < tokens.length; index += 1) {
    if (row[index] && aceitaAlgumCaractere(tokens[index], PROIBIDOS_EM_NOME)) row[index + 1] = true;
  }
  return row;
}

// Satisfazibilidade contra a extensão: existe nome da forma <qualquer>.<ext>
// casado pelo segmento? O sufixo é alimentado ao autômato já compilado; nenhum
// nome de arquivo concreto é usado como testemunha.
function casaExtensao(tokens, extensao) {
  let row = estadosAposPrefixo(tokens);
  for (const caractere of `${PONTO}${extensao}`) row = avancarCaractere(tokens, row, caractere);
  return row[tokens.length];
}

function podeCasarArquivoDeCodigo(tokens) {
  return EXTENSOES_ANALISADAS.some((extensao) => casaExtensao(tokens, extensao));
}

// Estados do caminho hipotético percorrido pelo padrão. DENTRO é um estado de
// passagem: o padrão nomeou um diretório sob a raiz protegida e ainda pode
// continuar. ARQUIVO é o único terminal: marca que o padrão casaria ali um
// caminho de arquivo com extensão analisada. Um segmento seguinte descarta
// ARQUIVO porque o caminho continuaria além do arquivo alcançado.
const FORA = "fora da raiz protegida";
const DENTRO = "sob a raiz protegida";
const ARQUIVO = "arquivo de código alcançado";

// Globstar casa qualquer sequência de nomes, em qualquer profundidade: partindo
// de fora, um deles pode ser a própria raiz protegida; partindo de dentro, os
// nomes intermediários são diretórios e o último pode ser um arquivo de código.
// É por isso que "src/**" e "**/*" alcançam arquivo: a sequência casada pelo
// globstar termina em um nome com extensão analisada. Consumir zero nomes
// preserva os estados anteriores.
function avancarGlobstar(estados) {
  const proximos = new Set(estados);
  if (!estados.has(FORA) && !estados.has(DENTRO)) return proximos;
  for (const estado of [DENTRO, ARQUIVO]) proximos.add(estado);
  return proximos;
}

// Um segmento comum casa exatamente um nome. Fora da raiz, só entra quem casa
// "src", e entrar apenas posiciona o caminho DENTRO dela. Dentro, o nome pode
// ser um diretório intermediário qualquer, do qual o padrão continua, e/ou um
// arquivo com extensão analisada. Nenhum nome de subdiretório é consultado:
// eles são arbitrários.
function avancarNome(estados, tokens) {
  const proximos = new Set();
  if (estados.has(FORA) && matchSegment(tokens, RAIZ_PROTEGIDA)) proximos.add(DENTRO);
  if (!estados.has(DENTRO)) return proximos;
  if (nomeSatisfazivel(tokens, PROIBIDOS_EM_NOME)) proximos.add(DENTRO);
  if (podeCasarArquivoDeCodigo(tokens)) proximos.add(ARQUIVO);
  return proximos;
}

// Simulação do padrão compilado contra o conjunto de TODOS os caminhos possíveis
// sob a raiz protegida. Aprova SOMENTE quando o padrão termina em ARQUIVO: um
// padrão de diretório puro, como "src" ou "src/app", não casa caminho de
// arquivo nenhum no ESLint, lintaria zero arquivos e tornaria o gate um no-op.
function alcancaArquivoDeCodigoEmSrc(segmentos) {
  let estados = new Set([FORA]);
  for (const segmento of segmentos) {
    estados = segmento.globstar ? avancarGlobstar(estados) : avancarNome(estados, segmento.tokens);
    if (estados.size === 0) return false;
  }
  return estados.has(ARQUIVO);
}

// Duas etapas obrigatórias e independentes. PRIMEIRA: compilar e validar TODOS
// os padrões declarados — um padrão inválido reprova a configuração inteira,
// mesmo quando um padrão anterior já provaria o alcance. SEGUNDA: só então
// decidir o alcance sobre a estrutura já compilada.
function escopoAlcancaSrc(escopo) {
  if (escopo === ESCOPO_GLOBAL) return true;
  if (!Array.isArray(escopo)) return false;
  const compilados = escopo.map((pattern) => compilePattern(pattern));
  return compilados.some((segmentos) => alcancaArquivoDeCodigoEmSrc(segmentos));
}

// O alcance de todos os blocos é calculado antes da decisão: a validação dos
// padrões não pode depender da ordem dos blocos nem parar no primeiro bloco que
// satisfaz o gate.
//
// Depois do alcance vem o VÍNCULO com o analisador, e ele é estrutural, no mesmo
// objeto — a disciplina que `readConfigObject` já aplica a escopo e regra. Um
// bloco desconhecido não prova nada por outro: o ESLint aplica `languageOptions`
// por bloco, e um analisador declarado em bloco alheio deixaria os arquivos
// protegidos sendo lidos pelo analisador padrão, que não entende TypeScript, de
// modo que a regra de complexidade cobriria zero arquivo. A exigência vale para
// TODOS os blocos que participam da prova, não para um deles: bastasse um, o
// arquivo poderia declarar a regra duas vezes e deixar a segunda sem analisador.
function assertAlcanceDaComplexidade(blocos, temImportacao) {
  const alcances = blocos.map((bloco) => escopoAlcancaSrc(bloco.escopo));
  const provantes = blocos.filter((bloco, indice) => bloco.complexidade && alcances[indice]);
  if (provantes.length === 0) throw new Error(COMPLEXIDADE_SEM_ALCANCE);
  if (!temImportacao && blocos.some((bloco) => bloco.parser)) throw new Error(ANALISADOR_SEM_IMPORTACAO);
  if (!provantes.every((bloco) => bloco.parser)) throw new Error(ANALISADOR_AUSENTE);
  // Mesma disciplina do analisador, e pela mesma razão: `linterOptions` é aplicado
  // POR BLOCO. Proteções declaradas em bloco alheio deixariam os arquivos
  // protegidos aceitando diretivas em linha que desligam a regra de complexidade
  // arquivo a arquivo — o gate continuaria escrito e deixaria de valer.
  if (!provantes.every((bloco) => bloco.protecoes)) throw new Error(PROTECOES_INCOMPATIVEIS);
}

// --- Leitura estrutural da configuração de cobertura.
//
// A aprovação decorre da ESTRUTURA efetivamente exportada, sem importar nem
// avaliar a candidata e sem nenhuma âncora textual para "test", "coverage",
// "include", "exclude", "thresholds" ou para as métricas. Procurar a chave por
// expressão regular aceita qualquer grafia equivalente em JavaScript — chave
// concatenada, template, escape unicode, acessador, método — e não distingue a
// propriedade efetiva de um chamariz escrito em objeto aninhado, em string ou em
// propriedade alheia. Aqui cada propriedade é lida no objeto REAL a que pertence.
//
// Gramática aceita para a expressão exportada, e nada além dela:
//   export default { ... }
//
// Nenhum envoltório é canônico, `defineConfig` inclusive. A forma envolta é
// INEXEQUÍVEL neste contrato: o identificador não existe globalmente, o
// preâmbulo canônico não admite a importação que o traria, e carregar o arquivo
// dá ReferenceError antes de qualquer configuração existir. Aceitá-la aprovava
// um texto que o Vitest nunca executaria — e, pior, um texto cujo valor
// efetivo dependeria de uma função desconhecida. A forma aceita precisa ser a
// mesma que o consumidor consegue carregar: o objeto literal.
const METRICAS_DE_COBERTURA = ["lines", "branches", "functions", "statements"];
const CHAVES_DE_COBERTURA = new Set(["include", "exclude", "thresholds"]);

// Início do objeto literal exportado. Identificador, chamada, composição de
// chamadas, array e qualquer outra expressão só teriam valor conhecido depois
// de avaliar o módulo, e avaliar a candidata é proibido.
function inicioDoObjetoExportado(source) {
  const inicio = significantIndex(source, 0);
  if (source[inicio] !== "{") throw new Error(COBERTURA_NAO_CANONICA);
  return inicio;
}

// Um nível da cadeia: devolve a posição do valor de cada propriedade procurada,
// preservando a associação com o objeto real. Espalhamento, acessador, método e
// chave dinâmica reprovam em `readProperty`, e chave repetida reprova antes que
// a última declaração vença.
//
// H3b3. NÃO existe mais regime tolerante: todos os níveis inspecionados são
// fechados. O objeto exportado declara somente `test`; `test` declara somente
// `coverage`; `coverage` e `thresholds` já eram fechados. O parâmetro que
// selecionava o regime saiu junto com o regime.
//
// A tolerância anterior supunha que os dois níveis externos tinham motivo
// legítimo para declarar propriedades desconhecidas, desde que o VALOR fosse
// estruturalmente estático. A suposição não se sustenta por duas razões
// independentes. Primeira: a garantia sobre o valor era fraca por construção —
// o critério era a ausência de parêntese, e `new Reporter`, um tagged template,
// `globalThis.x = 1`, `await p` e um identificador livre executam sem nenhum
// parêntese. Segunda, e decisiva: o dano não precisa de execução. `setupFiles`,
// `globalSetup`, `reporters`, `snapshotSerializers` e `plugins` fazem o runner
// IMPORTAR um arquivo escolhido pela candidata, e `include: []`, `exclude` e
// `passWithNoTests` esvaziam a medição sem tocar em `coverage`. Nenhuma
// inspeção do valor separa esses nomes de um dado inerte; o NOME separa.
//
// O preço é assumido: propriedade legítima do Vitest reprova, e ampliar o
// conjunto exige o PR próprio descrito em `docs/ai-engineering-system.md`.
// A recusa não ecoa o nome nem o valor da chave: o defeito é a forma.
function nivelDeCobertura(source, inicio, procuradas) {
  if (source[inicio] !== "{") throw new Error(COBERTURA_NAO_CANONICA);
  const encontradas = new Map();
  const fim = readObjectProperties(
    source,
    inicio,
    (name, value) => {
      if (procuradas.has(name)) {
        encontradas.set(name, value);
        return readSkippedValue(source, value, ERROS_COBERTURA);
      }
      throw new Error(COBERTURA_NAO_CANONICA);
    },
    ERROS_COBERTURA
  );
  return { encontradas, fim };
}

// Exatamente uma cadeia estrutural válida: objeto exportado → `test` → objeto
// literal → `coverage` → objeto literal.
function descer(source, encontradas, nome) {
  const valor = encontradas.get(nome);
  if (valor === undefined) throw new Error(ESCOPO_INCOMPATIVEL);
  if (source[valor] !== "{") throw new Error(COBERTURA_NAO_CANONICA);
  return valor;
}

function lerCadeiaDeCobertura(source) {
  const topo = nivelDeCobertura(source, inicioDoObjetoExportado(source), new Set(["test"]));
  const test = nivelDeCobertura(source, descer(source, topo.encontradas, "test"), new Set(["coverage"]));
  const coverage = descer(source, test.encontradas, "coverage");
  return { cobertura: nivelDeCobertura(source, coverage, CHAVES_DE_COBERTURA).encontradas, fim: topo.fim };
}

// Trecho residual depois do objeto exportado, com a MESMA disciplina já
// aplicada ao lint: nada ali compõe a configuração efetiva, e tudo ali é
// executado pelo runner ao carregar o módulo. Comentários já viraram espaço na
// varredura; sobra o ponto e vírgula do contrato. A simetria é deliberada —
// `process.exit(0)` depois do array de lint reprovava, e depois do objeto de
// cobertura era ignorado.
function assertResiduoDaCobertura(residual) {
  if (/[^\s;]/u.test(residual)) throw new Error(COBERTURA_NAO_CANONICA);
}

// Escopo de cobertura da POLÍTICA CONFIÁVEL, verificado antes de qualquer
// leitura da candidata. Cada padrão exigido precisa produzir uma raiz protegida
// não vazia: é dela que `assertExclude` deriva o que não pode ser excluído, e
// um padrão sem prefixo literal — "**", "*", "./**" — não delimita árvore
// alguma. Lista ausente, vazia, não textual ou sem raiz utilizável deixa a
// decisão sem objeto, e a resposta correta para "não sei decidir" é reprovar.
function assertPoliticaDeCobertura(policy) {
  const exigidos = policy?.coverage?.include;
  if (!Array.isArray(exigidos) || exigidos.length === 0) throw new Error(POLITICA_SEM_ESCOPO);
  for (const pattern of exigidos) {
    if (typeof pattern !== "string") throw new Error(POLITICA_SEM_ESCOPO);
    if (raizDeclaradaPelaPolitica(pattern).length === 0) throw new Error(POLITICA_SEM_ESCOPO);
  }
}

// A política é confiável, não infalível: um padrão fora do dialeto suportado
// faria o compilador lançar a classe de erro da CANDIDATA e descreveria o
// defeito no arquivo errado.
function raizDeclaradaPelaPolitica(pattern) {
  try {
    return raizProtegida(pattern);
  } catch {
    throw new Error(POLITICA_SEM_ESCOPO);
  }
}

// Array literal textual: os valores usam o leitor de literais do G1, que decodifica
// escapes sem avaliar nada. Qualquer outro conteúdo reprova com a classe da
// propriedade, porque é ela que fica sem valor conhecido.
function listaDePadroes(source, valor, erro) {
  if (valor === undefined || source[valor] !== "[") throw new Error(erro);
  const conteudo = balancedContent(source, valor, "[", "]");
  const padroes = conteudo === null ? null : literalStringArray(conteudo);
  if (padroes === null) throw new Error(erro);
  if (padroes.length > MAX_PATTERNS_PER_ARRAY) throw new Error(LIMITE_LISTA);
  return padroes;
}

function assertInclude(source, valor, policy) {
  const exigidos = policy?.coverage?.include;
  const declarados = listaDePadroes(source, valor, ESCOPO_INCOMPATIVEL);
  // Mesma disciplina de duas etapas do escopo do lint e das exclusões: TODOS os
  // padrões declarados passam pelo compilador antes da decisão. Conferir apenas a
  // presença dos padrões exigidos deixaria um padrão adicional entrar por carona,
  // sem nunca ser compilado nem ter o dialeto verificado.
  for (const pattern of declarados) compilePattern(pattern);
  if (
    !Array.isArray(exigidos) ||
    !exigidos.every((pattern) => typeof pattern === "string" && declarados.includes(pattern))
  ) {
    throw new Error(ESCOPO_INCOMPATIVEL);
  }
}

// Prefixo literal de uma raiz protegida, derivado da PRÓPRIA política: nenhum nome
// de subdiretório é enumerado no validador. "src/modules/**" descreve a raiz
// ["src", "modules"]; a parte curinga do padrão não integra o prefixo.
function textoLiteralDoSegmento(segmento) {
  if (segmento.globstar) return null;
  let texto = "";
  for (const token of segmento.tokens) {
    if (token.type !== "char") return null;
    texto += token.value;
  }
  return texto;
}

function raizProtegida(pattern) {
  const nomes = [];
  for (const segmento of compilePattern(pattern)) {
    const texto = textoLiteralDoSegmento(segmento);
    if (texto === null) break;
    if (texto === "" || texto === SEGMENTO_ATUAL) continue;
    nomes.push(texto);
  }
  return nomes;
}

// Estados do caminho hipotético percorrido pelo padrão contra UMA raiz protegida.
// Um número inteiro conta quantos nomes da raiz já foram casados; ALCANCADO marca
// que o padrão casa algum caminho na raiz ou abaixo dela. Nenhum nome de
// subdiretório é consultado: os nomes sob a raiz são arbitrários.
const ALCANCADO = "raiz protegida alcançada";

function avancarGlobstarProtegido(estados, total) {
  const proximos = new Set(estados);
  let menor = total;
  for (const estado of estados) if (typeof estado === "number" && estado < menor) menor = estado;
  // Globstar casa qualquer sequência de nomes: pode completar o que falta da raiz
  // e seguir para dentro dela, em qualquer profundidade.
  for (let nivel = menor; nivel < total; nivel += 1) proximos.add(nivel);
  proximos.add(ALCANCADO);
  return proximos;
}

function avancarNomeProtegido(estados, tokens, raiz) {
  const proximos = new Set();
  for (const estado of estados) {
    if (estado === ALCANCADO) {
      if (nomeSatisfazivel(tokens, PROIBIDOS_EM_NOME)) proximos.add(ALCANCADO);
      continue;
    }
    if (!matchSegment(tokens, raiz[estado])) continue;
    proximos.add(estado + 1 === raiz.length ? ALCANCADO : estado + 1);
  }
  return proximos;
}

// Existe ALGUM caminho, na raiz protegida ou abaixo dela, casado por este padrão?
// Nomear um ancestral da raiz — "src" para a raiz ["src", "modules"] — também
// alcança, porque excluir o diretório exclui a subárvore inteira. ".." reescreve o
// caminho e um padrão sem segmento significativo não prova nada: ambos alcançam.
function alcancaRaizProtegida(segmentos, raiz) {
  if (raiz.length === 0) return true;
  if (segmentos.some((segmento) => segmentoLiteral(segmento, SEGMENTO_PAI))) return true;
  let estados = new Set([0]);
  let significativos = 0;
  for (const segmento of segmentos) {
    if (!segmento.globstar && (segmento.tokens.length === 0 || segmentoLiteral(segmento, SEGMENTO_ATUAL))) continue;
    significativos += 1;
    estados = segmento.globstar
      ? avancarGlobstarProtegido(estados, raiz.length)
      : avancarNomeProtegido(estados, segmento.tokens, raiz);
    if (estados.size === 0) return false;
  }
  if (significativos === 0) return true;
  return estados.has(ALCANCADO) || [...estados].some((estado) => estado > 0);
}

// Duas etapas obrigatórias e independentes, como no alcance do lint. PRIMEIRA:
// compilar e validar TODOS os padrões declarados, sem curto-circuito. SEGUNDA: só
// então decidir o alcance sobre a estrutura já compilada.
function assertExclude(source, valor, policy) {
  const declarados = listaDePadroes(source, valor, EXCLUSAO_INCOMPATIVEL);
  const exigidos = policy?.coverage?.include;
  if (!Array.isArray(exigidos)) throw new Error(ESCOPO_INCOMPATIVEL);
  const raizes = exigidos.map((pattern) => raizProtegida(pattern));
  const compilados = declarados.map((pattern) => compilePattern(pattern));
  if (compilados.some((segmentos) => raizes.some((raiz) => alcancaRaizProtegida(segmentos, raiz)))) {
    throw new Error(EXCLUSAO_INCOMPATIVEL);
  }
}

// Métricas são inteiros decimais estáticos lidos no objeto real de limiares.
// Hexadecimal, expoente, string, acessador, método, chave dinâmica e chave
// repetida não descrevem um inteiro decimal estático e reprovam.
//
// A gramática deste nível é FECHADA, com a mesma disciplina de `coverage`: só
// as quatro métricas existem aqui. Toda outra chave é uma opção do consumidor
// que muda o limiar efetivo sem passar por comparação — limiar por arquivo ou
// por diretório, `perFile`, `autoUpdate` — e tolerá-la como valor não
// inspecionado aprovava a subárvore protegida zerada ao lado das quatro
// métricas fortes. A recusa não ecoa o nome nem o valor: o defeito é a forma.
function assertLimiares(source, valor, policy) {
  if (valor === undefined || source[valor] !== "{") throw new Error(LIMIAR_INCOMPATIVEL);
  const lidos = new Map();
  readObjectProperties(
    source,
    valor,
    (name, inicio) => {
      if (!METRICAS_DE_COBERTURA.includes(name)) throw new Error(COBERTURA_NAO_CANONICA);
      const numero = readInteiroDecimal(source, inicio);
      if (numero === null || !fimDeOpcao(source, numero.end)) throw new Error(LIMIAR_INCOMPATIVEL);
      lidos.set(name, numero.value);
      return numero.end;
    },
    ERROS_COBERTURA
  );
  for (const metric of METRICAS_DE_COBERTURA) {
    const exigido = policy?.coverage?.[metric];
    const declarado = lidos.get(metric);
    if (!Number.isFinite(exigido) || declarado === undefined || declarado < exigido) {
      throw new Error(LIMIAR_INCOMPATIVEL);
    }
  }
}

function assertLint(source, policy) {
  source = withoutComments(source);
  const eslint = exportedConfig(source);
  if (eslint === null) throw new Error(COMPLEXIDADE_INCOMPATIVEL);
  const estado = { listas: [], blocos: [], complexidades: 0, max: policy?.complexity?.maxCyclomaticPerFunction };
  const residual = eslint.slice(readExportedArray(eslint, estado));
  scanResidual(residual, estado.listas);
  if (/[^\s;]/u.test(residual)) throw new Error(NAO_CANONICO_LINT);
  assertIgnores(estado.listas);
  if (estado.complexidades === 0) throw new Error(COMPLEXIDADE_INCOMPATIVEL);
  const temImportacao = assertPreambuloDoLint(source);
  // Última verificação: só depois de a gramática e o preâmbulo estarem íntegros o
  // escopo lido descreve a configuração que o ESLint aplicaria.
  assertAlcanceDaComplexidade(estado.blocos, temImportacao);
}

function exportedConfig(source) {
  const match = singleAnchor(source, /\bexport\s+default\b/gu, "export default");
  return match === null ? null : source.slice(match.index + match[0].length);
}

// Avança até depois da crase final. A interpolação está fora da gramática canônica
// e reprova: o valor interpolado só existiria depois de avaliar o módulo, e a
// aninhagem de "${...}" é justamente o que desalinha uma máquina de aspas.
function skipTemplate(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "$" && source[index + 1] === "{") throw new Error(TOKEN_NAO_CANONICO);
    if (character === "`") return index + 1;
  }
  return source.length;
}

// Fim do literal textual iniciado em "start", ou "start + 1" quando ali não começa
// um literal. Literal sem fechamento consome o restante do arquivo como DADO: nada
// depois dele é tratado como comentário, e a estrutura inacabada reprova adiante.
function literalEnd(source, start) {
  const character = source[start];
  if (character === "`") return skipTemplate(source, start);
  if (character !== '"' && character !== "'") return start + 1;
  const end = skipQuoted(source, start);
  return end === -1 ? source.length : end;
}

// Só devolve espaços para texto PROVADO comentário, preservando as quebras de linha
// e, com elas, os deslocamentos usados nas mensagens. Um "/" que não abre comentário
// seria divisão ou literal de expressão regular; ambos estão fora da gramática
// canônica e reprovam, em vez de serem adivinhados por contexto.
function blankComment(source, start) {
  const next = source[start + 1];
  if (next === "/") {
    let end = start;
    while (end < source.length && source[end] !== "\n") end += 1;
    return { blanks: " ".repeat(end - start), end };
  }
  if (next !== "*") throw new Error(TOKEN_NAO_CANONICO);
  const close = source.indexOf("*/", start + 2);
  if (close === -1) throw new Error(COMENTARIO_SEM_FECHAMENTO);
  const end = close + 2;
  return { blanks: source.slice(start, end).replace(/[^\n]/gu, " "), end };
}

// Varredura determinística em um único passo para frente: cada iteração consome ao
// menos um caractere. Comentário só começa FORA de literal; "//", "/*" e "*/"
// dentro de um literal permanecem dados.
function withoutComments(source) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === "/") {
      const comment = blankComment(source, index);
      result += comment.blanks;
      index = comment.end;
      continue;
    }
    const end = literalEnd(source, index);
    result += source.slice(index, end);
    index = end;
  }
  return result;
}

// O arquivo de configuração é um módulo que a ferramenta executa ao carregar: o que
// antecede "export default" é código com o privilégio do runner. A gramática
// canônica admite ali apenas espaços e comentários — estes já convertidos em
// espaços pela varredura. A verificação vem depois da análise da estrutura
// exportada, para que a mensagem descreva o defeito mais específico encontrado; a
// decisão de aprovar exige as duas condições.
function assertPreambulo(source) {
  const match = singleAnchor(source, /\bexport\s+default\b/gu, "export default");
  if (match !== null && significantIndex(source, 0) !== match.index) {
    throw new Error(PREAMBULO_NAO_CANONICO);
  }
}

// O preâmbulo do LINT é o único que admite uma declaração, e apenas esta:
//
//   import parser from "@typescript-eslint/parser";
//
// A permissão existe porque o bloco de complexidade precisa nomear o analisador,
// e não há como nomeá-lo sem trazê-lo. Ela NÃO se estende à cobertura: lá o
// preâmbulo continua fechado em espaços e comentários, porque nenhuma
// propriedade inspecionada daquele arquivo depende de um identificador.
//
// A leitura é uma gramática de tokens, não uma expressão regular sobre o texto:
// cada palavra é lida pelo mesmo leitor de identificadores usado nas chaves, e o
// especificador pelo mesmo leitor de literais exatos usado na severidade — que
// recusa qualquer escape. Assim `import * as parser`, `import { parser }`,
// `import "pacote"`, `import(...)`, `await import(...)`, `require(...)`, uma
// segunda importação, uma declaração qualquer e um texto parecido com
// importação dentro de literal reprovam pela mesma classe, sem enumerar formas.
// Comentário já virou espaço na varredura.
function exigirPalavra(source, start, esperada) {
  const lido = readIdentifier(source, start);
  if (lido === null || lido.name !== esperada) throw new Error(IMPORTACAO_NAO_CANONICA);
  return significantIndex(source, lido.end);
}

function lerImportacaoCanonica(preambulo) {
  let index = significantIndex(preambulo, 0);
  if (index >= preambulo.length) return false;
  index = exigirPalavra(preambulo, index, PALAVRA_IMPORT);
  index = exigirPalavra(preambulo, index, ANALISADOR);
  index = exigirPalavra(preambulo, index, PALAVRA_FROM);
  const fim = readTextoExato(preambulo, index, PACOTE_DO_ANALISADOR);
  if (fim === null) throw new Error(IMPORTACAO_NAO_CANONICA);
  index = significantIndex(preambulo, fim);
  if (preambulo[index] !== ";") throw new Error(IMPORTACAO_NAO_CANONICA);
  if (significantIndex(preambulo, index + 1) !== preambulo.length) throw new Error(IMPORTACAO_NAO_CANONICA);
  return true;
}

// Devolve se a importação canônica está presente. Sem ela, nenhum bloco pode
// nomear o analisador: um identificador não ligado seria ReferenceError no
// ESLint, e aprovar isso seria aprovar um arquivo que o consumidor não carrega.
function assertPreambuloDoLint(source) {
  const match = singleAnchor(source, /\bexport\s+default\b/gu, "export default");
  return match === null ? false : lerImportacaoCanonica(source.slice(0, match.index));
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
  const trusted = resolve(options.get("--trusted"));
  // Fronteira de confiança ANTES de qualquer leitura: nenhum arquivo confiável é
  // indicável por argumento, e as duas raízes precisam ser disjuntas. Sem isso a
  // árvore candidata poderia apontar a própria configuração como confiável — o
  // `dependency-cruiser.json` e a `policy.json` sob ela — e o gate se autoaprovaria.
  assertRaizesDisjuntas(trusted, candidate);
  // Os dois arquivos confiáveis são resolvidos EXCLUSIVAMENTE sob a raiz confiável,
  // como `compare-policy.mjs` já faz: a política em `quality/policy.json` e as regras
  // de dependência em `tooling/toolchain/dependency-cruiser.json`. `quality:dependencies`
  // tem origem `base`, e por isso o `dependency-cruiser.json` vem da raiz confiável, não
  // do candidato — a divergência registrada em `docs/ai-engineering-system.md`.
  const policy = readJson(join(trusted, "quality", "policy.json"));
  const dependencyConfig = readJson(join(trusted, "tooling", "toolchain", "dependency-cruiser.json"));
  const vitest = readCandidateText(join(candidate, "vitest.config.ts"));
  const eslint = readCandidateText(join(candidate, "eslint.config.mjs"));
  assertCoverage(vitest, policy);
  assertLint(eslint, policy);
  assertDependencies(dependencyConfig, policy);
  process.stdout.write("Configuração candidata compatível com a política confiável.\n");
} catch (error) {
  process.stderr.write(`Configuração candidata reprovada: ${error.message}\n`);
  process.exitCode = 1;
}
