#!/usr/bin/env node
import { readFileSync } from "node:fs";

const FLAGS_UNICAS = new Set(["--lockfile", "--policy"]);
const FLAGS_REPETIVEIS = new Set(["--expect"]);

function parseArguments(argv) {
  const options = new Map();
  // Ordem recebida preservada: a posição é a única referência que as mensagens podem
  // usar sem ecoar o nome do pacote esperado.
  const expectativas = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`argumento posicional não é aceito: ${value}`);
    const unica = FLAGS_UNICAS.has(value);
    if (!unica && !FLAGS_REPETIVEIS.has(value)) throw new Error(`argumento desconhecido: ${value}`);
    if (unica && options.has(value)) throw new Error(`argumento repetido: ${value}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--") || next.trim() === "") {
      throw new Error(`${value} exige um valor`);
    }
    if (unica) options.set(value, next);
    else expectativas.push(next);
    index += 1;
  }
  return { options, expectativas };
}

// Nome de pacote npm, com ou sem escopo. Sem separador de caminho, sem barra
// invertida, sem `..`, sem espaço: a expectativa vira chave `node_modules/<nome>`,
// e um nome com caminho permitiria apontar para outra entrada do lockfile.
const NOME_PACOTE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSAO_EXATA = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

// O último `@` separa pacote e versão: `@escopo/nome@1.2.3` tem dois, e usar o
// primeiro partiria o escopo ao meio.
function parseExpectativa(bruta, posicao) {
  const separador = bruta.lastIndexOf("@");
  if (separador <= 0) throw new Error(`--expect inválido na posição ${posicao}`);
  const nome = bruta.slice(0, separador);
  const versao = bruta.slice(separador + 1);
  if (!NOME_PACOTE.test(nome) || !VERSAO_EXATA.test(versao)) {
    throw new Error(`--expect inválido na posição ${posicao}`);
  }
  return { nome, versao, posicao };
}

function parseExpectativas(brutas) {
  const vistas = new Set();
  return brutas.map((bruta, index) => {
    const expectativa = parseExpectativa(bruta, index);
    if (vistas.has(expectativa.nome)) {
      throw new Error(`expectativa duplicada na posição ${index} de \`--expect\``);
    }
    vistas.add(expectativa.nome);
    return expectativa;
  });
}

function readJson(file, label) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`${label} ausente ou ilegível: ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} não é JSON válido`);
  }
}

// A lista vem sempre da política da base. Ausente ou vazia, nada poderia ser
// autorizado, e aprovar seria declarar confiável um conjunto que não foi declarado.
function allowedRegistries(policy) {
  const configured = policy?.lockfile?.allowedRegistries;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error("política sem `lockfile.allowedRegistries`; lista ausente ou vazia não é aprovação");
  }
  return configured.map((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`registry autorizado inválido na posição ${index} de \`allowedRegistries\``);
    }
    // O prefixo sempre termina em `/`. Sem a barra, `https://registry.npmjs.org.atacante.com/`
    // casaria o prefixo `https://registry.npmjs.org` e seria aceito.
    return value.endsWith("/") ? value : `${value}/`;
  });
}

// Classificação puramente textual sobre o valor declarado: sem rede, sem resolver
// nome, sem executar nada. Cobre os esquemas Git, os atalhos de hospedeiro do npm,
// a forma SCP `git@host:org/repo.git` e a URL HTTP(S) que aponta direto para um
// repositório `.git`.
const ESQUEMAS_GIT = /^(git|git\+[a-z0-9.+-]+|ssh):\/\//i;
const ATALHOS_GIT = /^(github|gitlab|bitbucket|gist):/i;
const SCP_GIT = /^[^/\s:]+@[^/\s:]+:[^/\s]/;
const REPOSITORIO_DOT_GIT = /\.git($|[#?])/i;

// Git é proibido pelo Item 13 em qualquer forma. A verificação precede a comparação
// com `allowedRegistries`: se viesse depois, uma política malformada que listasse
// `git+https://` destravaria exatamente o que a regra existe para impedir.
function ehResolucaoGit(resolved) {
  return (
    ESQUEMAS_GIT.test(resolved) ||
    ATALHOS_GIT.test(resolved) ||
    SCP_GIT.test(resolved) ||
    REPOSITORIO_DOT_GIT.test(resolved)
  );
}

// Mesma disciplina de `allowedRegistries`: lista ausente ou vazia não autoriza nada,
// e entrada inválida na configuração reprova em vez de ser descartada em silêncio.
function acceptedIntegrityAlgorithms(policy) {
  const configured = policy?.lockfile?.acceptedIntegrityAlgorithms;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error(
      "política sem `lockfile.acceptedIntegrityAlgorithms`; lista ausente ou vazia não é aprovação"
    );
  }
  return new Set(
    configured.map((value, index) => {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `algoritmo inválido na posição ${index} de \`acceptedIntegrityAlgorithms\``
        );
      }
      return value.trim().toLowerCase();
    })
  );
}

