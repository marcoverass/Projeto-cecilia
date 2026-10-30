import { applyAction, canAttend, canView, computeMetrics, createTicket, isDirector, uuid, validateUser } from './core.js';
import { createSeed, DEMO_USERS } from './seed.js';

export { DEMO_USERS } from './seed.js';
export const LOCAL_DATA_KEY = 'solicitacoes-internas.demo.v1';
const SESSION_KEY = 'solicitacoes-internas.demo.user';

export class LocalAdapter {
  mode = 'local';
  constructor({ storage = globalThis.localStorage, session = globalThis.sessionStorage } = {}) {
    this.storage = storage;
    this.session = session;
    this.userId = null;
    this.data = null;
  }

  _load() {
    const raw = this.storage.getItem(LOCAL_DATA_KEY);
    if (raw === null) {
      this.data = createSeed();
      this._persist(this.data);
      return;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('Os dados de demonstração deste navegador não puderam ser lidos. Limpe os dados deste site para reiniciar a demonstração.'); }
    if (parsed.version !== 1 || !Array.isArray(parsed.users) || !Array.isArray(parsed.tickets) || !Array.isArray(parsed.notifications)) throw new Error('O formato dos dados locais não é compatível com esta versão.');
    this.data = parsed;
  }

  _persist(data) {
    try { this.storage.setItem(LOCAL_DATA_KEY, JSON.stringify(data)); }
    catch { throw new Error('O navegador não conseguiu guardar a alteração. Libere espaço ou reduza os anexos e tente novamente. Nenhuma alteração foi salva.'); }
  }

  _user() {
    const user = this.data?.users.find((person) => person.id === this.userId);
    if (!user) throw new Error('Entre novamente para continuar.');
    return validateUser(user);
  }

  async init() {
    this._load();
    this.userId = this.session.getItem(SESSION_KEY);
    if (!this.userId) return null;
    if (!this.data.users.some((person) => person.id === this.userId && person.active !== false)) {
      await this.logout();
      return null;
    }
    return this.snapshot();
  }

  async demoLogin(userId) {
    this._load();
    const user = this.data.users.find((person) => person.id === userId);
    validateUser(user);
    this.session.setItem(SESSION_KEY, user.id);
    this.userId = user.id;
    return this.snapshot();
  }

  async login() {
    throw new Error('Esta é a demonstração local. Escolha um dos perfis de exemplo. O acesso com e-mail e senha estará disponível após a configuração do ambiente compartilhado.');
  }

  async logout() {
    this.userId = null;
    this.session.removeItem(SESSION_KEY);
  }

  async snapshot() {
    this._load();
    const user = this._user();
    const tickets = this.data.tickets.filter((ticket) => canView(user, ticket)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const visibleIds = new Set([user.id]);
    for (const ticket of tickets) {
      visibleIds.add(ticket.requesterId);
      if (ticket.assignedTo) visibleIds.add(ticket.assignedTo);
      ticket.events.forEach((event) => visibleIds.add(event.actorId));
    }
    const users = this.data.users.filter((person) => visibleIds.has(person.id)).map(({ id, name, sectorId, roles, active }) => ({ id, name, sectorId, roles, active }));
    return structuredClone({ user, users, sectors: this.data.sectors, tickets, notifications: this.data.notifications.filter((notification) => notification.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }

  async _mutate(operation) {
    const perform = async () => {
      this._load();
      const user = this._user();
      const draft = structuredClone(this.data);
      operation(draft, user);
      this._persist(draft);
      this.data = draft;
      return this.snapshot();
    };
    return globalThis.navigator?.locks ? navigator.locks.request(LOCAL_DATA_KEY, perform) : perform();
  }

  _notify(data, ticket, actor, action, at) {
    const receivers = action === 'created' || actor.id === ticket.requesterId
      ? data.users.filter((person) => person.active !== false && canAttend(person, ticket))
      : data.users.filter((person) => person.active !== false && person.id === ticket.requesterId);
    const titles = {
      created: 'Novo chamado para o setor', claim: 'Atendimento iniciado', request_info: 'O setor precisa de mais informações',
      message: 'Nova mensagem no chamado', third_party: 'Atendimento depende de um terceiro', third_party_result: 'Resultado do atendimento externo registrado',
      start_resolution: 'Seu chamado está em resolução', resolve: 'Uma solução foi registrada', submit: 'Uma solução espera sua confirmação',
      approve: 'Solução aprovada e chamado finalizado', reject: 'Solução não aprovada: atendimento retomado',
    };
    for (const receiver of receivers) {
      if (receiver.id === actor.id) continue;
      data.notifications.push({ id: uuid(), userId: receiver.id, ticketId: ticket.id, title: titles[action], body: `${ticket.code} · ${ticket.title}`, createdAt: at, readAt: null });
    }
  }

  async createTicket(payload) {
    return this._mutate((data, user) => {
      const at = new Date().toISOString();
      const code = `SEC-${new Date(at).getFullYear()}-${String(data.sequence).padStart(4, '0')}`;
      const ticket = createTicket(user, payload, { at, code });
      data.sequence += 1;
      data.tickets.push(ticket);
      this._notify(data, ticket, user, 'created', at);
    });
  }

  async act(ticketId, action, payload = {}) {
    return this._mutate((data, user) => {
      const index = data.tickets.findIndex((ticket) => ticket.id === ticketId);
      if (index < 0) throw new Error('Chamado não encontrado.');
      const at = new Date().toISOString();
      data.tickets[index] = applyAction(data.tickets[index], user, action, payload, { at });
      this._notify(data, data.tickets[index], user, action, at);
    });
  }

  async markRead(id = null) {
    return this._mutate((data, user) => {
      const at = new Date().toISOString();
      data.notifications.forEach((notification) => {
        if (notification.userId === user.id && (!id || notification.id === id) && !notification.readAt) notification.readAt = at;
      });
    });
  }

  async metrics(filters = {}) {
    this._load();
    if (!isDirector(this._user())) throw new Error('Os indicadores estão disponíveis apenas para diretor ou gestor.');
    return computeMetrics(this.data.tickets, filters);
  }

  async downloadAttachment(ticketId, attachment) {
    this._load();
    const ticket = this.data.tickets.find((item) => item.id === ticketId);
    if (!ticket || !canView(this._user(), ticket)) throw new Error('Você não tem acesso a este anexo.');
    const stored = ticket.attachments.find((item) => item.id === attachment.id);
    if (!stored) throw new Error('Anexo não encontrado.');
    return stored.data;
  }
}
