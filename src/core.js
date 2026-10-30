export const SECTORS = [
  { id: 'rh', name: 'Recursos Humanos', receives: true },
  { id: 'ti', name: 'Tecnologia da Informação', receives: true },
  { id: 'financeiro', name: 'Financeiro e Contabilidade', receives: true },
  { id: 'fiscal', name: 'Fiscal e Jurídico', receives: true },
  { id: 'compras', name: 'Compras', receives: true },
  { id: 'administrativo', name: 'Administrativo', receives: true },
  { id: 'infraestrutura', name: 'Infraestrutura / Manutenção', receives: true },
  { id: 'servicos', name: 'Serviços Gerais', receives: true },
  { id: 'operacoes', name: 'Operações', receives: true },
  { id: 'comercial', name: 'Comercial / Vendas', receives: false },
  { id: 'marketing', name: 'Marketing', receives: false },
  { id: 'produto', name: 'Produto', receives: false },
  { id: 'diretoria', name: 'Diretoria', receives: false },
];

export const STATUSES = Object.freeze({
  open: 'Aberto',
  in_progress: 'Em atendimento',
  waiting_info: 'Aguardando informações',
  third_party: 'Envio a terceiros',
  resolving: 'Em resolução',
  resolved: 'Resolvido',
  waiting_confirmation: 'Aguardando confirmação',
  closed: 'Finalizado',
});