function acceptedLockfileVersions(policy) {
  const configured = policy?.lockfile?.acceptedLockfileVersions;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error(
      "política sem `lockfile.acceptedLockfileVersions`; lista ausente ou vazia não é aprovação"
    );
  }
  return new Set(
    configured.map((value, index) => {
      if (!Number.isInteger(value)) {
        throw new Error(`versão inválida na posição ${index} de \`acceptedLockfileVersions\``);
      }
      return value;
    })
  );
}

// O formato do lockfile determina onde a integridade vive e o que `packages` significa.
// Versão não declarada ou fora da allowlist reprova: validar um formato desconhecido
// com as regras de outro seria aprovar sem ter verificado.
function assertLockfileVersion(lockfile, versoesAceitas) {
  const declarada = lockfile?.lockfileVersion;
  if (!Number.isInteger(declarada)) {
    throw new Error("`lockfileVersion` ausente ou não é inteiro; formato desconhecido não é aprovação");
  }
  if (!versoesAceitas.has(declarada)) {
    throw new Error(`\`lockfileVersion\` ${declarada} fora de \`acceptedLockfileVersions\``);
  }
}

const ALGORITMO_SRI = /^[A-Za-z][A-Za-z0-9]*$/;
// Charset canônico do Base64 com padding somente no fim. `+` exige digest não vazio.
const BASE64_SRI = /^[A-Za-z0-9+/]+={0,2}$/;

// `Buffer.from(x, "base64")` é permissivo: descarta caracteres inválidos e tolera
// comprimento irregular, então decodificar com sucesso não prova nada. A prova vem
// de três exigências combinadas: charset e posição do padding pelo regex, múltiplo
// de quatro pelo comprimento, e representação canônica pelo ida e volta.
function digestBase64Canonico(digest) {
  if (!BASE64_SRI.test(digest)) return false;
  if (digest.length % 4 !== 0) return false;
  return Buffer.from(digest, "base64").toString("base64") === digest;
}

// Um campo `integrity` pode trazer vários tokens separados por espaço. Aceitar o
// campo porque um token é válido deixaria um token forjado passar junto: todos
// precisam ser válidos, e qualquer um inválido reprova o campo inteiro.
function tokensSriValidos(integrity) {
  if (typeof integrity !== "string") return null;
  const tokens = integrity.trim().split(/\s+/);
  const algoritmos = [];
  for (const token of tokens) {
    const separador = token.indexOf("-");
    if (separador <= 0) return null;
    const algoritmo = token.slice(0, separador);
    const digest = token.slice(separador + 1);
    if (!ALGORITMO_SRI.test(algoritmo)) return null;
    if (!digestBase64Canonico(digest)) return null;
    algoritmos.push(algoritmo.toLowerCase());
  }
  return algoritmos;
}

// Qualquer segmento `node_modules/` na chave, não só o primeiro: uma dependência
// aninhada em `node_modules/a/node_modules/b` também é instalada de fora.
const INSTALADA_EM_NODE_MODULES = /(^|\/)node_modules\//;

// Alvo de link: relativo, canônico e sem esquema. Componentes `.`, `..` e vazios
// abrem travessia ou grafias duplas do mesmo caminho; esquema e caminho absoluto
// apontam para fora do lockfile; barra invertida não é portável. `C:` casa como esquema.
const ESQUEMA_URI = /^[a-z][a-z0-9+.-]*:/i;
function alvoLocalCanonico(alvo) {
  if (typeof alvo !== "string" || alvo.trim() === "") return false;
  if (alvo.includes("\\") || alvo.startsWith("/") || ESQUEMA_URI.test(alvo)) return false;
  return alvo.split("/").every((componente) => componente !== "" && componente !== "." && componente !== "..");
}

// Chave própria com descritor objeto: `hasOwn` evita herança de protótipo, e a forma
// é exigida porque o alvo ainda pode não ter sido percorrido pelo laço.
function descritorObjeto(packages, chave) {
  if (!Object.hasOwn(packages, chave)) return false;
  const descritor = packages[chave];
  return descritor !== null && typeof descritor === "object" && !Array.isArray(descritor);
}

// As quatro coleções que um descritor pode usar para declarar dependência.
const COLECOES_DE_DEPENDENCIA = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
]);

// `true` quando a coleção declara ao menos um pacote. Forma inválida lança: um campo
// presente e ilegível não pode ser lido como "não declara nada".
//
// As chaves nunca entram na mensagem — são nomes de pacote do projeto examinado.
function colecaoDeclaraPacote(descritor, campo, mensagemDeFormaInvalida) {
  if (!Object.hasOwn(descritor, campo)) return false;
  const colecao = descritor[campo];
  if (colecao === null || typeof colecao !== "object" || Array.isArray(colecao)) {
    throw new Error(mensagemDeFormaInvalida);
  }
  return Object.keys(colecao).length > 0;
}

