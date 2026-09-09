# Especificação 3 — endurecimento da governança e dos quality gates

<!-- spec-meta
{"id":"3","issue":"github:#3","status":"approved"}
-->

## Status

Proposta ao revisor como candidata a aprovada. O metadado `status` já registra `approved` porque `tooling/governance/validate-spec.mjs` (linhas 43-45) recusa qualquer outro valor, e `tooling/governance/validate-pr.mjs` (linha 76) executa esse validador sobre o candidato em PR do tipo `spec`. A aprovação real é o merge humano deste PR.

**A implementação desta especificação só pode começar depois que este PR de spec for revisado e mesclado na `main`.** `validate-pr.mjs` (linha 66) exige que a spec exista na branch base e no candidato, e a linha 70 exige que ela permaneça byte a byte idêntica no PR de implementação. Abrir código antes do merge reprova o gate por construção.

Convenção de identificação adotada a partir desta spec: o id é o número exato da issue do GitHub, sem zero à esquerda. `validate-pr.mjs` (linhas 57-59) compara id da spec e número da issue como texto, e `"3" !== "003"`. `specs/004-ai-engineering-system.md` permanece como outlier histórico, registrado e encerrado na issue #4.

## Problema

O repositório contém hoje apenas a camada de governança: tooling em Node, grafo de contexto, gates de PR, specs e tasks. Não existe aplicação, banco, migrations nem CI de aplicação.

Antes de acrescentar a fundação do produto, defeitos da própria governança precisam ser corrigidos. Cada um deles, se sobreviver à fundação, passa a exigir retrabalho sobre código já mesclado.

1. **Referências fixas a `004`.** `package.json` (linhas 13 e 15) e `.github/workflows/pr-gates.yml` (linhas 82-83) validam um único plano e uma única spec, por caminho literal. Todo plano ou spec novo nasce sem validação.
2. **Scripts de instalação não confiáveis.** O job `quality` executa `npm ci` no diretório do candidato, rodando scripts de ciclo de vida de dependências escolhidas pelo PR antes de qualquer gate.
3. **Política que não se autovalida.** `tooling/quality/run-trusted-application-gates.mjs` (linhas 12-14) lê a política da branch base. Hoje ela está `enabled: false`, logo nenhum gate de aplicação roda. O primeiro PR que adicionar a aplicação seria mesclado sem nenhum dos seis gates.
4. **Semântica do gate delegada ao candidato.** Um contrato baseado em `npm run <script>` deixa o significado de cada gate no `package.json` do candidato. Redefinir `"lint": "echo ok"` transformaria um gate em ruído aprovado, sem que a política percebesse.
5. **Configuração do candidato sem verificação.** Mesmo com comandos fixados, o candidato controla configuração de teste, cobertura, lint e regras de dependência. Exclusões amplas, limiares reduzidos ou conjuntos de regras vazios esvaziam o gate por dentro.
6. **Cobertura sem escopo declarado.** `quality/policy.json` fixa 80/75/80/80 sem dizer o que é medido, criando pressão para reduzir o limite — o que a skill `quality-gate` proíbe.
7. **Versão de Node divergente.** `package.json` (linha 7) declara `>= 22`; o workflow (linha 72) usa `node-version: 24`.
8. **Referência a diretório inexistente.** `docs/architecture.md` (linha 11) descreve `buffet-mvp` como diretório deste repositório. Ele não existe.
9. **Risco de versionamento acidental.** Existe na raiz um documento de trabalho não rastreado, e `.gitignore` não cobre chaves, dumps, backups nem credenciais de ferramenta.
10. **Confusão entre PR de spec e PR de implementação.** A regra existe em `validate-pr.mjs` (linha 79), mas não está em `AGENTS.md`, e `templates/spec.md` contradiz o validador quanto ao estado da spec.
11. **Revisão por IA sem efeito de bloqueio garantido.** O resultado da revisão precisa ser publicado no commit que a proteção da branch avalia. Publicar no commit errado produz um check verde irrelevante.
12. **Falha técnica confundida com achado crítico.** Sem orçamento dimensionado e sem classificação explícita, uma revisão que se esgota por limite de turnos, timeout ou erro de API produz reprovação indistinguível de uma reprovação por defeito real do código. Isso corrói a confiança no gate e leva a ignorá-lo.

Quem sofre: quem revisa e quem mescla. Sem estas correções, o gate aprova por omissão em vez de reprovar por evidência, e a revisão humana passa a ser a única defesa real.

## Resultado esperado

Depois do merge da implementação desta especificação:

- todo plano e toda especificação aplicáveis são validados, inclusive os criados ou alterados pelo próprio PR, sem que alteração legítima seja confundida com duplicação;
- o significado de cada quality gate é fixado pela branch base, com comando e argumentos completos, e não pode ser redefinido pelo candidato;
- a origem de cada ferramenta está declarada, e as ferramentas que inevitavelmente vêm do candidato têm controles compensatórios explícitos;
- a configuração de teste, cobertura, lint e dependências do candidato é verificada contra regras da base;
- qualquer tentativa de afrouxar a política é reprovada, salvo autorização determinística previamente presente na base e vinculada a uma spec aprovada;
- nenhum job que instala ou executa código do candidato roda scripts de ciclo de vida, recebe segredo ou usa cache cuja chave o PR controla;
- o primeiro PR que adicionar a aplicação executa os seis quality gates de forma fail-closed;
- a revisão por IA roda em workflow controlado pela base, trata o diff apenas como dado, e seu veredito é publicado no commit exato que a proteção da branch avalia;
- a própria Fase 0 é validada de ponta a ponta antes do merge, com execução limpa e seis canários isolados.

## Escopo

### Item 1 — os seis quality gates, enumerados

A política confiável enumera exatamente seis comandos, nesta ordem:

1. `typecheck` — verificação de tipos;
2. `lint` — análise estática de estilo e correção;
3. `test:coverage` — testes com cobertura;
4. `quality:complexity` — complexidade ciclomática;
5. `quality:dependencies` — arquitetura de dependências;
6. `build` — compilação.

### Item 2 — comandos e argumentos vindos da política confiável

Cada comando declara, na política da branch base, o executável e a lista completa de argumentos. O runner executa o binário diretamente, com `shell: false`.

`npm run` e qualquer script definido pelo candidato deixam de ser autoridade do gate. O candidato pode manter scripts de conveniência em `package.json`, mas o gate não os consulta: redefinir `"lint": "echo ok"` não altera o que o gate executa.

O validador da política recusa, com mensagem específica: executável fora do allowlist da base; executável cujo nome base seja interpretador de comandos ou empacotador de execução, incluindo `sh`, `bash`, `zsh`, `dash`, `ash`, `ksh`, `csh`, `fish`, `cmd`, `cmd.exe`, `command.com`, `powershell`, `powershell.exe`, `pwsh`, `env`, `xargs`, `sudo`, `npm`, `npx`, `yarn` e `pnpm`; argumentos de avaliação de código arbitrário, como `-e`, `--eval`, `-p`, `--print`, `-r` e `--require`; lista de argumentos vazia; e qualquer indício de execução por shell na invocação.

