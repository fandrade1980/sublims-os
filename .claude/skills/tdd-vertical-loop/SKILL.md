---
name: tdd-vertical-loop
description: Executa mudanças do Sublims OS em ciclos TDD verticais, testando comportamento por interfaces públicas. Use durante toda implementação de funcionalidade ou correção.
---

# TDD vertical

Antes do primeiro teste, confirme que a spec aprovada já registra a interface pública observada. Se faltar, interrompa a implementação e proponha uma revisão da spec em PR separado. Exemplos: função exportada do domínio, endpoint HTTP ou CLI. Não teste método privado nem consulte o banco como atalho para verificar comportamento exposto por outra interface.

Para cada fatia:

1. escreva um teste de comportamento com valor esperado vindo da spec, exemplo trabalhado ou fonte independente;
2. execute somente o conjunto relevante e confirme que falha pela razão esperada;
3. registre comando, teste e motivo do vermelho no PR;
4. escreva a menor implementação capaz de passar;
5. execute novamente e registre o verde;
6. avance para o próximo comportamento aprendido no ciclo anterior.

Não escreva todos os testes antes de toda a implementação. Não antecipe abstrações. Refatoração ocorre depois dos ciclos, com todos os testes verdes e revisão separada.

Para cálculos do Sublims OS, os valores esperados precisam ser literais trabalhados e independentes da fórmula do código. Inclua precisão decimal, arredondamento, unidades e casos inválidos.