// `dependencies` no topo é a forma legada, anterior a `packages`. Presente e
// malformada REPROVA por classe própria, em vez de ser contada como declaração: as
// duas situações pedem ações diferentes — corrigir a forma do arquivo, ou enumerar as
// entradas que faltam — e colapsá-las numa só mensagem esconderia a causa real.
function topoLegadoDeclaraPacote(lockfile) {
  if (!Object.hasOwn(lockfile, "dependencies")) return false;
  const colecao = lockfile.dependencies;
  if (colecao === null || typeof colecao !== "object" || Array.isArray(colecao)) {
    throw new Error("coleção de dependências legada inválida");
  }
  return Object.keys(colecao).length > 0;
}

function lockfileEntries(lockfile) {
  const packages = lockfile?.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("lockfile sem `packages`; enumeração ausente não é aprovação");
  }
  const entries = Object.entries(packages).filter(([name]) => name !== "");
  if (entries.length > 0) return entries;

  // Conjunto externo vazio tem duas causas possíveis, e só uma é legítima: o projeto
  // não declara dependência alguma. A outra — a lista foi esvaziada enquanto o
  // descritor raiz do próprio lockfile ainda declara pacotes — continua reprovando,
  // porque aprovar seria aprovar o que não foi enumerado e, portanto, não foi
  // verificado.
  //
  // A distinção é feita pelo que o PRÓPRIO lockfile declara. O manifesto não é lido
  // aqui: sincronizar `package.json` e lockfile é responsabilidade de `npm ci`, e
  // duplicá-la neste validador criaria uma segunda fonte de verdade.
  if (!Object.hasOwn(packages, "")) {
    throw new Error("lockfile sem descritor da raiz");
  }
  const raiz = packages[""];
  if (raiz === null || typeof raiz !== "object" || Array.isArray(raiz)) {
    throw new Error("descritor da raiz inválido");
  }
  const declara =
    COLECOES_DE_DEPENDENCIA.some((campo) =>
      colecaoDeclaraPacote(raiz, campo, "coleção de dependências inválida no descritor da raiz")
    ) || topoLegadoDeclaraPacote(lockfile);
  if (declara) {
    throw new Error("lockfile declara dependências sem entradas enumeradas");
  }

  // Nenhuma dependência declarada e nenhuma enumerada: coerente. A verificação de
  // `--expect` acontece depois e permanece fail-closed — expectativa alguma é
  // satisfeita por um conjunto vazio.
  return [];
}

// Uma expectativa só é satisfeita por dependência externa real, localizada apenas em
// `packages["node_modules/<nome>"]`. Um aninhamento como
// `node_modules/host/node_modules/eslint` é outra instalação e não responde por uma
// expectativa de topo; `link: true` é código local, que o lockfile não fixa.
//
// `--expect` traz apenas pacote e versão: não existe segundo digest para comparar.
// "Integridade verificada" significa, neste contrato, que a entrada localizada passou
// pela validação estática — `resolved` textual, `integrity` presente, SRI canônico e
// algoritmo autorizado. Nada é baixado nem recomputado.
function assertExpectativa({ nome, versao, posicao }, packages, algoritmosAceitos) {
  const naoSatisfeita = new Error(
    `expectativa não satisfeita na posição ${posicao} de \`--expect\`; valores omitidos do relatório`
  );
  const entry = Object.hasOwn(packages, `node_modules/${nome}`)
    ? packages[`node_modules/${nome}`]
    : undefined;
  if (entry === null || typeof entry !== "object") throw naoSatisfeita;
  if (entry.link === true) throw naoSatisfeita;
  if (typeof entry.resolved !== "string") throw naoSatisfeita;
  if (entry.version !== versao) throw naoSatisfeita;
  const algoritmos = tokensSriValidos(entry.integrity);
  if (algoritmos === null) throw naoSatisfeita;
  if (!algoritmos.every((algoritmo) => algoritmosAceitos.has(algoritmo))) throw naoSatisfeita;
}

