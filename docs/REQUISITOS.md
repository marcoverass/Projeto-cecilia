# Rastreabilidade do documento

Base: **Sistema de Solicitações Internas.pdf**, fornecido pelo usuário. A aplicação implementa o ciclo e os três perfis do documento. O frontend é estático para GitHub Pages; a operação compartilhada depende de configurar o Supabase conforme [PRODUCAO.md](PRODUCAO.md).

| Requisito | Implementação |
| --- | --- |
| RF-01 | Identidade autenticada e setor pelo perfil cadastrado no servidor. Na demonstração, perfis fictícios identificados. |
| RF-02 a RF-04 | Formulário com título, descrição, prioridade e setor responsável; origem vinculada ao perfil; ID e código únicos; encaminhamento automático. |
| RF-05 | Eventos com autoria e horário do servidor na produção: criação, encaminhamento, recebimento, respostas, espera, terceiro, solução, confirmação, reprovação e fim. |
| RF-06 e RF-07 | Notificação interna aos atendentes do setor; fila por setor; responsável atribuído ao assumir. |
| RF-08 a RF-10 | Pedidos de informações repetíveis, conversa por chamado, anexos, autor e data; retomada explícita do atendimento. |
| RF-11 a RF-13 | Registro do terceiro, motivo do acionamento e resultado; aviso ao solicitante; nenhum contato automático com o terceiro. |
| RF-14 a RF-16 | Solução obrigatoriamente registrada antes de enviar para confirmação; notificação interna e estado intermediário. |
| RF-17 a RF-20 | Somente o solicitante aprova ou reprova. Reprovação exige motivo e retorna a aguardando informações. Aprovação registra fechamento definitivo. |
| RF-21 a RF-23 | Histórico preservado, consulta limitada por perfil e duração calculada entre abertura e aprovação. Finalizados não permitem novas ações operacionais. |
| RF-24 a RF-27 | Indicadores exclusivos de diretor/gestor, filtros por período e setor, volumes e médias derivadas dos registros. |
| RF-28 | Vários chamados simultâneos, identificadores independentes e sequência protegida no servidor. |

## Estados

`Aberto → Em atendimento → Em resolução → Resolvido → Aguardando confirmação → Finalizado`

O atendimento pode passar por **Aguardando informações** repetidamente. Após receber informações suficientes, o atendente retoma o atendimento. O estado **Envio a terceiros** registra a dependência externa; registrar seu resultado devolve o chamado ao atendimento. A reprovação da solução exige explicação e retorna a **Aguardando informações**, permitindo retomar e resolver novamente.

O encerramento pelo setor não é o fechamento definitivo. Somente a aprovação do solicitante preenche o fim efetivo e bloqueia o fluxo operacional.

## Perfis e indicadores

Solicitantes consultam seus próprios chamados. Atendentes também consultam e atendem os chamados destinados ao seu setor. Diretores/gestores consultam indicadores agregados; esse papel não concede acesso ao conteúdo dos chamados alheios. Um usuário possui até dois dos três papéis.

Os nove setores de atendimento e os quatro setores que apenas solicitam seguem a tabela do PDF. Usuários, setores e papéis são cadastrados administrativamente no banco; a aplicação usa esses cadastros para identificar a origem e autorizar as operações.

Indicadores: quantidades por situação e setor, total de recebidos e finalizados, primeira resposta, resolução, duração até aprovação, espera pela aprovação, participação de terceiros, retornos após reprovação e evolução das aberturas por período. Na tabela por setor, resolução média significa abertura até solução; a duração total é exibida separadamente.

## Critérios de aceitação e verificações

- **CA-01 a CA-05:** identificação, abertura, código, origem, encaminhamento e horário automático.
- **CA-06 a CA-09:** loop de informações e retomada do atendimento.
- **CA-10 a CA-12:** terceiro registrado, solicitante notificado e resultado preservado.
- **CA-13 a CA-20:** solução, confirmação, motivo obrigatório, retorno, aprovação e imutabilidade.
- **CA-21 a CA-25:** histórico autorizado, painel restrito, setor, tempo e filtros.

[tests/domain.html](../tests/domain.html) verifica a lógica local, as permissões e os cálculos. [tests/browser_check.py](../tests/browser_check.py) verifica também um ciclo completo pelas telas, incluindo anexos e os três perfis, além do layout desktop/celular. [tests/backend.html](../tests/backend.html) executa o esquema SQL em PostgreSQL em memória e verifica os RPCs, privilégios e a autenticação com respostas de teste. O último teste depende da internet para obter PGlite; a aplicação não depende desse pacote.

A validação com um projeto Supabase real e a verificação de toque/teclado em um celular físico dependem do ambiente do usuário.

## Limites definidos pelo documento

Sem integração com WhatsApp, ERP ou sistemas corporativos; sem atendimento externo, cobrança, pagamentos, resolução por IA, seleção automática de setor, gestão de projetos, controle de ponto ou avaliação individual. Contato com terceiros ocorre fora do sistema. Não foi acrescentado SLA automático, pois o PDF não define prazos.