export const PRIORITIES = Object.freeze({ low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente' });
export const statusLabel = (status) => Object.hasOwn(STATUSES, status) ? STATUSES[status] : status;
export const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const clone = (value) => structuredClone(value);
const fail = (message) => { throw new Error(message); };
const MS_DAY = 86400000;
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENTS = 10 * 1024 * 1024;
export const ATTACHMENT_TYPES = Object.freeze({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv' });

export function validateUser(user) {
  if (!user || user.active === false) fail('Seu acesso está inativo. Entre em contato com a administração.');
  if (!Array.isArray(user.roles) || user.roles.length < 1 || user.roles.length > 2 || new Set(user.roles).size !== user.roles.length || user.roles.some((r) => !['requester', 'agent', 'director'].includes(r))) fail('O usuário deve ter um ou dois perfis válidos.');
  if (!SECTORS.some((s) => s.id === user.sectorId)) fail('O usuário precisa estar vinculado a um setor válido.');
  if (user.roles.includes('agent') && !SECTORS.find((s) => s.id === user.sectorId).receives) fail('Este setor não recebe chamados.');
  return user;
}

export const isDirector = (user) => !!user && user.active !== false && user.roles?.includes('director');
export const canAttend = (user, ticket) => !!user && user.active !== false && user.roles?.includes('agent') && user.sectorId === ticket.sectorId;
export const canView = (user, ticket) => !!user && user.active !== false && (user.id === ticket.requesterId || canAttend(user, ticket));

export function validateAttachments(attachments = [], previous = []) {
  if (!Array.isArray(attachments) || attachments.length + previous.length > 20) fail('O chamado pode ter até 20 anexos.');
  let total = previous.reduce((sum, attachment) => sum + attachment.size, 0);
  return attachments.map((attachment) => {
    const name = String(attachment.name || '').trim();
    const extension = name.split('.').at(-1).toLowerCase();
    const type = Object.hasOwn(ATTACHMENT_TYPES, extension) ? ATTACHMENT_TYPES[extension] : null;
    const suppliedType = String(attachment.type || '').toLowerCase();
    const size = Number(attachment.size);
    if (!name || name.length > 180 || /[\\/\u0000-\u001f]/.test(name)) fail('O nome de um dos anexos é inválido.');
    if (!type || (suppliedType && suppliedType !== type && suppliedType !== 'application/octet-stream' && !(extension === 'csv' && ['application/vnd.ms-excel', 'application/csv', 'text/comma-separated-values'].includes(suppliedType)))) fail('Esse tipo de arquivo não pode ser anexado. Use PDF, PNG, JPEG, WebP, TXT ou CSV.');
    if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_SIZE) fail('Cada anexo deve ter no máximo 5 MB.');
    if (typeof attachment.data !== 'string' || !/^data:[a-z0-9.+\-/]*;base64,[a-z0-9+/]*={0,2}$/i.test(attachment.data)) fail('Não foi possível ler um dos anexos. Selecione o arquivo novamente.');
    const dataType = attachment.data.slice(5, attachment.data.indexOf(';')).toLowerCase();
    if (dataType && dataType !== type && dataType !== 'application/octet-stream' && !(extension === 'csv' && ['application/vnd.ms-excel', 'application/csv', 'text/comma-separated-values'].includes(dataType))) fail('O formato do conteúdo não corresponde ao tipo de arquivo.');
    const encoded = attachment.data.slice(attachment.data.indexOf(',') + 1);
    if (encoded.length % 4 !== 0) fail('O conteúdo de um dos anexos está incompleto.');
    const actualSize = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (actualSize !== size) fail('O conteúdo de um dos anexos está incompleto.');
    total += size;
    if (total > MAX_TOTAL_ATTACHMENTS) fail('Os anexos do chamado podem somar até 10 MB.');
    return { id: attachment.id || uuid(), name, type, size, data: `data:${type};base64,${encoded}` };
  });
}

function textValue(value, minimum = 1, maximum = 10000) {
  const text = String(value || '').trim();
  if (text.length < minimum) fail('Escreva uma mensagem para continuar.');
  if (text.length > maximum) fail(`O texto deve ter até ${maximum.toLocaleString('pt-BR')} caracteres.`);
  return text;
}

export function createTicket(user, payload, options = {}) {
  validateUser(user);
  if (!SECTORS.some((sector) => sector.id === payload.sectorId && sector.receives)) fail('Selecione um setor que receba chamados.');
  if (!Object.hasOwn(PRIORITIES, payload.priority || 'normal')) fail('Selecione uma prioridade válida.');
  const title = textValue(payload.title, 3, 160);
  const description = textValue(payload.description, 10, 10000);
  const at = options.at || new Date().toISOString();
  const ticket = {
    id: options.id || uuid(), code: options.code || '', title, description,
    priority: payload.priority || 'normal', sectorId: payload.sectorId,
    requesterId: user.id, requesterSectorId: user.sectorId, assignedTo: null,
    status: 'open', createdAt: at, updatedAt: at, firstResponseAt: null,
    resolvedAt: null, closedAt: null, reopenCount: 0,
    attachments: validateAttachments(payload.attachments), events: [],
  };
  for (const [type, text] of [['created', 'Chamado aberto.'], ['forwarded', `Encaminhado para ${SECTORS.find((sector) => sector.id === payload.sectorId).name}.`]]) {
    ticket.events.push({ id: uuid(), type, actorId: user.id, actorName: user.name, at, text, status: 'open' });
  }
  return ticket;
}

export function applyAction(original, user, action, payload = {}, options = {}) {
  validateUser(user);
  if (!canView(user, original)) fail('Você não tem acesso a este chamado.');
  if (original.status === 'closed') fail('Este chamado foi finalizado e não permite novas alterações.');
  const ticket = clone(original);
  const at = options.at || new Date().toISOString();
  const requester = user.id === ticket.requesterId;
  const attendant = canAttend(user, ticket);
  const working = ['in_progress', 'waiting_info', 'third_party', 'resolving'];
  const assigned = () => {
    if (!attendant || ticket.assignedTo !== user.id) fail('Assuma este chamado antes de realizar o atendimento.');
  };
  const inStatus = (...statuses) => { if (!statuses.includes(ticket.status)) fail('Essa ação não está disponível na situação atual do chamado.'); };
  let text = '';
  let meta;
  let firstResponse = false;
  const attachments = validateAttachments(payload.attachments, ticket.attachments);
  if (action !== 'message' && attachments.length) fail('Envie os anexos junto de uma mensagem.');
  switch (action) {
    case 'claim':
      if (!attendant) fail('Somente atendentes do setor responsável podem assumir o chamado.');
      inStatus('open', 'waiting_info', 'in_progress');
      if (ticket.assignedTo && ticket.assignedTo !== user.id) fail('Este chamado já está com outro atendente.');
      if (ticket.status === 'in_progress' && ticket.assignedTo === user.id) fail('Você já está atendendo este chamado.');
      text = ticket.assignedTo ? 'Atendimento retomado.' : 'Chamado recebido e atendimento iniciado.';
      ticket.assignedTo = user.id;
      ticket.status = 'in_progress';
      break;
    case 'request_info':
      assigned(); inStatus('in_progress', 'waiting_info', 'resolving');
      text = textValue(payload.text);
      ticket.status = 'waiting_info'; firstResponse = true;
      break;
    case 'message':
      if (!requester) assigned();
      inStatus('open', ...working, 'resolved', 'waiting_confirmation');
      text = String(payload.text || '').trim();
      if (text.length > 10000) fail('A mensagem deve ter até 10.000 caracteres.');
      if (!text && !attachments.length) fail('Escreva uma mensagem ou selecione um anexo.');
      if (attachments.length) { ticket.attachments.push(...attachments); meta = { attachmentIds: attachments.map((attachment) => attachment.id) }; }
      firstResponse = attendant && !requester;
      break;
    case 'third_party':
      assigned(); inStatus('in_progress', 'resolving');
      text = textValue(payload.text);
      meta = { thirdPartyName: textValue(payload.thirdPartyName, 1, 160) };
      ticket.status = 'third_party'; firstResponse = true;
      break;
    case 'third_party_result':
      assigned(); inStatus('third_party');
      text = textValue(payload.text);
      ticket.status = 'in_progress'; firstResponse = true;
      break;
    case 'start_resolution':
      assigned(); inStatus('in_progress');
      text = 'Resolução em andamento.'; ticket.status = 'resolving';
      break;
    case 'resolve':
      assigned(); inStatus('in_progress', 'resolving');
      text = textValue(payload.text);
      ticket.status = 'resolved'; ticket.resolvedAt = at; firstResponse = true;
      break;
    case 'submit':
      assigned(); inStatus('resolved');
      if (!ticket.resolvedAt || !ticket.events.some((event) => event.type === 'resolve')) fail('Registre a solução antes de solicitar a confirmação.');
      text = 'Atendimento encerrado pelo setor. Aguardando a confirmação do solicitante.';
      ticket.status = 'waiting_confirmation';
      break;
    case 'approve':
      if (!requester) fail('Somente o solicitante pode aprovar a solução.');
      inStatus('waiting_confirmation');
      text = 'Solução aprovada. Chamado finalizado.';
      ticket.status = 'closed'; ticket.closedAt = at;
      break;
    case 'reject':
      if (!requester) fail('Somente o solicitante pode reprovar a solução.');
      inStatus('waiting_confirmation');
      text = textValue(payload.text);
      ticket.status = 'waiting_info'; ticket.resolvedAt = null;
      ticket.reopenCount += 1;
      break;
    default: fail('Ação desconhecida. Atualize a página e tente novamente.');
  }
  if (firstResponse && !ticket.firstResponseAt) ticket.firstResponseAt = at;
  ticket.updatedAt = at;
  ticket.events.push({ id: options.eventId || uuid(), type: action, actorId: user.id, actorName: user.name, at, text, status: ticket.status, ...(meta ? { meta } : {}) });
  return ticket;
}

function dateBounds(from, to) {
  const fromTime = from ? Date.parse(`${from.slice(0, 10)}T00:00:00-03:00`) : -Infinity;
  const toTime = to ? Date.parse(`${to.slice(0, 10)}T23:59:59.999-03:00`) : Infinity;
  if (Number.isNaN(fromTime) || Number.isNaN(toTime) || fromTime > toTime) fail('Selecione um período válido.');
  return [fromTime, toTime];
}

export function computeMetrics(tickets, filters = {}) {
  const [from, to] = dateBounds(filters.from, filters.to);
  const selected = tickets.filter((ticket) => {
    const created = Date.parse(ticket.createdAt);
    return created >= from && created <= to && (!filters.sectorId || filters.sectorId === 'all' || ticket.sectorId === filters.sectorId);
  });
  const mean = (rows, start, end) => {
    const durations = rows.filter((ticket) => ticket[start] && ticket[end]).map((ticket) => Date.parse(ticket[end]) - Date.parse(ticket[start])).filter((duration) => Number.isFinite(duration) && duration >= 0);
    return durations.length ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length) : null;
  };
  const count = (status) => selected.filter((ticket) => ticket.status === status).length;
  const period = new Map();
  for (const ticket of selected) {
    const date = new Date(Date.parse(ticket.createdAt) - 3 * 3600000).toISOString().slice(0, 10);
    period.set(date, (period.get(date) || 0) + 1);
  }
  // Include days with no openings, keeping date-axis spacing truthful.
  if (selected.length) {
    const dates = [...period.keys()].sort();
    const first = filters.from || dates[0];
    const last = filters.to || dates.at(-1);
    const span = Math.min(366, Math.floor((Date.parse(last) - Date.parse(first)) / MS_DAY));
    for (let offset = 0; offset <= span; offset += 1) {
      const date = new Date(Date.parse(first) + offset * MS_DAY).toISOString().slice(0, 10);
      if (!period.has(date)) period.set(date, 0);
    }
  }
  return {
    total: selected.length, open: count('open'),
    inProgress: count('in_progress') + count('resolving') + count('resolved') + count('third_party'),
    waitingInfo: count('waiting_info'), waitingConfirmation: count('waiting_confirmation'), finalized: count('closed'),
    thirdPartyCount: selected.filter((ticket) => ticket.events.some((event) => event.type === 'third_party')).length,
    reopenedCount: selected.filter((ticket) => ticket.reopenCount > 0).length,
    firstResponseMs: mean(selected, 'createdAt', 'firstResponseAt'), resolutionMs: mean(selected, 'createdAt', 'resolvedAt'),
    durationMs: mean(selected.filter((ticket) => ticket.status === 'closed'), 'createdAt', 'closedAt'),
    approvalMs: mean(selected.filter((ticket) => ticket.status === 'closed'), 'resolvedAt', 'closedAt'),
    bySector: SECTORS.filter((sector) => sector.receives).filter((sector) => !filters.sectorId || filters.sectorId === 'all' || sector.id === filters.sectorId).map((sector) => {
      const rows = selected.filter((ticket) => ticket.sectorId === sector.id);
      return { sectorId: sector.id, received: rows.length, finalized: rows.filter((ticket) => ticket.status === 'closed').length, meanServiceMs: mean(rows, 'createdAt', 'resolvedAt') };
    }),
    byPeriod: [...period.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
  };
}
