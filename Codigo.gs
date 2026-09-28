/**
 * Alerta de Pedidos Travados → Google Chat
 *
 * Consulta uma question do Metabase via API e envia os resultados ao Google Chat
 * via webhook, agrupados por motivo e por urgência (tempo de travamento).
 *
 * Se qualquer etapa falhar (permissão, API key, Metabase fora do ar, webhook),
 * uma mensagem de falha é postada no mesmo espaço do Chat. No primeiro dia
 * em que voltar a funcionar, a mensagem avisa que o alerta foi normalizado.
 *
 * Script Properties necessárias (⚙️ Configurações do projeto → Propriedades do script):
 *   - METABASE_URL:      URL base do Metabase (sem barra final)
 *   - METABASE_API_KEY:  API key gerada em metabase-keygen.devgogroup.com
 *   - WEBHOOK_URL:       URL do webhook do Google Chat
 *   - QUESTION_ID:       ID da question Metabase a monitorar
 *
 * Property gerenciada pelo próprio script (não precisa criar):
 *   - CONSECUTIVE_FAILURES: contador de falhas seguidas
 *
 * IMPORTANTE: a question precisa estar numa coleção legível pelo grupo das
 * API keys do keygen (ex.: "Ecommerce"). Nunca na raiz "Nossas análises"
 * nem em coleção pessoal.
 *
 * Setup: rode setupTrigger() uma vez. Para testar o aviso de falha, rode
 * testarAvisoDeFalha().
 */

const CONFIG = {
  TZ: 'America/Fortaleza',
  TITLE: 'Pedidos travados — Motivos E-commerce',
  TRIGGER_FUNCTION: 'notifyPedidosTravados',
  TRIGGER_HOUR: 6,
  MAX_PER_BUCKET: 5,
  MAX_MOTIVOS: 10,
  BUCKETS: [
    { id: 'critical', label: 'Mais de 48h',     emoji: '🔴' },
    { id: 'high',     label: 'Entre 24h e 48h', emoji: '🟠' },
    { id: 'medium',   label: 'Entre 12h e 24h', emoji: '🟡' },
    { id: 'low',      label: 'Menos de 12h',    emoji: '🟢' },
    { id: 'unknown',  label: 'Sem data',        emoji: '⚪' }
  ]
};

// ============================================================================
// Ponto de entrada (é esta função que o acionador chama)
// ============================================================================

function notifyPedidosTravados() {
  const props = PropertiesService.getScriptProperties();
  const prevFailures = Number(props.getProperty('CONSECUTIVE_FAILURES') || 0);

  try {
    runAlert_(prevFailures);
    props.setProperty('CONSECUTIVE_FAILURES', '0');
  } catch (e) {
    const failures = prevFailures + 1;
    props.setProperty('CONSECUTIVE_FAILURES', String(failures));
    notifyFailure_(e, failures);
    throw e; // mantém a execução marcada como "Falha" no painel Execuções
  }
}

// ============================================================================
// Lógica principal do alerta
// ============================================================================

function runAlert_(prevFailures) {
  const cfg = getConfig_();

  // 1. Executar a question via API key do Metabase
  const queryRes = UrlFetchApp.fetch(
    `${cfg.METABASE_URL}/api/card/${cfg.QUESTION_ID}/query/json`,
    {
      method: 'post',
      headers: { 'X-API-Key': cfg.API_KEY },
      muteHttpExceptions: true
    }
  );
  const code = queryRes.getResponseCode();
  if (code !== 200) {
    throw alertError_('metabase', code,
      `Query falhou (${code}): ${queryRes.getContentText().slice(0, 300)}`);
  }

  let rows;
  try {
    rows = JSON.parse(queryRes.getContentText());
  } catch (err) {
    throw alertError_('metabase', code, 'Resposta do Metabase não é JSON válido.');
  }
  if (!Array.isArray(rows)) {
    // O Metabase às vezes responde 200 com um objeto de erro em vez da lista
    const detail = rows && rows.error ? rows.error : JSON.stringify(rows).slice(0, 300);
    throw alertError_('metabase', code, `Resposta inesperada do Metabase: ${detail}`);
  }

  Logger.log(`Question #${cfg.QUESTION_ID} retornou ${rows.length} linha(s)`);
  if (rows.length > 0) {
    Logger.log('Colunas disponíveis: ' + JSON.stringify(Object.keys(rows[0])));
  }

  const recoveryNote = prevFailures > 0
    ? `✅ _Alerta normalizado após ${prevFailures} falha${prevFailures === 1 ? '' : 's'} seguida${prevFailures === 1 ? '' : 's'}._\n\n`
    : '';

  // 2. Sem resultados → silêncio, exceto se estiver voltando de falha
  if (rows.length === 0) {
    Logger.log('Sem pedidos travados.');
    if (recoveryNote) {
      postToChat_(cfg.WEBHOOK_URL,
        `${recoveryNote}Sem pedidos travados hoje. O silêncio nos próximos dias volta a significar "nada travado".`);
    }
    return;
  }

  // 3. Montar e enviar a mensagem
  const message = recoveryNote + buildMessage_(rows, cfg);
  postToChat_(cfg.WEBHOOK_URL, message);
  Logger.log('Mensagem enviada ao Chat.');
}