`shell: false` é invariante do runner, não opção de configuração.

### Item 3 — origem das ferramentas: trusted e candidata

Fixar comando e argumentos garante a **invocação**, não a **implementação**. Se o binário vier de `candidate/node_modules`, o código que decide aprovar ou reprovar é do candidato. Esta especificação não afirma que a semântica dos gates é integralmente confiável.

A implementação classifica cada gate por origem da ferramenta e declara essa classificação na política:

- **Toolchain da base, sempre que possível.** Ferramentas cujo funcionamento não depende da versão exata usada pela aplicação são instaladas a partir de um lockfile próprio da branch base, isolado do lockfile do candidato, e executadas contra o código-fonte do candidato. Esse é o alvo para análise de arquitetura de dependências e para análise de complexidade.
- **Toolchain do candidato, quando inevitável.** Verificação de tipos, execução de testes com cobertura e compilação precisam da mesma versão de ferramenta que a aplicação usa; forçar outra versão produziria resultado inválido. Esses gates são declarados explicitamente como dependentes do candidato.

Para cada gate declarado como dependente do candidato valem, cumulativamente: versão e integridade da ferramenta verificadas no lockfile antes da execução, conforme o item 13; prova de canário obrigatória, conforme o item 4; e revisão humana explícita de qualquer diff que altere a versão dessas ferramentas ou sua configuração.

A política registra, por comando, se a origem é `base` ou `candidato`. Um comando declarado como `base` cujo executável resolva dentro da árvore do candidato é rejeitado.

### Item 4 — validação da configuração candidata e prova de canário

Um validador da base examina a configuração candidata **sem importar nem avaliar** esses arquivos, tratando-os como texto e dado.

Regras verificadas: o conjunto medido de cobertura inclui `src/modules/**` e `src/shared/**`, e padrão de exclusão que alcance qualquer um desses caminhos é rejeitado; limiar declarado na configuração candidata inferior ao da política é rejeitado; padrão de ignorar do lint que alcance `src/**` é rejeitado, assim como desativar a regra de complexidade ou elevá-la acima do máximo da política; as quatro regras de dependência declaradas em `quality/policy.json` precisam estar presentes com severidade de erro, e conjunto vazio é rejeitado; e configuração que torne qualquer gate um no-op é rejeitada.

Como análise estática de configuração nunca é completa, a evidência decisiva é comportamental. Uma **prova de canário** mantida na base injeta, em ambiente descartável, uma violação deliberada por gate: erro de tipo, violação de lint, teste falho, função acima do limite de complexidade, importação proibida e erro de compilação. Um gate que aprove o próprio canário é considerado quebrado e reprova.

Complementarmente, o relatório de cobertura precisa listar ao menos um arquivo sob `src/modules/**` e um sob `src/shared/**`.

### Item 5 — comparador de política com igualdade exata

O comparador da base confronta a política candidata com a da base e exige, para o conjunto de comandos, **igualdade exata**: mesma quantidade, exatamente seis; mesma ordem; mesmo `name`; mesmo `executable`; mesma origem declarada; e mesma lista de argumentos, elemento a elemento, sem acréscimo, remoção, reordenação ou substituição.

Trocar um argumento por `--passWithNoTests`, apontar para outro caminho de configuração, acrescentar um padrão de exclusão ou reordenar argumentos reprova. O comparador não interpreta a intenção do argumento: qualquer diferença é diferença.

Além dos comandos, o comparador reprova: mudar `enabled` de verdadeiro para falso; reduzir qualquer limiar de cobertura; elevar o máximo de complexidade; ampliar exclusões de cobertura; remover qualquer padrão da lista canônica de `appliesWhenChanged`; e introduzir entrada em `allowedRebuilds`.

A verificação roda em **todo** PR, inclusive nos que tocam apenas `quality/**`, que permanece fora de `appliesWhenChanged` para evitar auto-referência.

### Item 6 — lista canônica mínima de `appliesWhenChanged`

A base declara uma **lista canônica mínima** de padrões obrigatórios. A política candidata precisa conter todos eles.

A comparação é feita sobre **valores normalizados** — recorte de espaços em branco nas extremidades e normalização de forma Unicode — e exige correspondência exata de cadeia. O comparador **não** tenta deduzir semanticamente se um glob é mais ou menos abrangente que outro, porque essa dedução é indecidível na prática e produziria tanto falso negativo quanto falsa sensação de segurança. Padrões adicionais são permitidos; ausência de qualquer padrão canônico reprova.

Lista canônica mínima: `src/**`; `tests/**`; `**/__tests__/**`; `**/*.test.*`; `**/*.spec.*`; `package.json`; `package-lock.json`; `npm-shrinkwrap.json`; `.npmrc`; `tsconfig*.json`; `next.config.*`; `eslint.config.*`; `.eslintrc*`; `vitest.config.*`; `vitest.workspace.*`; `.dependency-cruiser.*`; `postcss.config.*`; `tailwind.config.*`; `coverage.config.*`; `db/**`; `migrations/**`; `Dockerfile*`; `.dockerignore`; `docker-compose*.yml`; `docker-compose*.yaml`; `compose*.yml`; `compose*.yaml`; `scripts/**`; `.nvmrc`.

Exclusão e renomeação de caminho coberto também disparam os gates.

### Item 7 — autorização determinística de exceção

Afrouxamento legítimo existe, mas não pode depender de interpretação de texto livre em corpo de PR, comentário ou mensagem de commit.

A base mantém um registro de autorizações em `quality/policy-exceptions.json`, versionado e confiável. Cada entrada declara, em campos estruturados: identificador da exceção; caminho da especificação que a autoriza; issue correspondente; a classe de mudança autorizada, escolhida de um conjunto fechado de classes reconhecidas pelo comparador; o valor exato autorizado; e data de expiração.

Quando o comparador detecta um afrouxamento, ele procura no registro **da base** uma entrada que corresponda exatamente à classe de mudança e ao valor detectados. A entrada só é aceita quando: existe no snapshot da base, não no candidato; a especificação referenciada existe no snapshot da base e está aprovada; a issue declarada corresponde à da especificação; e a data de expiração não passou.

Consequências deliberadas: uma exceção introduzida no mesmo PR que a utiliza é rejeitada, porque precisa estar previamente na base; uma exceção sem especificação aprovada correspondente é rejeitada; e uma exceção cujo valor não coincida exatamente com o afrouxamento detectado é rejeitada. Ausência de entrada aplicável reprova.

### Item 8 — dois snapshots para planos e especificações

A validação opera sobre dois conjuntos distintos, cada um íntegro em si: o **snapshot da base**, com todos os planos e specs de `trusted/`; e o **snapshot candidato efetivo**, no qual arquivos adicionados ou alterados pelo candidato substituem os correspondentes e arquivos excluídos são removidos.

