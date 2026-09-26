# Sistema de engenharia assistida por IA

## Fluxo obrigatório

```text
Issue
  ↓
PR exclusivo de spec → aprovação humana → merge
  ↓
seleção de contexto + plano de agentes
  ↓
TDD vertical
  ↓
governance → quality-gate → claude-critical-review
  ↓
aprovação humana → merge
```

A palavra `approved` dentro da spec não prova aprovação. A evidência real é a spec já existir na branch base após um PR revisado por uma pessoa. Por isso o PR de implementação não pode alterar sua própria spec.

## Comandos locais

```text
npm run quality:governance
npm run validate:context
npm run validate:orchestration
npm run validate:specs
npm run context:select -- task:004 --format json
```

`quality:governance` encadeia a suíte de governança e os três validadores. Destes, apenas `validate:orchestration` e `validate:specs` fazem **enumeração completa do snapshot** da raiz confiável; `validate:context` valida o grafo declarado, que é um arquivo só.

A distinção importa. Invocar um validador com um caminho posicional — por exemplo `node tooling/orchestration/validate-execution-plan.mjs orchestration/plans/3.json` — é diagnóstico pontual de um arquivo e **não** equivale à validação do snapshot. Só a enumeração completa detecta duplicação de identificador entre planos, plano ou spec fora do padrão de nome, entrada não regular no diretório e exclusão de arquivo presente na base. Um comando por caminho fixo também envelhece: ele continua passando enquanto ignora tudo o que foi acrescentado depois.

`context:select` permanece como exemplo de consulta ao grafo, não como validação.

## GitHub

O workflow usa três checks estáveis: `governance`, `quality-gate` e `claude-critical-review`. O primeiro usa regras da branch base; o segundo executa o candidato sem segredos; o terceiro entrega ao Claude apenas leitura do diff e do candidato.

O Code Review gerenciado do Claude, isoladamente, termina com conclusão neutra e não bloqueia merge. Este projeto usa a Claude Code Action com JSON estruturado e um validador determinístico que falha em achado crítico, saída vazia, schema inválido ou contagem divergente.

As Actions estão fixadas nos SHAs que as tags oficiais `v6`, `v6` e `v1` apontavam em 8 de setembro de 2026. Atualizações entram por PR do Dependabot e passam pelos mesmos gates.

## Quality gate progressivo

No pacote documental, rodam os testes de governança, grafo, DAG, cobertura simulada e veredito Claude.

Cobertura, complexidade, dependências, build e carga ainda não são gates operacionais. O teste de carga permanece desativado até haver endpoint, cenário, SLO e ambiente efêmero. Ele nunca aponta para produção por padrão.

## Três fases, deliberadamente separadas

Contrato construído não é controle ativado. A confusão entre as duas coisas é o modo mais comum de um gate existir no papel e não proteger nada, e por isso a separação é explícita:

| Fase | O que entrega | Estado |
|---|---|---|
| **PR 5** | o **contrato**: política canônica, registro de exceções, toolchain confiável e os validadores que os leem | construído |
| **PR 6** | a **integração**: o workflow passa a invocar esses validadores, e os publicadores de veredito entram em operação | pendente |
| **PR 7** | a **ativação**: política habilitada, runner isolado e provas de canário por gate | pendente |

Enquanto o PR 6 não integrar, os artefatos do PR 5 são dados versionados e revisáveis por humanos, executáveis à mão. **O CI não os executa.**

## Política confiável como fonte canônica

`quality/policy.json` é a fonte canônica do contrato dos seis comandos de aplicação:

```text
typecheck   lint   test:coverage   quality:complexity   quality:dependencies   build
```

Cada comando fixa quatro coisas: a **origem** da ferramenta — `base` ou `candidate` —, o **executável**, a **lista completa de argumentos** e os **pacotes de ferramenta** dos quais depende.

Essa fixação existe para remover uma autoridade do candidato. Sem ela, redefinir `"lint": "echo ok"` no `package.json` do próprio PR esvaziaria o gate sem alterar uma linha do que a base declara. Com ela, o comando executado é o da política; o script do candidato não é autoridade de gate.

Estado atual: `enabled` permanece **`false`** e `allowedRebuilds` permanece **vazio**. A política declara o contrato e não dispara execução.

## Toolchain confiável

`tooling/toolchain/package.json` e `tooling/toolchain/package-lock.json` fixam as ferramentas de análise da base e suas versões exatas, separadas das dependências do candidato.

A geração usou **Node 24.21.0** e **npm 11.19.0**, a partir da imagem fixada por digest, sem rede e sem scripts de ciclo de vida.

`tooling/quality/validate-lockfile.mjs` verifica a proveniência de um lockfile: exige resolução por registry autorizado, bloqueia resolução por URL Git em qualquer forma, bloqueia tarball fora do registry autorizado, exige campo de integridade presente e bem formado, e aceita apenas algoritmos de integridade declarados na política. As três listas — registries, algoritmos e versões de lockfile — vêm da política; lista ausente ou vazia reprova, porque enumeração vazia não é aprovação.

