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
