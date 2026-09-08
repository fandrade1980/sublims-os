# Infraestrutura-alvo do Sublims OS

Este documento registra apenas informações necessárias ao desenvolvimento. Endereço IP, usuário SSH, caminhos pessoais, chaves e detalhes excessivamente operacionais permanecem fora do repositório.

## Ambiente disponível

- VPS única na OVH com Ubuntu 24.04 LTS.
- Capacidade aproximada: 6 vCPU, 11 GiB de RAM e 145 GB de disco.
- O host é compartilhado por automações n8n, bancos PostgreSQL, painel de administração, site institucional e monitoramento.
- Entrada pública exclusivamente por Cloudflare Tunnel; portas HTTP/HTTPS não são abertas diretamente.
- Nginx e cloudflared rodam no host.
- Docker Compose é usado por múltiplos projetos independentes.
- Existe monitoramento próprio, hardening de SSH, firewall, fail2ban e rotinas de backup.
- O timezone do host difere do timezone operacional da Sublims Gastronomia.

## Arquitetura recomendada

```text
Internet
   ↓
Cloudflare Tunnel
   ↓
Nginx local
   ↓
Container Sublims OS
   ├─ PostgreSQL Sublims com database e role exclusivos
   ├─ armazenamento privado de arquivos
   └─ interface interna de integrações
          ↓
         n8n
```

O tráfego do aplicativo deve passar pelo Nginx local antes do container, para concentrar headers, limites, logs e políticas de proxy. O container deve publicar somente em loopback ou rede interna, nunca em todas as interfaces do host.

## PostgreSQL

Há uma instância PostgreSQL já isolada para o ecossistema Sublims. Antes de reutilizá-la, o agente de plataforma deve verificar capacidade, versão, política de backup e possibilidade de restauração.

Se aprovada, criar:

- database exclusivo para o Sublims OS;
- role de aplicação com menor privilégio;
- role separada para migrations;
- role de integração extremamente restrita, somente se necessária;
- backup independente e teste de restauração.

Não permitir que n8n escreva diretamente nas tabelas centrais. Preferir interfaces autenticadas da aplicação ou uma outbox. Um novo container PostgreSQL só deve ser criado se isolamento, capacidade ou ciclo de atualização justificarem o custo adicional.

## Docker Compose

- Usar um nome de projeto fixo e exclusivo, por exemplo `sublims-os`.
- Manter compose, Dockerfile e scripts no repositório.
- Fixar versões de imagens; não usar `latest` em produção.
- Definir health checks, limites de recursos e política de reinício.
- Não montar o socket Docker no aplicativo.
- Não compartilhar rede com sandboxes privilegiados ou produtos não relacionados.
- Nunca executar `docker compose up --remove-orphans` sem validar diretório, arquivos compose e `-p` do projeto correto.
- Toda operação destrutiva ou de produção exige prévia visualização do alvo e aprovação humana.

## Fuso horário

- Armazenar instantes em UTC.
- Armazenar separadamente o timezone IANA da Organização, inicialmente `America/Sao_Paulo`.
- Converter datas e horários apenas nas interfaces do domínio e da apresentação.
- Não alterar o timezone do host compartilhado para atender ao aplicativo.
- Testar horário de verão, virada de data, eventos atravessando meia-noite e jobs agendados no n8n.

## Backups e recuperação

As rotinas existentes são uma boa base, mas a proteção do Sublims OS só estará concluída quando incluir:

- backup consistente do database da aplicação;
- migrations e configuração versionadas;
- backup de arquivos privados enviados pelos usuários;
- cópia criptografada fora da VPS;
- retenção definida;
- monitoramento da idade do último backup;
- teste periódico de restauração em ambiente separado;
- objetivos de perda aceitável de dados e tempo de recuperação aprovados.

Backup sem teste de restauração não é evidência de recuperação.

## Observabilidade e capacidade

Integrar ao monitoramento existente:

- health check e readiness da aplicação;
- disponibilidade do database e pool de conexões;
- respostas 5xx, latência e falhas de autenticação;
- filas/outbox e erros de workflows n8n;
- validade do túnel e do proxy;
- uso de CPU, RAM, disco e crescimento de volumes;
- idade e resultado dos backups.

Antes do primeiro deploy, coletar uma linha de base de sete dias do host. Definir alertas de capacidade e evitar jobs pesados nos mesmos horários dos scans e backups existentes.

## Deploy inicial

- Pipeline de CI executa tipos, lint, testes, build e scan da imagem.
- A imagem recebe tag imutável baseada no commit.
- Deploy de produção é acionado e aprovado por uma pessoa.
- Migration ocorre como etapa explícita antes da troca da aplicação.
- Health check valida a nova versão.
- Rollback usa a imagem anterior; rollback de banco exige estratégia própria e nunca é presumido.
- Logs do deploy registram versão, operador, horário e resultado sem incluir segredos.

## Acesso à produção

- Agentes não recebem acesso SSH irrestrito por padrão.
- Não usar conta com sudo amplo em automações do projeto.
- Se automação de deploy for necessária, criar identidade dedicada com comandos e diretórios permitidos.
- O agente de plataforma gera planos, diffs e runbooks; execução na VPS precisa de aprovação humana explícita.
- O painel de administração próprio só pode ser integrado após revisão da interface, autenticação e privilégios.

## Decisões pendentes

1. Reutilizar a instância PostgreSQL do ecossistema Sublims ou criar container dedicado.
2. Escolher armazenamento privado local ou compatível com S3.
3. Definir objetivos de recuperação e retenção.
4. Escolher mecanismo de deploy: painel próprio, runner dedicado ou execução manual assistida.
5. Definir limites de CPU/RAM para aplicativo e database após a linha de base.
6. Decidir se staging ficará na mesma VPS ou em ambiente separado.

