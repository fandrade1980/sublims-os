---
name: orchestrate-graph
description: Seleciona contexto pelo grafo e coordena agentes por um DAG de execução com análises paralelas e escrita serial. Use em tarefas que envolvem vários módulos, riscos ou especialistas.
---

# Orquestração por grafos

O grafo `context/graph.json` responde quais arquivos ler. O plano em `orchestration/plans/<id>.json` responde em qual ordem os agentes trabalham. Não confunda os dois.

1. Valide e selecione o contexto a partir do nó da tarefa.
2. Crie ou atualize o plano de execução com `id`, `agent`, `mode`, `dependsOn`, `reads` e `writes`.
3. Paralelize somente passos `read` independentes. Um passo paralelo não pode escrever nem executar comandos que alterem o repositório.
4. Serialize passos `write`. Cada caminho tem um único proprietário na tarefa.
5. Subagentes devolvem artefatos ao orquestrador e não delegam novamente.
6. Revisores podem rodar em paralelo depois dos gates determinísticos.
7. Correções voltam ao escritor original; depois, repita os gates afetados.

Valide com `node tooling/orchestration/validate-execution-plan.mjs <plano>`. O grafo ajuda a reduzir contexto, mas não é um sandbox: ferramentas e permissões continuam definindo o acesso real.
