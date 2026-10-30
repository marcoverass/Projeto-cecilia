// Production adapter. Authentication and authorization are enforced by Supabase.
// The public configuration never contains an administrative database credential.
const SESSION_KEY = 'entre-setores.auth.v1';

export class RemoteAdapter {
  mode = 'cloud';

  constructor(config, { fetch = globalThis.fetch.bind(globalThis), storage = globalThis.sessionStorage } = {}) {
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') || url.username || url.password) {
      throw new Error('Informe a URL HTTPS do projeto Supabase em config.js.');
    }
    if (!config.supabaseAnonKey || /service_role/.test(config.supabaseAnonKey)) throw new Error('Use somente a chave pública do projeto Supabase.');
    // Legacy JWT service keys are also rejected before making a network request.
    try {
      const part = config.supabaseAnonKey.split('.')[1];
      if (part && JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role') {
        throw new Error('A chave service_role não pode ser utilizada no navegador.');
      }
    } catch (error) {
      if (error.message.includes('service_role')) throw error;
    }
    this.base = url.origin;
    this.key = config.supabaseAnonKey;
    this.fetch = fetch;
    this.storage = storage;
    this.session = null;
    this.refreshing = null;
    this.version = 0;
  }

  _clear() {
    this.version++;
    this.session = null;
    this.storage.removeItem(SESSION_KEY);
  }

  _save(data) {
    if (!data.access_token || !data.refresh_token) throw new Error('Não foi possível confirmar a sessão. Entre novamente.');
    const session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    };
    try { this.storage.setItem(SESSION_KEY, JSON.stringify(session)); }
    catch { throw new Error('O navegador não conseguiu guardar sua sessão. Permita o armazenamento deste site e tente novamente.'); }
    this.session = session;
  }

  async _request(path, { method = 'POST', body, authenticated = true, retry = true } = {}) {
    if (authenticated && !this.session) throw new Error('Entre novamente para continuar.');
    if (authenticated && this.session.expires_at * 1000 < Date.now() + 30000) await this._refresh();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let response;
    try {
      response = await this.fetch(`${this.base}${path}`, {
        method, headers: {
          apikey: this.key,
          'Content-Type': 'application/json',
          ...(authenticated ? { Authorization: `Bearer ${this.session.access_token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'omit', signal: controller.signal,
      });
    } catch (error) {
      throw new Error(error.name === 'AbortError' ? 'O servidor demorou a responder. Verifique sua conexão e tente novamente.' : 'Não foi possível conectar ao sistema. Verifique sua conexão e tente novamente.');
    } finally { clearTimeout(timer); }
    if (response.status === 401 && authenticated && retry) {
      await this._refresh();
      return this._request(path, { method, body, authenticated, retry: false });
    }
    let data;
    try { data = response.status === 204 ? null : await response.json(); }
    catch { throw new Error('O servidor retornou uma resposta inesperada. Tente novamente.'); }
    if (!response.ok) {
      const raw = data?.message || data?.msg || data?.error_description || data?.error || '';
      let message = raw;
      if (/invalid login credentials/i.test(raw)) message = 'E-mail ou senha incorretos.';
      else if (/email not confirmed/i.test(raw)) message = 'Confirme seu e-mail antes de entrar.';
      else if (/rate limit|too many requests/i.test(raw)) message = 'Muitas tentativas em pouco tempo. Aguarde um momento e tente novamente.';
      else if (response.status === 401 || /invalid.*token|expired|refresh_token/i.test(raw)) message = 'Sua sessão expirou. Entre novamente.';
      else if (/could not find the function|PGRST202/i.test(raw + ' ' + data?.code)) message = 'O banco de dados ainda não foi preparado. Siga o guia de produção do projeto.';
      else if (response.status >= 500) message = 'O servidor não conseguiu concluir a operação. Tente novamente.';
      const error = new Error(message || 'Não foi possível concluir a operação.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async _refresh() {
    if (this.refreshing) return this.refreshing;
    if (!this.session?.refresh_token) throw new Error('Sua sessão expirou. Entre novamente.');
    const version = this.version;
    this.refreshing = (async () => {
      try {
        const data = await this._request('/auth/v1/token?grant_type=refresh_token', {
          authenticated: false, body: { refresh_token: this.session.refresh_token },
        });
        if (this.version !== version) throw new Error('Entre novamente para continuar.');
        this._save(data);
      } catch (error) {
        if ([400, 401, 403].includes(error.status)) this._clear();
        throw error;
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }

  async init() {
    let stored;
    try { stored = JSON.parse(this.storage.getItem(SESSION_KEY)); }
    catch { this._clear(); return null; }
    if (!stored?.access_token || !stored?.refresh_token) return null;
    this.session = stored;
    try { return await this.snapshot(); }
    catch (error) {
      if ([400, 401].includes(error.status) && !this.session) return null;
      throw error;
    }
  }

  async login(email, password) {
    const data = await this._request('/auth/v1/token?grant_type=password', { authenticated: false, body: { email, password } });
    this.version++;
    this._save(data);
    try { return await this.snapshot(); }
    catch (error) { this._clear(); throw error; }
  }

  async logout() {
    const session = this.session;
    // Invalidate locally immediately, even when the network is unavailable.
    this._clear();
    if (!session) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await this.fetch(`${this.base}/auth/v1/logout`, {
        method: 'POST', headers: { apikey: this.key, Authorization: `Bearer ${session.access_token}` },
        credentials: 'omit', signal: controller.signal,
      });
    } catch { /* The tab session has already been removed. */ }
    finally { clearTimeout(timer); }
  }

  _rpc(name, body = {}) { return this._request(`/rest/v1/rpc/${name}`, { body }); }
  snapshot() { return this._rpc('app_snapshot'); }
  createTicket(payload) { return this._rpc('app_create_ticket', { p_payload: payload }); }
  act(ticketId, action, payload = {}) { return this._rpc('app_ticket_action', { p_ticket_id: ticketId, p_action: action, p_payload: payload }); }
  markRead(id = null) { return this._rpc('app_mark_read', { p_id: id }); }
  metrics(filters = {}) { return this._rpc('app_metrics', { p_filters: filters }); }

  async downloadAttachment(ticketId, attachment) {
    const state = await this.snapshot();
    const stored = state.tickets.find((ticket) => ticket.id === ticketId)?.attachments.find((file) => file.id === attachment.id);
    if (!stored) throw new Error('Você não tem acesso a este anexo.');
    return stored.data;
  }
}
