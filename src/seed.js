import { SECTORS, createTicket, applyAction } from './core.js';

export const DEMO_USERS = [
  { id: 'cecilia', name: 'Cecília Almeida', email: 'cecilia@empresa.exemplo', sectorId: 'comercial', roles: ['requester'], active: true },
  { id: 'rafael', name: 'Rafael Costa', email: 'rafael@empresa.exemplo', sectorId: 'ti', roles: ['requester', 'agent'], active: true },
  { id: 'helena', name: 'Helena Martins', email: 'helena@empresa.exemplo', sectorId: 'diretoria', roles: ['requester', 'director'], active: true },
  { id: 'mariana', name: 'Mariana Souza', email: 'mariana@empresa.exemplo', sectorId: 'rh', roles: ['requester', 'agent'], active: true },
  { id: 'bruno', name: 'Bruno Oliveira', email: 'bruno@empresa.exemplo', sectorId: 'infraestrutura', roles: ['requester', 'agent'], active: true },
  { id: 'ana', name: 'Ana Ribeiro', email: 'ana@empresa.exemplo', sectorId: 'financeiro', roles: ['requester', 'agent'], active: true },
  { id: 'lucas', name: 'Lucas Ferreira', email: 'lucas@empresa.exemplo', sectorId: 'compras', roles: ['requester', 'agent'], active: true },
  { id: 'paula', name: 'Paula Nunes', email: 'paula@empresa.exemplo', sectorId: 'administrativo', roles: ['requester', 'agent'], active: true },
  { id: 'renata', name: 'Renata Lima', email: 'renata@empresa.exemplo', sectorId: 'fiscal', roles: ['requester', 'agent'], active: true },
  { id: 'pedro', name: 'Pedro Santos', email: 'pedro@empresa.exemplo', sectorId: 'servicos', roles: ['requester', 'agent'], active: true },
  { id: 'beatriz', name: 'Beatriz Melo', email: 'beatriz@empresa.exemplo', sectorId: 'operacoes', roles: ['requester', 'agent'], active: true },
];

const HOUR = 3600000;
const MINUTE = 60000;

