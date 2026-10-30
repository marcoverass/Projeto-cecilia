import { SECTORS, applyAction, canView, computeMetrics, createTicket, validateAttachments, validateUser } from '../src/core.js';
import { createSeed, DEMO_USERS } from '../src/seed.js';
import { LocalAdapter, LOCAL_DATA_KEY } from '../src/local.js';

const cases = [];
const test = (name, run) => cases.push({ name, run });
const assert = (value, message = 'A condição esperada não foi atendida.') => { if (!value) throw new Error(message); };
const equal = (actual, expected) => assert(Object.is(actual, expected), `Esperado ${expected}; recebido ${actual}.`);
const throws = (run, contains = '') => {
  let error;
  try { run(); } catch (caught) { error = caught; }
  assert(error && error.message.includes(contains), `Era esperado um erro contendo: ${contains}`);
};
const rejects = async (run, contains = '') => {
  let error;
  try { await run(); } catch (caught) { error = caught; }
  assert(error && error.message.includes(contains), `Era esperado um erro contendo: ${contains}`);
};
const requester = DEMO_USERS.find((user) => user.id === 'cecilia');
const attendant = DEMO_USERS.find((user) => user.id === 'rafael');
const otherAgent = DEMO_USERS.find((user) => user.id === 'mariana');
const director = DEMO_USERS.find((user) => user.id === 'helena');
const at = (hour) => new Date(Date.parse('2026-10-20T12:00:00Z') + hour * 3600000).toISOString();
const payload = { title: 'Acesso a documentos', description: 'Preciso de acesso aos documentos da equipe Comercial.', sectorId: 'ti', priority: 'normal' };
const fresh = () => createTicket(requester, payload, { id: 'test-ticket', code: 'SEC-2026-0100', at: at(0) });
const claim = (ticket) => applyAction(ticket, attendant, 'claim', {}, { at: at(1) });
const resolved = () => applyAction(claim(fresh()), attendant, 'resolve', { text: 'O acesso aos documentos foi liberado.' }, { at: at(2) });
const submitted = () => applyAction(resolved(), attendant, 'submit', {}, { at: at(3) });
const closed = () => applyAction(submitted(), requester, 'approve', {}, { at: at(4) });

test('A abertura identifica usuário, setor e encaminhamento automaticamente', () => {
  const ticket = fresh();
  equal(ticket.requesterId, requester.id);
  equal(ticket.requesterSectorId, 'comercial');
  equal(ticket.status, 'open');
  equal(ticket.events[0].type, 'created');
  equal(ticket.events[1].type, 'forwarded');
  equal(ticket.events[1].at, at(0));
});

test('Os quatro setores que apenas solicitam não recebem chamados', () => {
  equal(SECTORS.filter((sector) => !sector.receives).length, 4);
  for (const sector of SECTORS.filter((item) => !item.receives)) throws(() => createTicket(requester, { ...payload, sectorId: sector.id }), 'receba chamados');
});

test('Usuários não podem acumular os três perfis ou atender em setor de envio', () => {
  throws(() => validateUser({ ...requester, roles: ['requester', 'agent', 'director'] }), 'um ou dois');
  throws(() => validateUser({ ...requester, roles: ['requester', 'agent'] }), 'não recebe');
});

test('Solicitantes veem os próprios chamados; gestão não ganha acesso operacional irrestrito', () => {
  assert(canView(requester, fresh()));
  assert(canView(attendant, fresh()));
  assert(!canView(otherAgent, fresh()));
  assert(!canView(director, fresh()));
});

test('Atendentes de outro setor não podem assumir ou responder', () => {
  throws(() => applyAction(fresh(), otherAgent, 'claim'), 'não tem acesso');
  throws(() => applyAction(fresh(), requester, 'request_info', { text: 'Teste' }), 'Assuma');
});

test('Assumir registra recebimento; a primeira resposta é registrada quando há comunicação', () => {
  const received = claim(fresh());
  equal(received.assignedTo, 'rafael');
  equal(received.firstResponseAt, null);
  const replied = applyAction(received, attendant, 'message', { text: 'Estamos verificando.' }, { at: at(1.5) });
  equal(replied.firstResponseAt, at(1.5));
});

test('O loop de informações pode acontecer repetidamente sem perder histórico', () => {
  let ticket = claim(fresh());
  for (let index = 0; index < 3; index += 1) {
    ticket = applyAction(ticket, attendant, 'request_info', { text: `Confirme a informação ${index + 1}.` }, { at: at(2 + index) });
    ticket = applyAction(ticket, requester, 'message', { text: `Segue a informação ${index + 1}.` }, { at: at(2.5 + index) });
    equal(ticket.status, 'waiting_info');
  }
  equal(ticket.events.filter((event) => event.type === 'request_info').length, 3);
  ticket = applyAction(ticket, attendant, 'claim', {}, { at: at(6) });
  equal(ticket.status, 'in_progress');
});

