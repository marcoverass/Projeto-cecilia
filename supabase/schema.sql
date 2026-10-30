-- Entre setores | Run once in the SQL Editor of a new Supabase project.
-- Tables are closed to direct API access. Only the five authenticated RPCs
-- below may read/write them; every RPC checks the active server-side profile.
begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table if not exists public.app_sectors (
  id text primary key,
  name text not null,
  receives boolean not null
);
insert into public.app_sectors(id,name,receives) values
  ('rh','Recursos Humanos',true),('ti','Tecnologia da Informação',true),
  ('financeiro','Financeiro e Contabilidade',true),('fiscal','Fiscal e Jurídico',true),
  ('compras','Compras',true),('administrativo','Administrativo',true),
  ('infraestrutura','Infraestrutura / Manutenção',true),('servicos','Serviços Gerais',true),
  ('operacoes','Operações',true),('comercial','Comercial / Vendas',false),
  ('marketing','Marketing',false),('produto','Produto',false),('diretoria','Diretoria',false)
on conflict(id) do update set name=excluded.name, receives=excluded.receives;

create table if not exists public.app_profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  name text not null check(length(trim(name)) between 2 and 120),
  sector_id text not null references public.app_sectors(id),
  roles text[] not null default array['requester']::text[],
  active boolean not null default true,
  constraint app_roles_valid check (
    cardinality(roles) between 1 and 2
    and roles <@ array['requester','agent','director']::text[]
    and array_position(roles,null) is null
    and (cardinality(roles)=1 or roles[1]<>roles[2])
  ),
  constraint app_sector_can_attend check (
    not ('agent'=any(roles)) or sector_id not in ('comercial','marketing','produto','diretoria')
  )
);
create sequence if not exists public.app_ticket_number_seq;
create table if not exists public.app_tickets (
  id uuid primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  constraint app_ticket_identity check(data->>'id'=id::text),
  constraint app_ticket_status check(data->>'status' in ('open','in_progress','waiting_info','third_party','resolving','resolved','waiting_confirmation','closed'))
);
create index if not exists app_ticket_requester_idx on public.app_tickets((data->>'requesterId'));
create index if not exists app_ticket_sector_idx on public.app_tickets((data->>'sectorId'));
create index if not exists app_ticket_created_idx on public.app_tickets(created_at);
create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_profiles(id) on delete restrict,
  ticket_id uuid not null references public.app_tickets(id) on delete restrict,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists app_notification_user_idx on public.app_notifications(user_id,created_at desc);

alter table public.app_sectors enable row level security;
alter table public.app_profiles enable row level security;
alter table public.app_tickets enable row level security;
alter table public.app_notifications enable row level security;
-- No permissive RLS policies: direct table requests are denied even if a
-- later client accidentally tries using the REST table endpoints.
revoke all on public.app_sectors, public.app_profiles, public.app_tickets, public.app_notifications from public,anon,authenticated;
revoke all on sequence public.app_ticket_number_seq from public,anon,authenticated;

create or replace function app_private.current_profile()
returns public.app_profiles language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.app_profiles;
begin
  if auth.uid() is null then raise exception 'Entre novamente para continuar.' using errcode='42501'; end if;
  select * into v from public.app_profiles where id=auth.uid() and active;
  if not found then raise exception 'Seu acesso está inativo ou ainda não foi cadastrado. Fale com a administração.' using errcode='42501'; end if;
  return v;
end $$;

create or replace function app_private.can_attend(p public.app_profiles,t jsonb)
returns boolean language sql immutable set search_path=public,pg_temp as $$
  select p.active and 'agent'=any(p.roles) and p.sector_id=t->>'sectorId'
$$;
create or replace function app_private.can_view(p public.app_profiles,t jsonb)
returns boolean language sql immutable set search_path=public,pg_temp as $$
  select p.active and (p.id::text=t->>'requesterId' or app_private.can_attend(p,t))
$$;
create or replace function app_private.require_status(t jsonb,allowed text[])
returns void language plpgsql set search_path=public,pg_temp as $$
begin
  if not ((t->>'status')=any(allowed)) then
    raise exception 'Esta ação não está disponível na situação atual do chamado. Atualize a página.' using errcode='22023';
  end if;
end $$;
create or replace function app_private.require_text(value text,minimum integer default 1,maximum integer default 10000)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare clean text:=trim(coalesce(value,''));
begin
  if length(clean)<minimum or length(clean)>maximum then
    raise exception 'Confira o texto informado: use entre % e % caracteres.',minimum,maximum using errcode='22023';
  end if;
  return clean;
