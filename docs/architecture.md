# Direção de arquitetura

## Recomendação inicial

Começar com um monólito modular em Next.js e TypeScript, executado em container e conectado a PostgreSQL. Essa forma reduz o custo operacional do MVP e mantém regras relacionadas no mesmo processo, sem impedir separações futuras quando houver volume ou equipes que as justifiquem.

O frontend e as operações de aplicação podem viver no mesmo projeto. Regras críticas não devem ficar em componentes React, handlers HTTP, automações n8n ou prompts de IA.

## Tratamento do protótipo analisado

O diretório `buffet-mvp` é um protótipo exploratório. Ele comprova nomenclaturas de tela e parte do fluxo, mas não deve ser promovido diretamente a produção porque:

- cálculos financeiros estão dentro de páginas React e usam números de ponto flutuante;
- eventos são recalculados com o preço atual dos ingredientes, sem retrato histórico;
- acesso ao banco está espalhado pela interface;
- o isolamento é por proprietário individual, incompatível com equipes por Organização;
- o repositório não contém migrations que reproduzam as tabelas descritas;
- Cliente, Cenário de Precificação e Proposta não estão modelados;
- não há suíte de testes nem comando de teste configurado;
- assinatura do SaaS foi implementada antes da validação da operação interna.

Reaproveitamento deve acontecer por comportamento validado, não por cópia indiscriminada de código ou schema.

## Módulos

```text
identity       Organização, Usuário, papéis e isolamento
crm            Cliente e contatos
events         Evento, convidados, datas e status
ingredients    Ingredientes, unidades, conversões e custos válidos
recipes        Fichas Técnicas, versões, perdas e rendimento
menus          Cardápios e quantidades por evento
pricing        Cenários, memória de cálculo e retratos de custos
proposals      Propostas e versões emitidas
integrations   n8n, e-mail, documentos e provedores externos
```

Cada módulo deve oferecer uma interface pequena. Banco e framework são detalhes da implementação, não parte da regra de negócio.

`events` não é sinônimo de proposta. `events` guarda o compromisso operacional; `pricing` guarda hipóteses e resultados; `proposals` guarda a oferta comercial emitida.

## Módulo profundo de precificação

Interface inicial conceitual:

```ts
calculateEventPrice(input: PricingInput): PricingResult
```

`PricingInput` contém todas as premissas explícitas. O módulo não consulta banco, não chama IA, não lê variáveis de ambiente e não depende da data atual. Assim, a mesma entrada sempre produz a mesma saída e os testes usam a mesma interface da aplicação.

`PricingResult` deve conter totais, decomposição, alertas, estado publicável e uma versão identificável da fórmula.

## Fluxo de dados

```text
Nginx
  └─ Next.js
      ├─ módulos de domínio
      ├─ adapters PostgreSQL
      ├─ adapter OpenAI
      └─ outbox de integrações
           └─ n8n
```

- Nginx encerra TLS e protege a aplicação exposta.
- PostgreSQL é a fonte de verdade.
- n8n recebe eventos de integração e executa tarefas externas; falhas nele não podem corromper o cálculo central.
- OpenAI recebe apenas o contexto mínimo necessário e pode sugerir ou explicar, mas não publicar números oficiais.

## Persistência

- Toda tabela de negócio possui `organization_id`.
- Usuários acessam dados por associação e papel dentro da Organização; `owner_id` individual não é o modelo de tenancy.
- Valores monetários usam representação decimal exata; quantidades e fatores usam precisão definida pelo domínio.
- Custos de ingrediente possuem unidade, vigência e origem.
- Fichas Técnicas, Cenários de Precificação e Propostas usam versões imutáveis quando publicados.
- Alterações relevantes registram autor, instante e motivo.
- Exclusões de registros usados financeiramente devem ser lógicas ou bloqueadas.
- O schema e todas as políticas de acesso vivem em migrations versionadas no mesmo repositório.

## Autenticação

Para o piloto, usar PostgreSQL simples e um módulo de autenticação confiável integrado à aplicação. Não construir criptografia ou gerenciamento de sessão artesanalmente.

Supabase permanece uma alternativa válida se Auth, Storage, políticas no banco ou Realtime passarem a trazer valor suficiente. A pilha completa self-hosted adiciona vários serviços e responsabilidades de atualização, backup, segurança e observabilidade; por isso não é pré-requisito para validar a precificação.

## Implantação inicial na VPS

- Usar a VPS compartilhada descrita de forma sanitizada em `docs/infrastructure-target.md`.
- Cloudflare Tunnel direciona o tráfego ao Nginx local, que encaminha para o container Next.js em loopback ou rede interna.
- PostgreSQL usa database e roles exclusivos. A reutilização da instância Sublims existente depende de capacidade e restauração verificadas.
- n8n permanece separado e integra por interfaces autenticadas ou outbox, sem escrita ampla nas tabelas centrais.
- O projeto Compose possui nome fixo e redes próprias, sem socket Docker ou acesso a sandboxes privilegiados.
- Ambientes de desenvolvimento e produção separados.
- Imagens com versões fixadas, health checks e rotina de atualização.
- Instantes são armazenados em UTC; a Organização define `America/Sao_Paulo` sem alterar o timezone do host.
- Backups da aplicação têm cópia externa e restauração testada.

## Estratégia de teste

- Testes de tabela para o cálculo de precificação.
- Testes de propriedades para invariantes monetários importantes.
- Testes de integração dos adapters PostgreSQL.
- Testes de fluxo para criar cenário, publicar preço e emitir proposta.
- Teste explícito garantindo que mudanças futuras de custo não alterem proposta emitida.
- Testes negativos de acesso entre Organizações e de uso privilegiado em webhooks.
