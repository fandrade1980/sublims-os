# Sublims OS — kit inicial para desenvolvimento com Claude Code

Este diretório é um ponto de partida para criar o repositório do Sublims OS e operar um time de agentes no Claude Code. Ele contém contexto, regras, quatorze perfis de agentes, skills do projeto, TDD, grafos, quality gates, revisão de PR e contratos operacionais. A estrutura foi revisada após a análise funcional do concorrente, de um protótipo exploratório e da infraestrutura disponível.

## Decisões iniciais

- Começar com um monólito modular em Next.js e TypeScript.
- Usar PostgreSQL como fonte de verdade.
- Manter o cálculo de custos e preços dentro de um módulo puro e testável.
- Tratar n8n como adaptador de automações, nunca como local da regra financeira central.
- Tratar IA como apoio e recomendação; números finais devem vir de regras determinísticas.
- Preparar isolamento por organização desde o primeiro schema, mesmo com apenas a Sublims Gastronomia no início.
- Não implantar a pilha completa do Supabase no primeiro piloto. Reavaliar quando autenticação, storage ou realtime justificarem o custo operacional.
- Usar o protótipo `buffet-mvp` como evidência de descoberta, não como base automática de produção.
- Priorizar a operação interna da Sublims Gastronomia; assinatura do SaaS e checkout ficam fora do primeiro ciclo.

## Estrutura

```text
CLAUDE.md                    entrada de instruções do Claude Code
AGENTS.md                    regras canônicas importadas por CLAUDE.md
CONTEXT.md                   linguagem oficial do domínio
.claude/agents/              subagentes reconhecidos pelo Claude Code
.claude/skills/              fluxos repetíveis de issue, TDD, grafos, gates e operação
.github/                     modelos e gates de pull request
context/graph.json           grafo dos arquivos necessários por tarefa
orchestration/plans/         DAG de execução dos agentes
quality/policy.json          limites e contratos dos quality gates
specs/                       especificações aprovadas antes do código
tooling/                     validadores testados da governança
ops/daily/                   manifesto desativado das rotinas diárias
docs/product.md              visão e escopo do MVP
docs/architecture.md         módulos e direção técnica
docs/domain-rules.md         regras iniciais de custo e preço
docs/competitor-analysis.md  síntese crítica do material analisado
docs/team-operating-model.md time revisado e regras de convocação
docs/roadmap.md              sequência recomendada de entregas
docs/infrastructure-target.md arquitetura sanitizada da VPS e operação
tasks/000-foundation.md      criação do repositório e esqueleto
tasks/001-pricing-engine.md  primeira entrega de valor
tasks/002-catalog-recipes.md ingredientes e Fichas Técnicas
tasks/003-infrastructure-baseline.md capacidade e plano de deploy
tasks/004-ai-engineering-system.md   engenharia assistida por IA
templates/task.md            modelo para novas tarefas
templates/spec.md            modelo obrigatório de especificação
```

## Como colocar em uso

1. Crie um repositório privado chamado `sublims-os`.
2. Copie todo o conteúdo deste diretório para a raiz do repositório.
3. Abra um terminal na raiz do repositório e inicie `claude`. O arquivo `.claude/settings.json` já define `orchestrator` como agente padrão. Como alternativa explícita, use `claude --agent orchestrator`.
4. Revise `CONTEXT.md` e as decisões pendentes com direção, comercial, cozinha e financeiro.
5. Confirme em `/agents` que os quatorze agentes do projeto foram carregados e entregue a missão abaixo.
6. Aprove o plano antes que o agente `developer` altere código.

Antes do primeiro push, rode `npm ci` e `npm run quality:governance`. O pacote não precisa baixar bibliotecas de governança; os validadores usam apenas o Node.js.

## Fluxo de uma nova issue

1. Crie a issue com o modelo do GitHub.
2. Peça ao Claude para usar `implement-issue`; se não houver spec, ele deve produzir somente o PR da spec.
3. Depois da aprovação humana e merge da spec, peça a implementação da mesma issue.
4. O Claude seleciona contexto, coordena análises, executa TDD e preenche o PR.
5. O GitHub exige governança, quality gate, revisão crítica do Claude e aprovação humana.

Detalhes: `docs/ai-engineering-system.md`. As rotinas diárias estão descritas em `docs/daily-operations.md` e permanecem desativadas até a infraestrutura do produto existir.

## Primeira instrução ao orquestrador no Claude Code

```text
Conduza a tarefa tasks/000-foundation.md. Primeiro peça ao product, ao architect,
ao platform-devops e ao security-data-reviewer que validem o escopo, os seams dos
módulos, a compatibilidade com a VPS e o isolamento dos dados. Consulte o
domain-pricing antes de fixar unidades ou fórmulas.
Consolide as decisões e apresente o plano para aprovação humana. Somente depois
da aprovação delegue a implementação ao developer. Ao final, peça ao reviewer
uma revisão independente e não faça merge automaticamente.
```

## Resultado esperado do primeiro ciclo

Ao terminar as tarefas 000 e 001, o sistema deverá calcular um preço de evento a partir de custos diretos, encargos percentuais e margem-alvo, com testes reproduzíveis e sem depender de IA para produzir o valor.

## Pontos que ainda exigem decisão humana

- Política real de impostos e comissões da Sublims Gastronomia.
- Quais custos entram como diretos, indiretos ou rateados.
- Escolha entre Fator de Correção e Fator de Aproveitamento como entrada canônica.
- Unidades e conversões usadas nas compras e nas fichas técnicas.
- Política de arredondamento comercial.
- Provedor de autenticação do primeiro ambiente.
- ORM e biblioteca de validação a serem adotados no bootstrap.
- Tratamento de sobras, embalagens fechadas e reaproveitamento entre eventos.
- Reutilização do PostgreSQL Sublims existente ou criação de container dedicado.
- Armazenamento privado de arquivos, objetivos de recuperação e ambiente de staging.
- Mecanismo de deploy aprovado para a VPS compartilhada.
