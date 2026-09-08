# Operação diária assistida por IA

## Estado atual

As rotinas estão desenhadas e **desativadas** em `ops/daily/manifest.json`. Este estado é intencional: ainda não existem aplicação de produção, endpoints de saúde, banco do Sublims OS, provedor de assinatura, canal de suporte, destino externo de backup ou destinatários aprovados.

## Arquitetura

Coletores determinísticos acessam cada sistema com credenciais mínimas e produzem JSON sanitizado. Agentes de leitura interpretam esses resultados. Um executor autorizado, preferencialmente n8n na infraestrutura já existente, agenda as rotinas e entrega o relatório.

```text
saúde ───────── operations-monitor ─────┐
backup ──────── backup-auditor ─────────┤
assinaturas ─── subscription-auditor ───┼─ daily-reporter ─ artefato para envio
suporte ─────── support-triage ──────────┘
```

O backup não é “feito pela IA”. Um job reproduzível do PostgreSQL cria, cifra e envia o backup; a IA apenas audita o manifesto. Isso evita que um modelo tenha credenciais amplas ou declare sucesso sem prova.

## Contrato mínimo dos artefatos

Cada coletor retorna:

- `routine_id`, `run_id`, `started_at_utc`, `finished_at_utc`;
- `status`: `ok`, `attention`, `failed` ou `not_verified`;
- `evidence`: campos específicos sem segredo ou dado pessoal desnecessário;
- `errors`: códigos sanitizados;
- `source_version` e `schema_version`.

O backup inclui também ferramenta/versão, banco lógico, tamanho, checksum, cifra, destino externo e retenção. O relatório nunca contém senha, token, string de conexão, cartão ou conteúdo integral de mensagens.

## Ativação por etapas

1. Aprovar responsáveis, horários e fuso `America/Sao_Paulo` sem mudar o timezone do host.
2. Criar interfaces e contas de serviço de menor privilégio.
3. Definir health check, SLOs, RPO, RTO, retenção e destino externo.
4. Implementar coletores com dados sintéticos e testes negativos.
5. Executar em observação; suporte produz apenas rascunhos.
6. Testar backup e restauração em ambiente isolado.
7. Aprovar canais e destinatários do relatório.
8. Somente então definir `schedule` e mudar `enabled` para `true` em PR próprio.

Envio automático de respostas a usuários é uma capacidade separada. Exige política de privacidade, categorias permitidas, limiar de confiança, supervisão, trilha de auditoria, opt-out e kill switch. Até isso existir, `support-triage` nunca envia.

## Incidentes e exceções

- Falha de uma fonte não impede o relatório; aparece como `not_verified` ou `failed`.
- Nenhum agente reinicia container, executa migration, altera assinatura ou restaura backup.
- O executor interrompe a rotina se o alvo não corresponder à Organização e ao ambiente configurados.
- Quebra de vidro exige pessoa identificada, justificativa, tempo limitado e auditoria.
