# Alerta de Pedidos Travados → Google Chat

Notificação diária automática que envia, ao espaço do Google Chat do time de E-commerce, a lista de pedidos travados por motivos de e-commerce que ainda não foram resolvidos. Roda no Google Apps Script consumindo a API do Metabase.

---

## 🔭 Visão geral

```
Metabase Question #26465  ──HTTP──►  Apps Script  ──webhook──►  Google Chat
```

Todo dia útil às 7h da manhã (horário de Brasília), o script:

1. Faz uma chamada autenticada na API do Metabase usando uma API key pessoal.
2. Executa a question **#26465 — Pedidos Travados - Motivos E-commerce [EC]**.
3. Se houver resultados, formata uma mensagem com indicador visual de urgência por idade e envia ao webhook do Google Chat.
4. Se não houver resultados, **não envia nada** (sem spam — silêncio é uma feature).

### Por que essa arquitetura?

O ideal seria usar o canal nativo de webhooks do Metabase (`Admin → Notificações → Webhooks`), mas isso exige acesso de administrador. Esta solução é o "plano B" enquanto o admin não habilita o webhook nativo — funciona 100% sem privilégios de admin no Metabase. Veja [Migração futura](#-migração-para-o-webhook-nativo-do-metabase).

### Anatomia da mensagem

```
🚨 Pedidos travados — Motivos E-commerce
3 pedidos hoje • 20/05

🔴 GC123456 — travado há 2 dias
   [EC] Cliente solicitou cancelamento parcial
   📅 18/05 às 14:30

🟠 GC789012 — travado há 1 dia
   [EC] Endereço de entrega incompleto
   📅 19/05 às 09:15

🟡 GC345678 — travado há 12h
   [EC] Conflito de promoção aplicada
   📅 20/05 às 06:50

🔗 Abrir lista completa no Metabase
```

**Indicadores de urgência por idade:**

| Emoji | Critério         | Significado                |
|-------|------------------|----------------------------|
| 🔴    | +48h travado     | Crítico — agir imediato    |
| 🟠    | 24–48h           | Alta prioridade            |
| 🟡    | 12–24h           | Média prioridade           |
| 🟢    | <12h             | Recém-travado              |
| ⚪    | Sem data         | Travamento de data desconhecida |

A lista é ordenada do mais antigo para o mais recente, máximo 10 pedidos visíveis (excedentes aparecem como "_... e mais X pedidos_").

---

## 🧰 Pré-requisitos

- Conta Google com acesso ao Apps Script ([script.google.com](https://script.google.com))
- Permissão de gerenciamento no espaço do Google Chat de destino (pra criar webhook)
- Conta no Metabase com permissão pra criar API keys pessoais

---

## 🚀 Setup do zero

### 1. Criar o webhook no Google Chat

1. Abra o espaço onde as mensagens devem chegar.
2. Clique no nome do espaço (canto superior) → **Apps e integrações** → aba **Webhooks**.
3. **Adicionar webhook** → dê um nome (ex: `Metabase - Alertas`) e opcionalmente uma URL de avatar.
4. Salve e **copie a URL gerada** — formato: `https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...`

> ⚠️ **Trate a URL como secret.** Qualquer pessoa com ela consegue postar no espaço.

### 2. Criar a API key no Metabase

1. Avatar (canto superior direito) → **Configurações da conta** → aba **Chaves de API**.
2. **Criar chave** → nome (ex: `apps-script-alerts`).
3. **Copie a chave imediatamente** — ela só aparece uma vez.

### 3. Criar o projeto no Apps Script

1. Acesse [script.google.com](https://script.google.com) → **Novo projeto**.
2. Renomeie o projeto (ex: `Alertas Pedidos Travados`).
3. Apague o conteúdo padrão de `Código.gs` e cole o conteúdo de [`Codigo.gs`](./Codigo.gs) deste repositório.
4. Salve (Ctrl/Cmd+S).

### 4. Configurar Script Properties (credenciais)

⚙️ **Configurações do projeto** → role até **Propriedades do script** → adicione estas quatro propriedades:

| Propriedade         | Valor                                                      |
|---------------------|------------------------------------------------------------|
| `METABASE_URL`      | URL base do Metabase, sem barra final (ex: `https://metabase.gocase.com.br`) |
| `METABASE_API_KEY`  | A chave criada no passo 2                                  |
| `WEBHOOK_URL`       | A URL do webhook do passo 1                                |
| `QUESTION_ID`       | `26465` (ou o ID da question Metabase a monitorar)         |

### 5. Ajustar o fuso horário do projeto

⚙️ **Configurações do projeto** → **Fuso horário** → `America/Fortaleza` (ou `America/Sao_Paulo`).

> Isto afeta o horário em que o trigger dispara. O formato das datas exibidas na mensagem já usa fuso hardcoded em `TZ` dentro do código.

### 6. Criar o acionador (trigger)

Ícone ⏰ na sidebar → **Adicionar acionador**:

- **Função:** `notifyPedidosTravados`
- **Implantação:** `Teste` (= HEAD, usa a versão mais recente salva — esse é o comportamento desejado)
- **Origem do evento:** `Baseado no tempo`
- **Tipo de acionador:** `Acionador diário`
- **Hora do dia:** `7h às 8h`

Salve. O Apps Script vai pedir autorização (Gmail-Send, UrlFetch) na primeira vez — aceite.

### 7. Teste manual

No editor, com `notifyPedidosTravados` selecionado no dropdown → clique em **Executar**. Acompanhe o **Registro de execução**:

- `Sem pedidos travados. Sem notificação.` → ✅ tudo certo, sem dados pra notificar.
- Mensagem chegando no Chat → ✅ tudo certo, com dados.
- Erro → veja [Troubleshooting](#-troubleshooting).

---

## 🔧 Manutenção

### Mudar o horário do alerta

⏰ **Acionadores** → ✏️ ícone de lápis no trigger → mude `Hora do dia` → salvar.

### Trocar a question monitorada

Edite apenas a propriedade `QUESTION_ID` em **Script Properties**. Não precisa mexer no código.

### Adicionar uma segunda question (ex: Motivos Ilustra #26468)

Dois caminhos:

- **A. Novo projeto Apps Script (recomendado pra começar)**
  Duplique o setup todo, com `QUESTION_ID = 26468`. Mais simples, isolamento total, fácil de desativar individualmente.

- **B. Mesmo projeto, função adicional (mais elegante)**
  Refatore o código pra extrair a função "rodar uma question e enviar" recebendo `QUESTION_ID` por parâmetro. Crie funções wrapper (`notifyEcommerce`, `notifyIlustra`) com triggers separados, lendo IDs distintos de Script Properties (`QUESTION_ID_EC`, `QUESTION_ID_IL`).

### Mudar o formato da mensagem

A montagem da mensagem está na seção `// 5. Montar mensagem` em `Codigo.gs`.

- **Limites de cor de urgência:** ajustar a função `ageEmoji()` (linhas com `if (h >= 48)` etc.).
- **Formato de "há X tempo":** ajustar `relativeTime()`.
- **Layout do bloco por pedido:** ajustar o `items.slice(0, MAX_SHOW).forEach(...)`.
- **Limite de pedidos mostrados:** mudar a constante `MAX_SHOW`.

### Rotacionar credenciais

**API key do Metabase** (recomendado a cada 6 meses ou após mudança de equipe):

1. Metabase → Configurações da conta → Chaves de API.
2. Crie uma nova chave.
3. Atualize `METABASE_API_KEY` em Script Properties.
4. **Confirme com uma execução manual** antes de deletar a antiga.
5. Delete a chave antiga.

**Webhook do Google Chat:**

1. Espaço → Apps e integrações → Webhooks.
2. Crie um novo webhook.
3. Atualize `WEBHOOK_URL` em Script Properties.
4. Confirme com uma execução manual.
5. Delete o webhook antigo.

### Pausar temporariamente

⏰ **Acionadores** → 3 pontinhos no trigger → **Desativar acionador** (não precisa deletar — pode reativar depois).

---

## 🐛 Troubleshooting

### A mensagem não chegou no horário esperado

1. **Apps Script → ícone de relógio invertido (Execuções)** — veja a última execução.
2. Confira:
   - **Status verde "Concluído" + log "Sem pedidos travados"** → ✅ comportamento normal, query rodou e não tinha dados.
   - **Status vermelho com erro** → veja a mensagem de erro nas tabelas abaixo.
   - **Nenhuma execução listada** no horário esperado → o trigger pode estar desativado ou o fuso do projeto pode estar errado.

### Erros comuns e o que fazer

| Erro                                              | Causa provável                              | Solução                                                                 |
|---------------------------------------------------|---------------------------------------------|-------------------------------------------------------------------------|
| `Query falhou (401): ...`                         | API key inválida ou revogada                | Crie nova API key no Metabase, atualize `METABASE_API_KEY`              |
| `Query falhou (404): ...`                         | `QUESTION_ID` não existe ou foi deletada    | Confira o ID em Script Properties                                       |
| `Query falhou (403): ...`                         | API key sem permissão pra essa question     | A question deve estar em coleção acessível pelo usuário dono da API key |
| `Faltam Script Properties.`                       | Alguma das 4 properties não foi configurada | Revise ⚙️ Configurações do projeto → Propriedades do script             |
| `Exception: Request failed for ...`               | URL do Metabase ou webhook errada           | Confira `METABASE_URL` (sem barra final) e `WEBHOOK_URL`                |
| Webhook retorna não-200 (sem exception lançada)   | Webhook deletado, URL malformada            | Crie novo webhook no Chat e atualize `WEBHOOK_URL`                      |

### Mensagem chega mas o layout está estranho

O script procura colunas com nomes específicos no resultado da query (case-insensitive):

- `REFERÊNCIA` / `REFERENCIA` / `reference`
- `MOTIVO` / `locking_reason` / `translations`
- `DATA DO TRAVAMENTO` / `locked_at`
- `LINK DO PEDIDO` / `link`

Se nenhuma bater, o script **não cai num fallback** — vai mostrar `?` ou pular o campo. Para corrigir:

- **Opção A:** renomeie as colunas no `SELECT` da question Metabase com aliases que batam (ex: `o.reference AS "REFERÊNCIA"`).
- **Opção B:** adicione o nome real da coluna na chamada `getField(row, ...)` no código.

Você pode descobrir os nomes reais das colunas no log do Apps Script — o script loga `Colunas disponíveis: [...]` a cada execução.

---

## 🔁 Migração para o webhook nativo do Metabase

Quando o admin do Metabase configurar webhooks (`Admin → Notificações → Webhooks`), a solução nativa fica disponível e é preferível:

1. Admin cadastra o webhook do Google Chat no Metabase (`Admin → Notificações → Webhooks`).
2. Você cria um alerta nativo na question #26465 escolhendo "Google Chat" (ou o nome dado ao webhook) como canal de destino.
3. **Desative o trigger no Apps Script** (⏰ Acionadores → 3 pontinhos → Desativar acionador). O projeto fica como backup desligado.
4. (Opcional) Após algumas semanas confirmando que o nativo funciona, delete o projeto Apps Script e a API key associada.

**Por que migrar:**

- Menos peças móveis (sem intermediário).
- Configuração feita por quem tem acesso administrativo (não depende de uma pessoa específica).
- Não depende de uma API key pessoal — se a pessoa sair da empresa, o alerta continua funcionando.
- Logs e debugging centralizados no Metabase.

---

## 🔐 Segurança

- **Nunca commite secrets.** Todas as credenciais ficam em Script Properties, fora do código. O conteúdo deste repositório pode ser público.
- **Compartilhamento do projeto Apps Script:** Compartilhe só com quem precisa manter (Editor). Evite "qualquer pessoa com o link".
- **Rotacione credenciais periodicamente.** Sugerido: a cada 6 meses ou após mudanças de equipe.
- **Monitore execuções.** O painel **Execuções** do Apps Script mostra histórico — útil pra detectar falhas silenciosas ou uso indevido.
- **Não cole a URL do webhook ou a API key em chats, tickets ou screenshots.** Trate como senhas.

---

## 📂 Estrutura deste repositório

```
.
├── README.md       # Esta documentação
└── Codigo.gs       # Código do Apps Script (copiar para o projeto)
```

---

## 📝 Autoria e contato

- **Setup inicial:** Artur Guerin, maio de 2026.
- **Time responsável:** Growth / E-commerce.

Para mudanças no comportamento do alerta, abra uma issue ou PR. Para suporte rápido, contate o autor pelo Chat interno.