test('Terceiros ficam registrados no histórico sem ganhar conta ou receber comunicação do sistema', () => {
  let ticket = applyAction(claim(fresh()), attendant, 'third_party', { text: 'Contato externo realizado pelo setor.', thirdPartyName: 'Assistência técnica' }, { at: at(2) });
  equal(ticket.status, 'third_party');
  equal(ticket.events.at(-1).meta.thirdPartyName, 'Assistência técnica');
  ticket = applyAction(ticket, attendant, 'third_party_result', { text: 'O equipamento foi verificado pela assistência.' }, { at: at(3) });
  equal(ticket.status, 'in_progress');
});

test('Registrar a resolução e encerrar pelo setor não finalizam o chamado', () => {
  equal(resolved().status, 'resolved');
  equal(resolved().closedAt, null);
  equal(submitted().status, 'waiting_confirmation');
  equal(submitted().closedAt, null);
});

test('Somente o solicitante pode aprovar; aprovação registra fim efetivo', () => {
  throws(() => applyAction(submitted(), attendant, 'approve'), 'Somente o solicitante');
  const ticket = closed();
  equal(ticket.status, 'closed');
  equal(ticket.closedAt, at(4));
});

test('Reprovação exige justificativa e permite uma nova rodada completa de atendimento', () => {
  throws(() => applyAction(submitted(), requester, 'reject', { text: '  ' }), 'Escreva');
  let ticket = applyAction(submitted(), requester, 'reject', { text: 'O acesso continua indisponível.' }, { at: at(4) });
  equal(ticket.status, 'waiting_info'); equal(ticket.reopenCount, 1); equal(ticket.closedAt, null);
  ticket = applyAction(ticket, attendant, 'claim', {}, { at: at(5) });
  ticket = applyAction(ticket, attendant, 'resolve', { text: 'Corrigimos a permissão do grupo.' }, { at: at(6) });
  ticket = applyAction(ticket, attendant, 'submit', {}, { at: at(7) });
  ticket = applyAction(ticket, requester, 'approve', {}, { at: at(8) });
  equal(ticket.closedAt, at(8)); equal(ticket.events.filter((event) => event.type === 'resolve').length, 2);
});

test('Um chamado finalizado não pode receber mensagens ou mudar de estado', () => {
  for (const action of ['message', 'claim', 'approve', 'reject', 'resolve']) throws(() => applyAction(closed(), requester, action, { text: 'Teste' }), 'finalizado');
});

test('O atendente não pode pular a solução para pedir confirmação', () => {
  throws(() => applyAction(claim(fresh()), attendant, 'submit'), 'situação atual');
});

test('A duração usa aprovação; a resolução e a primeira resposta usam seus próprios eventos', () => {
  const metrics = computeMetrics([closed()]);
  equal(metrics.durationMs, 4 * 3600000);
  equal(metrics.resolutionMs, 2 * 3600000);
  equal(metrics.firstResponseMs, 2 * 3600000);
  equal(metrics.approvalMs, 2 * 3600000);
  equal(metrics.finalized, 1);
});

test('Filtros usam setor responsável e data de abertura no fuso de São Paulo', () => {
  const ticket = createTicket(requester, payload, { at: '2026-10-21T01:30:00Z' });
  equal(computeMetrics([ticket], { from: '2026-10-20', to: '2026-10-20' }).total, 1);
  equal(computeMetrics([ticket], { from: '2026-10-21', to: '2026-10-21' }).total, 0);
  equal(computeMetrics([ticket], { sectorId: 'rh' }).total, 0);
  throws(() => computeMetrics([ticket], { from: '2026-10-21', to: '2026-10-20' }), 'período válido');
});

test('Anexos validam conteúdo real e bloqueiam formatos ativos', () => {
  equal(validateAttachments([{ name: 'notas.txt', type: 'text/plain', size: 3, data: 'data:text/plain;base64,YWJj' }])[0].size, 3);
  throws(() => validateAttachments([{ name: 'notas.txt', type: 'text/plain', size: 8, data: 'data:text/plain;base64,YWJj' }]), 'incompleto');
  throws(() => validateAttachments([{ name: 'pagina.html', type: 'text/html', size: 3, data: 'data:text/html;base64,YWJj' }]), 'tipo de arquivo');
  throws(() => validateAttachments([{ name: 'arquivo.constructor', size: 0, data: 'data:;base64,' }]), 'tipo de arquivo');
});