Cada snapshot é validado integralmente. A unicidade de caminho, de `id` e de `task` é verificada dentro de cada snapshot, nunca pela união dos dois. Sem essa separação, alterar um plano existente apareceria como dois planos com o mesmo `task`, e uma alteração legítima seria reprovada como duplicação.

Regras adicionais por entrada candidata sob `orchestration/plans/`: formato `^orchestration/plans/[0-9]+\.json$` estrito, com qualquer outro nome, extensão ou subdiretório rejeitado e não ignorado; recusa de caminho que resolva fora do diretório de planos do candidato; recusa de symlink em qualquer componente, verificado por `lstat` e nunca seguido; e recusa de exclusão de plano presente na base, com renomeação tratada como exclusão mais adição.

`specs/` recebe o mesmo tratamento de snapshot, com o formato `^specs/[0-9]+-[a-z0-9-]+\.md$` já usado em `validate-pr.mjs` (linha 17).

O código do validador vem sempre da branch base. Arquivos do candidato são dado, nunca instrução: `JSON.parse`, jamais `import`.

### Item 9 — lista de alterações confiável

A lista é produzida com `git diff --name-status -z --no-renames`, entre o SHA de base e o SHA de head obtidos do contexto confiável do evento, nunca do corpo do PR.

O parsing é NUL-safe, sobre `Buffer`, sem conversão prévia para texto: a saída é dividida em campos por `0x00`, alternando status e caminho.

**São aceitos exclusivamente os status `A`, `M` e `D`.** Mudança de tipo `T` reprova, assim como `R`, `C`, `U`, `X` e qualquer outro valor. O status aceito é preservado e disponibilizado às demais regras.

São rejeitadas também: entrada com número ímpar de campos; e caminho vazio, absoluto, contendo `..` ou contendo barra invertida.

### Item 10 — contrato do runner e disponibilidade dos dois commits

`tooling/quality/run-trusted-application-gates.mjs` passa a exigir `--changed` explicitamente, além de `--policy` e `--candidate`. A ausência do argumento é erro, nunca aprovação silenciosa.

O workflow garante que os dois commits necessários ao diff estejam presentes no runner antes de gerar a lista de alterações.

### Item 11 — Node vindo de `trusted/.nvmrc`

Alinhamento em uma única versão, com patch fixado, em `.nvmrc`, em `engines.node` e no workflow, que usa `node-version-file: trusted/.nvmrc`, apontando explicitamente para a cópia da branch base. Apontar para o `.nvmrc` do candidato deixaria o PR escolher o runtime que executa o próprio código.

### Item 12 — instalação sem scripts e `allowedRebuilds` vazio

`npm ci --ignore-scripts` é obrigatório no job que instala dependências do candidato, sem exceção configurável pelo candidato.

**`allowedRebuilds` permanece vazio nesta fase.** Nenhuma reconstrução é autorizada.

Uma exceção futura exige especificação própria e a autorização determinística do item 7, fixando nome do pacote, versão exata, integridade esperada, verificação do lockfile confirmando essa versão e essa integridade antes da execução, e ambiente de execução sem segredos e sem permissão de escrita. `npm rebuild` sem argumento permanece proibido.

### Item 13 — verificação do lockfile

Todo PR que altere `package-lock.json` ou `npm-shrinkwrap.json`, automatizado ou não, passa por verificação da base que reprova: resolução para registry não autorizado; resolução por URL Git, em qualquer forma; resolução por tarball fora do registry autorizado; e campo de integridade ausente, malformado ou com algoritmo fora do conjunto aceito.

A mesma verificação atende ao item 3, confirmando versão e integridade das ferramentas de gate que vêm do candidato.

### Item 14 — ativação dos gates no primeiro PR da aplicação

A política é uma regra sobre o diff do PR, não uma afirmação sobre a árvore da base. A base não precisa conter `src/` para que a política esteja ativa.

O PR que ativa a política é julgado pela política antiga, ainda `enabled: false`, e por isso pode ser mesclado sem que exista qualquer código de aplicação. Depois do merge, um PR que altere somente `specs/` e `tasks/` não casa o predicado e é registrado como fora de escopo. Um PR que adicione a aplicação casa o predicado e passa a ter os seis comandos obrigatórios, executados após `npm ci --ignore-scripts`.

Fail-closed: a política define comando e argumentos; o candidato fornece configuração, ela própria verificada. Ferramenta ausente, configuração inválida ou saída de erro reprovam.

Consequência aceita conscientemente: entre o merge desta implementação e o merge da fundação, qualquer PR que toque caminhos cobertos dispara os seis gates e falha, porque a aplicação ainda não existe. Nesse intervalo entram apenas PRs documentais e o PR de spec da fundação.

### Item 15 — tipo automatizado inferido de metadados confiáveis

`validate-pr.mjs` passa a reconhecer um tipo de PR para atualização automatizada de dependências. A classificação é inferida exclusivamente dos metadados confiáveis do evento, entregues pelo workflow: autor, referência da branch de origem e repositório de origem. O campo `Tipo:` do corpo é irrelevante para essa classificação, porque o corpo é criado pelo próprio bot e é dado não confiável.

A isenção alcança somente os campos `Issue` e `Spec`. Nenhum gate, verificação de lockfile, revisão ou aprovação humana é dispensado.

Condições cumulativas: autor exatamente `dependabot[bot]`; branch de origem casando `^dependabot/`; repositório de origem idêntico ao repositório base, com fork recusado mesmo que o nome da branch coincida; ecossistema `npm`; e arquivos alterados limitados a `package.json`, `package-lock.json` e `npm-shrinkwrap.json`.

Se qualquer condição falhar, o PR é reprovado imediatamente como tipo automatizado, sem conversão ambígua para outro fluxo. Atualização manual de dependências, ou qualquer atualização do ecossistema `github-actions`, usa `Tipo: implementação`, com issue, especificação aprovada na base e evidência TDD.

### Item 16 — actions fixadas por SHA imutável

Toda entrada `uses:` referencia uma action por SHA de commit de quarenta caracteres hexadecimais, acompanhada de comentário indicando a versão correspondente. Referência por tag, branch ou intervalo é rejeitada. Atualizações do ecossistema `github-actions` precisam comprovar, na revisão, que o SHA proposto corresponde à release oficial indicada no comentário.

### Item 17 — separação entre gates determinísticos e revisão por IA

**Gates determinísticos**, no evento `pull_request`: executam e instalam código do candidato, e por isso não recebem nenhum segredo.

**Revisão por IA**, em workflow controlado pela base, no evento `pull_request_target`, usado exclusivamente para ler e revisar o diff como dado. Esse job não faz checkout do head candidato e não executa nenhum código, comando ou arquivo executável do candidato; obtém o diff pela API do GitHub; e não disponibiliza ao agente nenhuma ferramenta de rede, restringindo-o a leitura, busca e listagem de arquivos da base.

