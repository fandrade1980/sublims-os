# Roadmap orientado a risco e valor

## Etapa 0 — decisões de domínio

- Validar linguagem de `CONTEXT.md`.
- Escolher Fator de Correção ou Fator de Aproveitamento como entrada canônica.
- Separar custo, preço, lucro, margem, markup, CMV e percentual de custo total.
- Definir unidades, conversões e arredondamentos.
- Classificar custos do evento e encargos sobre venda.

Saída: exemplos reais aprovados pela direção, cozinha e financeiro.

## Etapa 1 — fundação reproduzível

- Criar o novo repositório privado.
- Configurar aplicação, banco, migrations, testes e CI.
- Criar Organização, Usuário, associação e papéis.
- Provar isolamento entre Organizações.
- Remover dependência de credenciais do protótipo.
- Preparar Compose com projeto exclusivo sem alterar a VPS.

Saída: tarefa `000-foundation.md` concluída.

## Etapa 2 — motor de precificação

- Implementar cálculo puro e decimal exato.
- Validar custo base, encargos, margem e lucro-alvo.
- Separar CMV e custo total.
- Produzir memória de cálculo versionada.

Saída: tarefa `001-pricing-engine.md` concluída.

## Etapa 3 — catálogo e Fichas Técnicas

- Ingredientes e histórico de custos.
- Unidades e conversões.
- Fichas Técnicas versionadas, perda e rendimento.
- Custo por porção.
- Bloqueio ou arquivamento de itens em uso.

Saída: custo gastronômico reproduzível.

Tarefa de referência: `tasks/002-catalog-recipes.md`.

## Etapa 4 — primeira fatia comercial completa

- Cliente e contatos.
- Evento e briefing.
- Cardápio com versões de Fichas Técnicas.
- Custos adicionais e Cenário de Precificação.
- Proposta versionada, emitida e imprimível.

Saída: um evento real da Sublims calculado e proposto pelo sistema.

## Etapa 5 — operação do evento

- Referências de consumo por convidado.
- Lista de compras.
- Checklists.
- Cronograma e produção.
- Setores e sequência de serviço.
- Equipe e logística.

## Gate de infraestrutura antes do primeiro deploy

- Executar `tasks/003-infrastructure-baseline.md`.
- Medir capacidade do host compartilhado.
- Aprovar estratégia de banco, backup, staging e deploy.
- Validar Cloudflare Tunnel → Nginx → container.
- Testar restauração e rollback antes de dados reais.

## Etapa 6 — automação, BI e IA

- Outbox e workflows n8n.
- Indicadores executivos.
- Assistência de cardápio e produção com aprovação humana.
- Auditoria de prompts, dados enviados, custo e qualidade.

## Etapa 7 — comercialização como SaaS

- Onboarding externo.
- Planos, trial e assinatura.
- Checkout e webhooks idempotentes.
- Suporte, métricas de adoção e termos de uso.

Cobrança só entra depois que o fluxo interno demonstrar valor e estabilidade.