end $$;

create or replace function app_private.attachments(files jsonb,previous jsonb default '[]'::jsonb)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare f jsonb; result jsonb:='[]'; total bigint; expected text; name text; mime text; encoded text; actual integer;
begin
  if files is null then return '[]'::jsonb; end if;
  if jsonb_typeof(files)<>'array' or jsonb_array_length(files)+jsonb_array_length(previous)>20 then
    raise exception 'O chamado pode ter até 20 anexos.' using errcode='22023';
  end if;
  select coalesce(sum((a->>'size')::bigint),0) into total from jsonb_array_elements(previous) a;
  for f in select value from jsonb_array_elements(files) loop
    name:=f->>'name'; mime:=f->>'type';
    if name is null or length(name) not between 1 and 180 or name~E'[/\\\\]' or name~'[[:cntrl:]]' then
      raise exception 'O nome de um dos anexos é inválido.' using errcode='22023';
    end if;
    expected:=case lower(substring(name from '\.([^.]+)$'))
      when 'pdf' then 'application/pdf' when 'png' then 'image/png'
      when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg'
      when 'webp' then 'image/webp' when 'txt' then 'text/plain' when 'csv' then 'text/csv' else null end;
    if expected is null or mime is distinct from expected or jsonb_typeof(f->'size') is distinct from 'number' then
      raise exception 'Selecione arquivos PDF, PNG, JPG, WEBP, TXT ou CSV.' using errcode='22023';
    end if;
    if (f->>'size')::numeric<0 or (f->>'size')::numeric>5242880 or (f->>'size')::numeric<>trunc((f->>'size')::numeric) then
      raise exception 'Cada anexo deve ter no máximo 5 MB.' using errcode='22023';
    end if;
    if f->>'data' is null or left(f->>'data',length('data:'||mime||';base64,'))<>'data:'||mime||';base64,' then
      raise exception 'O conteúdo de um dos anexos é inválido.' using errcode='22023';
    end if;
    encoded:=substring(f->>'data' from length('data:'||mime||';base64,')+1);
    if length(encoded)>6990508 or encoded!~'^[A-Za-z0-9+/]*={0,2}$' then
      raise exception 'Não foi possível ler o conteúdo de um dos anexos.' using errcode='22023';
    end if;
    begin actual:=octet_length(decode(encoded,'base64'));
    exception when others then raise exception 'O conteúdo de um dos anexos está incompleto.' using errcode='22023'; end;
    if actual<>(f->>'size')::integer then raise exception 'O tamanho do anexo não corresponde ao conteúdo.' using errcode='22023'; end if;
    total:=total+actual;
    if total>10485760 then raise exception 'Os anexos do chamado podem somar até 10 MB.' using errcode='22023'; end if;
    result:=result||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'name',name,'type',mime,'size',actual,'data',f->>'data'));
  end loop;
  return result;
end $$;

create or replace function app_private.notify(t jsonb,actor public.app_profiles,action text,at_time timestamptz)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare heading text;
begin
  heading:=case action
    when 'created' then 'Novo chamado para o setor' when 'claim' then 'Atendimento iniciado'
    when 'request_info' then 'O setor precisa de mais informações' when 'message' then 'Nova mensagem no chamado'
    when 'third_party' then 'Atendimento depende de um terceiro' when 'third_party_result' then 'Resultado do atendimento externo registrado'
    when 'start_resolution' then 'Seu chamado está em resolução' when 'resolve' then 'Uma solução foi registrada'
    when 'submit' then 'Uma solução espera sua confirmação' when 'approve' then 'Solução aprovada e chamado finalizado'
    when 'reject' then 'Solução não aprovada: atendimento retomado' else 'Atualização no chamado' end;
  insert into public.app_notifications(user_id,ticket_id,title,body,created_at)
  select p.id,(t->>'id')::uuid,heading,(t->>'code')||' · '||(t->>'title'),at_time
  from public.app_profiles p where p.active and p.id<>actor.id and (
    ((action='created' or actor.id::text=t->>'requesterId') and app_private.can_attend(p,t))
    or (action<>'created' and actor.id::text<>t->>'requesterId' and p.id::text=t->>'requesterId')
  );
end $$;

