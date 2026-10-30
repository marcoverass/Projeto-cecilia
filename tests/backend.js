import { PGlite } from 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.13/dist/index.js';
import { RemoteAdapter } from '../src/remote.js';

const checks = [];
const expect = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
async function forbidden(operation, name) {
  let error;
  try { await operation(); } catch (caught) { error = caught; }
  expect(Boolean(error), name);
}
const ids = {
  requester: '11111111-1111-4111-8111-111111111111',
  agent: '22222222-2222-4222-8222-222222222222',
  outsider: '33333333-3333-4333-8333-333333333333',
  director: '44444444-4444-4444-8444-444444444444',
  inactive: '55555555-5555-4555-8555-555555555555',
};
const memory = () => { const data = new Map(); return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) }; };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const config = { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'sb_publishable_test' };

async function testRemote() {
  await forbidden(() => new RemoteAdapter({ ...config, supabaseUrl: 'http://example.supabase.co' }), 'Autenticação: recusa endpoint sem HTTPS');
  await forbidden(() => new RemoteAdapter({ ...config, supabaseUrl: 'https://attacker.example' }), 'Autenticação: recusa envio de credenciais para origem externa');
  const privilegedKey = `e30.${btoa(JSON.stringify({ role: 'service_role' }))}.sig`;
  await forbidden(() => new RemoteAdapter({ ...config, supabaseAnonKey: privilegedKey }), 'Autenticação: bloqueia chave administrativa no navegador');
  let calls = [];
  let offline = false;
  const state = { user: { id: ids.requester }, tickets: [], users: [], sectors: [], notifications: [] };
  const storage = memory();
  const remote = new RemoteAdapter(config, { storage, fetch: async (url, options) => {
    calls.push({ url, options });
    if (offline) throw new Error('offline');
    if (url.includes('grant_type=password')) return reply({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    if (url.endsWith('/auth/v1/logout')) return new Response(null, { status: 204 });
    return reply(state);
  } });
  expect(await remote.init() === null && calls.length === 0, 'Autenticação: sem sessão não consulta dados');
  const result = await remote.login('user@example.test', 'sample-password');
  expect(result.user.id === ids.requester, 'Autenticação: login real exige resposta do servidor');
  expect(JSON.parse(calls[0].options.body).password === 'sample-password' && calls[0].options.credentials === 'omit', 'Autenticação: credenciais enviadas apenas ao endpoint de autenticação');
  expect(![...Array(1)].some(() => storage.getItem('password')), 'Autenticação: senha não é persistida');
  await remote.act('ticket-uuid', 'approve');
  expect(calls.at(-1).url.endsWith('/rpc/app_ticket_action') && JSON.parse(calls.at(-1).options.body).p_action === 'approve', 'Autenticação: alterações passam pelo RPC protegido');
  offline = true;
  await remote.logout();
  expect(remote.session === null && await new RemoteAdapter(config, { storage, fetch: async () => reply({}) }).init() === null, 'Autenticação: sair remove a sessão mesmo sem rede');
  const invalid = new RemoteAdapter(config, { storage: memory(), fetch: async () => reply({ msg: 'Invalid login credentials' }, 400) });
  let invalidMessage;
  try { await invalid.login('wrong@example.test', 'wrong'); } catch (error) { invalidMessage = error.message; }
  expect(invalidMessage === 'E-mail ou senha incorretos.' && invalid.session === null, 'Autenticação: senha inválida não cria sessão nem usa demonstração');
  let refreshed = 0;
  const refreshStorage = memory();
  refreshStorage.setItem('entre-setores.auth.v1', JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: 1 }));
  const refreshing = new RemoteAdapter(config, { storage: refreshStorage, fetch: async (url, options) => {
    if (url.includes('refresh_token')) { refreshed++; return reply({ access_token: 'new', refresh_token: 'next', expires_in: 3600 }); }
    expect(options.headers.Authorization === 'Bearer new', 'Autenticação: renovação usa o token atualizado');
    return reply(state);
  } });
  await refreshing.init();
  expect(refreshed === 1, 'Autenticação: sessão expirada é renovada');
  await forbidden(() => refreshing.downloadAttachment('unavailable', { id: 'private' }), 'Autenticação: download exige chamado retornado pelo servidor');
}

