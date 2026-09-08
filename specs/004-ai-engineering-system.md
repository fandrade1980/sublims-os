# Especificação 004 — sistema de engenharia assistida por IA

<!-- spec-meta
{"id":"004","issue":"local:tasks/004-ai-engineering-system.md","status":"approved"}
-->

## Status

Aprovada para implementação local por solicitação do responsável pelo produto. Ativações externas continuam pendentes.

## Problema

O Sublims OS precisa transformar issues em mudanças revisáveis sem permitir que agentes pulem definição, testes, revisão ou controles operacionais. A base atual descreve papéis, mas ainda não oferece contratos executáveis para especificação, contexto, TDD, PRs, quality gates e rotinas diárias.

## Resultado esperado

Uma issue aprovada percorre um fluxo verificável:

```text
Issue → Especificação → Plano → TDD → Quality Gate → PR → Revisão Claude → Aprovação humana
```

O sistema também deve preparar rotinas operacionais diárias sem conceder acesso irrestrito à produção nem ativar ações externas antes de credenciais, endpoints e responsáveis serem aprovados.

## Escopo

- Modelo de issue e PR para GitHub.
- Skill do Claude para implementar uma issue somente após existir uma especificação válida.
- Skill do Claude para ciclos TDD verticais: um teste falhando, implementação mínima e repetição.
- Grafo versionado de contexto com seleção dos arquivos necessários por tarefa.
- Validação automática do grafo e da especificação.
- Orquestração paralela de agentes de análise com dependências explícitas e um único escritor por conjunto de arquivos.
- Workflow de CI para governança e quality gates.
- Revisão automática de PR pelo Claude com saída estruturada e falha do check quando houver achado crítico.
- Contrato para cobertura, complexidade ciclomática, arquitetura de dependências e teste de carga.
- Projeto seguro das rotinas de saúde, backup, assinaturas, suporte e relatório diário.
- Runbook de ativação de GitHub, proteção de branch e rotinas operacionais.

## Fora de escopo

- Criar ou administrar a organização GitHub do usuário.
- Instalar o Claude GitHub App, cadastrar chaves ou alterar proteção da branch remotamente.
- Conectar à VPS, banco, n8n, provedor de pagamentos, e-mail ou canal de atendimento.
- Executar backup real ou teste de restauração na infraestrutura atual.
- Responder automaticamente a usuários reais.
- Implementar funcionalidades de produto antes da fundação da aplicação.

## Regras

1. Nenhum código de produto começa sem uma especificação em `specs/` vinculada à issue.
2. O primeiro teste de cada fatia precisa falhar pela razão esperada antes da implementação.
3. Testes observam interfaces públicas. Para as ferramentas deste pacote, a interface pública é a CLI: argumentos, saída padrão, JSON e código de saída.
4. Agentes podem analisar em paralelo, mas somente um agente escreve cada conjunto de arquivos.
5. Nós do grafo apontam para arquivos versionados; referências ausentes e ciclos de dependência bloqueiam o fluxo.
6. O gate determinístico roda antes da revisão por IA. A IA não substitui lint, tipos, testes ou build.
7. O check de revisão por IA falha quando a saída estruturada contém pelo menos um achado `critical`.
8. Falha, ausência ou saída inválida da revisão por IA também bloqueia o merge; o fluxo é fail-closed.
9. Merge continua dependendo de aprovação humana e proteção da branch no GitHub.
10. Rotinas operacionais começam em modo de observação. Respostas a usuários são rascunhos até haver política e aprovação específicas.
11. Backup diário só é considerado bem-sucedido após envio cifrado para destino externo e verificação; restauração deve ser testada em rotina separada.
12. Nenhum agente recebe SSH, sudo, socket Docker ou credenciais amplas por padrão.

## Quality gates

| Gate | Regra inicial | Evidência |
|---|---|---|
| Especificação | arquivo vinculado, seções obrigatórias e status aprovado | validador de spec |
| Contexto | grafo válido, sem referências ausentes ou ciclos `requires` | validador do grafo |
| Tipos e lint | zero erro | comandos do projeto |
| Testes | zero falha | relatório do runner |
| Cobertura | linhas ≥ 80%, branches ≥ 75%, funções ≥ 80%, statements ≥ 80% | `coverage-summary.json` |
| Complexidade | máximo 10 por função; exceção documentada e revisada | ESLint/relatório equivalente |
| Dependências | módulos de domínio não importam UI, banco, rede ou automação | regras arquiteturais |
| Build | build reproduzível | comando do projeto |
| Carga | cenário smoke sem erro e limites definidos por endpoint | relatório k6 |
| Segurança e segredos | zero segredo detectado e análise de dependências sem crítico conhecido | ferramentas do CI |
| Revisão Claude | zero achado crítico e saída estruturada válida | check `claude-critical-review` |

