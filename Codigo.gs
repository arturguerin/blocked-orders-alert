/**
 * Alerta de Pedidos Travados → Google Chat
 *
 * Consulta uma question do Metabase via API e envia os resultados ao Google Chat
 * via webhook. Foco em pedidos travados, com indicador visual de urgência por idade.
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
  const MAX_SHOW = 10;

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
  if (rows.length > 0) Logger.log('Colunas disponíveis: ' + JSON.stringify(Object.keys(rows[0])));

  // 2. Sem resultados → sem notificação (silêncio é uma feature)
  if (rows.length === 0) {
    Logger.log('Sem pedidos travados. Sem notificação.');
    return;
  }

  // 3. Helpers ============================================================

  /** Busca uma coluna no row testando vários nomes (case-insensitive). */
  function getField(row, ...candidates) {
    for (const c of candidates) {
      const key = Object.keys(row).find(k => k.toLowerCase() === c.toLowerCase());
      if (key && row[key] != null) return row[key];
    }
    return null;
  }

  /** Converte um valor (string ISO ou null) em Date ou null se inválido. */
  function parseDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Retorna emoji de urgência baseado em horas decorridas. */
  function ageEmoji(h) {
    if (h == null) return '⚪';
    if (h >= 48) return '🔴'; // mais de 2 dias
    if (h >= 24) return '🟠'; // 1 a 2 dias
    if (h >= 12) return '🟡'; // 12 a 24h
    return '🟢';              // menos de 12h
  }

  /** Formata "há X tempo" em português. */
  function relativeTime(h) {
    if (h == null) return 'tempo desconhecido';
    if (h < 1) return `há ${Math.max(1, Math.round(h * 60))} min`;
    if (h < 24) return `há ${Math.round(h)}h`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'há 1 dia' : `há ${d} dias`;
  }

  /** Formata Date no padrão "dd/MM às HH:mm" no fuso configurado. */
  function formatDate(d) {
    return d ? Utilities.formatDate(d, TZ, "dd/MM 'às' HH:mm") : '';
  }

  // 4. Normalizar + enriquecer + ordenar (mais antigos primeiro) =========
  const now = new Date();
  const items = rows.map(row => {
    const lockedAt = parseDate(getField(row, 'DATA DO TRAVAMENTO', 'locked_at'));
    return {
      ref:      getField(row, 'REFERÊNCIA', 'REFERENCIA', 'reference'),
      motivo:   getField(row, 'MOTIVO', 'locking_reason', 'translations'),
      link:     getField(row, 'LINK DO PEDIDO', 'link'),
      lockedAt: lockedAt,
      hoursAgo: lockedAt ? (now - lockedAt) / 3600000 : null
    };
  });

  // Ordena do mais antigo (urgente) pro mais novo
  items.sort((a, b) => (b.hoursAgo ?? -1) - (a.hoursAgo ?? -1));

  // 5. Montar mensagem ====================================================
  const total = items.length;
  const todayStr = Utilities.formatDate(now, TZ, 'dd/MM');
  let message = `🚨 *${TITLE}*\n`;
  message += `_${total} pedido${total === 1 ? '' : 's'} hoje • ${todayStr}_\n\n`;

  items.slice(0, MAX_SHOW).forEach(p => {
    const refDisp = p.link && p.ref ? `<${p.link}|${p.ref}>` : (p.ref || '?');
    message += `${ageEmoji(p.hoursAgo)} ${refDisp} — travado *${relativeTime(p.hoursAgo)}*\n`;
    if (p.motivo)   message += `   ${p.motivo}\n`;
    if (p.lockedAt) message += `   📅 ${formatDate(p.lockedAt)}\n`;
    message += '\n';
  });

  if (total > MAX_SHOW) {
    const rest = total - MAX_SHOW;
    message += `_... e mais ${rest} pedido${rest === 1 ? '' : 's'}._\n\n`;
  }

  message += `🔗 <${METABASE_URL}/question/${QUESTION_ID}|Abrir lista completa no Metabase>`;

  // 6. Enviar pro webhook do Google Chat =================================
  const chatRes = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: message }),
    muteHttpExceptions: true
  });

  Logger.log(`Mensagem enviada ao Chat. Status HTTP: ${chatRes.getResponseCode()}`);
}