export function createSeed(now = new Date()) {
  const epoch = Number(now);
  const tickets = [];
  const users = structuredClone(DEMO_USERS);
  const user = (id) => users.find((item) => item.id === id);
  const agent = (sectorId) => users.find((item) => item.sectorId === sectorId && item.roles.includes('agent'));
  const records = [
    ['Acesso à pasta compartilhada do Comercial', 'Preciso acessar a pasta de propostas comerciais para atualizar os documentos da equipe. A permissão atual permite apenas a leitura.', 'ti', 'high', 'in_progress', 0, 'cecilia'],
    ['Ajuste no monitor da sala de reuniões', 'O monitor da sala de reuniões do segundo andar apresenta falhas na imagem ao conectar o notebook por HDMI.', 'ti', 'normal', 'waiting_confirmation', 1, 'cecilia'],
    ['Atualização dos dados para reembolso', 'Solicito a atualização dos dados bancários vinculados ao meu cadastro para o reembolso da viagem comercial.', 'financeiro', 'normal', 'waiting_info', 1, 'cecilia'],
    ['Instalação de aplicativo para apresentações', 'Precisamos instalar o aplicativo de apresentação na estação da equipe Comercial para a reunião da próxima semana.', 'ti', 'normal', 'open', 0, 'cecilia'],
    ['Manutenção do ar-condicionado', 'O ar-condicionado da sala do Comercial está desligando durante o expediente. A equipe já verificou as pilhas do controle.', 'infraestrutura', 'high', 'third_party', 2, 'cecilia'],
    ['Declaração de vínculo empregatício', 'Solicito a emissão de uma declaração de vínculo empregatício atualizada para apresentar à instituição de ensino.', 'rh', 'low', 'closed', 3, 'cecilia'],
    ['Compra de adaptadores para notebooks', 'Solicito três adaptadores USB-C para HDMI para os notebooks utilizados nas visitas e apresentações comerciais.', 'compras', 'normal', 'resolving', 2, 'cecilia'],
    ['Conexão instável na rede sem fio', 'A rede sem fio da sala do Comercial apresenta interrupções durante as videochamadas, principalmente no período da tarde.', 'ti', 'urgent', 'waiting_info', 3, 'cecilia', true],
    ['Reserva da sala para treinamento', 'Precisamos reservar a sala principal para o treinamento dos novos representantes na próxima quinta-feira, no período da manhã.', 'administrativo', 'low', 'closed', 5, 'cecilia'],
    ['Revisão de minuta de contrato', 'Solicito revisão da minuta de contrato de prestação de serviços antes do envio ao cliente. As condições estão descritas na solicitação.', 'fiscal', 'high', 'in_progress', 4, 'cecilia'],
    ['Reconfiguração da assinatura de e-mail', 'A assinatura do meu e-mail ainda apresenta o telefone antigo. Solicito a atualização com os dados do cadastro atual.', 'ti', 'low', 'closed', 6, 'cecilia'],
    ['Limpeza da sala após evento', 'Após o encontro com os representantes, a sala de reuniões precisa de limpeza e reorganização das mesas e cadeiras.', 'servicos', 'normal', 'closed', 7, 'cecilia'],
    ['Disponibilização de demonstrativo mensal', 'Solicito o demonstrativo mensal consolidado para a reunião de acompanhamento dos resultados dos setores.', 'financeiro', 'normal', 'closed', 9, 'helena'],
    ['Configuração de equipamento de admissão', 'Precisamos preparar o notebook e as permissões iniciais para a chegada do novo funcionário do setor de Recursos Humanos.', 'ti', 'high', 'open', 0, 'mariana'],
    ['Recuperação de documento de trabalho', 'Um documento da pasta do Financeiro foi removido por engano. Precisamos recuperar a versão de ontem para concluir a conciliação.', 'ti', 'high', 'in_progress', 1, 'ana'],
    ['Atualização da estação de atendimento', 'Solicito a atualização da estação de atendimento utilizada no posto de Operações. O equipamento está reiniciando sem aviso.', 'ti', 'normal', 'resolved', 2, 'beatriz'],
    ['Conferência de entrega de materiais', 'Solicito a conferência da entrega dos materiais de escritório recebidos para atualizar os registros da solicitação de compras.', 'operacoes', 'normal', 'closed', 11, 'lucas'],
    ['Reposição de materiais para reuniões', 'Precisamos repor os materiais de apoio utilizados nas salas de reuniões, incluindo blocos e marcadores para o quadro.', 'compras', 'low', 'closed', 13, 'paula'],
    ['Troca de teclado da estação de trabalho', 'O teclado da estação do Comercial apresenta falha em algumas teclas. Solicito a substituição para continuar o trabalho.', 'ti', 'normal', 'closed', 16, 'cecilia'],
    ['Revisão da iluminação do corredor', 'Duas luminárias do corredor próximo à sala do Comercial estão oscilando. Solicito uma avaliação da manutenção.', 'infraestrutura', 'normal', 'closed', 19, 'cecilia'],
    ['Correção de acesso ao e-mail', 'Não estou conseguindo acessar o e-mail corporativo pelo computador da sala. A senha funciona normalmente no celular.', 'ti', 'high', 'closed', 22, 'cecilia'],
    ['Segunda via de comprovante de reembolso', 'Preciso da segunda via do comprovante referente ao reembolso da última visita comercial para organizar meus documentos.', 'financeiro', 'low', 'closed', 25, 'cecilia'],
  ];

  records.forEach(([title, description, sectorId, priority, status, daysAgo, requesterId, reopened], index) => {
    const opened = epoch - daysAgo * 24 * HOUR - 5 * HOUR;
    const at = (minutes) => new Date(opened + minutes * MINUTE).toISOString();
    const requester = user(requesterId);
    const attendant = agent(sectorId);
    let ticket = createTicket(requester, { title, description, sectorId, priority }, {
      id: `demo-${String(index + 1).padStart(3, '0')}`, code: `SEC-${new Date(opened).getFullYear()}-${String(index + 1).padStart(4, '0')}`, at: at(0),
    });
    const action = (type, payload, minutes, actor = attendant) => {
      ticket = applyAction(ticket, actor, type, payload, { at: at(minutes) });
    };
    if (status !== 'open') {
      action('claim', {}, 8);
      action('message', { text: 'Recebemos sua solicitação e estamos verificando os detalhes para dar continuidade ao atendimento.' }, 18);
      if (status === 'waiting_info' && !reopened) action('request_info', { text: 'Você pode confirmar os dados necessários para o atendimento? Envie as informações por aqui para que possamos prosseguir.' }, 32);
      if (status === 'third_party') action('third_party', { text: 'Foi solicitada uma avaliação à assistência técnica. O contato foi realizado pelo setor de Manutenção, fora do sistema.', thirdPartyName: 'Assistência técnica de climatização' }, 45);
      if (['resolving', 'resolved', 'waiting_confirmation', 'closed'].includes(status) || reopened) action('start_resolution', {}, 45);
      if (['resolved', 'waiting_confirmation', 'closed'].includes(status) || reopened) action('resolve', { text: 'A solicitação foi atendida e a verificação do serviço foi concluída. Por favor, confira se tudo funciona como esperado.' }, 110);
      if (['waiting_confirmation', 'closed'].includes(status) || reopened) action('submit', {}, 115);
      if (status === 'closed') action('approve', {}, 175, requester);
      if (reopened) action('reject', { text: 'A conexão melhorou, mas voltou a cair durante a chamada da tarde. Preciso de uma nova verificação, por favor.' }, 190, requester);
    }
    tickets.push(ticket);
  });

  const notifications = [];
  for (const ticket of tickets) {
    const event = ticket.events.at(-1);
    const recipients = event.actorId === ticket.requesterId
      ? users.filter((person) => person.roles.includes('agent') && person.sectorId === ticket.sectorId)
      : [user(ticket.requesterId)];
    for (const recipient of recipients) {
      notifications.push({
        id: `notice-${ticket.id}-${recipient.id}`, userId: recipient.id, ticketId: ticket.id,
        title: ticket.status === 'waiting_confirmation' ? 'Uma solução espera sua confirmação' : ticket.status === 'open' ? 'Novo chamado para o setor' : ticket.status === 'waiting_info' ? 'Novas informações no chamado' : 'Seu chamado foi atualizado',
        body: `${ticket.code} · ${ticket.title}`, createdAt: event.at,
        readAt: ['waiting_confirmation', 'waiting_info', 'open'].includes(ticket.status) ? null : event.at,
      });
    }
  }
  return { version: 1, users, sectors: structuredClone(SECTORS), tickets, notifications, sequence: records.length + 1 };
}
