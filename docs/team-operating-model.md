# Modelo operacional do time de IA

## Estrutura revisada

O material analisado mostrou que o maior risco não é produzir telas; é cristalizar fórmulas, unidades, tenancy, fluxos e operações de infraestrutura errados. O time possui quatorze perfis, mas somente os necessários são convocados em cada tarefa. Cinco perfis operacionais permanecem inativos até a ativação segura das rotinas diárias.

No Claude Code, os perfis vivem em `.claude/agents/`. O `orchestrator` deve rodar como agente da sessão principal, pois subagentes não podem criar outros subagentes. Ele faz todo o encadeamento usando a ferramenta `Agent`.

| Agente | Tipo | Responsabilidade principal | Pode escrever código? |
|---|---|---|---|
| `orchestrator` | Permanente | Planejar, convocar especialistas e consolidar evidências | Não deve implementar |
| `product` | Permanente | Definir problema, escopo e critérios de aceite | Não |
| `domain-pricing` | Permanente no núcleo | Validar gastronomia, unidades, perdas, custos, CMV e margem | Não |
| `architect` | Sob demanda | Definir módulos, interfaces, dados e migrations | Não |
| `ux-operations` | Sob demanda | Desenhar jornadas por papel e uso em campo | Não |
| `developer` | Permanente | Ser o único escritor do código da tarefa | Sim |
| `platform-devops` | Sob demanda | Planejar e escrever infraestrutura, CI/CD e runbooks | Sim, somente em tarefa de plataforma |
| `reviewer` | Permanente | Revisar correção, regressões e testes | Não |
| `security-data-reviewer` | Gate de dados | Revisar tenancy, RLS, segredos, arquivos e integrações | Não |
| `operations-monitor` | Operação | Interpretar evidências de saúde sem reparar serviços | Não |
| `backup-auditor` | Operação | Auditar manifesto de backup e verificabilidade | Não |
| `subscription-auditor` | Operação futura | Encontrar divergências de assinatura sem alterar cobrança | Não |
| `support-triage` | Operação futura | Classificar suporte e produzir somente rascunhos | Não |
| `daily-reporter` | Operação | Consolidar o relatório diário sanitizado | Não |

## Regra de convocação

- Fórmula, unidade, perda, rendimento ou indicador financeiro: incluir `domain-pricing`.
- Schema, migration, integração ou seam de módulo: incluir `architect`.
- Tela, wizard, celular ou fluxo entre áreas: incluir `ux-operations`.
- Autenticação, RLS, arquivo, webhook, IA ou dado pessoal: incluir `security-data-reviewer`.
- Docker, CI/CD, Nginx, túnel, banco operacional, backups ou deploy: incluir `platform-devops`.
- Código de produto: `developer` escreve. Infraestrutura: `platform-devops` escreve. Nunca os dois nos mesmos arquivos ao mesmo tempo.
- Toda alteração é revisada por `reviewer`; plataforma e dados também passam por `security-data-reviewer`.

Não convoque todos por padrão. O orquestrador escolhe o menor grupo que cobre os riscos reais.

## Fluxos recomendados

### Núcleo de precificação

```text
product + domain-pricing
          ↓
       architect
          ↓
      aprovação humana
          ↓
       developer
          ↓
reviewer + security-data-reviewer
```

### Jornada de interface

```text
product + ux-operations
          ↓
domain-pricing, se houver números
          ↓
       developer
          ↓
       reviewer
```

### Integração externa

```text
product + architect + security-data-reviewer
                     ↓
                  developer
                     ↓
      reviewer + security-data-reviewer
```

### Infraestrutura e deploy

```text
architect + platform-devops
             ↓
 security-data-reviewer
             ↓
       aprovação humana
             ↓
 platform-devops escreve arquivos
             ↓
 reviewer + security-data-reviewer
             ↓
 aprovação separada para produção
```

## Handoffs obrigatórios

Cada agente deve entregar um artefato verificável ao próximo:

- Produto: cenário do usuário e critérios de aceite.
- Domínio: exemplos numéricos, invariantes e decisões pendentes.
- Arquitetura: módulo proprietário, interface, dados e estratégia de teste.
- UX: fluxo, estados vazios, erros e experiência móvel.
- Desenvolvimento: código, testes, migrations e evidências.
- Plataforma: compose, pipeline, runbook, capacidade, backup e rollback.
- Revisão: achados por severidade e decisão de gate.
- Segurança: ameaças, testes negativos e aprovação ou bloqueio.

## Autoridade humana

Exigem aprovação de uma pessoa responsável:

- política de margem, impostos, comissão e rateio;
- mudança em unidade ou fórmula já usada;
- migration destrutiva;
- importação de dados reais;
- abertura de bucket ou endpoint público;
- envio de dados para IA;
- ativação de cobrança;
- merge na branch principal e deploy em produção.
- conexão de qualquer agente à VPS e alteração de serviços compartilhados.