`pull_request_target` é adequado aqui precisamente porque é controlado pela base, e permanece seguro apenas enquanto não houver checkout nem execução do head. A separação é verificada por lint estático, não por convenção.

### Item 18 — credenciais do workflow de revisão

O workflow de revisão possui **duas** credenciais: o segredo dedicado da Anthropic e o `GITHUB_TOKEN` efêmero da execução.

Nenhuma das duas pode entrar no prompt enviado ao modelo nem ficar acessível às ferramentas do agente. A comunicação com a API da Anthropic e com a API do GitHub é feita pelo job e por ações confiáveis, não pelo agente. O agente permanece restrito a leitura, busca e listagem de arquivos da base.

### Item 19 — materialização do diff para revisão

A montagem do material enviado à revisão é fail-closed. Ela precisa: paginar a lista completa de arquivos do PR até o fim, sem depender do tamanho padrão de página; conferir a quantidade obtida com o campo `changed_files` do PR e reprovar em caso de divergência; detectar patch ausente, truncado ou indisponível para qualquer arquivo; declarar limites explícitos de quantidade de arquivos, tamanho por patch e tamanho total; e reprovar quando o conteúdo completo não puder ser revisado, em vez de revisar um subconjunto silencioso.

Arquivos binários não são enviados à revisão. Sua presença bloqueia o fluxo automatizado e o encaminha para um fluxo manual explicitamente especificado, com inspeção humana registrada.

### Item 20 — publicação do veredito no SHA correto

Em `pull_request_target`, `GITHUB_SHA` aponta para a base. Um check publicado nesse commit não é o check que a proteção da branch avalia, e presumir o contrário produziria um veredito sem efeito de bloqueio.

Depois de validar a saída estruturada, um **job publisher separado** publica o resultado. Esse job não recebe o segredo da Anthropic e declara somente `checks: write` além da leitura necessária.

Antes de publicar, o publisher obtém novamente pela API o SHA que a proteção da branch estará avaliando e o compara com o estado do PR registrado no início da revisão. O SHA não é presumido a partir de `GITHUB_SHA`.

O check publicado falha quando: a saída estruturada estiver ausente ou malformada; a contagem de achados críticos divergir da quantidade de achados críticos presentes; houver qualquer achado crítico; o SHA do PR tiver mudado desde o início da revisão; ou não for possível identificar com segurança o SHA avaliado.

A proteção da branch exige o **nome exato** desse check e sua **origem esperada**, de modo que um check homônimo produzido por outra origem não satisfaça a exigência.

### Item 21 — orçamento e conclusividade da revisão

Um veredito de revisão só é informação útil quando o revisor teve orçamento para produzi-lo e quando o resultado distingue defeito de indisponibilidade.

**Orçamento dimensionado.** O limite de turnos e o timeout do job de revisão são dimensionados e testados para o **maior diff que a política permite**, conforme os limites declarados no item 19. Orçamento não é escolhido por tentativa: existe teste que exercita o limite máximo aceito de tamanho de diff e comprova que a revisão produz saída estruturada válida dentro do orçamento.

**Classificação de falhas.** São falhas técnicas ou inconclusivas, não achados: esgotamento do limite de turnos; timeout do job; erro da API; saída estruturada ausente ou inválida; e esgotamento causado por tentativas de uso de ferramentas negadas.

Todas continuam **bloqueando o merge de forma fail-closed** — ausência de veredito nunca é aprovação. Nenhuma delas, porém, pode ser apresentada como "falha crítica encontrada", porque nada foi encontrado: a revisão não concluiu.

**Três estados distintos.** O relatório e o check publicado distinguem explicitamente: revisão aprovada, sem achado crítico; achado crítico, com a evidência correspondente; e revisão inconclusiva por falha técnica ou de configuração, com a causa classificada. O terceiro estado nomeia a causa e não é rotulado com a linguagem do segundo.

**Compatibilidade entre ferramentas e prompt.** A lista de ferramentas permitidas ao agente e as instruções do prompt precisam ser coerentes: o prompt não pode solicitar, direta ou indiretamente, ação que exija ferramenta ausente da lista. Cada tentativa negada consome orçamento sem produzir revisão. O canário de ponta a ponta comprova conclusão **sem nenhuma tentativa de ferramenta proibida**.

**Retry.** Repetição automática é opcional. Se implementada, precisa ser limitada em quantidade e permitida somente para falhas transitórias explicitamente classificadas como tais. Repetição nunca pode transformar ausência de veredito em aprovação, e o esgotamento das tentativas mantém o estado inconclusivo e o bloqueio.

**Evidência operacional que originou este requisito.** O PR #6, que propôs esta própria especificação, teve o check `claude-critical-review` reprovado após 9 minutos e 33 segundos. A execução terminou com `subtype: error_max_turns`, `num_turns: 11` contra um limite configurado de 10, `permission_denials_count: 3` e ausência de `structured_output`. O passo de veredito fail-closed ficou como não executado, e nenhum achado foi produzido. O diff em análise tinha 519 linhas em um único arquivo. O comportamento de bloqueio estava correto; o que faltou foi orçamento compatível com o material, e o resultado foi exibido sem distinguir falha técnica de achado crítico.

### Item 22 — permissões exatas por job

- `governance` e `quality`: somente `contents: read`. Sem `id-token`, sem qualquer permissão de escrita, sem segredo.
- Revisão por IA: `contents: read` e `pull-requests: read`, além exclusivamente do segredo dedicado da Anthropic e do `GITHUB_TOKEN` efêmero.
- Publisher: `checks: write` e a leitura necessária, sem o segredo da Anthropic.
- Nenhum job que instala ou executa código do candidato recebe segredo.

O cache chaveado por arquivo do candidato é removido do job que executa código não confiável.

### Item 23 — bootstrap verificado da própria Fase 0

O PR de implementação desta especificação não pode se limitar a alterar validadores: precisa provar que o mecanismo resultante funciona sobre um repositório com a forma real da base.

A implementação executa, e anexa como evidência: as novas suítes candidatas de governança; uma simulação de ponta a ponta em ambiente descartável, com base sem aplicação, política nova ativa e um candidato mínimo; uma execução limpa em que os seis gates passam; e seis execuções em que cada canário falha isoladamente, uma por gate.

### Item 24 — isolamento das execuções

Cada execução limpa ou de canário usa workspace temporário novo, timeout explícito e instalação isolada.

Não há reuso de `node_modules`, de configuração nem de artefatos mutados entre gates ou entre execuções. Ao final de cada execução de canário, a implementação confirma que nenhuma mutação permaneceu para a execução seguinte, de modo que uma falha não possa ser herdada nem mascarada.

### Item 25 — higiene de repositório e adição explícita ao Git