try {
  const { options, expectativas: expectativasBrutas } = parseArguments(process.argv.slice(2));
  const lockfileFile = options.get("--lockfile");
  const policyFile = options.get("--policy");
  if (!lockfileFile || !policyFile) throw new Error("--lockfile e --policy são obrigatórios");

  const expectativas = parseExpectativas(expectativasBrutas);
  const lockfile = readJson(lockfileFile, "lockfile");
  const policy = readJson(policyFile, "política");
  const registries = allowedRegistries(policy);
  const algoritmosAceitos = acceptedIntegrityAlgorithms(policy);
  assertLockfileVersion(lockfile, acceptedLockfileVersions(policy));
  const entries = lockfileEntries(lockfile);

  let verificadas = 0;
  for (const [posicao, [chave, entry]] of entries.entries()) {
    // Forma antes de conteúdo: `null`, texto ou array sob `packages` não são
    // descritores. Reprovam como dado inválido — nunca como TypeError, nem como
    // aprovação silenciosa por simplesmente não terem os campos verificados.
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`descritor inválido na entrada ${posicao} de \`packages\``);
    }
    const resolved = entry.resolved;
    // `link: true` não é dispensa: é uma forma cujo `resolved` tem regras próprias. O
    // lockfile é candidato e pode combinar `link` com Git, tarball, travessia ou alvo
    // inexistente. Git é classificado antes para manter a classe precisa; o resto
    // precisa ser alvo local relativo canônico, existente em `packages` com descritor
    // objeto. Só depois dessa prova o link é dispensado de registry e integridade —
    // e `assertExpectativa` continua impedindo que satisfaça `--expect`.
    if (entry.link === true) {
      if (typeof resolved === "string" && ehResolucaoGit(resolved)) {
        throw new Error(
          `resolução Git proibida na entrada ${posicao} de \`packages\`; valor omitido do relatório`
        );
      }
      // O alvo tem de ser o descritor local final: não a própria chave, e não outro
      // link. Rejeitar link para link elimina ciclos e cadeias sem resolver nada
      // recursivamente — o formato do npm aponta direto para o pacote do workspace.
      if (
        !alvoLocalCanonico(resolved) ||
        resolved === chave ||
        !descritorObjeto(lockfile.packages, resolved) ||
        lockfile.packages[resolved].link === true
      ) {
        throw new Error(`link inválido na entrada ${posicao} de \`packages\`; alvo omitido do relatório`);
      }
      continue;
    }
    // Descritor fora de `node_modules/` sem origem declarada é o próprio pacote do
    // workspace: o npm não baixa nada para ele. Se declarar `resolved`, deixa de ser
    // local e segue pelas mesmas classificações de uma entrada instalada.
    if (resolved === undefined && !INSTALADA_EM_NODE_MODULES.test(chave)) continue;
    // Toda entrada instalada precisa declarar origem. Sem `resolved` ela escaparia de
    // registry, Git, tarball e integridade — e integridade sem origem não prova de
    // onde o conteúdo veio.
    if (typeof resolved !== "string" || resolved.trim() === "") {
      throw new Error(
        `origem não verificável na entrada ${posicao} de \`packages\`; \`resolved\` ausente ou vazio`
      );
    }
    // Antes da allowlist, deliberadamente: a proibição de Git não é negociável por
    // política. Mesma disciplina da mensagem — posição e classe, nunca o valor, que
    // carrega credencial, organização, repositório e fragmento de commit.
    if (ehResolucaoGit(resolved)) {
      throw new Error(
        `resolução Git proibida na entrada ${posicao} de \`packages\`; valor omitido do relatório`
      );
    }
    if (!registries.some((prefix) => resolved.startsWith(prefix))) {
      // A mensagem nomeia a classe do erro e a posição, nunca o valor. Uma URL de
      // registry privado carrega credencial em `userinfo` e token em query string,
      // e o stderr do gate vai para o log público da execução. O nome da dependência
      // também fica de fora: em registry privado ele revela projeto interno.
      throw new Error(
        `registry não autorizado na entrada ${posicao} de \`packages\`; valor omitido do relatório`
      );
    }
    // Toda entrada externa precisa de integridade. Sem ela, o lockfile fixa a origem
    // mas não o conteúdo, e o tarball pode ser trocado sem que nada reprove.
    if (entry?.integrity === undefined) {
      throw new Error(`integridade ausente na entrada ${posicao} de \`packages\``);
    }
    const algoritmos = tokensSriValidos(entry.integrity);
    if (algoritmos === null) {
      throw new Error(
        `integridade malformada na entrada ${posicao} de \`packages\`; valor omitido do relatório`
      );
    }
    // `every`, não `some`: um token autorizado ao lado de outro fora da allowlist
    // deixaria passar o algoritmo fraco, que é justamente o que se quer impedir.
    if (!algoritmos.every((algoritmo) => algoritmosAceitos.has(algoritmo))) {
      throw new Error(
        `algoritmo de integridade não autorizado na entrada ${posicao} de \`packages\`; valor omitido do relatório`
      );
    }
    verificadas += 1;
  }

  for (const expectativa of expectativas) {
    assertExpectativa(expectativa, lockfile.packages, algoritmosAceitos);
  }

  process.stdout.write(`Lockfile válido: ${verificadas} dependências resolvidas por registry autorizado.\n`);
} catch (error) {
  process.stderr.write(`Lockfile inválido: ${error.message}\n`);
  process.exitCode = 1;
}
