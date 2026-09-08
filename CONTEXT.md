# Sublims OS

Linguagem oficial para descrever a operação comercial e gastronômica de eventos. Os termos abaixo evitam que produto, operação e código usem nomes diferentes para o mesmo conceito.

## Organização e relacionamento

**Organização**:
Empresa cujos dados e operação são administrados no Sublims OS.
_Evitar_: Tenant, conta da empresa

**Usuário**:
Pessoa autorizada a acessar uma Organização com um ou mais papéis.
_Evitar_: Colaborador, login

**Cliente**:
Pessoa ou empresa que contrata ou avalia contratar um Evento.
_Evitar_: Conta, lead quando já houver identificação do cliente

**Evento**:
Compromisso comercial e operacional para fornecer gastronomia e serviços em data, local e condições definidos.
_Evitar_: Pedido, festa, projeto

## Gastronomia

**Ingrediente**:
Item alimentar ou insumo consumível usado em uma Ficha Técnica.
_Evitar_: Produto, matéria-prima

**Custo de Ingrediente**:
Valor de aquisição de um Ingrediente em uma unidade e período de validade definidos.
_Evitar_: Preço do ingrediente

**Ficha Técnica**:
Definição padronizada de uma preparação, com ingredientes, quantidades, perdas e rendimento.
_Evitar_: Receita

**Versão da Ficha Técnica**:
Estado imutável de uma Ficha Técnica usado para reprodução e cálculo em determinado momento.
_Evitar_: Cópia da receita

**Rendimento**:
Quantidade útil produzida por uma Versão da Ficha Técnica.
_Evitar_: Quantidade bruta

**Fator de Correção**:
Relação entre quantidade bruta comprada e quantidade líquida utilizável de um Ingrediente; normalmente é maior ou igual a um.
_Evitar_: Fator de Aproveitamento sem conversão explícita, Margem de perda

**Cardápio**:
Composição gastronômica oferecida para um Evento, formada por versões específicas de Fichas Técnicas e respectivas quantidades.
_Evitar_: Menu quando se referir à composição registrada

**Referência de Consumo**:
Quantidade sugerida por convidado para uma categoria gastronômica, usada como apoio ao planejamento e nunca como quantidade final automática.
_Evitar_: Modelo de Evento quando se referir apenas à quantidade por pessoa

**Custo por Porção**:
Custo da Versão da Ficha Técnica dividido por seu Rendimento.
_Evitar_: Preço por Porção quando não houver margem de venda

## Precificação e proposta

**Cenário de Precificação**:
Conjunto versionado de premissas usado para calcular custo, preço e margem de um Evento.
_Evitar_: Simulação quando o resultado for usado oficialmente

**Custo Direto**:
Gasto atribuível ao Evento, incluindo gastronomia, equipe, logística, locações e outros itens explicitamente associados.
_Evitar_: Despesa geral

**Encargo sobre Venda**:
Percentual do preço de venda destinado a imposto, comissão, taxa de pagamento ou outro ônus proporcional à receita.
_Evitar_: Custo fixo

**Margem-alvo**:
Percentual do preço de venda que deve permanecer após os custos e encargos considerados no Cenário de Precificação.
_Evitar_: Markup, lucro líquido

**Markup**:
Relação entre acréscimo e custo usada apenas quando explicitamente solicitada; não representa a Margem-alvo.
_Evitar_: Margem

**Lucro-alvo**:
Valor monetário que se deseja obter no Cenário de Precificação, quando a meta for definida em reais e não como percentual da venda.
_Evitar_: Margem-alvo

**CMV do Evento**:
Relação entre o custo gastronômico consumido e o Preço de Venda do Evento.
_Evitar_: Percentual de todos os custos

**Percentual de Custo Total**:
Relação entre todos os custos considerados e o Preço de Venda do Evento.
_Evitar_: CMV

**Preço de Venda**:
Valor calculado para cobrir custos, encargos sobre venda e Margem-alvo de um Cenário de Precificação.
_Evitar_: Custo final

**Retrato de Custos**:
Registro imutável dos custos e premissas usados por um Cenário de Precificação.
_Evitar_: Preço atual, snapshot

**Proposta**:
Documento comercial apresentado ao Cliente com escopo, condições e preço de um Evento.
_Evitar_: Orçamento quando já houver uma oferta formal

**Orçamento**:
Termo ambíguo que só deve ser usado com qualificador: Cenário de Precificação para o cálculo interno ou Proposta para a oferta ao Cliente.
_Evitar_: Usar Orçamento como sinônimo simultâneo de Evento e Proposta

**Versão da Proposta**:
Estado imutável de uma Proposta em uma emissão específica.
_Evitar_: Proposta atual