`.gitignore` passa a ignorar o documento de trabalho da raiz e é endurecido para cobrir chaves e certificados, credenciais de ferramenta, dumps e backups, arquivos de sobreposição de container, artefatos de build e arquivos de sistema operacional.

`.gitignore` **evita inclusão acidental**; não impede inclusão deliberada, já que `git add -f` existe. Por isso a defesa é dupla: além da regra de ignorar, `validate-pr.mjs` reprova o PR quando a lista de arquivos alterados contiver caminho proibido — esse documento, qualquer `.env` que não seja `.env.example`, chaves, dumps, backups e `.npmrc`.

`AGENTS.md` passa a documentar que `git add` usa sempre caminhos explícitos, e que `git add -A`, `git add .` e `git commit -a` são proibidos para qualquer agente ou script.

### Item 26 — correção da referência a `buffet-mvp` e alinhamento do template

`docs/architecture.md` passa a descrever `buffet-mvp` como protótipo externo arquivado fora deste repositório, mantendo os oito motivos pelos quais não deve ser promovido a produção e acrescentando que nenhum arquivo, schema, histórico git ou arquivo de ambiente é importado.

`templates/spec.md` tem o texto sobre o estado da spec alinhado ao comportamento real do validador.

## Fora de escopo

- Aplicação Next.js, TypeScript, Tailwind, banco, migrations, autenticação e isolamento por Organização — pertencem à issue #5.
- Qualquer arquivo sob `src/**`, `db/**`, `Dockerfile`, `docker-compose*` ou dependência de aplicação.
- Cenário de teste de carga e objetivos de latência; `quality/policy.json` mantém `load.enabled: false`.
- Nginx, Cloudflare Tunnel, deploy, backups e restauração — pertencem a `tasks/003-infrastructure-baseline.md`.
- Alteração de `specs/004-ai-engineering-system.md`, encerrada na issue #4.
- Criação de arquivo em `tasks/` para esta especificação; `tasks/003-infrastructure-baseline.md` já existe e representa outra tarefa.
- Fechamento, edição ou aprovação dos PRs de atualização de dependências abertos.
- Autorização de qualquer entrada em `allowedRebuilds`.
- Qualquer segredo, token ou configuração de servidor de produção.

## Regras

1. O código de validação vem sempre da branch base. Arquivos do candidato são dado, nunca instrução: `JSON.parse`, jamais `import`.
2. O significado de um gate é fixado pela base, com comando e argumentos completos. Script do candidato não é autoridade de gate.
3. A origem de cada ferramenta é declarada. Nenhuma afirmação de confiabilidade é feita sobre binário que venha da árvore do candidato; esses gates dependem de integridade verificada, canário e revisão humana.
4. Execução de gate nunca passa por shell; `shell: false` é invariante.
5. Configuração fornecida pelo candidato é verificada contra regras da base, e o comportamento observado prevalece sobre a configuração declarada.
6. Igualdade de política é exata. Qualquer diferença em nome, executável, origem, ordem, quantidade ou argumento reprova.
7. Comparação de padrões é textual sobre valores normalizados; abrangência semântica de glob não é deduzida.
8. Afrouxamento só ocorre por autorização determinística previamente presente na base e vinculada a especificação aprovada.
9. Enumeração vazia nunca equivale a aprovação.
10. Gate ativado é fail-closed. Ausência de ferramenta, argumento, arquivo, patch ou evidência é reprovação.
11. Unicidade é verificada dentro de um snapshot íntegro, nunca pela união de base e candidato.
12. A lista de alterações vem do contexto confiável do evento, com parsing NUL-safe, e aceita somente os status `A`, `M` e `D`.
13. O candidato não escolhe o runtime, a política, os comandos, os argumentos nem a lista de reconstrução.
14. Nenhum job que instala ou executa código do candidato recebe segredo, `id-token` ou permissão de escrita.
15. `pull_request_target` só é admissível em workflow controlado pela base que não faça checkout nem execute o head.
16. Credencial nenhuma entra no prompt ou nas ferramentas do agente.
17. Veredito de revisão só tem valor quando publicado no commit que a proteção da branch avalia, com o SHA confirmado por consulta e não presumido.
18. Revisão sem veredito bloqueia, mas não acusa. Falha técnica ou inconclusiva nunca é apresentada como achado crítico.
19. Orçamento de revisão é dimensionado para o maior diff que a política permite, e essa suficiência é testada, não presumida.
20. Repetição automática só alcança falhas transitórias explicitamente classificadas, é limitada em quantidade, e jamais converte ausência de veredito em aprovação.
21. Isenção de campos de PR é estreita, inferida de metadados confiáveis, e fail-closed: falha de condição reprova, não converte.
22. Automação não altera sozinha o mecanismo que a fiscaliza: mudança em `.github/`, `tooling/` e `quality/**` exige inspeção humana explícita.
23. PR de especificação toca somente `specs/` e `tasks/`; plano de execução e grafo entram no PR de implementação.

## Superfícies de teste

- `tooling/orchestration/validate-execution-plan.mjs`: argumentos `--trusted`, `--candidate` e `--changed`; construção dos dois snapshots; mensagem distinta por classe de rejeição.
- `tooling/governance/validate-spec.mjs`: enumeração por snapshot, aceitando simultaneamente `github:#N` e `local:tasks/...`.
- `tooling/governance/validate-pr.mjs`: tipos de PR; correspondência entre id da spec e número da issue; imutabilidade da spec; restrição de caminhos em PR de spec; caminhos proibidos; e classificação do tipo automatizado a partir de metadados do evento.
- Verificador de lockfile: registry, URL Git, tarball, integridade, versão e integridade das ferramentas de gate.
- `tooling/quality/run-trusted-application-gates.mjs`: obrigatoriedade de `--changed`; allowlist de executáveis; recusa de shell e de argumentos de avaliação; origem declarada por comando; casamento do predicado incluindo exclusão e renomeação; comportamento fail-closed.
- Comparador de política: igualdade exata de comandos e as demais classes de afrouxamento.
- Registro de autorizações `quality/policy-exceptions.json`: correspondência exata, existência na base, spec aprovada, issue correspondente e expiração.
- Validador de configuração candidata e prova de canário por gate, em ambiente descartável.
- Parser da lista de alterações: entrada NUL-safe como `Buffer`, status aceitos, entradas inválidas rejeitadas.
- Materializador do diff de revisão: paginação, conferência com `changed_files`, patch ausente ou truncado, limites e binários.
- Publisher do check: resolução do SHA por consulta, comparação com o estado inicial, e as cinco condições de falha.
- Classificador de resultado da revisão: os três estados observáveis, e o mapeamento de cada causa técnica para o estado inconclusivo.
- Orçamento de revisão: execução no limite máximo de tamanho de diff permitido pela política, comprovando saída estruturada dentro do limite de turnos e do timeout.
- Coerência entre lista de ferramentas permitidas e prompt do revisor, medida pela contagem de tentativas negadas.
- Política de repetição: classificação de transitoriedade, limite de tentativas e impossibilidade de aprovar sem veredito.
- `.github/workflows/**` como dado verificável, por lint estático.
- `.gitignore` como dado verificável.
- Paridade de versão entre `.nvmrc`, `engines.node` e o workflow.
- Ausência de referência a `buffet-mvp` como caminho deste repositório.