create or replace function public.app_snapshot()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.app_profiles; output jsonb;
begin
  p:=app_private.current_profile();
  with visible as (select data from public.app_tickets where app_private.can_view(p,data)),
  people as (
    select q.* from public.app_profiles q where q.id=p.id or exists (
      select 1 from visible v where v.data->>'requesterId'=q.id::text or v.data->>'assignedTo'=q.id::text
      or exists(select 1 from jsonb_array_elements(v.data->'events') e where e->>'actorId'=q.id::text)
    )
  )
  select jsonb_build_object(
    'user',jsonb_build_object('id',p.id,'name',p.name,'email',(select email from auth.users where id=p.id),'sectorId',p.sector_id,'roles',to_jsonb(p.roles),'active',p.active),
    'users',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'sectorId',sector_id,'roles',to_jsonb(roles),'active',active)) from people),'[]'::jsonb),
    'sectors',(select jsonb_agg(jsonb_build_object('id',id,'name',name,'receives',receives) order by name) from public.app_sectors),
    'tickets',coalesce((select jsonb_agg(data order by data->>'updatedAt' desc) from visible),'[]'::jsonb),
    'notifications',coalesce((select jsonb_agg(jsonb_build_object('id',id,'userId',user_id,'ticketId',ticket_id,'title',title,'body',body,'createdAt',created_at,'readAt',read_at) order by created_at desc) from public.app_notifications where user_id=p.id),'[]'::jsonb)
  ) into output;
  return output;
end $$;

create or replace function public.app_create_ticket(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.app_profiles; t jsonb; files jsonb; ticket_id uuid:=gen_random_uuid(); at_time timestamptz:=clock_timestamp();
  code text; target_name text; title text; description text; priority text; serial_number bigint;
begin
  p:=app_private.current_profile();
  title:=app_private.require_text(p_payload->>'title',3,160);
  description:=app_private.require_text(p_payload->>'description',10,10000);
  priority:=coalesce(p_payload->>'priority','normal');
  if priority not in ('low','normal','high','urgent') then raise exception 'Selecione uma prioridade válida.' using errcode='22023'; end if;
  select name into target_name from public.app_sectors where id=p_payload->>'sectorId' and receives;
  if not found then raise exception 'Selecione um setor que receba chamados.' using errcode='22023'; end if;
  files:=app_private.attachments(p_payload->'attachments');
  serial_number:=nextval('public.app_ticket_number_seq');
  code:='SEC-'||to_char(at_time at time zone 'America/Sao_Paulo','YYYY')||'-'||lpad(serial_number::text,greatest(4,length(serial_number::text)),'0');
  t:=jsonb_build_object('id',ticket_id,'code',code,'title',title,'description',description,'priority',priority,
    'sectorId',p_payload->>'sectorId','requesterId',p.id,'requesterSectorId',p.sector_id,'assignedTo',null,
    'status','open','createdAt',at_time,'updatedAt',at_time,'firstResponseAt',null,'resolvedAt',null,'closedAt',null,'reopenCount',0,
    'attachments',files,'events',jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid(),'type','created','actorId',p.id,'actorName',p.name,'at',at_time,'text','Chamado aberto.','status','open'),
      jsonb_build_object('id',gen_random_uuid(),'type','forwarded','actorId',p.id,'actorName',p.name,'at',at_time,'text','Encaminhado para '||target_name||'.','status','open')
    ));
  insert into public.app_tickets(id,data,created_at) values(ticket_id,t,at_time);
  perform app_private.notify(t,p,'created',at_time);
  return public.app_snapshot();
end $$;

