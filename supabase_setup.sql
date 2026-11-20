-- Programação Triapack · estrutura do banco (colar no Supabase: SQL Editor → New query → Run)

-- 1) Dados do sistema (máquinas, calendário, pedidos, desenhos, ordem, apontamentos)
create table if not exists public.docs (
  col text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);

-- 2) Usuários e nível de acesso
create table if not exists public.perfis (
  user_id uuid primary key references auth.users on delete cascade,
  nome text,
  email text,
  papel text not null default 'pendente' check (papel in ('pendente','consulta','programador')),
  criado_em timestamptz not null default now()
);

create or replace function public.papel_atual() returns text
language sql stable security definer set search_path = public as $$
  select papel from perfis where user_id = auth.uid()
$$;

-- novo cadastro entra como pendente; o primeiro usuário vira programador
create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfis (user_id, nome, email, papel)
  values (new.id, coalesce(new.raw_user_meta_data->>'nome', split_part(new.email,'@',1)), new.email,
          case when exists (select 1 from perfis where papel = 'programador') then 'pendente' else 'programador' end);
  return new;
end $$;
drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario after insert on auth.users for each row execute function public.novo_usuario();

-- 3) Permissões
alter table public.docs enable row level security;
alter table public.perfis enable row level security;

drop policy if exists "ler dados" on public.docs;
create policy "ler dados" on public.docs for select to authenticated
  using (public.papel_atual() in ('consulta','programador'));

drop policy if exists "programador grava" on public.docs;
create policy "programador grava" on public.docs for all to authenticated
  using (public.papel_atual() = 'programador') with check (public.papel_atual() = 'programador');

drop policy if exists "producao marca produzido" on public.docs;
create policy "producao marca produzido" on public.docs for all to authenticated
  using (col = 'apontamentos' and public.papel_atual() in ('consulta','programador'))
  with check (col = 'apontamentos' and public.papel_atual() in ('consulta','programador'));

drop policy if exists "ver perfis" on public.perfis;
create policy "ver perfis" on public.perfis for select to authenticated
  using (user_id = auth.uid() or public.papel_atual() = 'programador');

drop policy if exists "programador libera acesso" on public.perfis;
create policy "programador libera acesso" on public.perfis for update to authenticated
  using (public.papel_atual() = 'programador') with check (public.papel_atual() = 'programador');

-- 4) Atualização em tempo real para todos que estão com o site aberto
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 5) Usuários que se cadastraram antes deste script: cria o perfil que faltou
--    e, se ainda não houver programador, promove o primeiro cadastrado.
insert into public.perfis (user_id, nome, email, papel)
select u.id, coalesce(u.raw_user_meta_data->>'nome', split_part(u.email,'@',1)), u.email, 'pendente'
from auth.users u
where not exists (select 1 from public.perfis p where p.user_id = u.id);

update public.perfis set papel = 'programador'
where user_id = (select user_id from public.perfis order by criado_em limit 1)
  and not exists (select 1 from public.perfis where papel = 'programador');

-- 6) Libera o acesso das tabelas para o site (projetos novos do Supabase não liberam sozinhos)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.docs to authenticated;
grant select, update on public.perfis to authenticated;
grant execute on function public.papel_atual() to authenticated;
