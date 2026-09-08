# Síntese crítica da análise concorrente e do protótipo

## Materiais avaliados

- Mapeamento funcional da plataforma concorrente feito por uso legítimo como assinante.
- PRD derivado desse levantamento.
- Protótipo `buffet-mvp` em Next.js, Supabase, Mercado Pago e Anthropic.

O material é útil como pesquisa de necessidades e fluxos. Não autoriza copiar marca, textos, ativos, código, estrutura privada ou experiência visual distintiva do concorrente.

## Capacidades observadas

| Área | Capacidades identificadas | Decisão para o Sublims OS |
|---|---|---|
| Catálogo | Ingredientes, bebidas e serviços | Entra no núcleo, com distinção entre custo e preço |
| Fichas Técnicas | Quantidade líquida/bruta, perda, rendimento e custo | Entra no núcleo com versões e unidades rigorosas |
| Referência de consumo | Quantidade por pessoa e categoria | Entra após o cálculo básico, como sugestão editável |
| Evento | Dados, convidados, receitas, bebidas, serviços e despesas | Entra no fluxo prioritário |
| Precificação | Soma de custos, lucro em reais, CMV e margem | Reprojetar: separar lucro, margem, CMV e custo total |
| Proposta | Impressão do resumo | Reprojetar como entidade versionada ligada ao Cliente |
| Controle | Status comercial, contrato e pagamentos | Fase posterior ao primeiro fluxo de proposta |
| Operação | Lista de compras, checklists, cronograma, setores e serviço | Fase posterior, mas prevista no mapa de módulos |
| IA | Sugestões de cardápio, cronograma e resposta ao cliente | Fase posterior, com privacidade e limites claros |
| Cobrança do SaaS | Trial e assinatura recorrente | Fora da validação interna inicial |

## Lacunas do material em relação ao Sublims OS

1. Cliente não aparece como entidade central no protótipo.
2. Evento, orçamento interno e proposta são tratados quase como o mesmo registro.
3. “Preço” em ingredientes, bebidas e serviços não distingue custo de aquisição, preço de venda ou valor contratado.
4. “Preço por porção” da Ficha Técnica é, na prática, custo por porção.
5. O CMV mostrado usa todos os custos do evento, não apenas o custo gastronômico.
6. “Lucro desejado” é um valor em reais; não resolve diretamente o objetivo de alcançar uma margem percentual.
7. Custos atuais recalculam eventos antigos, impedindo reprodução histórica.
8. Não há tratamento claro para impostos, comissões, taxas de pagamento, descontos, sobras e embalagens fechadas.
9. A tenancy é por usuário proprietário, embora o Sublims OS precise suportar equipes e papéis.
10. O schema informado não está acompanhado das migrations no diretório analisado.

## Avaliação do protótipo

### O que aproveitar

- Vocabulário inicial das telas.
- Evidência de que cadastro, ficha e evento formam um fluxo compreensível.
- Uso de sugestões por pessoa como acelerador.
- Alertas de exclusão de registros em uso.
- Necessidade de experiência responsiva.
- Ideias para impressão, checklists e plano operacional.

### O que não promover diretamente

- Fórmulas em páginas React.
- Uso de `number` para dinheiro e quantidades críticas.
- Consultas do banco espalhadas por componentes de interface.
- Atualização retroativa de custos em eventos.
- `owner_id` como tenancy definitiva.
- Bucket público de imagens sem análise de privacidade.
- Uso privilegiado de banco sem testes de autorização e idempotência.
- Cobrança recorrente antes de validar o valor operacional.

## Riscos a tratar antes de reutilizar o protótipo

- Existe um `.env.local`; ele foi deliberadamente não lido. Não deve ser copiado para o novo repositório. Se chaves reais foram compartilhadas fora do ambiente original, devem ser rotacionadas.
- Não foi possível executar lint ou build porque as dependências não estão instaladas. O projeto também não define comando de testes.
- As políticas RLS e as 21 tabelas citadas não puderam ser verificadas porque suas migrations não estão presentes.
- Webhooks e adapters externos precisam de verificação de autenticidade, idempotência, reconciliação e menor privilégio antes de uso real.

## Conclusão

O protótipo deve ser classificado como `discovery prototype`: suficiente para informar o produto, insuficiente como fundação confiável. O novo repositório deve reconstruir primeiro o núcleo Cliente → Evento → Ficha Técnica → Cardápio → Precificação → Proposta, com versionamento, precisão e isolamento por Organização.