Scripts de ciclo de vida não são autorizados nesta fase, e `allowedRebuilds` vazio significa que nenhuma reconstrução é permitida.

**ESLint, TypeScript e dependency-cruiser ainda não são executados pelo CI.** Suas configurações confiáveis existem e estão versionadas; a execução comportamental e as provas de canário pertencem ao PR 7.

## Comparação da política candidata

`tooling/quality/compare-policy.mjs` confronta a política do candidato com a da base:

```text
node tooling/quality/compare-policy.mjs --trusted <raiz-confiável> --candidate <raiz-candidata>
```

Os seis comandos exigem **igualdade exata** — mesma quantidade, mesma ordem, mesmo nome, mesmo executável, mesma origem, mesma lista de argumentos e mesma lista de `toolPackages`, ambas comparadas elemento a elemento e na mesma ordem.

`toolPackages` entra na igualdade pelo mesmo motivo que os argumentos: sem ela, o candidato trocaria a ferramenta de que o gate depende mantendo nome, executável, origem e argumentos idênticos, e a política continuaria "igual". As listas não são normalizadas, ordenadas nem deduplicadas — ordenar tornaria dois arranjos distintos indistinguíveis.

Diferença de comando não é excetuável por desenho: não existe classe de exceção para ela.

Fora dos comandos, o comparador reprova afrouxamentos: desligar `enabled`, reduzir limiar de cobertura, elevar o máximo de complexidade, ampliar exclusões de cobertura, remover padrão da lista canônica de `appliesWhenChanged` e introduzir entrada em `allowedRebuilds`.

Um afrouxamento só passa com autorização estruturada em `quality/policy-exceptions.json`, lido **exclusivamente da base**. A entrada precisa corresponder exatamente à classe de mudança, ao alvo e ao valor canônico detectados, ter `expiresOn` vigente como data civil UTC real, e apontar para uma especificação que exista e esteja aprovada no snapshot confiável, com a issue idêntica à do metadado dessa spec.

Disso decorre, sem regra adicional, que **uma exceção criada no mesmo PR que tenta usá-la não autoriza nada**: o registro consultado é o da base, e ali a entrada ainda não existe.

As mensagens de reprovação declaram a classe do problema e a posição da entrada. Nunca ecoam valor, padrão, nome de pacote, caminho de spec, issue ou data.

Hoje o registro nasce vazio: `{"version":1,"exceptions":[]}`. Nenhum afrouxamento está autorizado.

## Configuração do candidato

`tooling/quality/validate-candidate-config.mjs` confere a configuração declarada pelo candidato contra a política:

```text
node tooling/quality/validate-candidate-config.mjs --candidate <raiz-candidata> --policy <política>
```

A inspeção é **estática**. O conteúdo é lido como texto e analisado por correspondência de padrão e varredura de delimitadores balanceados. Nada é importado, avaliado ou executado — ler configuração do candidato executando-a seria dar a ele o controle que o gate pretende verificar.

Reprova configuração ausente ou ilegível, inválida, ambígua, dinâmica e incompatível com a política, sem ecoar o conteúdo inspecionado.

### Gramática aceita, intencionalmente mais estreita

A gramática que o validador aceita é **deliberadamente mais estreita** que a sintaxe geral do ESLint e do Vitest. Ele lê texto e não executa a configuração candidata; portanto, só pode afirmar o que consegue reconhecer com segurança na forma escrita. Toda forma que ele não reconhece é **reprovada**, não ignorada — inclusive formas que a ferramenta original aceitaria sem reclamar.

A escolha é deliberada e tem uma razão só: quanto menor a superfície que o validador precisa entender, menor a chance de ele afirmar algo falso sobre o que o gate fará. Uma gramática permissiva exigiria reimplementar a semântica de resolução do ESLint e do Vitest, e a cada divergência entre as duas leituras nasceria um caminho para esvaziar o gate mantendo o validador satisfeito.

Restrições principais, sem promessa de suporte a nenhuma forma além destas:

