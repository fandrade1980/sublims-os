# Tarefa 000 — fundação do repositório

## Objetivo

Criar um repositório executável e testável para o Sublims OS sem implementar módulos além do necessário para provar a estrutura.

## Escopo

- Aplicação Next.js com TypeScript e Tailwind.
- Organização inicial por módulos descritos em `docs/architecture.md`.
- PostgreSQL local para desenvolvimento.
- Ferramenta de migrations e acesso ao banco escolhida e documentada.
- Módulo de autenticação escolhido por um pequeno spike, sem autenticação artesanal.
- Testes unitários e de integração configurados.
- Verificações automáticas de tipos, lint, testes e build.
- Docker para aplicação e dependências locais.
- Exemplo de configuração sem segredos reais.
- Pipeline de integração contínua no GitHub.
- Modelo mínimo de Organização, Usuário, associação e papéis.
- Migrations, políticas e dados de desenvolvimento reproduzíveis a partir do repositório.
- Registro do protótipo `buffet-mvp` como referência arquivada, sem copiar `.env.local`.
- Arquivos iniciais de container e Compose compatíveis com o projeto exclusivo `sublims-os`, sem executar deploy.

## Fora de escopo

- VPS de produção.
- Supabase completo self-hosted.
- n8n e OpenAI em funcionamento.
- Mercado Pago, trial e assinatura do SaaS.
- Telas finais do produto.
- Módulos financeiros além do esqueleto.
- Alterações nos serviços, proxy, túnel ou bancos já existentes na VPS.

## Critérios de aceite

- Uma pessoa nova consegue iniciar o ambiente seguindo o README.
- Aplicação e PostgreSQL iniciam de forma reproduzível.
- Health check confirma aplicação e banco.
- Testes, tipos, lint e build passam localmente e no CI.
- Estrutura permite adicionar o módulo puro de precificação sem dependência de React ou banco.
- Nenhum segredo está versionado.
- Um teste negativo prova que usuário de uma Organização não lê ou altera dados de outra.
- O banco pode ser criado do zero somente com arquivos versionados.
- Decisões ainda abertas estão registradas, não escondidas em defaults.
- Nenhum comando de bootstrap pressupõe controle exclusivo do host compartilhado.

## Aprovação obrigatória

O orquestrador deve apresentar a escolha de autenticação, acesso ao banco, ferramenta de testes, estratégia de isolamento por Organização e compatibilidade do Compose com a VPS compartilhada antes da implementação.
