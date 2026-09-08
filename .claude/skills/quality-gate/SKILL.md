---
name: quality-gate
description: Verifica os gates determinísticos e a revisão estruturada de IA antes de um PR do Sublims OS ser considerado pronto. Use após implementação ou correção.
---

# Quality gate

Leia `quality/policy.json`. Execute primeiro governança, lint, tipos, testes, cobertura, complexidade, dependências e build. Teste de carga só pode rodar contra ambiente efêmero aprovado; nunca use produção como alvo padrão.

Um gate ausente, ignorado, inválido ou que atingiu timeout não equivale a aprovação. Não reduza limites dentro do PR para fazê-lo passar; mudanças de política usam spec e revisão próprias.

A revisão Claude é adicional. Sua saída precisa atender ao schema do workflow e passar por `tooling/quality/enforce-claude-review.mjs`. Qualquer achado crítico ou saída inconsistente bloqueia o PR.

Entregue uma tabela curta com comando, resultado e evidência. Declare explicitamente gates ainda não aplicáveis à base inicial; não os chame de aprovados.