- **Nada executável.** Chamada, expressão imediatamente invocada, `import(...)`, `await import(...)`, acessador, método, espalhamento, atribuição e identificador livre reprovam, em qualquer profundidade, tanto no lint quanto na cobertura. Na cobertura isso não depende mais de reconhecer a forma do valor: como todos os níveis inspecionados têm conjunto fechado de propriedades, a recusa vem do **nome** da propriedade, antes de o valor ser lido. Formas executáveis que não usam parêntese — `new Reporter`, um tagged template, `modulo.prop`, `globalThis.x = 1`, `await promessa` — reprovam pelo mesmo caminho.
- **Dois níveis fechados na cobertura.** O objeto exportado de `vitest.config.ts` declara **somente** `test`; `test` declara **somente** `coverage`. Propriedade legítima do Vitest reprova: `plugins`, `resolve`, `esbuild`, `define`, `globals`, `environment`, `setupFiles`, `globalSetup`, `reporters`, `snapshotSerializers`, `include`, `exclude`, `bail`, `testTimeout` e `passWithNoTests` estão entre as recusadas. A razão é dupla — parte desses nomes faz o runner importar e executar um arquivo escolhido pela candidata, e outra parte esvazia a medição sem tocar em um único limiar. Ampliar o conjunto exige o PR próprio descrito adiante nesta seção. A recusa não ecoa o nome nem o valor da propriedade: o defeito é a forma.
- **Preâmbulo do lint.** Antes do único `export default`, apenas espaços, comentários e a importação do analisador. A configuração de cobertura não admite preâmbulo algum.
- **Expressão exportada.** No lint, um array literal de objetos literais. Na cobertura, um objeto literal direto — envoltório de função, inclusive `defineConfig(...)`, reprova. Depois do objeto exportado só cabem espaços, comentários e o ponto e vírgula final.
- **Chaves com grafia direta.** `files`, `languageOptions`, `linterOptions` e `rules` precisam ser escritas literalmente; chave citada, computada ou com escape reprova. `ignores` mantém, por compatibilidade, as grafias citada e computada.
- **Conjunto fechado de propriedades.** No bloco de lint, apenas `files`, `ignores`, `languageOptions`, `linterOptions` e `rules`. Na cobertura, os quatro níveis inspecionados são fechados: no objeto exportado, apenas `test`; em `test`, apenas `coverage`; em `coverage`, apenas `include`, `exclude` e `thresholds`; em `thresholds`, apenas as quatro métricas. Qualquer outra propriedade reprova, mesmo com valor estático, e mesmo sendo uma opção real da ferramenta — `plugins`, `settings`, `name`, `processor`, `all`, `provider` e limiar por arquivo estão entre as recusadas.
- **Padrões de caminho.** Dialeto restrito: `*`, `**`, `?` e classes de caracteres simples. Expansão por chaves, extglob, parênteses de grupo, classe POSIX nomeada e contrabarra no valor decodificado reprovam, porque este verificador não os interpreta como o consumidor interpretaria.
- **Valores das regras.** Fora de `complexity`, apenas literais estáticos: texto, número decimal finito, `true`, `false`, `null`, e array ou objeto compostos recursivamente desses valores. Inteiro com zero à esquerda, expoente, hexadecimal, separador numérico e sufixo `n` reprovam.

Exemplo mínimo e completo de `eslint.config.mjs` aceito:

```javascript
import parser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    rules: { complexity: ["error", { max: 10, variant: "classic" }] }
  }
];
```

Exemplo mínimo e completo de `vitest.config.ts` aceito:

```typescript
export default {
  test: {
    coverage: {
      include: ["src/modules/**", "src/shared/**"],
      exclude: [],
      thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 }
    }
  }
};
```

Os dois exemplos foram derivados das fixtures positivas da suíte do validador, e os blocos publicados acima foram extraídos deste documento e validados separadamente pela CLI real.

`tooling/toolchain/complexity.config.mjs` **não** é uma configuração candidata e não passa por esta gramática. Ela pertence à base confiável, é versionada junto dos validadores e usa formas que a gramática candidata recusaria — segunda importação, constantes, verificação de invariante e espalhamento. A assimetria é o próprio desenho: a base pode ser mais expressiva porque não é o objeto sob verificação.

**Não existe exceção para contornar esta gramática.** `quality/policy-exceptions.json` registra afrouxamento de política — limiar reduzido, exclusão acrescentada, padrão canônico removido — e não autoriza forma sintática que o validador não reconheça. Uma necessidade legítima de forma nova exige **um PR próprio que amplie o validador**, com testes que a cubram e revisão, antes que a forma seja usada por qualquer candidato. Enquanto esse PR não for mesclado, a forma reprova.

Análise estática é incompleta por natureza: ela não alcança toda forma de esvaziar um gate por composição dinâmica. A evidência decisiva é comportamental, e vem das provas de canário do PR 7, que injetam uma violação deliberada por gate e reprovam qualquer gate que aprove a própria violação.

## Runtime

`.nvmrc`, `engines.node` do `package.json` e `packages[""].engines.node` do lockfile raiz declaram a mesma versão: **24.21.0**.

A paridade entre esses três e o workflow ainda não está fechada: fazer o workflow derivar a versão do `.nvmrc` da base pertence ao PR 6.

## Ativação humana no GitHub

1. Criar o repositório privado e enviar o pacote inicial.
2. Instalar o Claude GitHub App ou configurar a Claude Code Action manualmente.
3. Cadastrar `ANTHROPIC_API_KEY` e um limite de gasto apropriado.
4. Fazer um PR de teste e verificar os três nomes de check.
5. Criar ruleset para a branch principal exigindo os três checks e pelo menos uma aprovação humana.
6. Exigir resolução de conversas, nova aprovação após commits e bloquear force-push/exclusão.
7. Não permitir bypass rotineiro; documentar conta de emergência e auditoria.

O workflow usa `pull_request`, não `pull_request_target`. PRs de forks sem o secret ficam bloqueados por desenho; o primeiro repositório é privado e não precisa aceitar contribuições externas.
