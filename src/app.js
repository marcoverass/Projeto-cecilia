import { config } from '../config.js';
import { SECTORS, STATUSES, PRIORITIES, canAttend, isDirector } from './core.js';
import { LocalAdapter, DEMO_USERS } from './local.js';
import { icon } from './icons.js';

const $ = (query, root = document) => root.querySelector(query);
const app = $('#app');
const dialogs = $('#dialog-root');
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const hasConnection = Boolean(config.supabaseUrl && config.supabaseAnonKey);
const partialConnection = Boolean(config.supabaseUrl) !== Boolean(config.supabaseAnonKey);
let adapter;
let snapshot = null;
let route = 'overview';
let ticketId = null;
let filter = { tab: 'all', search: '', status: '', sector: '', page: 1 };
let metricFilters = { from: dateKey(new Date(Date.now() - 29 * 86400000)), to: dateKey(new Date()), sectorId: '' };
let metrics = null;
let renderVersion = 0;
let busy = false;
let toastTimer;
let returnFocus;
let selectedFiles = [];
let dialogAction = null;
let refreshing = false;

function dateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const sectorName = (id) => (snapshot?.sectors || SECTORS).find((item) => item.id === id)?.name || 'Setor';
const shortSector = (id) => ({ ti: 'Tecnologia da Informação', financeiro: 'Financeiro', infraestrutura: 'Infraestrutura', fiscal: 'Fiscal e Jurídico', comercial: 'Comercial', servicos: 'Serviços Gerais' })[id] || sectorName(id);
const person = (id) => snapshot?.users.find((item) => item.id === id) || (snapshot?.user.id === id ? snapshot.user : null);
const personName = (id) => person(id)?.name || 'Usuário';
const initials = (name) => String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
const avatar = (name, cls = '') => `<span class="avatar ${cls}" aria-hidden="true">${escape(initials(name))}</span>`;
const status = (value) => `<span class="pill ${Object.hasOwn(STATUSES, value) ? value : ''}">${escape(STATUSES[value] || value)}</span>`;
const formatDate = (value, full = false) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short', ...(full ? { year: 'numeric', hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value)).replace(' de ', ' ') : '—';
const formatTime = (value) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';
function relative(value) {
  const diff = Math.max(0, Date.now() - new Date(value));
  if (diff < 60000) return 'Agora';
  if (diff < 3600000) return `Há ${Math.floor(diff / 60000)} min`;
  if (diff < 86400000) return `Há ${Math.floor(diff / 3600000)} h`;
  if (diff < 7 * 86400000) return `Há ${Math.floor(diff / 86400000)} ${Math.floor(diff / 86400000) === 1 ? 'dia' : 'dias'}`;
  return formatDate(value);
}
function duration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
}
const bytes = (size) => size >= 1048576 ? `${(size / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
const selectOptions = (items, selected, label = '') => `${label ? `<option value="">${escape(label)}</option>` : ''}${items.map(([value, name]) => `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(name)}</option>`).join('')}`;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast-root').innerHTML = `<div class="toast${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">${icon(error ? 'help' : 'circlecheck')}<span>${escape(message)}</span></div>`;
  toastTimer = setTimeout(() => { $('#toast-root').innerHTML = ''; }, error ? 7000 : 4200);
}
function empty(title, description, symbol = 'inbox', action = '') {
  return `<div class="empty">${icon(symbol)}<h3>${escape(title)}</h3><p>${escape(description)}</p>${action}</div>`;
}
function go(next, id = null) {
  const nextHash = next === 'detail' ? `#/ticket/${encodeURIComponent(id)}` : `#/${next}`;
  if (location.hash === nextHash) readRoute(); else location.hash = nextHash;
}
function readRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  ticketId = parts[0] === 'ticket' ? decodeURIComponent(parts[1] || '') : null;
  const next = ticketId ? 'detail' : parts[0] || 'overview';
  if (next !== route) filter = { tab: 'all', search: '', status: '', sector: '', page: 1 };
  route = ['overview', 'tickets', 'sector', 'metrics', 'notifications', 'detail'].includes(next) ? next : 'overview';
  closeDialog(false);
  render();
  if (snapshot) $('#main-content')?.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function ownTickets() { return snapshot.tickets.filter((item) => item.requesterId === snapshot.user.id); }
function sectorTickets() { return snapshot.tickets.filter((item) => canAttend(snapshot.user, item)); }
function unreadCount() { return snapshot.notifications.filter((item) => !item.readAt).length; }
function roleName(user) { return user.roles.includes('director') ? 'Diretoria' : user.roles.includes('agent') ? 'Atendimento' : 'Solicitante'; }

function renderLogin(error = '') {
  const demo = adapter.mode === 'local';
  app.innerHTML = `<main id="main-content" class="login-page">
    <section class="login-story"><div class="brand"><span class="brand-mark">e.</span>entre setores</div>
      <div class="login-copy"><span class="eyebrow">Um espaço para resolver</span><h1>O trabalho flui.<br><span>As soluções também.</span></h1><p>Cada solicitação, conversa e solução. Tudo conectado, do primeiro pedido ao último detalhe.</p>
        <div class="sample-card" aria-hidden="true"><div class="mini-top"><span>SEC · SOLICITAÇÃO INTERNA</span>${icon('inbox')}</div><h3>Ajuste no monitor da sala de reuniões</h3><p>Tecnologia da Informação</p><div class="sample-bottom">${avatar('Rafael Costa')}<span>Solução apresentada</span><span class="pill closed">Resolvido</span></div></div>
      </div><p class="login-footer">Clareza para quem solicita. Contexto para quem resolve.</p>
    </section>
    <section class="login-main"><div class="login-box"><h2>${demo ? 'Conheça seu novo espaço.' : 'Bom ter você por aqui.'}</h2><p class="muted">${demo ? 'Escolha um perfil para explorar os chamados.' : 'Entre para acompanhar suas solicitações.'}</p>
      ${error ? `<div class="error-note" role="alert">${escape(error)}</div>` : ''}
      ${!demo ? `<form class="login-form" data-form="login"><div class="field"><label for="email">E-mail corporativo</label><input id="email" name="email" type="email" autocomplete="username" placeholder="voce@empresa.com.br" required maxlength="254"></div><div class="field"><label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Sua senha" required></div><div class="error-note" data-form-error hidden role="alert"></div><button class="btn primary" type="submit">Entrar no sistema ${icon('arrow')}</button><p class="field-hint">O acesso é fornecido pela administração da sua empresa.</p></form>` : `
      <div class="demo-label">AMBIENTE DE DEMONSTRAÇÃO</div><div class="demo-profiles">${DEMO_USERS.slice(0, 3).map((user) => `<button class="demo-profile" data-demo-user="${user.id}">${avatar(user.name, user.id === 'rafael' ? 'blue' : '')}<div><strong>${escape(user.name)}</strong><small>${escape(roleName(user))} · ${escape(shortSector(user.sectorId))}</small></div>${icon('chevron')}</button>`).join('')}</div><p class="demo-caption">Dados fictícios, salvos somente neste navegador. Você pode alternar entre os perfis para acompanhar o ciclo completo de um chamado.</p>`}
      <div class="login-footnote">${icon('shield')}<span>${demo ? 'O acesso compartilhado com contas reais será habilitado ao conectar o ambiente de produção.' : 'Seu acesso respeita o seu perfil e o setor ao qual você pertence.'}</span></div>
    </div></section>
  </main>`;
}

