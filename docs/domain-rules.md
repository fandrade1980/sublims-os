# Regras iniciais de custo e precificação

Este documento é a hipótese de partida do piloto. Direção, comercial, cozinha e financeiro devem validar as classificações e fórmulas antes de uso em propostas reais.

## 1. Custo de ingrediente

Todo ingrediente possui uma unidade base. Custos de compra em outras unidades precisam de uma conversão explícita e testada.

O material analisado usa Fator de Correção como multiplicador. Essa será a hipótese do piloto até validação formal com a cozinha:

```text
fator_de_correcao = quantidade_bruta / quantidade_liquida
quantidade_comprada = quantidade_liquida × fator_de_correcao
custo_do_item = quantidade_comprada × custo_por_unidade_base
```

O Fator de Correção deve ser maior ou igual a um. Se a operação preferir registrar Fator de Aproveitamento, o sistema deverá convertê-lo explicitamente (`fator_de_correcao = 1 / fator_de_aproveitamento`) e armazenar qual convenção originou o valor. Uma ficha com conversão ausente, custo ausente ou fator inválido não pode ser publicada.

## 2. Custo da Ficha Técnica

```text
custo_da_ficha = soma(custo_dos_itens)
custo_por_unidade_produzida = custo_da_ficha / rendimento
```

O rendimento precisa declarar unidade e quantidade. Arredondamentos intermediários devem ser evitados; arredonde apenas valores apresentados ou cobrados, conforme política comercial documentada.

## 3. Custo gastronômico do Evento

O Cardápio referencia versões específicas de Fichas Técnicas.

```text
custo_da_preparacao_no_evento = quantidade_necessaria × custo_por_unidade_produzida
custo_gastronomico = soma(custos_das_preparacoes)
```

Antes da publicação, o Cenário cria um Retrato de Custos com as versões e valores efetivamente usados.

## 4. Custo base do Evento

```text
custo_base =
  custo_gastronomico
  + equipe
  + logística
  + locações
  + serviços_de_terceiros
  + outros_custos_diretos
  + rateios_explicitamente_aprovados
```

Custos não podem ser escondidos em uma categoria genérica sem descrição e origem.

CMV e percentual de custo total não são equivalentes:

```text
cmv_do_evento = custo_gastronomico / preco_de_venda
percentual_de_custo_total = custo_base / preco_de_venda
```

## 5. Preço com Margem-alvo

Encargos sobre venda são percentuais calculados sobre o preço, como impostos, comissões e taxas de pagamento.

```text
taxa_total_de_encargos = soma(encargos_sobre_venda)
denominador = 1 - taxa_total_de_encargos - margem_alvo
preco_de_venda = custo_base / denominador
```

O denominador deve ser maior que zero. Margem-alvo não é markup.

### Exemplo de referência

Premissas:

- custo base: R$ 10.000,00;
- impostos: 8%;
- comissão: 5%;
- margem-alvo: 25%.

```text
preço = 10.000 / (1 - 0,08 - 0,05 - 0,25)
preço = 10.000 / 0,62
preço = R$ 16.129,03
```

O exemplo valida a fórmula, mas não define as taxas reais da empresa.

## 6. Estados e publicação

- Rascunho: aceita informações incompletas, mostrando alertas.
- Calculado: possui memória de cálculo completa e reproduzível.
- Publicado: congela o Retrato de Custos e a fórmula utilizada.
- Substituído: permanece consultável, mas outra versão passa a ser a vigente.

Uma Proposta emitida deve referenciar um Cenário publicado. Alterações posteriores criam novas versões.

Atualizar um Ingrediente pode recalcular rascunhos, mas nunca altera retroativamente uma Versão da Ficha Técnica, um Cenário publicado ou uma Versão da Proposta.

## 7. Casos que exigem decisão humana

- Impostos variam por tipo de operação ou cliente.
- Comissão possui faixa, teto ou base diferente do preço total.
- Existe sinal, desconto, cortesia ou permuta.
- Quantidade mínima de compra gera sobra aproveitável em outros eventos.
- Um ingrediente usa unidade cuja conversão depende de densidade ou preparação.
- Custos indiretos precisam ser rateados entre eventos.
- A margem comercial desejada difere da margem de contribuição usada pela direção.