## Critérios de aceite

**Comandos dos gates**

1. A política da base enumera exatamente seis comandos: verificação de tipos, lint, testes com cobertura, complexidade, arquitetura de dependências e build.
2. Cada comando declara executável e lista completa de argumentos na política da base; nenhum invoca `npm run` ou script do candidato.
3. O runner executa com `shell: false`; política que solicite execução por shell é rejeitada.
4. Executável fora do allowlist da base é rejeitado, incluindo interpretadores de comandos e empacotadores de execução.
5. Argumentos de avaliação de código arbitrário são rejeitados.
6. Comando com lista de argumentos vazia é rejeitado.
7. Um candidato que redefina o script `lint` para `echo ok` no `package.json` não altera o gate: o comando executado continua o da política, e a violação de lint reprova.

**Origem das ferramentas**

8. A política declara, por comando, se a origem da ferramenta é `base` ou `candidato`.
9. Um comando declarado como origem `base` cujo executável resolva dentro da árvore do candidato é rejeitado.
10. Os gates de arquitetura de dependências e de complexidade executam a partir do toolchain fixado pelo lockfile da base.
11. Os gates de tipos, testes com cobertura e build estão declarados como dependentes do candidato, com versão e integridade verificadas no lockfile antes da execução.
12. Nenhum texto da especificação ou da política afirma que a semântica é integralmente confiável para gate cuja ferramenta venha do candidato.
13. Alteração da versão dessas ferramentas ou de sua configuração exige revisão humana explícita registrada.

**Configuração candidata e canário**

14. O validador examina a configuração candidata sem importar nem avaliar os arquivos.
15. Conjunto de cobertura que não inclua `src/modules/**` e `src/shared/**` é rejeitado; exclusão que alcance esses caminhos é rejeitada.
16. Limiar declarado na configuração candidata inferior ao da política é rejeitado.
17. Padrão de ignorar do lint que alcance `src/**` é rejeitado; regra de complexidade desativada ou acima do máximo é rejeitada.
18. Ausência de qualquer uma das quatro regras de dependência, severidade abaixo de erro, ou conjunto vazio, é rejeitada.
19. O relatório de cobertura lista ao menos um arquivo sob `src/modules/**` e um sob `src/shared/**`.
20. A prova de canário reprova cada gate que aprove sua própria violação deliberada.

**Comparador de política**

21. O comparador exige quantidade exata de seis comandos; acrescentar ou remover comando reprova.
22. O comparador exige mesma ordem; reordenar comandos reprova.
23. O comparador exige igualdade de `name`, `executable` e origem declarada.
24. O comparador exige igualdade da lista de argumentos elemento a elemento; substituir um argumento por `--passWithNoTests` reprova.
25. Apontar para outro caminho de configuração ou acrescentar padrão de exclusão nos argumentos reprova.
26. Reordenar argumentos dentro de um comando reprova.
27. Mudar `enabled` de verdadeiro para falso reprova.
28. Reduzir limiar de cobertura ou elevar o máximo de complexidade reprova.
29. Ampliar exclusões de cobertura reprova.
30. Introduzir entrada em `allowedRebuilds` reprova.
31. A verificação roda em todo PR, inclusive nos que tocam apenas `quality/**`.

**Lista canônica de `appliesWhenChanged`**

32. A base declara a lista canônica mínima de padrões obrigatórios.
33. A política candidata contém todos os padrões canônicos; a ausência de qualquer um reprova.
34. A comparação é textual sobre valores normalizados, e o comparador não deduz abrangência semântica de glob.
35. Padrões adicionais além dos canônicos são aceitos.

**Autorização determinística de exceção**

36. Existe registro estruturado de autorizações com identificador, especificação, issue, classe de mudança, valor exato e expiração.
37. Afrouxamento sem entrada aplicável no registro da base reprova.
38. Entrada introduzida no mesmo PR que a utiliza reprova, porque precisa estar previamente na base.
39. Entrada cuja especificação não exista na base ou não esteja aprovada reprova.
40. Entrada cuja issue não corresponda à da especificação reprova.
41. Entrada expirada reprova.
42. Entrada cujo valor não coincida exatamente com o afrouxamento detectado reprova.
43. Nenhuma exceção depende de interpretação de texto livre.

**Snapshots de planos e specs**

44. São construídos dois snapshots: o da base e o candidato efetivo.
45. Cada snapshot é validado integralmente; falha em qualquer um reprova.
46. Unicidade de caminho, de `id` e de `task` é verificada dentro de cada snapshot.
47. Alteração legítima de um plano existente não é interpretada como duplicação.
48. Snapshot da base sem nenhum plano aplicável retorna erro.
49. São rejeitados nome fora de `^orchestration/plans/[0-9]+\.json$`, caminho que resolva fora do diretório de planos, symlink em qualquer componente, e exclusão de plano presente na base, com renomeação tratada como exclusão mais adição.
50. `specs/` recebe o mesmo tratamento e aprova simultaneamente `specs/3-governance-hardening.md` e `specs/004-ai-engineering-system.md`.
51. Nenhuma referência fixa a `004` permanece em `package.json` ou nos workflows.

**Lista de alterações**

52. A lista é produzida com `git diff --name-status -z --no-renames` a partir dos SHAs de base e head do contexto confiável.
53. O parsing é NUL-safe sobre `Buffer`.
54. Somente os status `A`, `M` e `D` são aceitos; mudança de tipo `T` reprova, assim como qualquer outro status.
55. São rejeitadas entrada com número ímpar de campos e caminho vazio, absoluto, com `..` ou com barra invertida.

**Contrato do runner e escopo**

56. `run-trusted-application-gates.mjs` exige `--changed`; a ausência é erro, não aprovação.
57. O workflow disponibiliza os dois commits necessários antes de gerar a lista de alterações.
58. Exclusão e renomeação de qualquer caminho coberto disparam os gates.
59. PR que altera somente `specs/` e `tasks/` é registrado como fora de escopo e aprovado.
60. Com caminho coberto alterado e ferramenta ou configuração ausente, o gate falha.

**Runtime, instalação e lockfile**

61. `.nvmrc`, `engines.node` e o workflow declaram a mesma versão e patch, e um teste falha se o workflow apontar para `.nvmrc` que não seja o da base.
62. O job que instala dependências do candidato usa `npm ci --ignore-scripts`.
63. `allowedRebuilds` está vazio; política com lista não vazia é reprovada nesta fase.
64. Resolução para registry não autorizado é rejeitada.
65. Resolução por URL Git é rejeitada.
66. Resolução por tarball fora do registry autorizado é rejeitada.
67. Integridade ausente, malformada ou com algoritmo fora do conjunto aceito é rejeitada.