function navItem(key, label, symbol, count = '') {
  const active = route === key || (route === 'detail' && key === 'tickets');
  return `<button class="nav-item${active ? ' active' : ''}" data-nav="${key}"${active ? ' aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span>${count !== '' ? `<span class="count">${count}</span>` : ''}</button>`;
}
function mobileNav(key, label, symbol) {
  const active = route === key || (route === 'detail' && key === 'tickets');
  return `<button class="mobile-tab${active ? ' active' : ''}" data-nav="${key}"${active ? ' aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></button>`;
}
function render() {
  renderVersion++;
  if (!snapshot) { renderLogin(); return; }
  const user = snapshot.user;
  if (route === 'metrics' && !isDirector(user)) route = 'overview';
  if (route === 'sector' && !user.roles.includes('agent')) route = 'overview';
  const labels = { overview: 'Visão geral', tickets: 'Meus chamados', sector: 'Chamados do setor', metrics: 'Indicadores', notifications: 'Notificações', detail: 'Detalhes do chamado' };
  document.title = `${labels[route]} — ${config.appName}`;
  const ownOpen = ownTickets().filter((item) => item.status !== 'closed').length;
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#/overview" aria-label="Entre setores, visão geral"><span class="brand-mark">e.</span>entre setores</a><p class="workspace-label">Seu espaço de trabalho</p><nav class="sidebar-nav" aria-label="Navegação principal">${navItem('overview', 'Visão geral', 'grid')}${navItem('tickets', 'Meus chamados', 'inbox', ownOpen || '')}${user.roles.includes('agent') ? navItem('sector', 'Chamados do setor', 'message', sectorTickets().filter((item) => item.status === 'open').length || '') : ''}${isDirector(user) ? navItem('metrics', 'Indicadores', 'chart') : ''}<div class="divider"></div>${navItem('notifications', 'Notificações', 'bell', unreadCount() || '')}</nav><div class="sidebar-bottom"><button class="sidebar-help" data-help>${icon('help')}Como funciona</button><button class="sidebar-help" data-profile>${icon('person')}Minha conta</button><div class="mode-note">${adapter.mode === 'local' ? 'Demonstração · dados neste navegador' : 'Ambiente compartilhado'}</div></div></aside>
    <div class="app-main"><header class="topbar"><div class="breadcrumb"><span>Espaço de trabalho</span>${icon('chevron')}<span>${labels[route]}</span></div><a class="brand mobile-brand" href="#/overview"><span class="brand-mark">e.</span>entre setores</a><div class="topbar-actions"><button class="icon-btn" data-nav="notifications" aria-label="Notificações${unreadCount() ? `, ${unreadCount()} não lidas` : ''}">${icon('bell')}${unreadCount() ? '<span class="notification-dot"></span>' : ''}</button><span class="topbar-separator"></span><button class="user-control" data-profile aria-label="Abrir minha conta">${avatar(user.name)}<div><strong>${escape(user.name)}</strong><small>${escape(shortSector(user.sectorId))}</small></div>${icon('down')}</button></div></header><main class="content" id="main-content" tabindex="-1">${renderPage()}</main></div>
    <nav class="mobile-bottom-nav" aria-label="Navegação principal">${mobileNav('overview', 'Visão geral', 'grid')}${mobileNav('tickets', 'Meus chamados', 'inbox')}${user.roles.includes('agent') ? mobileNav('sector', 'Meu setor', 'message') : ''}${isDirector(user) ? mobileNav('metrics', 'Indicadores', 'chart') : ''}${mobileNav('notifications', 'Notificações', 'bell')}</nav></div>`;
  if (route === 'metrics') loadMetrics(renderVersion);
}
function renderPage() {
  if (route === 'overview') return overviewPage();
  if (route === 'tickets' || route === 'sector') return ticketsPage();
  if (route === 'detail') return detailPage();
  if (route === 'notifications') return notificationsPage();
  if (route === 'metrics') return metricsPage();
  return '';
}
function pageHeading(title, subtitle, action = true) {
  return `<div class="page-heading"><div><h1>${escape(title)}</h1><p>${escape(subtitle)}</p></div>${action ? `<button class="btn primary" data-new-ticket>${icon('plus')}Novo chamado</button>` : ''}</div>`;
}
function statCard(label, value, note, symbol = 'inbox', kind = '') {
  return `<div class="stat-card"><div class="stat-top"><span>${escape(label)}</span><span class="stat-icon">${icon(symbol)}</span></div><div class="stat-value">${escape(value)}</div><div class="stat-bottom ${kind}">${escape(note)}</div></div>`;
}
function requestRow(item) {
  return `<button class="request-row" data-ticket="${escape(item.id)}"><span class="request-symbol">${icon(item.status === 'closed' ? 'circlecheck' : 'inbox')}</span><div class="request-body"><h3>${escape(item.title)}</h3><div class="request-sub"><span>${escape(item.code)}</span><i class="dot"></i><span>${escape(shortSector(item.sectorId))}</span></div></div><div class="request-right">${status(item.status)}<span class="request-date">${escape(relative(item.updatedAt))}</span></div>${icon('chevron')}</button>`;
}
function overviewPage() {
  const user = snapshot.user;
  const items = user.roles.includes('agent') ? sectorTickets() : ownTickets();
  const waiting = ownTickets().filter((item) => ['waiting_info', 'waiting_confirmation'].includes(item.status));
  const open = items.filter((item) => item.status !== 'closed');
  const hour = Number(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  return `<div class="greeting">${icon('sun')}${greeting}, ${escape(user.name.split(' ')[0])}</div>${pageHeading('Tudo em seu lugar.', 'Acompanhe as solicitações e dê o próximo passo.')}
    <section class="stats-grid" aria-label="Resumo dos chamados">${statCard('Chamados em aberto', open.length, user.roles.includes('agent') ? 'Destinados ao seu setor' : 'Aguardando a solução final', 'inbox')}${statCard('Em atendimento', items.filter((item) => ['in_progress', 'resolving', 'resolved', 'third_party'].includes(item.status)).length, 'O trabalho está acontecendo', 'clock')}${statCard('Aguardando você', waiting.length, waiting.length ? 'Uma resposta faz a diferença' : 'Tudo em dia por aqui', 'message', waiting.length ? 'attention' : 'good')}${statCard('Finalizados', items.filter((item) => item.status === 'closed').length, 'Soluções aprovadas', 'circlecheck', 'good')}</section>
    <div class="overview-grid"><section class="panel"><div class="panel-head"><div><h2>${user.roles.includes('agent') ? 'Solicitações do seu setor' : 'Suas solicitações recentes'}</h2><p>Cada pedido com o seu próximo passo.</p></div><button class="text-btn panel-heading-link" data-nav="${user.roles.includes('agent') ? 'sector' : 'tickets'}">Ver todos ${icon('arrow')}</button></div><div class="request-list">${items.slice(0, 6).map(requestRow).join('') || empty('Seu espaço está pronto.', 'Abra um chamado quando precisar de outro setor.')}</div><div class="panel-footer">${icon('clock')}Atualizações e conversas ficam registradas no chamado.</div></section>
      <div class="right-stack"><section class="panel attention-card"><div class="attention-top">${icon('clock')}<h2>Sua atenção, por aqui</h2></div><p>${waiting.length ? 'Algumas solicitações precisam de você para continuar.' : 'Nenhuma resposta pendente. Tudo pronto para seguir.'}</p>${waiting.slice(0, 2).map((item) => `<div class="attention-item"><strong>${escape(item.title)}</strong><p>${item.status === 'waiting_confirmation' ? 'O setor apresentou uma solução.' : 'O setor precisa de mais informações.'}</p><button class="btn small" data-ticket="${escape(item.id)}">${item.status === 'waiting_confirmation' ? 'Avaliar solução' : 'Enviar informações'} ${icon('arrow')}</button></div>`).join('')}${waiting.length > 2 ? `<button class="text-btn" data-nav="tickets">Ver ${waiting.length} pendências</button>` : ''}</section>
        <section class="panel quick-guide"><h2>Do pedido à solução.</h2><div class="guide-step"><span class="guide-num">1</span><div><strong>Conte o que você precisa</strong><p>Escolha o setor e dê contexto ao pedido.</p></div></div><div class="guide-step"><span class="guide-num">2</span><div><strong>Converse no próprio chamado</strong><p>Informações e atualizações, sempre juntas.</p></div></div><div class="guide-step"><span class="guide-num">3</span><div><strong>Confirme que deu certo</strong><p>A sua aprovação conclui o atendimento.</p></div></div></section>
      </div></div><div class="section-note"><span>${icon('shield')}Você visualiza os chamados permitidos pelo seu perfil.</span><span>Horários de Brasília</span></div>`;
}

function filteredTickets() {
  let items = route === 'sector' ? sectorTickets() : ownTickets();
  if (filter.tab === 'active') items = items.filter((item) => item.status !== 'closed');
  if (filter.tab === 'waiting') items = items.filter((item) => ['waiting_info', 'waiting_confirmation'].includes(item.status));
  if (filter.tab === 'closed') items = items.filter((item) => item.status === 'closed');
  if (filter.status) items = items.filter((item) => item.status === filter.status);
  if (filter.sector) items = items.filter((item) => item.sectorId === filter.sector);
  if (filter.search) {
    const query = filter.search.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
    items = items.filter((item) => `${item.title} ${item.code} ${item.description}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').includes(query));
  }
  return items;
}
function ticketsPage() {
  return `${pageHeading(route === 'sector' ? 'Chamados do setor' : 'Meus chamados', route === 'sector' ? `As solicitações para ${shortSector(snapshot.user.sectorId)}.` : 'Seus pedidos, do começo ao fim.')}<section class="panel"><div class="list-toolbar"><div class="segmented" aria-label="Filtrar chamados">${[['all', 'Todos'], ['active', 'Em aberto'], ['waiting', 'Aguardando'], ['closed', 'Finalizados']].map(([key, label]) => `<button class="segment${filter.tab === key ? ' active' : ''}" data-tab="${key}" aria-pressed="${filter.tab === key}">${label}</button>`).join('')}</div><div class="search-field">${icon('search')}<input type="search" data-search value="${escape(filter.search)}" placeholder="Buscar chamado" aria-label="Buscar por título, código ou descrição"></div></div><div class="filter-row"><select data-filter="status" aria-label="Filtrar por situação">${selectOptions(Object.entries(STATUSES), filter.status, 'Todas as situações')}</select>${route !== 'sector' ? `<select data-filter="sector" aria-label="Filtrar por setor">${selectOptions(SECTORS.filter((item) => item.receives).map((item) => [item.id, shortSector(item.id)]), filter.sector, 'Todos os setores')}</select>` : ''}<span class="filter-count" data-filter-count></span></div><div id="ticket-results">${ticketResults()}</div></section>`;
}
function ticketResults() {
  const items = filteredTickets();
  const pageCount = Math.max(1, Math.ceil(items.length / 8));
  filter.page = Math.max(1, Math.min(pageCount, filter.page));
  const pageItems = items.slice((filter.page - 1) * 8, filter.page * 8);
  if (!items.length) return empty('Nenhum chamado por aqui.', filter.search || filter.status || filter.sector || filter.tab !== 'all' ? 'Ajuste os filtros ou tente outra busca.' : 'Quando houver uma solicitação, ela aparecerá neste espaço.', 'search', '<button class="btn small" data-new-ticket>Novo chamado</button>');
  return `<table class="ticket-table"><thead><tr><th scope="col">SOLICITAÇÃO</th><th scope="col">SETOR RESPONSÁVEL</th><th scope="col">SITUAÇÃO</th><th scope="col">PRIORIDADE</th></tr></thead><tbody>${pageItems.map((item) => `<tr><td><button class="ticket-title" data-ticket="${escape(item.id)}"><strong>${escape(item.title)}</strong><small>${escape(item.code)} · ${escape(formatDate(item.createdAt))}</small></button></td><td class="sector-text">${escape(shortSector(item.sectorId))}</td><td>${status(item.status)}</td><td><span class="priority ${escape(item.priority)}">${escape(PRIORITIES[item.priority])}</span></td></tr>`).join('')}</tbody></table><div class="table-footer"><span>${items.length} ${items.length === 1 ? 'chamado' : 'chamados'} · página ${filter.page} de ${pageCount}</span><div class="pagination"><button class="icon-btn" data-page="${filter.page - 1}" aria-label="Página anterior"${filter.page <= 1 ? ' disabled' : ''}>${icon('back')}</button><button class="icon-btn" data-page="${filter.page + 1}" aria-label="Próxima página"${filter.page >= pageCount ? ' disabled' : ''}>${icon('arrow')}</button></div></div>`;
}
function updateResults() {
  const el = $('#ticket-results');
  if (el) el.innerHTML = ticketResults();
}

