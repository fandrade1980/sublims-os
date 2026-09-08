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
npm run test:governance
npm run validate:context
npm run context:select -- task:004 --format json
node tooling/orchestration/validate-execution-plan.mjs orchestration/plans/004.json
node tooling/governance/validate-spec.mjs specs/004-ai-engineering-system.md
```

## GitHub

O workflow usa três checks estáveis: `governance`, `quality-gate` e `claude-critical-review`. O primeiro usa regras da branch base; o segundo executa o candidato sem segredos; o terceiro entrega ao Claude apenas leitura do diff e do candidato.

O Code Review gerenciado do Claude, isoladamente, termina com conclusão neutra e não bloqueia merge. Este projeto usa a Claude Code Action com JSON estruturado e um validador determinístico que falha em achado crítico, saída vazia, schema inválido ou contagem divergente.

As Actions estão fixadas nos SHAs que as tags oficiais `v6`, `v6` e `v1` apontavam em 8 de setembro de 2026. Atualizações entram por PR do Dependabot e passam pelos mesmos gates.

## Quality gate progressivo

No pacote documental, rodam os testes de governança, grafo, DAG, cobertura simulada e veredito Claude. Os comandos de aplicação ficam em `quality/application-gates.json` da branch protegida, nunca no PR candidato. A Tarefa 000 define ferramentas e comandos diretos; um PR de plataforma ativa a política depois que essa fundação já estiver na base. A partir daí, remover ou renomear a aplicação não pula gates.

Cobertura, complexidade, dependências, build e carga ainda não são gates operacionais neste pacote documental. O teste de carga permanece desativado até haver endpoint, cenário, SLO e ambiente efêmero. Ele nunca aponta para produção por padrão.

## Ativação humana no GitHub

1. Criar o repositório privado e enviar o pacote inicial.
2. Instalar o Claude GitHub App ou configurar a Claude Code Action manualmente.
3. Cadastrar `ANTHROPIC_API_KEY` e um limite de gasto apropriado.
4. Fazer um PR de teste e verificar os três nomes de check.
5. Criar ruleset para a branch principal exigindo os três checks e pelo menos uma aprovação humana.
6. Exigir resolução de conversas, nova aprovação após commits e bloquear force-push/exclusão.
7. Não permitir bypass rotineiro; documentar conta de emergência e auditoria.

O workflow usa `pull_request`, não `pull_request_target`. PRs de forks sem o secret ficam bloqueados por desenho; o primeiro repositório é privado e não precisa aceitar contribuições externas.