// ============================================================================
// Montagem da mensagem
// ============================================================================

function buildMessage_(rows, cfg) {
  const now = new Date();

  const items = rows.map(row => {
    const lockedAt = parseDate_(getField_(row,
      'DATA DO TRAVAMENTO', 'locked_at', 'data_travamento', 'data_do_travamento'
    ));
    return {
      ref: getField_(row,
        'PEDIDO', 'REFERÊNCIA', 'REFERENCIA', 'reference', 'referencia',
        'pedido', 'order', 'order_id', 'id'
      ),
      motivo: getField_(row,
        'MOTIVO DE TRAVAMENTO', 'MOTIVO', 'motivo',
        'locking_reason', 'reason', 'translations'
      ),
      link: getField_(row, 'LINK DO PEDIDO', 'link', 'link_pedido', 'url'),
      lockedAt: lockedAt,
      hoursAgo: lockedAt ? (now - lockedAt) / 3600000 : null
    };
  });

  const total = items.length;
  const todayStr = Utilities.formatDate(now, CONFIG.TZ, 'dd/MM');

  let message = `🚨 *${CONFIG.TITLE}*\n`;
  message += `_${total} pedido${total === 1 ? '' : 's'} hoje • ${todayStr}_\n\n`;

  // Resumo por motivo (mais frequente primeiro)
  const byMotivo = {};
  items.forEach(p => {
    const m = p.motivo || 'Sem motivo';
    byMotivo[m] = (byMotivo[m] || 0) + 1;
  });
  const motivos = Object.entries(byMotivo).sort((a, b) => b[1] - a[1]);

  message += `📊 *Por motivo:*\n`;
  motivos.slice(0, CONFIG.MAX_MOTIVOS).forEach(([m, n]) => {
    message += `   • ${m}: *${n}*\n`;
  });
  if (motivos.length > CONFIG.MAX_MOTIVOS) {
    message += `   _... e mais ${motivos.length - CONFIG.MAX_MOTIVOS} motivo(s)_\n`;
  }
  message += '\n';

  // Agrupar por bucket de urgência (mais antigo primeiro)
  const grouped = {};
  items.forEach(p => {
    const b = bucketOf_(p.hoursAgo);
    (grouped[b] = grouped[b] || []).push(p);
  });
  Object.values(grouped).forEach(arr =>
    arr.sort((a, b) => (b.hoursAgo ?? -1) - (a.hoursAgo ?? -1))
  );

  for (const bucket of CONFIG.BUCKETS) {
    const arr = grouped[bucket.id] || [];
    if (arr.length === 0) continue;

    message += `${bucket.emoji} *${bucket.label}* (${arr.length})\n`;
    arr.slice(0, CONFIG.MAX_PER_BUCKET).forEach(p => {
      const refDisp = p.link && p.ref ? `<${p.link}|${p.ref}>` : (p.ref || '?');
      const motivoStr = p.motivo ? ` — ${p.motivo}` : '';
      const dateStr = p.lockedAt ? ` · ${formatDate_(p.lockedAt)}` : '';
      message += `   • ${refDisp}${motivoStr}${dateStr}\n`;
    });
    if (arr.length > CONFIG.MAX_PER_BUCKET) {
      message += `   _... e mais ${arr.length - CONFIG.MAX_PER_BUCKET}_\n`;
    }
    message += '\n';
  }

  message += `🔗 <${cfg.METABASE_URL}/question/${cfg.QUESTION_ID}|Abrir lista completa no Metabase>`;
  return message;
}

// ============================================================================
// Aviso de falha no Chat
// ============================================================================

