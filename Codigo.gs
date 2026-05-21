/**
 * Alerta de Pedidos Travados → Google Chat
 *
 * Consulta uma question do Metabase via API e envia os resultados ao Google Chat
 * via webhook. Os pedidos são agrupados por urgência (tempo de travamento).
 *
 * Veja README.md para setup completo.
 *
 * Configuração: ⚙️ Configurações do projeto → Propriedades do script
 * Propriedades necessárias:
 *   - METABASE_URL:      URL base do Metabase (sem barra final)
 *   - METABASE_API_KEY:  API key pessoal criada no Metabase
 *   - WEBHOOK_URL:       URL do webhook do Google Chat
 *   - QUESTION_ID:       ID da question Metabase a monitorar
 *
 * Acionador recomendado: diário, das 7h às 8h, fuso America/Fortaleza.
 */

function notifyPedidosTravados() {
  const props = PropertiesService.getScriptProperties();
  const METABASE_URL = (props.getProperty('METABASE_URL') || '').replace(/\/$/, '');
  const API_KEY = props.getProperty('METABASE_API_KEY');
  const WEBHOOK_URL = props.getProperty('WEBHOOK_URL');
  const QUESTION_ID = props.getProperty('QUESTION_ID');

  if (!METABASE_URL || !API_KEY || !WEBHOOK_URL || !QUESTION_ID) {
    throw new Error('Faltam Script Properties. Veja README.md para configuração.');
  }

  // Configurações visuais
  const TZ = 'America/Fortaleza';
  const TITLE = 'Pedidos travados — Motivos E-commerce';
  const MAX_PER_BUCKET = 5;

  // Definição dos buckets de urgência
  const BUCKETS = [
    { id: 'critical', label: 'Mais de 48h',     emoji: '🔴' },
    { id: 'high',     label: 'Entre 24h e 48h', emoji: '🟠' },
    { id: 'medium',   label: 'Entre 12h e 24h', emoji: '🟡' },
    { id: 'low',      label: 'Menos de 12h',    emoji: '🟢' },
    { id: 'unknown',  label: 'Sem data',        emoji: '⚪' }
  ];

  // 1. Executar a question via API key do Metabase
  const queryRes = UrlFetchApp.fetch(
    `${METABASE_URL}/api/card/${QUESTION_ID}/query/json`,
    {
      method: 'post',
      headers: { 'X-API-Key': API_KEY },
      muteHttpExceptions: true
    }
  );
  if (queryRes.getResponseCode() !== 200) {
    throw new Error(`Query falhou (${queryRes.getResponseCode()}): ${queryRes.getContentText()}`);
  }

  const rows = JSON.parse(queryRes.getContentText());
  Logger.log(`Question #${QUESTION_ID} retornou ${rows.length} linha(s)`);
  if (rows.length > 0) {
    Logger.log('Colunas disponíveis: ' + JSON.stringify(Object.keys(rows[0])));
    Logger.log('Exemplo (primeira linha): ' + JSON.stringify(rows[0]));
  }

  // 2. Sem resultados → sem notificação (silêncio é uma feature)
  if (rows.length === 0) {
    Logger.log('Sem pedidos travados. Sem notificação.');
    return;
  }

  // 3. Helpers ============================================================

  /**
   * Normaliza nome de coluna: minúsculas, sem acentos, sem caracteres especiais.
   * "REFERÊNCIA" → "referencia"
   * "MOTIVO DE TRAVAMENTO" → "motivodetravamento"
   * "Data do Travamento" → "datadotravamento"
   * "locked_at" → "lockedat"
   */
  function normalize(s) {
    return String(s).toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  /**
   * Busca uma coluna no row testando vários nomes candidatos.
   * A normalização permite matchar variações de caixa, acentos, espaços, etc.
   */
  function getField(row, ...candidates) {
    const normalizedKeys = Object.keys(row).map(k => ({ orig: k, norm: normalize(k) }));
    for (const c of candidates) {
      const cNorm = normalize(c);
      const match = normalizedKeys.find(({ norm }) => norm === cNorm);
      if (match && row[match.orig] != null) return row[match.orig];
    }
    return null;
  }

  function parseDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function bucketOf(h) {
    if (h == null) return 'unknown';
    if (h >= 48) return 'critical';
    if (h >= 24) return 'high';
    if (h >= 12) return 'medium';
    return 'low';
  }

  function formatDate(d) {
    return d ? Utilities.formatDate(d, TZ, "dd/MM 'às' HH:mm") : '';
  }

  // 4. Normalizar + enriquecer cada linha =================================
  const now = new Date();
  const items = rows.map(row => {
    const lockedAt = parseDate(getField(row,
      'DATA DO TRAVAMENTO', 'locked_at', 'data_travamento', 'data_do_travamento'
    ));
    return {
      ref: getField(row,
        'PEDIDO', 'REFERÊNCIA', 'REFERENCIA', 'reference', 'referencia',
        'pedido', 'order', 'order_id', 'id'
      ),
      motivo: getField(row,
        'MOTIVO DE TRAVAMENTO', 'MOTIVO', 'motivo',
        'locking_reason', 'reason', 'translations'
      ),
      link: getField(row,
        'LINK DO PEDIDO', 'link', 'link_pedido', 'url'
      ),
      lockedAt: lockedAt,
      hoursAgo: lockedAt ? (now - lockedAt) / 3600000 : null
    };
  });

  // 5. Agrupar por bucket e ordenar (mais antigo primeiro dentro do bucket)
  const grouped = {};
  items.forEach(p => {
    const b = bucketOf(p.hoursAgo);
    (grouped[b] = grouped[b] || []).push(p);
  });
  Object.values(grouped).forEach(arr =>
    arr.sort((a, b) => (b.hoursAgo ?? -1) - (a.hoursAgo ?? -1))
  );

  // 6. Montar mensagem ====================================================
  const total = items.length;
  const todayStr = Utilities.formatDate(now, TZ, 'dd/MM');

  let message = `🚨 *${TITLE}*\n`;
  message += `_${total} pedido${total === 1 ? '' : 's'} hoje • ${todayStr}_\n\n`;

  for (const bucket of BUCKETS) {
    const arr = grouped[bucket.id] || [];
    if (arr.length === 0) continue;

    message += `${bucket.emoji} *${bucket.label}* (${arr.length})\n`;

    arr.slice(0, MAX_PER_BUCKET).forEach(p => {
      const refDisp = p.link && p.ref ? `<${p.link}|${p.ref}>` : (p.ref || '?');
      const motivoStr = p.motivo ? ` — ${p.motivo}` : '';
      const dateStr = p.lockedAt ? ` · ${formatDate(p.lockedAt)}` : '';
      message += `   • ${refDisp}${motivoStr}${dateStr}\n`;
    });

    if (arr.length > MAX_PER_BUCKET) {
      const rest = arr.length - MAX_PER_BUCKET;
      message += `   _... e mais ${rest}_\n`;
    }
    message += '\n';
  }

  message += `🔗 <${METABASE_URL}/question/${QUESTION_ID}|Abrir lista completa no Metabase>`;

  // 7. Enviar pro webhook do Google Chat ==================================
  const chatRes = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: message }),
    muteHttpExceptions: true
  });

  Logger.log(`Mensagem enviada ao Chat. Status HTTP: ${chatRes.getResponseCode()}`);
}
