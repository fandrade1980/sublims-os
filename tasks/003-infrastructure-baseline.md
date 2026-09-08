# Tarefa 003 — linha de base e plano de implantação

## Objetivo

Validar que a VPS compartilhada comporta o Sublims OS e produzir uma implantação reproduzível, segura e reversível sem afetar as stacks existentes.

## Escopo

- Inventário sanitizado dos recursos necessários.
- Linha de base de CPU, RAM, disco, I/O e containers por sete dias.
- Decisão sobre reutilização do PostgreSQL Sublims ou novo container.
- Database, roles e backup exclusivos para a aplicação.
- Dockerfile e Compose com projeto explícito, versões fixadas e health checks.
- Configuração Nginx e rota do Cloudflare Tunnel em forma de diff revisável.
- Pipeline de CI para build, testes e imagem.
- Runbooks de deploy, migration, verificação e rollback.
- Alertas de aplicação, banco, capacidade e backups.
- Teste de restauração em ambiente separado.

## Fora de escopo

- Execução automática em produção sem aprovação.
- Alterar serviços de outros projetos.
- Expor novas portas públicas.
- Mudar o timezone do host.
- Kubernetes ou cluster multi-VPS.
- Dar socket Docker ou sudo irrestrito ao aplicativo.

## Critérios de aceite

1. Todo comando de Compose informa projeto e arquivos alvo.
2. A aplicação não compartilha redes ou volumes com workloads não relacionados.
3. Nenhum segredo aparece em Git, logs ou artefatos de CI.
4. A aplicação é alcançável somente pelo caminho Cloudflare Tunnel → Nginx → container.
5. Banco e roles têm menor privilégio e isolamento demonstrável.
6. Backup fora da VPS pode ser restaurado em ambiente separado.
7. Deploy e rollback identificam exatamente a imagem utilizada.
8. Datas de evento permanecem corretas entre UTC, timezone do host e `America/Sao_Paulo`.
9. Alertas detectam indisponibilidade, disco alto e backup vencido.
10. O plano foi revisado por `security-data-reviewer` e aprovado por uma pessoa.

## Gate obrigatório

`platform-devops` é o único escritor desta tarefa. `security-data-reviewer` trabalha somente em leitura. Nenhuma conexão ou mudança na VPS está autorizada pela existência desta tarefa; cada execução em produção precisa de autorização explícita.