function notifyFailure_(e, failures) {
  const webhook = PropertiesService.getScriptProperties().getProperty('WEBHOOK_URL');
  if (!webhook) {
    Logger.log('Sem WEBHOOK_URL, impossível avisar a falha no Chat.');
    return;
  }

  const execUrl = `https://script.google.com/home/projects/${ScriptApp.getScriptId()}/executions`;
  const detail = String(e && e.message ? e.message : e).slice(0, 400);
  const streak = failures > 1 ? ` (${failures}ª falha seguida)` : '';

  let text = `⚠️ *O alerta de pedidos travados falhou hoje${streak}*\n`;
  text += `_Os pedidos travados de hoje NÃO foram verificados. Ausência de alerta não significa ausência de pedidos._\n\n`;
  text += `*Erro:* \`${detail}\`\n`;
  text += `*Provável causa:* ${hintFor_(e)}\n\n`;
  text += `🔧 <${execUrl}|Ver execuções no Apps Script>`;

  // Se o erro foi no próprio webhook, provavelmente esta tentativa também falha.
  // Nesse caso sobra o e-mail automático de falha do Apps Script.
  try {
    postToChat_(webhook, text);
  } catch (err) {
    Logger.log(`Não foi possível avisar a falha no Chat: ${err.message}`);
  }
}

function hintFor_(e) {
  if (e && e.source === 'config') {
    return 'faltam Script Properties no projeto (METABASE_URL, METABASE_API_KEY, WEBHOOK_URL, QUESTION_ID).';
  }
  if (e && e.source === 'chat') {
    return 'o webhook do Google Chat recusou a mensagem. Verifique se o webhook ainda existe no espaço.';
  }
  const code = e && e.httpStatus;
  if (code === 401) {
    return 'API key inválida ou revogada. Gere uma nova em metabase-keygen.devgogroup.com e atualize METABASE_API_KEY.';
  }
  if (code === 403) {
    return 'a API key perdeu acesso à question. Confira se ela está numa coleção legível pelo grupo das chaves do keygen (ex.: Ecommerce), e não na raiz ou em coleção pessoal.';
  }
  if (code === 404) {
    return 'question não encontrada. Confira QUESTION_ID ou se o card foi arquivado/excluído.';
  }
  if (code >= 500) {
    return 'Metabase instável ou a query estourou o tempo. Rode notifyPedidosTravados manualmente mais tarde.';
  }
  return 'erro inesperado. Veja o log da execução.';
}

// ============================================================================
// Helpers
// ============================================================================

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const cfg = {
    METABASE_URL: (props.getProperty('METABASE_URL') || '').replace(/\/$/, ''),
    API_KEY: props.getProperty('METABASE_API_KEY'),
    WEBHOOK_URL: props.getProperty('WEBHOOK_URL'),
    QUESTION_ID: props.getProperty('QUESTION_ID')
  };
  const missing = Object.keys(cfg).filter(k => !cfg[k]);
  if (missing.length) {
    throw alertError_('config', null, `Faltam Script Properties: ${missing.join(', ')}`);
  }
  return cfg;
}

function postToChat_(webhookUrl, text) {
  const res = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    throw alertError_('chat', code,
      `Webhook do Chat falhou (${code}): ${res.getContentText().slice(0, 300)}`);
  }
}

function alertError_(source, httpStatus, message) {
  const err = new Error(message);
  err.source = source;
  err.httpStatus = httpStatus;
  return err;
}

/**
 * Normaliza nome de coluna: minúsculas, sem acentos, sem caracteres especiais.
 * "MOTIVO DE TRAVAMENTO" → "motivodetravamento"
 */
function normalize_(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function getField_(row, ...candidates) {
  const keys = Object.keys(row).map(k => ({ orig: k, norm: normalize_(k) }));
  for (const c of candidates) {
    const match = keys.find(({ norm }) => norm === normalize_(c));
    if (match && row[match.orig] != null) return row[match.orig];
  }
  return null;
}

function parseDate_(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function bucketOf_(h) {
  if (h == null) return 'unknown';
  if (h >= 48) return 'critical';
  if (h >= 24) return 'high';
  if (h >= 12) return 'medium';
  return 'low';
}

function formatDate_(d) {
  return d ? Utilities.formatDate(d, CONFIG.TZ, "dd/MM 'às' HH:mm") : '';
}

// ============================================================================
// Setup e testes (rodar manualmente pelo editor)
// ============================================================================

/**
 * Recria o acionador diário. Apaga os existentes antes, para não duplicar.
 * O fuso é fixado no próprio acionador, então não depende da configuração
 * de fuso do projeto.
 */
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === CONFIG.TRIGGER_FUNCTION)
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION)
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.TZ)
    .create();

  const n = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === CONFIG.TRIGGER_FUNCTION).length;
  Logger.log(`Acionador criado: todo dia entre ${CONFIG.TRIGGER_HOUR}h e ${CONFIG.TRIGGER_HOUR + 1}h (${CONFIG.TZ}). Total ativo: ${n}.`);
}

/**
 * Posta no Chat um aviso de falha simulado, sem alterar o contador.
 * Use para validar que o aviso chega no espaço.
 */
function testarAvisoDeFalha() {
  notifyFailure_(alertError_('metabase', 403,
    'TESTE: Query falhou (403): Você não tem permissão para fazer isso.'), 1);
}
