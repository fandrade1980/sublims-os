# Tarefa 002 — ingredientes e Fichas Técnicas versionadas

## Usuário e problema

Cozinha, compras e comercial precisam chegar ao mesmo custo gastronômico mesmo quando ingredientes são comprados e usados em unidades diferentes ou possuem perda de preparo.

## Objetivo

Implementar Ingredientes, histórico de custos, conversões e Fichas Técnicas versionadas, produzindo custo por porção reproduzível.

## Escopo

- Ingrediente com unidade base.
- Registro de custo com valor, unidade, vigência, origem e Organização.
- Conversões explícitas entre unidades compatíveis.
- Ficha Técnica, versão, rendimento e itens.
- Quantidade líquida, Fator de Correção e quantidade bruta.
- Custo total e Custo por Porção.
- Estados rascunho, publicado e substituído.
- Bloqueio de publicação quando custo ou conversão estiver ausente.
- Testes de interface do módulo e integração PostgreSQL.

## Fora de escopo

- Subpreparos aninhados.
- Estoque e lotes.
- Sugestão de consumo por pessoa.
- Lista de compras.
- Foto pública ou exportação em PDF.

## Critérios de aceite

1. Para 2 kg líquidos e Fator de Correção 1,25, a quantidade bruta é 2,5 kg.
2. Se for informado Fator de Aproveitamento 0,8 em uma importação, a conversão explícita gera Fator de Correção 1,25 e preserva a origem.
3. Quantidades em gramas e custo em quilogramas reconciliam sem conversão implícita ambígua.
4. Fator de Correção menor que 1, rendimento não positivo e custo negativo são rejeitados.
5. O Custo por Porção é custo, não preço de venda.
6. Atualizar o custo atual de um Ingrediente não altera uma Versão da Ficha Técnica já publicada.
7. Um Ingrediente usado não pode ser apagado fisicamente; pode ser arquivado conforme a política aprovada.
8. Usuário de outra Organização não acessa ingredientes, custos ou fichas.
9. Valores monetários e quantidades usam representação decimal exata.

## Aprovações obrigatórias

- Convenção canônica de perda.
- Tabela de unidades e conversões permitidas.
- Política de vigência e escolha do custo aplicável.
- Política de arredondamento e apresentação.

## Evidência de conclusão

- Cenário numérico reproduzível aprovado pelo `domain-pricing`.
- Testes automatizados dos critérios acima.
- Migration versionada e teste de isolamento por Organização.
- Pareceres de `reviewer` e `security-data-reviewer` sem bloqueadores.