**Tipo automatizado**

68. A classificação como atualização automatizada usa apenas metadados confiáveis do evento; o campo `Tipo:` do corpo não participa dessa classificação.
69. A falha de qualquer condição cumulativa reprova imediatamente o PR como tipo automatizado, sem conversão para outro fluxo.
70. PR automatizado que altere arquivo fora de manifesto e lockfile é reprovado.
71. Atualização manual de dependências e atualização do ecossistema `github-actions` exigem `Tipo: implementação`, issue, especificação aprovada na base e evidência TDD.

**Workflows, credenciais e permissões**

72. Toda entrada `uses:` está fixada por SHA de quarenta caracteres hexadecimais, com comentário de versão; tag, branch ou intervalo é rejeitado.
73. Atualização de `github-actions` comprova, na revisão, que o SHA corresponde à release oficial indicada.
74. Os gates determinísticos permanecem no evento `pull_request` e não recebem nenhum segredo.
75. A revisão por IA roda em workflow controlado pela base, no evento `pull_request_target`, restrito a ler e revisar o diff como dado.
76. O workflow de revisão não faz checkout do head candidato e não executa nenhum código, comando ou arquivo executável do candidato; o lint estático prova ambas as ausências.
77. O workflow de revisão possui duas credenciais: o segredo dedicado da Anthropic e o `GITHUB_TOKEN` efêmero.
78. Nenhuma credencial entra no prompt enviado ao modelo nem fica acessível às ferramentas do agente.
79. O agente não dispõe de nenhuma ferramenta de rede; a comunicação com as APIs é do job.
80. `governance` e `quality` declaram somente `contents: read`, sem `id-token` e sem permissão de escrita.
81. A revisão declara `contents: read` e `pull-requests: read`.
82. O publisher declara `checks: write` e a leitura necessária, e não recebe o segredo da Anthropic.
83. O cache chaveado por arquivo do candidato foi removido do job que executa código não confiável.

**Materialização do diff**

84. A lista de arquivos do PR é paginada até o fim.
85. A quantidade obtida é conferida com `changed_files` e a divergência reprova.
86. Patch ausente, truncado ou indisponível é detectado e reprova.
87. Limites explícitos de quantidade de arquivos, tamanho por patch e tamanho total estão declarados.
88. Quando o conteúdo completo não pode ser revisado, o fluxo reprova em vez de revisar subconjunto silencioso.
89. Arquivo binário não é enviado à revisão e encaminha o PR ao fluxo manual especificado, com inspeção humana registrada.

**Publicação do veredito**

90. Um job publisher separado publica o resultado, sem o segredo da Anthropic.
91. O SHA avaliado é obtido novamente pela API e comparado com o estado do PR registrado no início da revisão; não é presumido a partir de `GITHUB_SHA`.
92. O check falha quando a saída estruturada está ausente ou malformada.
93. O check falha quando a contagem de críticos diverge dos achados presentes.
94. O check falha quando existe qualquer achado crítico.
95. O check falha quando o SHA do PR mudou desde o início da revisão.
96. O check falha quando não é possível identificar com segurança o SHA avaliado.
97. A proteção da branch exige o nome exato do check e sua origem esperada.

**Orçamento e conclusividade da revisão**

98. O limite de turnos e o timeout do job de revisão estão dimensionados para o maior diff permitido pelos limites declarados no item 19 do Escopo.
99. Existe teste que exercita o limite máximo aceito de tamanho de diff e comprova que a revisão produz saída estruturada válida dentro do orçamento.
100. Esgotamento do limite de turnos é classificado como falha técnica ou inconclusiva, nunca como achado.
101. Timeout do job é classificado como falha técnica ou inconclusiva.
102. Erro da API é classificado como falha técnica ou inconclusiva.
103. Saída estruturada ausente ou inválida é classificada como falha técnica ou inconclusiva.
104. Esgotamento causado por tentativas de uso de ferramentas negadas é classificado como falha técnica ou inconclusiva.
105. Toda falha das cinco classes acima bloqueia o merge de forma fail-closed.
106. Nenhuma falha dessas classes é apresentada com a linguagem de achado crítico.
107. O relatório e o check distinguem explicitamente três estados: revisão aprovada, achado crítico, e revisão inconclusiva por falha técnica ou de configuração, com a causa nomeada.
108. A lista de ferramentas permitidas ao agente e o prompt do revisor são coerentes: o prompt não solicita ação que exija ferramenta ausente da lista.
109. O canário de ponta a ponta comprova conclusão da revisão sem nenhuma tentativa de ferramenta proibida.
110. Repetição automática, quando implementada, é limitada em quantidade e restrita a falhas transitórias explicitamente classificadas.
111. Repetição automática nunca converte ausência de veredito em aprovação, e o esgotamento das tentativas mantém o estado inconclusivo e o bloqueio.

**Bootstrap e isolamento**

112. O PR de implementação executa as novas suítes candidatas de governança.
113. O PR de implementação executa uma simulação de ponta a ponta descartável, com base sem aplicação, política nova ativa e candidato mínimo.
114. O PR de implementação executa uma execução limpa em que os seis gates passam.
115. O PR de implementação executa seis execuções em que cada canário falha isoladamente, uma por gate.
116. Cada execução usa workspace temporário novo, timeout explícito e instalação isolada.
117. Não há reuso de `node_modules`, configuração ou artefatos mutados entre gates ou execuções.
118. Ao final de cada execução de canário, é confirmado que nenhuma mutação permaneceu para a execução seguinte.

**Higiene e governança**

119. `.gitignore` ignora o documento de trabalho da raiz, evitando inclusão acidental, e o gate reprova o PR caso esse caminho apareça na lista de alterações.
120. O gate reprova caminho proibido na lista de alterações, incluindo `.env` que não seja `.env.example`, chaves, dumps, backups e `.npmrc`.
121. Nenhum documento referencia `buffet-mvp` como caminho deste repositório.
122. `AGENTS.md` documenta o uso de caminhos explícitos em `git add` e proíbe adição indiscriminada.
123. `npm run quality:governance` passa e todas as suítes de `tooling/**` continuam verdes.

## Riscos e decisões pendentes

**Semântica de gate parcialmente candidata.** Verificação de tipos, testes com cobertura e compilação dependem de ferramenta instalada a partir do lockfile do candidato. A invocação é confiável; a implementação não é. Os controles compensatórios são integridade verificada, prova de canário e revisão humana do diff de versão e de configuração. Risco declarado, não eliminado.

**Análise estática de configuração é incompleta por natureza.** Ler configuração como texto evita executar código do candidato, mas não cobre toda forma de esvaziar um gate por composição dinâmica. A prova de canário mede comportamento observado, não intenção declarada. Ainda assim, um candidato suficientemente criativo pode encontrar caminhos não cobertos; a mitigação final continua sendo inspeção humana dos diffs de configuração.