test('A prioridade aceita somente valores explícitos, inclusive contra nomes herdados de Object', () => {
  for (const priority of ['invalid', '__proto__', 'constructor', 'toString']) throws(() => createTicket(requester, { ...payload, priority }), 'prioridade válida');
});

function memoryStore() {
  const values = new Map();
  return { getItem: (key) => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
const adapter = () => new LocalAdapter({ storage: memoryStore(), session: memoryStore() });

test('Todos os perfis de demonstração iniciam e os exemplos respeitam os setores', async () => {
  const data = createSeed();
  assert(data.tickets.length >= 20);
  for (const person of DEMO_USERS) {
    const local = adapter();
    const snapshot = await local.demoLogin(person.id);
    assert(snapshot.tickets.every((ticket) => canView(person, ticket)));
  }
});

test('Dois chamados podem ser abertos simultaneamente com identificadores distintos', async () => {
  const local = adapter();
  await local.demoLogin('cecilia');
  const before = (await local.snapshot()).tickets.length;
  await local.createTicket(payload);
  const snapshot = await local.createTicket(payload);
  equal(snapshot.tickets.length, before + 2);
  equal(new Set(snapshot.tickets.map((ticket) => ticket.id)).size, snapshot.tickets.length);
  equal(new Set(snapshot.tickets.map((ticket) => ticket.code)).size, snapshot.tickets.length);
});

test('Notificações são isoladas por usuário e não incluem terceiros', async () => {
  const local = adapter();
  await local.demoLogin('cecilia');
  let snapshot = await local.createTicket(payload);
  const id = snapshot.tickets[0].id;
  snapshot = await local.demoLogin('rafael');
  assert(snapshot.notifications.some((notification) => notification.ticketId === id));
  assert(snapshot.notifications.every((notification) => notification.userId === 'rafael'));
  await local.act(id, 'claim');
  await local.act(id, 'third_party', { text: 'Contato realizado por telefone.', thirdPartyName: 'Empresa externa' });
  snapshot = await local.demoLogin('cecilia');
  assert(snapshot.notifications.some((notification) => notification.ticketId === id && notification.title.includes('terceiro')));
  assert(local.data.notifications.every((notification) => DEMO_USERS.some((person) => person.id === notification.userId)));
});

test('Somente a gestão pode solicitar indicadores, que não expõem chamados individuais', async () => {
  const local = adapter();
  await local.demoLogin('rafael');
  await rejects(() => local.metrics(), 'apenas');
  const snapshot = await local.demoLogin('helena');
  assert(snapshot.tickets.every((ticket) => ticket.requesterId === 'helena'));
  const metrics = await local.metrics();
  assert(metrics.total > snapshot.tickets.length);
  assert(!('tickets' in metrics));
});

test('Falha ao persistir reverte a operação e preserva o contador dos chamados', async () => {
  const storage = memoryStore();
  const local = new LocalAdapter({ storage, session: memoryStore() });
  await local.demoLogin('cecilia');
  const previous = storage.getItem(LOCAL_DATA_KEY);
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  await rejects(() => local.createTicket(payload), 'Nenhuma alteração foi salva');
  equal(storage.getItem(LOCAL_DATA_KEY), previous);
});

test('Marcar notificações como lidas mantém a leitura dos outros usuários intacta', async () => {
  const local = adapter();
  await local.demoLogin('cecilia');
  const others = JSON.stringify(local.data.notifications.filter((notification) => notification.userId !== 'cecilia'));
  const snapshot = await local.markRead();
  assert(snapshot.notifications.every((notification) => !!notification.readAt));
  equal(JSON.stringify(local.data.notifications.filter((notification) => notification.userId !== 'cecilia')), others);
});

const results = [];
for (const item of cases) {
  const element = document.createElement('li');
  try {
    await item.run();
    element.className = 'pass'; element.textContent = `✓ ${item.name}`;
    results.push({ name: item.name, passed: true });
  } catch (error) {
    element.className = 'fail'; element.textContent = `✗ ${item.name}: ${error.message}`;
    results.push({ name: item.name, passed: false, error: error.message });
  }
  document.getElementById('results').append(element);
}
const failures = results.filter((result) => !result.passed);
document.getElementById('summary').textContent = `${results.length - failures.length}/${results.length} verificações aprovadas.`;
document.title = failures.length ? `FALHOU: ${failures.length} verificações` : `OK: ${results.length} verificações`;
window.__domainTestResults = { passed: results.length - failures.length, failed: failures.length, results };
window.__TEST_RESULTS__ = window.__domainTestResults;
