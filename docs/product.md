# Produto e escopo inicial

## Visão

O Sublims OS integra a jornada comercial e gastronômica de eventos, reduzindo planilhas desconectadas e decisões sem rastreabilidade. A primeira versão deve transformar ingredientes, fichas técnicas, cardápio e custos operacionais em um preço defensável para uma proposta.

## Usuários iniciais

- Direção: acompanha margem, risco e resultado esperado.
- Comercial: cria cliente, evento, cenário e proposta.
- Chef/cozinha: mantém ingredientes, fichas técnicas, perdas e rendimentos.
- Compras: registra custos de aquisição e unidades.
- Financeiro: valida encargos, custos e premissas comerciais.

## Resultado prioritário

Dado um evento com quantidade de convidados, cardápio, custos operacionais, encargos percentuais e margem-alvo, o sistema apresenta:

- custo gastronômico total e por convidado;
- demais custos diretos por categoria;
- preço mínimo calculado;
- preço por convidado;
- valor correspondente à margem-alvo;
- alertas sobre premissas ausentes ou inválidas;
- memória de cálculo reproduzível.

O fluxo prioritário do Sublims OS é `Cliente → Evento → Ingredientes → Fichas Técnicas → Cardápio → Cenário de Precificação → Proposta`. O material concorrente conflava Evento, orçamento interno e proposta; o Sublims OS deve mantê-los separados para permitir revisões comerciais sem alterar a operação ou a memória financeira.

## Escopo do MVP comercial-gastronômico

1. Cliente.
2. Evento.
3. Ingrediente, unidade base e histórico de custo.
4. Ficha Técnica versionada, perdas e rendimento.
5. Cardápio do evento.
6. Custos diretos não gastronômicos.
7. Cenário de Precificação.
8. Proposta versionada em estado de rascunho e emitida.

## Aprendizados incorporados da análise concorrente

- Sugestões de quantidade por convidado aceleram a montagem, mas não devem substituir a decisão do responsável.
- Bloquear exclusão de itens em uso é requisito de integridade, não apenas uma mensagem de interface.
- Fichas precisam distinguir quantidade líquida, quantidade bruta, unidade de compra e rendimento.
- Indicadores financeiros devem separar CMV gastronômico de percentual de custo total.
- Checklists, cronograma, setorização e sequência de serviço têm valor operacional, mas entram depois que a precificação estiver validada.
- Subpreparos exigem política explícita de unidade, ciclos e profundidade; não entram no primeiro núcleo.
- Uso em celular é essencial, mas a experiência precisa refletir papéis e tarefas reais, não apenas encolher telas administrativas.

## Fora do primeiro piloto

- Contratos e assinatura eletrônica.
- Contas a pagar e receber completas.
- Gestão de estoque e compras automáticas.
- Escala de equipe e logística detalhada.
- BI executivo.
- Geração autônoma de preços por IA.
- Produto multiempresa comercializado para terceiros.
- Trial, assinatura do SaaS e checkout recorrente.

O schema deve permitir evolução futura, mas o piloto não deve implementar esses módulos antecipadamente.

Embora o produto possa futuramente ser vendido a outros buffets, a primeira validação ocorre dentro da Sublims Gastronomia. Isso elimina a necessidade de construir cobrança recorrente antes de provar o fluxo comercial-gastronômico.

## Métricas do piloto

- Um usuário consegue reproduzir manualmente o resultado de um cenário de teste.
- Uma proposta emitida mantém os mesmos valores após atualização de custos.
- Todo valor exibido informa sua origem ou fórmula.
- Casos de custo ausente são bloqueados antes da emissão.
- Direção, comercial e cozinha concordam com a linguagem usada.