**Alteração do próprio workflow.** Em eventos `pull_request`, o GitHub Actions usa o workflow do head do PR. Um PR pode reescrever os arquivos de workflow e desmontar o padrão de separação entre base e candidato. O padrão protege validadores e política, não a orquestração contra si mesma. A defesa é de processo: proteção da branch, revisão obrigatória sobre `.github/`, `tooling/` e `quality/**`, e tratamento de qualquer diff nesses caminhos como mudança de segurança.

**Proteção da `main` é pré-condição humana, não entrega de código.** Nenhum arquivo deste repositório configura proteção de branch. Antes do merge do PR de implementação desta especificação, é necessário verificar e anexar evidência de que a `main` exige os checks obrigatórios pelo nome exato e pela origem esperada, bloqueia force push, bloqueia exclusão e proíbe merge automático. Enquanto essa evidência não existir, o PR de implementação não deve ser mesclado.

**Modo individual e revisão por segundo code owner.** Com um único mantenedor, `CODEOWNERS` e aprovação obrigatória existem mas não protegem: o autor não aprova o próprio PR de forma significativa. Enquanto durar esse modo, são aceitos somente PRs do proprietário ou de colaboradores explicitamente confiáveis, com inspeção manual dos arquivos de governança em todo PR. Antes de aceitar contribuições externas, é exigido um segundo code owner humano ou a migração para organização ou plano que permita fluxos de trabalho obrigatórios protegidos.

**Limites de materialização do diff.** PR muito grande pode exceder os limites declarados e ser reprovado por não poder ser revisado integralmente. Isso é intencional, mas cria atrito: a mitigação é dividir a mudança, não elevar o limite dentro do PR afetado.

**Orçamento de revisão observado em campo.** O PR #6, que propôs esta própria especificação, reprovou por `error_max_turns` com `num_turns: 11` contra limite 10, `permission_denials_count: 3` e sem `structured_output`, sobre um diff de 519 linhas em um arquivo. O bloqueio foi correto, mas o resultado não distinguia falha técnica de defeito encontrado. O risco residual permanece: orçamento é dimensionado para o limite declarado da política, e um material dentro do limite ainda pode exigir mais turnos que o previsto em casos atípicos. A mitigação é o teste no limite máximo, a classificação explícita do estado inconclusivo, e a proibição de tratar ausência de veredito como aprovação. Elevar o orçamento dentro do PR afetado não é caminho aceitável.

**Tensão entre orçamento e limite de diff.** Aumentar o limite de tamanho de diff aceito exige reavaliar o orçamento de turnos e o timeout, e o inverso também vale. Os dois parâmetros são acoplados e não podem ser alterados isoladamente sem novo teste no limite.

**Intervalo entre esta implementação e a fundação.** Com a política ativa e sem aplicação na base, qualquer PR que toque caminhos cobertos dispara os seis gates e falha. Mitigação declarada no item 14 do Escopo.

**PRs de atualização de dependências já abertos.** Os PRs do ecossistema `github-actions` existentes alteram arquivo de workflow e não se qualificam para a isenção. Permanecem abertos e não podem ser mesclados antes desta implementação e de nova execução dos checks. A condução posterior exige inspeção manual do diff, com verificação do SHA contra a release oficial.

**Divergência entre `templates/spec.md` e o validador.** O template instrui manter a spec como proposta e alterar o metadado antes do merge, mas o validador recusa qualquer valor diferente de `approved` já no PR. Divergência registrada em vez de resolvida em silêncio; o alinhamento ocorre na implementação.

**Assimetria de `spec-meta.issue`.** Convivem `github:#N`, padrão a partir desta spec, e `local:tasks/...` da especificação 004. Resíduo aceito, registrado na issue #4.

## Evidência de conclusão

- Saída de `node tooling/governance/validate-spec.mjs specs/3-governance-hardening.md` aprovando esta especificação.
- Saída do job `governance` aprovando este PR como tipo `spec`.
- Na implementação: log vermelho e verde de cada teste determinístico, demonstrando falha pelo motivo esperado antes da passagem.
- Demonstração de que o gate ignora scripts do candidato: `package.json` com `"lint": "echo ok"` e reprovação mantida.
- Saída da execução limpa com os seis gates aprovados, e das seis execuções de canário com falha isolada por gate.
- Registro de que cada execução usou workspace novo, timeout explícito e instalação isolada, e de que nenhuma mutação permaneceu entre execuções.
- Saída da simulação de ponta a ponta com base sem aplicação, política nova ativa e candidato mínimo.
- Demonstração do comparador de política: as seis classes de afrouxamento e as substituições de argumento, todas reprovadas.
- Demonstração do registro de autorizações: exceção válida aceita, e as cinco formas de exceção inválida reprovadas.
- Demonstração dos dois snapshots: alteração legítima de plano aprovada, duplicação real reprovada.
- Demonstração das rejeições de plano: formato inválido, travessia, symlink e exclusão.
- Demonstração do parser da lista de alterações, incluindo caminho com espaço, status `T` reprovado e entrada inválida reprovada.
- Demonstração das quatro rejeições de lockfile.
- Demonstração da isenção automatizada: PR npm restrito a manifesto e lockfile aceito sem `Issue` e `Spec`; o mesmo PR com arquivo adicional reprovado; PR de `github-actions` não isento.
- Demonstração da materialização do diff: paginação completa, divergência com `changed_files` reprovada, patch truncado reprovado e binário encaminhado ao fluxo manual.
- Demonstração da publicação do veredito: check publicado no SHA obtido por consulta, e as cinco condições de falha exercitadas.
- Saída da revisão executada no limite máximo de tamanho de diff permitido, com `structured_output` válido dentro do limite de turnos e do timeout.
- Demonstração dos três estados do relatório: revisão aprovada, achado crítico e revisão inconclusiva com causa nomeada.
- Registro de `permission_denials_count` igual a zero no canário de ponta a ponta, comprovando coerência entre prompt e ferramentas permitidas.
- Quando houver repetição automática: registro do limite de tentativas, da classificação de transitoriedade, e de que o esgotamento manteve o bloqueio.
- Referência à execução do PR #6 como linha de base do problema: `subtype: error_max_turns`, `num_turns: 11`, `permission_denials_count: 3`, ausência de `structured_output`, veredito fail-closed não executado.
- Saída do lint estático de workflows: permissões por job, ausência de segredo nos jobs de candidato, fixação de `uses:` por SHA, e ausência de checkout ou execução do head no workflow de revisão.
- Evidência humana da proteção da `main`, com nome exato e origem esperada do check, anexada antes do merge.
- Saída de `npm run quality:governance` sem nenhuma referência fixa a `004`.
- Relatório do revisor independente sem achado bloqueador.
- Relatório do revisor de segurança aprovando o modelo de ameaça do CI.
- `claude-critical-review` com contagem de achados críticos igual a zero.