create or replace function public.app_ticket_action(p_ticket_id uuid,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.app_profiles; t jsonb; files jsonb; event jsonb; meta jsonb:='{}';
  at_time timestamptz:=clock_timestamp(); text_value text:=''; current_status text; next_status text;
  requester boolean; attendant boolean; assigned boolean; first_response boolean:=false;
begin
  p:=app_private.current_profile();
  select data into t from public.app_tickets where id=p_ticket_id for update;
  if not found or not app_private.can_view(p,t) then raise exception 'Chamado indisponível para este perfil.' using errcode='42501'; end if;
  current_status:=t->>'status'; next_status:=current_status;
  if current_status='closed' then raise exception 'Este chamado foi finalizado e não permite novas alterações.' using errcode='22023'; end if;
  requester:=t->>'requesterId'=p.id::text;
  attendant:=app_private.can_attend(p,t);
  assigned:=attendant and t->>'assignedTo'=p.id::text;
  if p_action in ('request_info','third_party','third_party_result','start_resolution','resolve','submit')
    and not coalesce(assigned,false) then raise exception 'Assuma o chamado para realizar esta ação.' using errcode='42501'; end if;
  files:=app_private.attachments(p_payload->'attachments',t->'attachments');
  if p_action<>'message' and jsonb_array_length(files)>0 then raise exception 'Envie os anexos junto de uma mensagem.' using errcode='22023'; end if;
  case p_action
    when 'claim' then
      if not attendant or (t->>'assignedTo' is not null and t->>'assignedTo'<>p.id::text) then raise exception 'Este chamado não está disponível para você assumir.' using errcode='42501'; end if;
      perform app_private.require_status(t,array['open','waiting_info']);
      text_value:=case when t->>'assignedTo' is null then 'Chamado recebido e atendimento iniciado.' else 'Atendimento retomado.' end;
      t:=t||jsonb_build_object('assignedTo',p.id); next_status:='in_progress';
    when 'request_info' then
      perform app_private.require_status(t,array['in_progress','waiting_info','resolving']);
      text_value:=app_private.require_text(p_payload->>'text'); next_status:='waiting_info'; first_response:=true;
    when 'message' then
      if not requester and not coalesce(assigned,false) then raise exception 'Assuma o chamado para participar da conversa.' using errcode='42501'; end if;
      text_value:=trim(coalesce(p_payload->>'text',''));
      if length(text_value)>10000 or (text_value='' and jsonb_array_length(files)=0) then raise exception 'Escreva uma mensagem ou selecione um anexo.' using errcode='22023'; end if;
      if jsonb_array_length(files)>0 then
        t:=t||jsonb_build_object('attachments',(t->'attachments')||files);
        meta:=jsonb_build_object('attachmentIds',(select jsonb_agg(f->>'id') from jsonb_array_elements(files) f));
      end if;
      first_response:=attendant and not requester;
    when 'third_party' then
      perform app_private.require_status(t,array['in_progress','resolving']);
      text_value:=app_private.require_text(p_payload->>'text');
      meta:=jsonb_build_object('thirdPartyName',app_private.require_text(p_payload->>'thirdPartyName',1,160));
      next_status:='third_party'; first_response:=true;
    when 'third_party_result' then
      perform app_private.require_status(t,array['third_party']);
      text_value:=app_private.require_text(p_payload->>'text'); next_status:='in_progress'; first_response:=true;
    when 'start_resolution' then
      perform app_private.require_status(t,array['in_progress']); text_value:='Resolução em andamento.'; next_status:='resolving';
    when 'resolve' then
      perform app_private.require_status(t,array['in_progress','resolving']);
      text_value:=app_private.require_text(p_payload->>'text'); next_status:='resolved'; first_response:=true;
      t:=t||jsonb_build_object('resolvedAt',at_time);
    when 'submit' then
      perform app_private.require_status(t,array['resolved']);
      if t->>'resolvedAt' is null then raise exception 'Registre a solução antes de pedir a confirmação.' using errcode='22023'; end if;
      text_value:='Atendimento encerrado pelo setor. Aguardando a confirmação do solicitante.'; next_status:='waiting_confirmation';
    when 'approve' then
      if not requester then raise exception 'Somente o solicitante pode aprovar a solução.' using errcode='42501'; end if;
      perform app_private.require_status(t,array['waiting_confirmation']);
      text_value:='Solução aprovada. Chamado finalizado.'; next_status:='closed'; t:=t||jsonb_build_object('closedAt',at_time);
    when 'reject' then
      if not requester then raise exception 'Somente o solicitante pode reprovar a solução.' using errcode='42501'; end if;
      perform app_private.require_status(t,array['waiting_confirmation']);
      text_value:=app_private.require_text(p_payload->>'text'); next_status:='waiting_info';
      t:=t||jsonb_build_object('resolvedAt',null,'reopenCount',(t->>'reopenCount')::integer+1);
    else raise exception 'Ação desconhecida.' using errcode='22023';
  end case;
  if first_response and t->>'firstResponseAt' is null then t:=t||jsonb_build_object('firstResponseAt',at_time); end if;
  event:=jsonb_build_object('id',gen_random_uuid(),'type',p_action,'actorId',p.id,'actorName',p.name,'at',at_time,'text',text_value,'status',next_status,'meta',meta);
  t:=t||jsonb_build_object('status',next_status,'updatedAt',at_time,'events',(t->'events')||jsonb_build_array(event));
  update public.app_tickets set data=t where id=p_ticket_id;
  perform app_private.notify(t,p,p_action,at_time);
  return public.app_snapshot();
end $$;

create or replace function public.app_mark_read(p_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.app_profiles;
begin
  p:=app_private.current_profile();
  update public.app_notifications set read_at=clock_timestamp() where user_id=p.id and read_at is null and (p_id is null or id=p_id);
  return public.app_snapshot();
end $$;

create or replace function public.app_metrics(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.app_profiles; date_from date; date_to date; sector text; result jsonb;
begin
  p:=app_private.current_profile();
  if not ('director'=any(p.roles)) then raise exception 'Os indicadores estão disponíveis apenas para diretor ou gestor.' using errcode='42501'; end if;
  date_from:=nullif(p_filters->>'from','')::date; date_to:=nullif(p_filters->>'to','')::date;
  if date_from>date_to then raise exception 'Selecione um período válido.' using errcode='22023'; end if;
  sector:=nullif(p_filters->>'sectorId','');
  if sector='all' then sector:=null; end if;
  if sector is not null and not exists(select 1 from public.app_sectors where id=sector and receives) then raise exception 'Setor inválido.' using errcode='22023'; end if;
  with filtered as (
    select data d,created_at,
      (data->>'resolvedAt')::timestamptz resolved_at,
      (data->>'closedAt')::timestamptz closed_at,
      (data->>'firstResponseAt')::timestamptz first_response_at
    from public.app_tickets where
      (date_from is null or created_at>=date_from::timestamp at time zone 'America/Sao_Paulo')
      and (date_to is null or created_at<(date_to+1)::timestamp at time zone 'America/Sao_Paulo')
      and (sector is null or data->>'sectorId'=sector)
  ), per_sector as (
    select s.id,count(f.d) received,count(f.d) filter(where f.d->>'status'='closed') finalized,
      round(avg(extract(epoch from (f.resolved_at-f.created_at))*1000)) mean_time
    from public.app_sectors s left join filtered f on f.d->>'sectorId'=s.id
    where s.receives and (sector is null or s.id=sector) group by s.id
  ), bounds as (
    select coalesce(date_from,min((created_at at time zone 'America/Sao_Paulo')::date)) first_date,
      coalesce(date_to,max((created_at at time zone 'America/Sao_Paulo')::date)) last_date from filtered
  ), dates as (
    select generate_series(first_date::timestamp,last_date::timestamp,interval '1 day')::date as date_key from bounds where exists(select 1 from filtered)
  ), period as (
    select dates.date_key,count(f.d) as volume from dates left join filtered f on (f.created_at at time zone 'America/Sao_Paulo')::date=dates.date_key group by dates.date_key
  )
  select jsonb_build_object(
    'total',count(*),'open',count(*) filter(where d->>'status'='open'),
    'inProgress',count(*) filter(where d->>'status' in ('in_progress','resolving','resolved','third_party')),
    'waitingInfo',count(*) filter(where d->>'status'='waiting_info'),
    'waitingConfirmation',count(*) filter(where d->>'status'='waiting_confirmation'),
    'finalized',count(*) filter(where d->>'status'='closed'),
    'thirdPartyCount',count(*) filter(where exists(select 1 from jsonb_array_elements(d->'events') e where e->>'type'='third_party')),
    'reopenedCount',count(*) filter(where (d->>'reopenCount')::integer>0),
    'firstResponseMs',round(avg(extract(epoch from(first_response_at-created_at))*1000)),
    'resolutionMs',round(avg(extract(epoch from(resolved_at-created_at))*1000)),
    'durationMs',round(avg(extract(epoch from(closed_at-created_at))*1000) filter(where d->>'status'='closed')),
    'approvalMs',round(avg(extract(epoch from(closed_at-resolved_at))*1000) filter(where d->>'status'='closed')),
    'bySector',coalesce((select jsonb_agg(jsonb_build_object('sectorId',id,'received',received,'finalized',finalized,'meanServiceMs',mean_time) order by id) from per_sector),'[]'::jsonb),
    'byPeriod',coalesce((select jsonb_agg(jsonb_build_object('date',date_key,'count',volume) order by date_key) from period),'[]'::jsonb)
  ) into result from filtered;
  return result;
end $$;

-- PostgreSQL grants EXECUTE to PUBLIC by default. Explicitly close every helper
-- and every RPC first, then grant only the intended entry points.
revoke all on all functions in schema app_private from public,anon,authenticated;
revoke all on function public.app_snapshot() from public,anon,authenticated;
revoke all on function public.app_create_ticket(jsonb) from public,anon,authenticated;
revoke all on function public.app_ticket_action(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.app_mark_read(uuid) from public,anon,authenticated;
revoke all on function public.app_metrics(jsonb) from public,anon,authenticated;
grant execute on function public.app_snapshot() to authenticated;
grant execute on function public.app_create_ticket(jsonb) to authenticated;
grant execute on function public.app_ticket_action(uuid,text,jsonb) to authenticated;
grant execute on function public.app_mark_read(uuid) to authenticated;
grant execute on function public.app_metrics(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
