# Tarefa 001 — núcleo determinístico de precificação

## Usuário e problema

Direção e comercial precisam calcular quanto cobrar por um Evento para cobrir os custos considerados e atingir uma Margem-alvo conhecida.

## Objetivo

Implementar o primeiro módulo profundo do produto: uma função determinística que recebe custos, Encargos sobre Venda e Margem-alvo e devolve preço, decomposição e validade do cenário.

## Escopo

- Tipos de entrada e saída do cálculo.
- Representação decimal exata.
- Soma de custos diretos por categoria.
- Soma de Encargos sobre Venda.
- Fórmula descrita em `docs/domain-rules.md`.
- Preço total e por convidado.
- Memória de cálculo estruturada.
- Alertas e erros de domínio.
- Versão identificável da fórmula.
- Testes unitários de tabela e invariantes.
- Interface mínima de demonstração, sem persistência definitiva.
- CMV gastronômico separado do percentual de custo total.

## Fora de escopo

- Banco de ingredientes e fichas completas.
- Proposta em PDF.
- IA sugerindo margem ou preço.
- Tributos com múltiplas bases de cálculo.
- Desconto, parcelamento e reajuste.

## Critérios de aceite

1. Para custo base de R$ 10.000,00, encargos de 8% e 5%, e Margem-alvo de 25%, o preço antes da política de arredondamento é R$ 16.129,032258... .
2. O resultado apresenta custo, cada encargo, valor da margem, preço total e preço por convidado.
3. Taxas negativas, quantidade de convidados não positiva ou denominador menor ou igual a zero são rejeitados.
4. A ordem dos custos de entrada não altera o resultado.
5. A soma da decomposição reconcilia com o preço dentro da precisão definida.
6. A mesma entrada sempre produz a mesma saída.
7. O módulo não acessa banco, rede, relógio, variáveis de ambiente, React, n8n ou IA.
8. Testes demonstram claramente a diferença entre Margem-alvo e markup.
9. Testes demonstram claramente a diferença entre CMV e percentual de custo total.

## Casos adicionais de teste

- custo zero;
- nenhum encargo;
- margem zero;
- taxas com várias casas decimais;
- quantidade grande de convidados;
- arredondamento apenas na apresentação;
- soma de encargos e margem próxima de 100%;
- categoria de custo desconhecida, conforme política definida no plano.

Conversão de unidades, rendimento e Fator de Correção pertencem à tarefa `002-catalog-recipes.md`; este módulo recebe custos já calculados e categorizados.

## Evidência de conclusão

- Resultado dos testes.
- Exemplo reproduzível do cenário de referência.
- Lista dos arquivos alterados.
- Parecer independente do reviewer sem bloqueadores.
