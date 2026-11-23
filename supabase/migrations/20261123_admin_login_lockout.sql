-- 관리자 비밀번호 5번 실패 시 10분 잠금 (같은 IP 기준)
create table if not exists public.auth_fail (
  ip text primary key,
  fails int not null default 0,
  last_at timestamptz not null default now(),
  locked_until timestamptz
);
alter table public.auth_fail enable row level security;

create or replace function public.auth_fail_hit(p_ip text, p_max int default 5, p_minutes int default 10)
returns table(fails int, locked_until timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  insert into auth_fail as a (ip, fails, last_at) values (p_ip, 1, now())
  on conflict (ip) do update set
    fails = case when a.last_at < now() - make_interval(mins => p_minutes) or (a.locked_until is not null and a.locked_until < now()) then 1 else a.fails + 1 end,
    locked_until = case when a.locked_until is not null and a.locked_until < now() then null else a.locked_until end,
    last_at = now();
  update auth_fail set locked_until = now() + make_interval(mins => p_minutes)
   where ip = p_ip and auth_fail.fails >= p_max and auth_fail.locked_until is null;
  return query select a.fails, a.locked_until from auth_fail a where a.ip = p_ip;
end $$;
revoke all on function public.auth_fail_hit(text,int,int) from public, anon, authenticated;
grant execute on function public.auth_fail_hit(text,int,int) to service_role;
grant select, insert, update, delete on public.auth_fail to service_role;