const eventLabels = { created: 'Abertura registrada', forwarded: 'Encaminhamento ao setor', claim: 'Atendimento iniciado', request_info: 'Informações solicitadas', message: 'Mensagem', third_party: 'Terceiro acionado', third_party_result: 'Resultado do terceiro', start_resolution: 'Resolução iniciada', resolve: 'Solução registrada', submit: 'Enviado para sua confirmação', approve: 'Solução aprovada', reject: 'Solução não aprovada' };
function attachmentHTML(files, id) {
  if (!files?.length) return '';
  return `<div class="attachment-list">${files.map((file) => `<button class="attachment" data-download="${escape(file.id)}" data-in-ticket="${escape(id)}">${icon('file')}<span><strong>${escape(file.name)}</strong><small>${escape(bytes(file.size))} · Baixar arquivo</small></span>${icon('download')}</button>`).join('')}</div>`;
}
function detailPage() {
  const ticket = snapshot.tickets.find((item) => item.id === ticketId);
  if (!ticket) return `<button class="back-link" data-nav="tickets">${icon('back')}Meus chamados</button><section class="panel">${empty('Chamado indisponível.', 'Este chamado não está disponível para o seu perfil ou não existe.', 'shield')}</section>`;
  const requester = ticket.requesterId === snapshot.user.id;
  const agent = canAttend(snapshot.user, ticket);
  const assigned = agent && ticket.assignedTo === snapshot.user.id;
  const canMessage = ticket.status !== 'closed' && (requester || assigned);
  const solution = [...ticket.events].reverse().find((event) => event.type === 'resolve');
  const metaRow = (label, value) => `<div class="info-row"><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<button class="back-link" data-nav="${agent && !requester ? 'sector' : 'tickets'}">${icon('back')}${agent && !requester ? 'Chamados do setor' : 'Meus chamados'}</button><div class="detail-heading"><div><span class="detail-code">${escape(ticket.code)}</span><h1>${escape(ticket.title)}</h1><div class="detail-meta-line">${status(ticket.status)}<span class="priority ${escape(ticket.priority)}">Prioridade ${escape(PRIORITIES[ticket.priority]).toLowerCase()}</span></div></div></div>
    <div class="detail-grid"><div class="detail-main-stack"><section class="panel detail-section"><h2>Sobre a solicitação</h2><p class="prose">${escape(ticket.description)}</p>${attachmentHTML(ticket.attachments, ticket.id)}${solution && ['resolved', 'waiting_confirmation', 'closed'].includes(ticket.status) ? `<div class="resolution-box"><strong>Solução apresentada</strong><br>${escape(solution.text)}</div>` : ''}</section><section class="panel"><div class="conversation-head"><h2>Conversa e histórico</h2><small>${ticket.events.length} registros</small></div><div class="timeline">${ticket.events.map((event) => {
      const isMessage = ['message', 'request_info', 'resolve', 'reject', 'third_party_result', 'third_party'].includes(event.type);
      const own = event.actorId === snapshot.user.id;
      const eventFiles = (event.meta?.attachmentIds || []).map((id) => ticket.attachments.find((file) => file.id === id)).filter(Boolean);
      return `<article class="timeline-event${isMessage ? ' message' : ''}${own ? ' own' : ''}">${isMessage ? avatar(event.actorName, own ? 'blue' : '') : `<span class="event-marker">${icon(event.type === 'approve' ? 'check' : event.type === 'claim' ? 'person' : 'clock')}</span>`}<div class="event-content"><div class="event-head"><strong>${escape(isMessage ? event.actorName : eventLabels[event.type] || 'Atualização registrada')}</strong><time datetime="${escape(event.at)}" title="${escape(formatDate(event.at, true))}">${escape(formatDate(event.at))} · ${escape(formatTime(event.at))}</time></div>${isMessage ? `<p>${escape(event.text)}</p>${event.meta?.thirdPartyName ? `<p>Terceiro: ${escape(event.meta.thirdPartyName)}</p>` : ''}<span class="event-status">${escape(eventLabels[event.type] || 'Atualização')}</span>` : `<p>${escape(event.actorName)} · ${escape(event.text)}</p>`}${attachmentHTML(eventFiles, ticket.id)}</div></article>`;
    }).join('')}</div>${canMessage ? `<form class="composer" data-form="message" data-ticket-id="${escape(ticket.id)}"><label for="message-text" class="field-label">${ticket.status === 'waiting_info' && requester ? 'Envie as informações solicitadas' : 'Uma nova mensagem'}</label><textarea id="message-text" name="text" placeholder="Escreva sua mensagem…" maxlength="10000" rows="3"></textarea><div class="file-preview" data-message-files></div><div class="error-note" data-form-error hidden role="alert"></div><div class="composer-bottom"><label class="icon-btn" aria-label="Anexar arquivos à mensagem" title="Anexar arquivos">${icon('attach')}<input class="visually-hidden" type="file" data-message-upload multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv"></label><span>A conversa fica salva no histórico.</span><button class="btn primary small" type="submit">Enviar ${icon('arrow')}</button></div></form>` : ticket.status === 'closed' ? `<div class="closed-note">${icon('circlecheck')}<span>Solução aprovada. Este chamado foi finalizado em ${escape(formatDate(ticket.closedAt, true))} e seu histórico está preservado.</span></div>` : `<div class="panel-footer">${icon('shield')}Assuma o atendimento para participar da conversa.</div>`}</section></div>
    <div class="right-stack"><section class="panel action-card"><h2>${ticket.status === 'closed' ? 'Atendimento concluído' : 'Próximo passo'}</h2>${actionPanel(ticket, requester, agent, assigned)}</section><section class="panel detail-info"><h2>Informações do chamado</h2><dl>${metaRow('Solicitante', `${avatar(personName(ticket.requesterId))} ${escape(personName(ticket.requesterId))}`)}${metaRow('Setor solicitante', escape(sectorName(ticket.requesterSectorId)))}${metaRow('Setor responsável', escape(sectorName(ticket.sectorId)))}${metaRow('Atendente', ticket.assignedTo ? escape(personName(ticket.assignedTo)) : 'Aguardando atendimento')}${metaRow('Aberto em', escape(formatDate(ticket.createdAt, true)))}${metaRow('Última atualização', escape(formatDate(ticket.updatedAt, true)))}${ticket.closedAt ? metaRow('Duração total', duration(new Date(ticket.closedAt) - new Date(ticket.createdAt))) : ''}${ticket.reopenCount ? metaRow('Retornos ao atendimento', ticket.reopenCount) : ''}</dl></section></div></div>`;
}
function actionPanel(ticket, requester, agent, assigned) {
  const button = (action, label, primary = false) => `<button class="btn${primary ? ' primary' : ''}" data-action="${action}" data-ticket-id="${escape(ticket.id)}">${label}</button>`;
  if (ticket.status === 'closed') return `<p>A solução foi confirmada pelo solicitante. O histórico permanece disponível para consulta.</p>${status('closed')}`;
  if (requester && ticket.status === 'waiting_confirmation') return `<p>A solução atendeu ao seu pedido? Sua confirmação finaliza o chamado.</p><div class="action-stack">${button('approve', `${icon('check')}Aprovar solução`, true)}${button('reject', 'Preciso de outro ajuste')}</div>`;
  if (agent && !ticket.assignedTo) return `<p>O chamado está disponível para o seu setor. Assuma para iniciar o atendimento.</p><div class="action-stack">${button('claim', 'Assumir atendimento', true)}</div>`;
  if (assigned) {
    let actions = '';
    if (ticket.status === 'waiting_info') actions = button('claim', 'Retomar atendimento', true) + button('request_info', 'Pedir outras informações');
    if (ticket.status === 'third_party') actions = button('third_party_result', 'Registrar resultado do terceiro', true);
    if (ticket.status === 'resolved') actions = button('submit', 'Enviar para confirmação', true);
    if (ticket.status === 'in_progress') actions = button('start_resolution', 'Iniciar resolução', true) + button('request_info', 'Pedir mais informações') + button('third_party', 'Registrar acionamento de terceiro') + button('resolve', 'Registrar solução');
    if (ticket.status === 'resolving') actions = button('resolve', 'Registrar solução', true) + button('request_info', 'Pedir mais informações') + button('third_party', 'Registrar acionamento de terceiro');
    const notes = { waiting_info: 'Aguarde as informações do solicitante. Quando forem suficientes, retome o atendimento.', third_party: 'O contato com o terceiro acontece fora do sistema. Registre o resultado quando ele retornar.', resolved: 'A solução foi registrada. Envie o chamado para que o solicitante confirme.', waiting_confirmation: 'O solicitante foi notificado e precisa avaliar a solução para concluir o chamado.', in_progress: 'Mantenha o solicitante informado e registre os próximos passos.', resolving: 'Descreva a solução aplicada antes de encaminhar para confirmação.' };
    return `<p>${notes[ticket.status] || 'Acompanhe o histórico do atendimento.'}</p><div class="action-stack">${actions}</div>`;
  }
  if (requester && ticket.status === 'waiting_info') return '<p>O setor precisa de mais informações. Responda na conversa para que o atendimento possa continuar.</p><button class="btn" data-focus-message>Responder na conversa</button>';
  return `<p>${agent ? 'Este chamado está com outro atendente do seu setor. Acompanhe as atualizações pelo histórico.' : 'O setor responsável está acompanhando seu pedido. Use a conversa para complementar as informações.'}</p>${requester ? '<button class="btn" data-focus-message>Abrir conversa</button>' : ''}`;
}

function notificationsPage() {
  return `${pageHeading('Notificações', 'As atualizações que precisam chegar até você.', false)}<section class="panel"><div class="panel-head"><div><h2>${unreadCount() ? `${unreadCount()} ${unreadCount() === 1 ? 'atualização não lida' : 'atualizações não lidas'}` : 'Tudo em dia'}</h2><p>Informações sobre os seus chamados e atendimentos.</p></div><button class="text-btn" data-mark-all${unreadCount() ? '' : ' disabled'}>Marcar todas como lidas</button></div>${snapshot.notifications.length ? snapshot.notifications.map((item) => `<article class="notification-item${!item.readAt ? ' unread' : ''}"><span class="request-symbol">${icon('bell')}</span><div><h3>${!item.readAt ? '<span class="unread-dot"></span>' : ''}${escape(item.title)}</h3><p>${escape(item.body)}</p><time datetime="${escape(item.createdAt)}">${escape(formatDate(item.createdAt, true))}</time></div><button class="btn small" data-open-notification="${escape(item.id)}" data-ticket-id="${escape(item.ticketId)}">Ver chamado ${icon('arrow')}</button></article>`).join('') : empty('Nenhuma atualização por enquanto.', 'Quando houver uma novidade nos seus chamados, você encontra aqui.', 'bell')}</section>`;
}

function metricsPage() {
  return `${pageHeading('Indicadores', 'Uma visão do trabalho entre os setores.', false)}<form class="metrics-toolbar" data-form="metrics"><div class="field"><label for="metric-from">Data inicial</label><input id="metric-from" name="from" type="date" value="${escape(metricFilters.from)}" required></div><div class="field"><label for="metric-to">Data final</label><input id="metric-to" name="to" type="date" value="${escape(metricFilters.to)}" required></div><div class="field"><label for="metric-sector">Setor responsável</label><select id="metric-sector" name="sectorId">${selectOptions(SECTORS.filter((item) => item.receives).map((item) => [item.id, shortSector(item.id)]), metricFilters.sectorId, 'Todos os setores')}</select></div><button class="btn" type="submit">${icon('filter')}Aplicar filtros</button></form><div id="metrics-results" aria-live="polite"><div class="page-loading">Calculando os indicadores…</div></div>`;
}
async function loadMetrics(version) {
  try {
    const data = await adapter.metrics(metricFilters);
    if (version !== renderVersion || route !== 'metrics' || !snapshot) return;
    metrics = data;
    $('#metrics-results').innerHTML = metricsResults(data);
  } catch (error) {
    if (version === renderVersion && $('#metrics-results')) $('#metrics-results').innerHTML = `<div class="error-note" role="alert">${escape(error.message)}</div>`;
  }
}
function metricsResults(data) {
  const sectors = data.bySector || [];
  const max = Math.max(1, ...sectors.map((item) => item.received));
  const periods = data.byPeriod || [];
  const peak = Math.max(1, ...periods.map((item) => item.count));
  const displayed = periods.length > 14 ? periods.filter((_, index) => index % Math.ceil(periods.length / 14) === 0).map((entry, index) => ({ ...entry, count: periods.slice(index * Math.ceil(periods.length / 14), (index + 1) * Math.ceil(periods.length / 14)).reduce((sum, item) => sum + item.count, 0) })) : periods;
  const displayPeak = Math.max(peak, ...displayed.map((item) => item.count));
  const trend = displayed.length ? `<svg class="trend-svg" viewBox="0 0 520 185" role="img" aria-label="Volume de chamados por período">${displayed.map((item, index) => { const space = 500 / displayed.length; const height = 125 * item.count / displayPeak; return `<g><rect x="${10 + index * space}" y="${150 - height}" width="${Math.max(4, space - 13)}" height="${height || 1}" rx="3" fill="#96afd2"/><text x="${10 + index * space + (space - 13) / 2}" y="${Math.max(13, 141 - height)}" text-anchor="middle" fill="#92929f" font-size="10">${item.count}</text><text x="${10 + index * space + (space - 13) / 2}" y="173" text-anchor="middle" fill="#a2a2ad" font-size="8">${escape(String(item.date).slice(5).split('-').reverse().join('/'))}</text></g>`; }).join('')}</svg>` : empty('Ainda sem dados.', 'Os chamados do período aparecerão aqui.', 'chart');
  return `<section class="stats-grid" aria-label="Indicadores do período">${statCard('Chamados recebidos', data.total, 'Abertos no período selecionado', 'inbox')}${statCard('Em andamento', Math.max(0, data.total - data.finalized), 'Ainda sem fechamento definitivo', 'clock')}${statCard('Aguardando confirmação', data.waitingConfirmation, 'Solução em avaliação', 'message')}${statCard('Finalizados', data.finalized, 'Aprovados pelo solicitante', 'circlecheck', 'good')}</section><section class="metric-secondary" aria-label="Tempos médios">${statCard('Primeira resposta', duration(data.firstResponseMs), 'Da abertura à primeira resposta')}${statCard('Tempo de resolução', duration(data.resolutionMs), 'Da abertura à solução registrada')}${statCard('Duração total', duration(data.durationMs), 'Da abertura à aprovação')}${statCard('Espera pela aprovação', duration(data.approvalMs), 'Da solução à aprovação')}${statCard('Acionamento de terceiros', data.thirdPartyCount, 'Chamados com participação externa')}${statCard('Retornos ao atendimento', data.reopenedCount, 'Chamados com solução não aprovada')}</section><div class="metrics-grid"><section class="panel"><div class="panel-head"><div><h2>Chamados por setor</h2><p>Volume recebido no período.</p></div></div><div class="chart-area">${sectors.filter((item) => item.received > 0).map((item) => `<div class="bar-row"><span class="bar-label" title="${escape(sectorName(item.sectorId))}">${escape(shortSector(item.sectorId))}</span><meter class="bar-meter" min="0" max="${max}" value="${item.received}" aria-label="${escape(sectorName(item.sectorId))}: ${item.received} chamados">${item.received}</meter><span class="bar-value">${item.received}</span></div>`).join('') || empty('Sem chamados no período.', 'Selecione outra data para consultar os registros.', 'chart')}</div></section><section class="panel"><div class="panel-head"><div><h2>Evolução das solicitações</h2><p>${displayed.length < periods.length ? 'Volume agrupado em intervalos do período.' : 'Volume por data de abertura.'}</p></div></div><div class="chart-area">${trend}</div></section></div><section class="panel"><div class="panel-head"><div><h2>Atendimento por setor</h2><p>Os resultados refletem os eventos registrados nos chamados.</p></div></div><div class="table-overflow"><table class="metric-table"><thead><tr><th scope="col">SETOR</th><th scope="col">RECEBIDOS</th><th scope="col">FINALIZADOS</th><th scope="col">RESOLUÇÃO MÉDIA</th></tr></thead><tbody>${sectors.filter((item) => item.received > 0).map((item) => `<tr><td>${escape(shortSector(item.sectorId))}</td><td>${item.received}</td><td>${item.finalized}</td><td>${duration(item.meanServiceMs)}</td></tr>`).join('') || '<tr><td colspan="4">Nenhum chamado encontrado no período.</td></tr>'}</tbody></table></div></section><p class="metrics-note">${icon('help')}Período aplicado à data de abertura, em Brasília. Tempos em horas corridas. As médias consideram apenas registros com os eventos necessários. A duração total termina na aprovação do solicitante.</p><p class="metrics-note">${icon('shield')}Indicadores consolidados exclusivos da diretoria. ${data.open} abertos · ${data.inProgress} em atendimento · ${data.waitingInfo} aguardando informações.</p>`;
}

function openDialog(title, subtitle, body, compact = false) {
  returnFocus = document.activeElement;
  dialogs.innerHTML = `<div class="dialog-scrim" data-scrim><section class="dialog${compact ? ' compact' : ''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description"><div class="dialog-header"><div><h2 id="dialog-title">${escape(title)}</h2><p id="dialog-description">${escape(subtitle)}</p></div><button class="icon-btn" data-close-dialog aria-label="Fechar">${icon('close')}</button></div><div class="dialog-body">${body}</div></section></div>`;
  document.body.classList.add('dialog-open');
  queueMicrotask(() => ($('input:not([type=file]),textarea,select', dialogs) || $('button', dialogs))?.focus());
}
function closeDialog(focus = true) {
  if (!dialogs.firstChild) return;
  dialogs.innerHTML = '';
  document.body.classList.remove('dialog-open');
  selectedFiles = [];
  dialogAction = null;
  if (focus && returnFocus?.isConnected) returnFocus.focus();
}
function newTicketDialog() {
  selectedFiles = [];
  openDialog('Um novo chamado.', 'Conte o que você precisa. O setor responsável cuida do próximo passo.', `<form data-form="new-ticket" class="dialog-form"><div class="info-note">${escape(snapshot.user.name)} · ${escape(sectorName(snapshot.user.sectorId))}</div><div class="field"><label for="new-title">Título da solicitação</label><input id="new-title" name="title" required minlength="3" maxlength="160" placeholder="Ex.: Acesso à pasta compartilhada" autofocus></div><div class="field-row"><div class="field"><label for="new-sector">Setor responsável</label><select id="new-sector" name="sectorId" required>${selectOptions(SECTORS.filter((item) => item.receives).map((item) => [item.id, item.name]), '', 'Selecione o setor')}</select></div><div class="field"><label for="new-priority">Prioridade</label><select id="new-priority" name="priority">${selectOptions(Object.entries(PRIORITIES), 'normal')}</select></div></div><div class="field"><label for="new-description">O que você precisa?</label><textarea id="new-description" name="description" minlength="10" maxlength="10000" required placeholder="Descreva a situação e inclua as informações que podem ajudar no atendimento." rows="4"></textarea><span class="field-hint">Quanto mais contexto, mais fácil dar o próximo passo.</span></div><div class="field"><label>Anexos <span class="required">· opcional</span></label><label class="upload-zone">${icon('attach')}Escolher arquivos<input type="file" data-upload multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv" aria-label="Escolher anexos"></label><span class="field-hint">PDF, imagens, TXT ou CSV. Até 5 MB por arquivo e 10 MB por chamado.</span><div class="file-preview" data-files></div></div><div class="error-note" data-form-error hidden role="alert"></div><div class="dialog-footer"><button type="button" class="btn" data-close-dialog>Cancelar</button><button type="submit" class="btn primary">Abrir chamado ${icon('arrow')}</button></div></form>`);
}
const actionCopy = {
  claim: ['Assumir atendimento', 'Você ficará responsável por acompanhar esta solicitação.'],
  request_info: ['Pedir mais informações', 'Explique quais informações são necessárias para continuar.'],
  third_party: ['Registrar acionamento de terceiro', 'O contato acontece fora do sistema. O solicitante será informado.'],
  third_party_result: ['Resultado do terceiro', 'Registre o que foi feito. O chamado volta ao atendimento.'],
  start_resolution: ['Iniciar resolução', 'O chamado passa para a etapa de resolução.'],
  resolve: ['Registrar solução', 'Descreva o que foi feito para resolver a solicitação.'],
  submit: ['Enviar para confirmação', 'O solicitante receberá a solução para aprovar ou pedir outro ajuste.'],
  approve: ['Aprovar solução', 'Ao confirmar, o chamado será finalizado e o histórico ficará disponível para consulta.'],
  reject: ['O que ainda precisa de ajuste?', 'Explique o motivo. O chamado voltará para o setor responsável.'],
};
async function performAction(id, action, trigger) {
  if (['claim', 'start_resolution', 'submit'].includes(action)) {
    await mutate(() => adapter.act(id, action, {}), action === 'claim' ? 'Atendimento assumido.' : action === 'submit' ? 'Solução enviada para confirmação.' : 'Resolução iniciada.', trigger);
    return;
  }
  dialogAction = { id, action };
  const [title, subtitle] = actionCopy[action];
  const isApproval = action === 'approve';
  openDialog(title, subtitle, `<form data-form="action" class="dialog-form">${action === 'third_party' ? '<div class="field"><label for="third-party-name">Terceiro acionado</label><input id="third-party-name" name="thirdPartyName" maxlength="160" required placeholder="Nome da empresa ou profissional"></div>' : ''}${!isApproval ? `<div class="field"><label for="action-text">${action === 'reject' ? 'Motivo da não aprovação' : action === 'resolve' ? 'Solução aplicada' : 'Informações do atendimento'}</label><textarea id="action-text" name="text" required maxlength="10000" rows="5" placeholder="${action === 'reject' ? 'Descreva o que ainda precisa ser resolvido…' : 'Descreva os detalhes…'}"></textarea></div>` : '<div class="info-note">A duração total do chamado será calculada até este momento.</div>'}<div class="error-note" data-form-error hidden role="alert"></div><div class="dialog-footer"><button type="button" class="btn" data-close-dialog>Voltar</button><button type="submit" class="btn primary">${isApproval ? 'Aprovar e finalizar' : action === 'reject' ? 'Enviar para o setor' : 'Salvar registro'} ${icon(isApproval ? 'check' : 'arrow')}</button></div></form>`, isApproval);
  dialogAction = { id, action };
}
function profileDialog() {
  const user = snapshot.user;
  openDialog('Minha conta', 'Seu perfil e acesso ao espaço de trabalho.', `<div class="profile-current">${avatar(user.name, 'large')}<div><strong>${escape(user.name)}</strong><small>${escape(user.email || roleName(user))}</small></div></div><div class="info-note">${escape(sectorName(user.sectorId))} · ${escape(roleName(user))}</div>${adapter.mode === 'local' ? `<div class="divider"></div><h3>Explorar outro perfil</h3><p class="field-hint">Troque de pessoa para testar o atendimento entre os setores.</p><div class="profile-list">${DEMO_USERS.filter((item) => item.id !== user.id).map((item) => `<button class="demo-profile" data-demo-user="${item.id}">${avatar(item.name)}<div><strong>${escape(item.name)}</strong><small>${escape(roleName(item))} · ${escape(shortSector(item.sectorId))}</small></div>${icon('chevron')}</button>`).join('')}</div>` : '<p class="field-hint">Para alterar seu nome, setor ou permissões, fale com a administração da empresa.</p>'}<div class="dialog-footer"><button class="btn" data-logout>${icon('logout')}Sair da conta</button></div>`, true);
}
function helpDialog() {
  openDialog('Cada chamado, um caminho claro.', 'Do pedido à confirmação de que tudo deu certo.', `<div class="help-content"><h3>Abra uma solicitação</h3><p>Escolha o setor responsável, dê um título e descreva o que precisa. Você pode ter vários chamados abertos ao mesmo tempo.</p><h3>Acompanhe e converse</h3><p>As mensagens, os anexos e as mudanças de situação ficam registrados no chamado, com autor, data e horário. Quando o setor pedir mais informações, responda na conversa.</p><h3>Confirme a solução</h3><p>Depois de receber a solução, aprove para finalizar ou explique o que ainda precisa de ajuste. O chamado só termina com a aprovação do solicitante.</p><h3>Quando um terceiro participa</h3><p>O setor registra o acionamento e o resultado no histórico. O contato com o terceiro acontece fora do sistema.</p><h3>O que você pode acessar</h3><p>Solicitantes acompanham seus próprios chamados. Atendentes também recebem os chamados do seu setor. A diretoria consulta os indicadores consolidados.</p>${adapter.mode === 'local' ? '<h3>Sobre esta demonstração</h3><p>Os dados são fictícios e ficam neste navegador. As contas reais e o compartilhamento entre computadores dependem da configuração do ambiente de produção, descrita na documentação do projeto.</p>' : ''}</div>`);
}

