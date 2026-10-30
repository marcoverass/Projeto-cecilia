# Contas reais e dados compartilhados

O GitHub Pages hospeda os arquivos do site. O ambiente de produção usa um projeto **Supabase**, com Auth e PostgreSQL, para compartilhar chamados e validar permissões no servidor. Sem essa configuração, o site oferece uma demonstração com dados fictícios salvos apenas no navegador.

## 1. Preparar o projeto

1. Crie um projeto na sua conta em [Supabase](https://supabase.com/dashboard).
2. Abra **SQL Editor** e execute todo o arquivo [schema.sql](../supabase/schema.sql). Use um projeto novo para esta aplicação. O script usa os nomes `app_*` e não remove dados existentes.
3. Em **Authentication**, desative cadastros públicos. Os funcionários recebem contas fornecidas pela administração; eles não escolhem seu próprio setor ou perfil.
4. Nas configurações de URL do Auth, informe a URL do Pages, quando disponível: `https://marcoverass.github.io/Projeto-cecilia/`.
5. Em **Authentication → Users**, crie as contas dos funcionários ou utilize o convite administrativo do Supabase. Configure uma senha pelo procedimento do Auth antes do primeiro acesso ao site. A interface utiliza e-mail e senha; não implementa um fluxo próprio de recuperação ou aceitação de convites.

Não compartilhe a senha do banco, tokens administrativos ou a chave `service_role` no chat, no repositório ou no frontend.

## 2. Vincular cada conta a um perfil

Depois de criar cada conta no Auth, execute no SQL Editor, substituindo o e-mail, o nome e o setor:

```sql
-- Funcionário que abre solicitações
insert into public.app_profiles(id,name,sector_id,roles)
select id,'Nome do funcionário','comercial',array['requester']::text[]
from auth.users where email='funcionario@empresa.com.br';

-- Atendente de TI, que também pode abrir solicitações
insert into public.app_profiles(id,name,sector_id,roles)
select id,'Nome do atendente','ti',array['requester','agent']::text[]
from auth.users where email='atendente@empresa.com.br';

-- Diretoria, que também pode abrir solicitações
insert into public.app_profiles(id,name,sector_id,roles)
select id,'Nome do diretor','diretoria',array['requester','director']::text[]
from auth.users where email='diretor@empresa.com.br';
```

Confira que cada inserção criou uma linha. O e-mail deve corresponder exatamente a uma conta existente no Auth. Uma conta sem perfil ativo não recebe acesso aos dados.

Os papéis disponíveis são `requester`, `agent` e `director`; cada conta pode ter um ou dois papéis, nunca os três. A manutenção dos cadastros é administrativa no Supabase. O sistema não acrescenta um quarto perfil operacional ao PDF.

| ID do setor | Nome | Recebe chamados |
| --- | --- | --- |
| `rh` | Recursos Humanos | Sim |
| `ti` | Tecnologia da Informação | Sim |
| `financeiro` | Financeiro e Contabilidade | Sim |
| `fiscal` | Fiscal e Jurídico | Sim |
| `compras` | Compras | Sim |
| `administrativo` | Administrativo | Sim |
| `infraestrutura` | Infraestrutura / Manutenção | Sim |
| `servicos` | Serviços Gerais | Sim |
| `operacoes` | Operações | Sim |
| `comercial` | Comercial / Vendas | Não |
| `marketing` | Marketing | Não |
| `produto` | Produto | Não |
| `diretoria` | Diretoria | Não |

Para desativar um acesso sem apagar seu histórico:

```sql
update public.app_profiles set active=false where id='UUID_DA_CONTA';
```

## 3. Conectar o frontend

Em [config.js](../config.js), preencha somente a URL do projeto e sua chave pública, disponíveis no painel do Supabase. Aceita chave publishable (`sb_publishable_...`) ou a chave legada `anon`:

```js
export const config = Object.freeze({
  appName: 'Entre setores',
  supabaseUrl: 'https://SEU-PROJETO.supabase.co',
  supabaseAnonKey: 'SUA_CHAVE_PUBLICA',
  allowDemo: false,
});
```

Esses dois valores são públicos. A segurança depende dos RPCs e das permissões do banco, não de esconder a chave pública. O frontend recusa uma chave legada identificada como `service_role`.

Com a configuração preenchida, o site exibe login real e desativa a seleção de perfis fictícios. Uma falha de autenticação ou conexão nunca troca automaticamente para a demonstração. A sessão dura na aba do navegador, com renovação de token; a senha não é armazenada pelo código da aplicação.

Envie a alteração ao GitHub. O workflow publica o frontend atualizado.

## 4. Validar antes de usar na empresa

Entre com contas reais em navegadores separados e verifique:

1. O solicitante vê seu setor e abre um chamado para um setor que atende.
2. Um atendente do setor recebe a notificação, assume e solicita informações.
3. Um atendente de outro setor não vê o chamado nem consegue alterá-lo.
4. A resposta do solicitante aparece no histórico. O atendente pode repetir a solicitação de informações.
5. O acionamento e o resultado do terceiro são registrados sem comunicar com o terceiro pelo sistema.
6. O atendente registra a solução e envia para confirmação. O chamado permanece sem fechamento definitivo.
7. A reprovação exige motivo e permite outra rodada de atendimento.
8. A aprovação finaliza e bloqueia novas alterações operacionais.
9. Somente a diretoria vê os agregados; isso não dá acesso às conversas de outros funcionários.
10. O download de um anexo exige acesso ao chamado.

Os testes locais executam a lógica SQL em PostgreSQL via PGlite, com `auth.uid()` e contas simulados. Eles não substituem essa validação do projeto Supabase, das credenciais e do Auth reais.

## Comportamento e operação

- Notificações são internas ao sistema. No ambiente compartilhado, a aplicação busca atualizações a cada 30 segundos quando a aba está em uso e ao voltar para a aba. Não há integração de e-mail ou WhatsApp.
- Anexos: PDF, PNG, JPEG, WebP, TXT e CSV; 5 MB por arquivo, 10 MB e 20 arquivos por chamado. Os conteúdos são armazenados junto aos registros protegidos no banco. Nenhum link público de anexo é criado.
- Prioridades: baixa, normal, alta e urgente, escolhidas na abertura. O PDF não determina SLA; a aplicação não cria prazo automático nem classificação de atraso.
- Datas são exibidas em Brasília. Tempos usam horas corridas. O filtro gerencial considera a data de abertura. Médias usam somente chamados que já possuem os eventos necessários.
- Tempo de resolução: abertura até a última solução válida. Duração total: abertura até a aprovação definitiva. Espera pela aprovação: última solução até aprovação. Uma reprovação invalida a solução corrente para as médias, preservando todas as tentativas no histórico.
- Os dados de demonstração não são migrados para produção. O banco real começa com os chamados criados pelas contas reais.
- As tabelas têm RLS ativado e acesso direto de `anon` e `authenticated` revogado. Somente os RPCs públicos autorizados executam operações, com perfil ativo conferido no servidor e `search_path` fixo. O histórico não possui endpoint de edição ou exclusão. As mutações do chamado usam bloqueio de linha e transação.
- A administração do projeto mantém acesso ao banco; backups e retenção devem ser configurados nessa conta. A aplicação não exclui automaticamente históricos.

Referências: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [Supabase Auth](https://supabase.com/docs/guides/auth), [permissões e RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