async function testDatabase() {
  const db = await PGlite.create();
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  `);
  await db.exec(await (await fetch('../supabase/schema.sql')).text());
  checks.push('SQL: esquema compilado em PostgreSQL');
  await db.exec(await (await fetch('../supabase/schema.sql')).text());
  checks.push('SQL: reaplicação do esquema preserva estrutura');
  for (const [key, id] of Object.entries(ids)) await db.query('insert into auth.users(id,email) values($1,$2)', [id, `${key}@example.test`]);
  const profiles = [
    [ids.requester, 'Pessoa solicitante', 'comercial', ['requester'], true],
    [ids.agent, 'Pessoa atendente', 'ti', ['requester', 'agent'], true],
    [ids.outsider, 'Outro setor', 'rh', ['requester', 'agent'], true],
    [ids.director, 'Pessoa gestora', 'diretoria', ['requester', 'director'], true],
    [ids.inactive, 'Pessoa inativa', 'comercial', ['requester'], false],
  ];
  for (const row of profiles) await db.query('insert into app_profiles(id,name,sector_id,roles,active) values($1,$2,$3,$4,$5)', row);
  const identity = async (key, role = 'authenticated') => {
    await db.exec(`reset role; set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ids[key] || '']);
  };
  const rpc = async (sql, args = []) => (await db.query(sql, args)).rows[0].result;
  const create = (payload) => rpc('select public.app_create_ticket($1::jsonb) as result', [JSON.stringify(payload)]);
  const action = (id, kind, payload = {}) => rpc('select public.app_ticket_action($1::uuid,$2,$3::jsonb) as result', [id, kind, JSON.stringify(payload)]);
  const snapshot = () => rpc('select public.app_snapshot() as result');
  const metrics = (filters = {}) => rpc('select public.app_metrics($1::jsonb) as result', [JSON.stringify(filters)]);
  await identity('', 'anon');
  await forbidden(snapshot, 'SQL: visitante não autenticado não executa RPC');
  await identity('requester');
  await forbidden(() => db.query('select * from app_tickets'), 'SQL: API não possui leitura direta de chamados');
  await forbidden(() => db.query("update app_profiles set roles=array['director']"), 'SQL: usuário não consegue elevar seu próprio perfil');
  await forbidden(() => db.query('select app_private.current_profile()'), 'SQL: funções internas não estão disponíveis ao cliente');
  await forbidden(metrics, 'SQL: solicitante não recebe indicadores');
  await forbidden(() => create({ title: 'Setor inválido', description: 'Pedido para setor sem atendimento.', sectorId: 'diretoria' }), 'SQL: diretoria não pode receber chamados');
  const payload = { title: 'Teste de permissão', description: 'Acesso à pasta compartilhada da equipe.', sectorId: 'ti', priority: 'high', requesterId: ids.director, status: 'closed', attachments: [{ name: 'contexto.txt', type: 'text/plain', size: 2, data: 'data:text/plain;base64,T0s=' }] };
  let state = await create(payload);
  const id = state.tickets[0].id;
  let t = state.tickets[0];
  expect(t.requesterId === ids.requester && t.requesterSectorId === 'comercial' && t.status === 'open', 'SQL: identidade, setor e estado fornecidos pelo cliente não são confiados');
  expect(t.events.length === 2 && t.attachments[0].size === 2, 'SQL: abertura registra histórico e anexo protegido');
  await identity('outsider');
  expect((await snapshot()).tickets.length === 0, 'SQL: outro setor não consulta o chamado');
  await forbidden(() => action(id, 'claim'), 'SQL: outro setor não assume chamado');
  await identity('agent');
  state = await snapshot();
  expect(state.tickets.length === 1 && state.notifications.length === 1, 'SQL: setor recebe chamado e notificação');
  expect(state.users.every((user) => !Object.hasOwn(user, 'email')), 'SQL: lista de participantes não expõe e-mails');
  await forbidden(() => action(id, 'resolve', { text: 'Alteração sem assumir' }), 'SQL: atendimento exige responsável atribuído');
  await action(id, 'claim');
  state = await action(id, 'request_info', { text: 'Informe o caminho da pasta.' });
  expect(state.tickets[0].status === 'waiting_info' && state.tickets[0].firstResponseAt, 'SQL: primeira resposta e espera por informações registradas');
  await action(id, 'request_info', { text: 'Também informe a mensagem exibida.' });
  checks.push('SQL: solicitação de informações pode se repetir');
  await identity('requester');
  await action(id, 'message', { text: 'O caminho e a mensagem estão nos detalhes.' });
  await identity('agent');
  await action(id, 'claim');
  await action(id, 'third_party', { text: 'Chamado ao fornecedor por telefone.', thirdPartyName: 'Fornecedor externo' });
  await action(id, 'third_party_result', { text: 'Fornecedor corrigiu a configuração.' });
  await action(id, 'start_resolution');
  state = await action(id, 'resolve', { text: 'Permissões corrigidas.' });
  expect(state.tickets[0].closedAt === null && state.tickets[0].status === 'resolved', 'SQL: resolução não finaliza o chamado');
  await action(id, 'submit');
  await forbidden(() => action(id, 'approve'), 'SQL: atendente não aprova pelo solicitante');
  await identity('requester');
  await forbidden(() => action(id, 'reject', { text: '' }), 'SQL: reprovação exige motivo');
  state = await action(id, 'reject', { text: 'A edição ainda não está disponível.' });
  expect(state.tickets[0].status === 'waiting_info' && state.tickets[0].reopenCount === 1 && state.tickets[0].resolvedAt === null, 'SQL: reprovação retoma atendimento e invalida solução anterior');
  await identity('agent');
  await action(id, 'claim');
  await action(id, 'resolve', { text: 'A edição também foi liberada.' });
  await action(id, 'submit');
  await identity('requester');
  state = await action(id, 'approve'); t = state.tickets[0];
  expect(t.status === 'closed' && t.closedAt && new Date(t.closedAt) >= new Date(t.resolvedAt), 'SQL: aprovação é o fechamento definitivo');
  await forbidden(() => action(id, 'message', { text: 'Alteração após finalização' }), 'SQL: finalizado não aceita novas alterações');
  expect(t.events.some((event) => event.meta?.thirdPartyName === 'Fornecedor externo') && t.events.every((event) => event.actorId && event.at), 'SQL: histórico preserva autoria, horários e terceiro');
  await identity('director');
  expect((await snapshot()).tickets.length === 0, 'SQL: diretoria não ganha acesso ao conteúdo dos chamados');
  const indicators = await metrics();
  expect(indicators.total === 1 && indicators.finalized === 1 && indicators.reopenedCount === 1 && indicators.thirdPartyCount === 1, 'SQL: indicadores derivam dos eventos reais');
  expect(indicators.durationMs >= indicators.resolutionMs && indicators.byPeriod.length > 0, 'SQL: tempos e série temporal são calculados pelo servidor');
  expect((await metrics({ sectorId: 'rh' })).total === 0, 'SQL: filtro de setor limita os agregados');
  await identity('inactive');
  await forbidden(snapshot, 'SQL: conta inativa não recebe dados');
  await db.exec('reset role');
  await forbidden(() => db.query("update app_profiles set roles=array['requester','agent','director'] where id=$1", [ids.agent]), 'SQL: banco impede acumular os três perfis');
  await forbidden(() => db.query("update app_profiles set roles=array['requester','agent'] where id=$1", [ids.requester]), 'SQL: banco impede atendente em setor que apenas solicita');
  await identity('requester');
  await forbidden(() => create({ ...payload, attachments: [{ name: 'inseguro.svg', type: 'image/svg+xml', size: 0, data: 'data:image/svg+xml;base64,' }] }), 'SQL: servidor bloqueia anexo com conteúdo ativo');
  await db.exec("reset role; select setval('public.app_ticket_number_seq',10000,false)");
  await identity('requester');
  const next = await create({ ...payload, attachments: [] });
  expect(next.tickets.some((ticket) => ticket.code.endsWith('-10000')), 'SQL: códigos não são truncados após dez mil chamados');
  await db.close();
}

try {
  await testRemote();
  await testDatabase();
  window.__BACKEND_RESULTS__ = { passed: checks.length, failed: 0, checks };
} catch (error) {
  window.__BACKEND_RESULTS__ = { passed: checks.length, failed: 1, checks, error: error.message, detail: error.detail, where: error.where, stack: error.stack };
}
document.querySelector('#results').textContent = JSON.stringify(window.__BACKEND_RESULTS__, null, 2);
