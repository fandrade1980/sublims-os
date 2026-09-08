---
name: daily-operations
description: Consolida as rotinas diárias de saúde, backup, assinaturas, suporte e relatório do Sublims OS a partir de artefatos operacionais sanitizados. Use somente depois da ativação descrita no runbook.
---

# Operação diária

Leia `docs/daily-operations.md` e `ops/daily/manifest.json`. Enquanto `enabled` for `false`, apenas valide configuração e produza simulações com dados sintéticos.

Coletores determinísticos verificam saúde, backup e assinaturas. IA pode classificar suporte, sugerir resposta e resumir resultados, mas não declara uma fonte ausente como saudável e não envia resposta real sem política e autorização configuradas.

Regras de parada:

- falha de autenticação, alvo desconhecido ou dado incompleto: marque `não verificado` e escale;
- backup sem checksum, cópia externa ou confirmação: marque `falhou`;
- divergência de assinatura: reporte, não cobre nem cancele;
- suporte sensível, financeiro, jurídico ou de segurança: encaminhe a uma pessoa;
- nunca use SSH, sudo, socket Docker ou segredos além do escopo da rotina.

O relatório final distingue `ok`, `atenção`, `falhou` e `não verificado`, com horário em UTC e exibição no fuso da Organização.
