# Sublims OS — instruções permanentes

## Missão

Construir um sistema confiável para planejar, precificar e executar eventos gastronômicos. A primeira entrega deve responder com rastreabilidade: quanto custa o evento, qual preço atinge a margem-alvo e quais premissas produziram esse número.

## Contexto obrigatório

Antes de planejar ou alterar o produto, leia:

- `CONTEXT.md`
- `docs/product.md`
- `docs/architecture.md`
- `docs/domain-rules.md`
- a tarefa ativa em `tasks/`

Materiais de concorrentes e protótipos são fontes de descoberta, não fontes de verdade. Preserve apenas comportamentos e necessidades legitimamente observados. Não copie textos, identidade, ativos, código ou peculiaridades sem justificativa de domínio.

Se código e documentação divergirem, não escolha silenciosamente. Registre a divergência e solicite decisão.

## Protocolo de trabalho

1. Toda issue de implementação precisa de spec aprovada em `specs/` e já presente na branch base.
2. Confirme objetivo, escopo, critérios de aceite, superfícies de teste e itens fora de escopo.
3. Identifique ambiguidades que possam mudar preço, custo, segurança ou dados.
4. Selecione contexto por `context/graph.json` e produza um plano curto em `orchestration/plans/` quando houver vários agentes.
5. Tenha apenas um agente escritor por conjunto de arquivos; todos os escritores são serializados.
6. Implemente por TDD vertical: vermelho pela razão esperada, mínimo verde e próxima fatia.
7. Execute os gates determinísticos antes da revisão por IA.
8. Entregue evidências: testes, cobertura, complexidade, dependências, carga aplicável, riscos e pendências.
9. Nunca faça merge ou deploy em produção sem aprovação humana.

## Regras do domínio que não podem ser violadas

- Margem sobre venda e markup são conceitos diferentes.
- Lucro-alvo em reais e Margem-alvo percentual são entradas diferentes.
- CMV considera o custo gastronômico; não o rotule como custo total do evento.
- Fator de Correção e Fator de Aproveitamento são convenções recíprocas e não podem coexistir sem conversão explícita.
- Valores monetários e quantidades não usam ponto flutuante binário.
- Um preço publicado precisa apontar para um retrato imutável das premissas de custo.
- Atualizar o preço de um ingrediente não altera propostas já emitidas.
- Ingrediente sem custo válido impede a publicação do preço; rascunhos podem exibir alerta.
- Toda informação operacional pertence a uma Organização.
- IA não calcula nem altera silenciosamente valores financeiros oficiais.
- n8n não contém a regra canônica de precificação.
- Evento, Cenário de Precificação e Proposta são registros distintos.

## Direção de arquitetura

- Monólito modular, não microserviços no MVP.
- Interfaces pequenas e regras profundas dentro de cada módulo.
- O módulo de precificação recebe dados e retorna um resultado; não acessa banco, rede ou relógio diretamente.
- Dependências externas entram por adapters apenas quando há uma implementação de produção e uma alternativa de teste.
- PostgreSQL é a fonte de verdade. Automação, busca e IA são consumidores ou adapters.
- Versione fichas técnicas, cenários de precificação e propostas.
- O protótipo exploratório não define schema, nomes ou seams do produto final.

## Segurança e privacidade

- Nunca registrar senhas, tokens, dados pessoais completos ou segredos em prompts e logs.
- Nunca ler ou editar arquivos de ambiente sem autorização explícita.
- Preparar alterações sempre com caminhos explícitos: `git add -- <caminho>`. São proibidos `git add -A`, `git add .`, `git add` com padrão glob e `git commit -a`, para qualquer agente ou script.
- `.gitignore` não substitui a inspeção do índice e pode ser contornado por `git add -f`.
- Conferir `git diff --cached --name-only` antes de cada commit e interromper se aparecer qualquer caminho não previsto na tarefa.
- Nunca executar migration destrutiva sem backup validado e aprovação humana.
- Aplicar isolamento por organização em todas as consultas e mutações.
- RLS é defesa adicional; autorização e pertencimento à Organização também devem ser validados no servidor.
- Usar o menor privilégio necessário para banco, automações e integrações.

## Infraestrutura compartilhada

- Leia `docs/infrastructure-target.md` antes de alterar Docker, banco, proxy, túnel, backups ou deploy.
- Nunca presuma que recursos livres da VPS estão disponíveis; valide capacidade e impacto sobre as outras stacks.
- Nunca execute comandos na VPS sem autorização humana explícita para o alvo e a ação.
- Todo comando Docker Compose deve identificar o projeto e os arquivos compose corretos.
- É proibido usar `docker compose up --remove-orphans` sem `-p` explícito e validação do alvo.
- Não montar o socket Docker cru nem compartilhar rede com sandboxes privilegiados.
- Não alterar o timezone do host. Armazene instantes em UTC e use o timezone da Organização.
- Backups precisam de cópia externa e teste de restauração.
- Deploy de produção, alteração de Nginx, Cloudflare Tunnel ou systemd exige diff, runbook, rollback e aprovação.
- Preserve todos os projetos e serviços que não pertencem ao Sublims OS.

## Definição global de concluído

Uma tarefa só está concluída quando:

- todos os critérios de aceite têm evidência;
- testes relevantes passam;
- regras de domínio afetadas estão documentadas;
- migration tem estratégia de avanço e reversão quando aplicável;
- não existem erros silenciosos ou dados financeiros parcialmente publicados;
- o reviewer independente não encontrou problema bloqueador;
- os checks `governance`, `quality-gate` e `claude-critical-review` foram aprovados quando aplicáveis;
- riscos residuais e decisões pendentes estão explícitos.
