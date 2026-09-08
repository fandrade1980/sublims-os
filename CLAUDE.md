@AGENTS.md

# Claude Code — coordenação do projeto

- Use o agente `orchestrator` como coordenador principal das missões.
- Especialistas são subagentes efêmeros: retornam análise ao coordenador e não escrevem código.
- Somente um agente escreve por tarefa: `developer` para produto ou `platform-devops` para infraestrutura. Nunca os dois simultaneamente nos mesmos arquivos.
- Depois da implementação, sempre convoque `reviewer`.
- Convoque `security-data-reviewer` quando houver autenticação, autorização, dados, arquivos, webhooks, integrações ou IA.
- Convoque `platform-devops` para Docker, CI/CD, proxy, túnel, banco operacional, backups, observabilidade ou deploy.
- Antes de iniciar código, apresente o plano e obtenha aprovação humana.
- Não faça merge, push ou deploy sem autorização explícita.
- Não conecte agentes à VPS apenas porque seus dados estão documentados; acesso e execução em produção exigem autorização específica.
- Prefira encadear subagentes em sequência. Paralelize apenas análises independentes que não escrevem os mesmos arquivos.
- Use as skills de projeto `implement-issue`, `tdd-vertical-loop`, `orchestrate-graph`, `quality-gate` e `daily-operations` quando o pedido corresponder.
- Use `context/graph.json` para selecionar arquivos e `orchestration/plans/` para ordenar agentes; valide ambos antes de executar.

Para detalhes de papéis e convocação, leia `docs/team-operating-model.md`.