Os limites de carga definitivos dependem dos endpoints e SLOs da aplicação. Até essa definição, o teste de carga existe como contrato e não inventa metas de produção.

## Superfícies de teste

- CLI de validação da spec: arquivo de entrada, mensagem e código de saída.
- CLI do grafo de contexto: grafo/raiz de entrada, lista JSON/texto e código de saída.
- CLI do DAG: plano de entrada, diagnóstico de dependências/escritores e código de saída.
- CLI do veredito Claude: JSON estruturado, diagnóstico e código bloqueador.
- CLI do gate de cobertura: relatório/política, diagnóstico e código de saída.
- CLI do executor confiável: política da branch base, diretório candidato e resultado dos comandos fixados.
- Workflow do GitHub: checks observáveis `governance`, `quality-gate` e `claude-critical-review`.

## Rotinas diárias

### Saúde da aplicação

- Consultar endpoint autenticado de saúde e dependências.
- Registrar latência, versão, banco e filas sem expor segredos.
- Abrir incidente; não tentar reparo destrutivo automaticamente.

### Backup

- Executar ferramenta nativa do PostgreSQL com usuário de backup de menor privilégio.
- Cifrar, enviar a destino externo, registrar checksum e retenção.
- Alertar em qualquer etapa incompleta.

### Assinaturas

- Comparar estado local com o provedor por interface autenticada e idempotente.
- Produzir divergências; não cancelar, cobrar ou reativar automaticamente no primeiro estágio.

### Suporte

- Classificar mensagens, remover dados sensíveis do contexto e gerar rascunho.
- Envio automático fica desativado até política de atendimento, níveis de confiança e escalonamento serem aprovados.

### Relatório final

- Consolidar saúde, backup, assinaturas, suporte, incidentes e ações pendentes.
- Não declarar sucesso de uma fonte ausente; usar `não verificado`.

## Critérios de aceite

1. Uma issue criada pelo modelo contém problema, escopo, critérios e riscos.
2. O fluxo recusa implementação sem `specs/<id>-*.md` válido.
3. O seletor de contexto parte de uma tarefa e retorna somente seus ancestrais necessários no grafo.
4. Grafo com arquivo inexistente, nó duplicado ou ciclo falha com diagnóstico útil.
5. As instruções do Claude impõem ciclos TDD verticais e registram evidência vermelho/verde.
6. Análises independentes podem ser delegadas em paralelo, respeitando dependências e propriedade de escrita.
7. PR sem link para issue/spec falha no gate de governança.
8. O CI executa gates determinísticos antes da revisão Claude.
9. A revisão Claude produz JSON validado e retorna falha quando `critical_count > 0`.
10. Existe documentação para tornar os checks obrigatórios na branch principal.
11. As cinco rotinas operacionais têm contrato, permissões mínimas, falhas e modo de ativação documentados.
12. Nenhuma automação externa ou conexão à VPS é ativada por este pacote.

## Riscos e decisões pendentes

- Plano e forma de autenticação do Claude no GitHub.
- Custo máximo aceitável por revisão e por rotina.
- Repositório, branch principal e nomes finais dos checks obrigatórios.
- Ferramentas definitivas de cobertura, complexidade e dependências após o bootstrap do código.
- Endpoint e SLOs para teste de carga.
- Destino externo, retenção, RPO e RTO de backup.
- Provedor de assinaturas e fonte de verdade.
- Canal de suporte, política de privacidade e autoridade para envio de respostas.
- Canal e destinatários do relatório diário.

## Evidência de conclusão

- Testes automatizados dos validadores criados em ciclos TDD.
- Execução local dos validadores com casos válidos e inválidos.
- Workflows validados sintaticamente.
- Revisão independente dos arquivos de CI, segurança e operação.
- Lista explícita das etapas que ainda exigem configuração humana no GitHub e na infraestrutura.