async function mutate(operation, success, trigger = null, form = null) {
  if (busy) return false;
  busy = true;
  const original = trigger?.innerHTML;
  if (trigger) { trigger.disabled = true; trigger.setAttribute('aria-busy', 'true'); }
  const errorBox = form && $('[data-form-error]', form);
  if (errorBox) errorBox.hidden = true;
  try {
    snapshot = await operation();
    metrics = null;
    closeDialog(false);
    render();
    if (success) toast(success);
    return true;
  } catch (error) {
    if (errorBox?.isConnected) { errorBox.textContent = error.message; errorBox.hidden = false; }
    else toast(error.message || 'Não foi possível salvar. Tente novamente.', true);
    return false;
  } finally {
    busy = false;
    if (trigger?.isConnected) { trigger.disabled = false; trigger.removeAttribute('aria-busy'); trigger.innerHTML = original; }
  }
}
async function filesToAttachments(files) {
  let total = 0;
  const types = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv' };
  const result = [];
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!types[ext]) throw new Error('Selecione arquivos PDF, PNG, JPG, WEBP, TXT ou CSV.');
    if (file.size > 5 * 1048576) throw new Error(`${file.name}: o limite por arquivo é 5 MB.`);
    total += file.size;
    if (total > 10 * 1048576) throw new Error('Os anexos podem somar até 10 MB.');
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Não foi possível ler o arquivo. Selecione-o novamente.')); reader.readAsDataURL(new Blob([file], { type: types[ext] })); });
    result.push({ id: crypto.randomUUID(), name: file.name, size: file.size, type: types[ext], data });
  }
  return result;
}
function renderFiles() {
  const box = $('[data-files]', dialogs);
  if (box) box.innerHTML = selectedFiles.map((file, index) => `<div class="file-chip">${icon('file')}<span>${escape(file.name)} · ${escape(bytes(file.size))}</span><button type="button" class="icon-btn" data-remove-file="${index}" aria-label="Remover ${escape(file.name)}">${icon('close')}</button></div>`).join('');
}
async function downloadFile(id, fileId) {
  const ticket = snapshot.tickets.find((item) => item.id === id);
  const file = ticket?.attachments.find((item) => item.id === fileId) || ticket?.events.flatMap((event) => event.meta?.attachments || []).find((item) => item.id === fileId);
  if (!file) { toast('Arquivo indisponível para este chamado.', true); return; }
  try {
    const data = adapter.downloadAttachment ? await adapter.downloadAttachment(id, file) : file.data;
    if (!/^data:[a-z0-9.+\-/]*;base64,/i.test(data)) throw new Error('O arquivo não está disponível.');
    const raw = atob(data.split(',')[1]);
    const blob = new Blob([Uint8Array.from(raw, (char) => char.charCodeAt(0))], { type: file.type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) { toast(error.message, true); }
}

document.addEventListener('click', async (event) => {
  const el = event.target.closest('button,a,[data-scrim]');
  if (!el || el.disabled) return;
  if (el.matches('[data-scrim]') && event.target !== el) return;
  if (el.hasAttribute('data-close-dialog') || el.hasAttribute('data-scrim')) { closeDialog(); return; }
  if (el.hasAttribute('data-nav')) { go(el.dataset.nav); return; }
  if (el.hasAttribute('data-demo-user')) {
    const ok = await mutate(() => adapter.demoLogin(el.dataset.demoUser), '', el);
    if (ok) { filter = { tab: 'all', search: '', status: '', sector: '', page: 1 }; go('overview'); }
    return;
  }
  if (!snapshot) return;
  if (el.hasAttribute('data-new-ticket')) { newTicketDialog(); return; }
  if (el.hasAttribute('data-ticket')) { go('detail', el.dataset.ticket); return; }
  if (el.hasAttribute('data-tab')) { filter.tab = el.dataset.tab; filter.page = 1; render(); return; }
  if (el.hasAttribute('data-page')) { filter.page = Number(el.dataset.page); updateResults(); return; }
  if (el.hasAttribute('data-profile')) { profileDialog(); return; }
  if (el.hasAttribute('data-help')) { helpDialog(); return; }
  if (el.hasAttribute('data-logout')) {
    if (busy) return;
    try { await adapter.logout(); snapshot = null; closeDialog(false); location.hash = '#/overview'; renderLogin(); } catch (error) { toast(error.message, true); }
    return;
  }
  if (el.hasAttribute('data-action')) { await performAction(el.dataset.ticketId, el.dataset.action, el); return; }
  if (el.hasAttribute('data-focus-message')) { $('#message-text')?.focus(); $('#message-text')?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); return; }
  if (el.hasAttribute('data-remove-file')) { selectedFiles.splice(Number(el.dataset.removeFile), 1); renderFiles(); return; }
  if (el.hasAttribute('data-mark-all')) { await mutate(() => adapter.markRead(null), 'Notificações marcadas como lidas.', el); return; }
  if (el.hasAttribute('data-open-notification')) {
    const ok = await mutate(() => adapter.markRead(el.dataset.openNotification), '', el);
    if (ok) go('detail', el.dataset.ticketId);
    return;
  }
  if (el.hasAttribute('data-download')) { await downloadFile(el.dataset.inTicket, el.dataset.download); }
});
document.addEventListener('input', (event) => {
  if (event.target.matches('[data-search]')) { filter.search = event.target.value; filter.page = 1; updateResults(); }
});
document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.matches('[data-filter]')) { filter[el.dataset.filter] = el.value; filter.page = 1; updateResults(); }
  if (el.matches('[data-upload]')) {
    selectedFiles = [...selectedFiles, ...el.files];
    renderFiles(); el.value = '';
  }
  if (el.matches('[data-message-upload]')) {
    const box = $('[data-message-files]', el.closest('form'));
    box.textContent = [...el.files].map((file) => `${file.name} · ${bytes(file.size)}`).join(' / ');
  }
});
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (!form.reportValidity() || busy) return;
  const values = Object.fromEntries(new FormData(form));
  const trigger = $('button[type=submit]', form);
  if (form.dataset.form === 'metrics') {
    if (values.from > values.to) { toast('A data inicial precisa ser anterior à data final.', true); return; }
    metricFilters = { from: values.from, to: values.to, sectorId: values.sectorId };
    render(); return;
  }
  if (form.dataset.form === 'login') {
    const ok = await mutate(() => adapter.login(values.email.trim(), values.password), '', trigger, form);
    if (ok) go('overview');
  }
  if (form.dataset.form === 'new-ticket') {
    const previousIds = new Set(snapshot.tickets.map((item) => item.id));
    const ok = await mutate(async () => adapter.createTicket({ title: values.title.trim(), description: values.description.trim(), sectorId: values.sectorId, priority: values.priority, attachments: await filesToAttachments(selectedFiles) }), 'Chamado aberto e encaminhado ao setor.', trigger, form);
    if (ok) { const created = snapshot.tickets.find((item) => !previousIds.has(item.id)); if (created) go('detail', created.id); }
  }
  if (form.dataset.form === 'message') {
    const files = [...($('[data-message-upload]', form)?.files || [])];
    await mutate(async () => adapter.act(form.dataset.ticketId, 'message', { text: values.text.trim(), attachments: await filesToAttachments(files) }), 'Mensagem enviada.', trigger, form);
  }
  if (form.dataset.form === 'action' && dialogAction) {
    const { id, action } = dialogAction;
    await mutate(() => adapter.act(id, action, { text: (values.text || '').trim(), thirdPartyName: (values.thirdPartyName || '').trim() }), action === 'approve' ? 'Solução aprovada. Chamado finalizado.' : action === 'reject' ? 'Seu pedido de ajuste foi enviado ao setor.' : 'Registro salvo no histórico.', trigger, form);
  }
});
document.addEventListener('keydown', (event) => {
  if (!dialogs.firstChild) return;
  if (event.key === 'Escape' && !busy) { event.preventDefault(); closeDialog(); }
  if (event.key === 'Tab') {
    const focusable = [...dialogs.querySelectorAll('button:not(:disabled),a[href],input:not([type=file]),textarea,select')].filter((el) => !el.hidden);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
window.addEventListener('hashchange', readRoute);
async function refresh() {
  if (!snapshot || busy || refreshing || document.hidden || dialogs.firstChild || $('[data-form="message"] textarea')?.value || $('[data-message-upload]')?.files.length) return;
  refreshing = true;
  try {
    const next = await adapter.snapshot();
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; render(); }
  } catch (error) { toast(error.message || 'Não foi possível atualizar os chamados.', true); }
  finally { refreshing = false; }
}
window.addEventListener('storage', (event) => { if (adapter.mode === 'local' && event.key?.includes('solicitacoes-internas.demo')) refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

async function init() {
  if (partialConnection || (!hasConnection && !config.allowDemo)) {
    app.innerHTML = `<main id="main-content" class="boot"><span class="boot-mark">e.</span><h2>Ambiente aguardando configuração.</h2><p>Preencha a URL e a chave pública do Supabase em config.js.</p></main>`;
    return;
  }
  try {
    adapter = hasConnection ? new (await import('./remote.js')).RemoteAdapter(config) : new LocalAdapter();
    snapshot = await adapter.init();
    if (adapter.mode === 'cloud') setInterval(refresh, 30000);
    readRoute();
  } catch (error) {
    app.innerHTML = `<main id="main-content" class="boot"><span class="boot-mark">e.</span><h2>Não foi possível abrir seu espaço.</h2><p class="error-note">${escape(error.message)}</p><button class="btn" data-reload>Tentar novamente</button></main>`;
    $('[data-reload]')?.addEventListener('click', () => location.reload());
  }
}
init();
