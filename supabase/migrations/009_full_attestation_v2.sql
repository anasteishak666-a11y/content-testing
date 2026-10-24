-- Prepare the v2 full attestation server functions. Do not apply to production until approved.
-- Existing version-1 rules and attempts remain valid; this file does not switch the active rule.
begin;

create or replace function private.testing_eligibility(p_employee uuid, p_kind text,
                                            p_at timestamptz)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_open private.attempts%rowtype;
  v_last_passed boolean;
  v_last_retry timestamptz;
  v_last_valid timestamptz;
  v_basic_passed boolean;
  v_override boolean;
  v_rule uuid;
  v_rule_data private.test_rules%rowtype;
  v_count integer;
  v_photo_count integer;
  v_text_count integer;
  v_state text := 'available';
  v_next timestamptz;
begin
  if p_kind not in ('basic', 'full') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  select * into v_open from private.attempts
  where employee_id = p_employee and test_kind = p_kind
    and state = 'in_progress'
  limit 1;
  if found then
    return jsonb_build_object('kind', p_kind, 'state', 'in_progress',
      'can_start', false, 'active_attempt_id', v_open.id,
      'deadline_at', v_open.deadline_at, 'next_allowed_at', null,
      'next_allowed_moscow', null);
  end if;

  select exists (
    select 1 from private.attempts a
    join private.attempt_results r on r.attempt_id = a.id
    where a.employee_id = p_employee and a.test_kind = 'basic' and r.passed
  ) into v_basic_passed;
  select exists (
    select 1 from private.retake_overrides o
    where o.employee_id = p_employee and o.test_kind = p_kind
      and o.used_by_attempt_id is null
  ) into v_override;
  select r.passed, r.retry_available_at, r.valid_until
  into v_last_passed, v_last_retry, v_last_valid
  from private.attempts a
  join private.attempt_results r on r.attempt_id = a.id
  where a.employee_id = p_employee and a.test_kind = p_kind
  order by a.finished_at desc, a.id desc limit 1;

  if p_kind = 'basic' and v_basic_passed then
    v_state := 'passed';
  elsif p_kind = 'full' and not v_basic_passed then
    v_state := 'prerequisite_required';
  elsif v_last_passed and p_kind = 'full' and v_last_valid > p_at
        and not v_override then
    v_state := 'valid_until_due';
    v_next := v_last_valid;
  elsif not v_last_passed and v_last_retry > p_at
        and not v_override then
    v_state := 'cooldown';
    v_next := v_last_retry;
  end if;

  if v_state = 'available' then
    select r.* into v_rule_data from private.active_test_rules a
    join private.test_rules r on r.id = a.rule_id
    where a.test_kind = p_kind;
    v_rule := v_rule_data.id;
    if v_rule is null or
       (p_kind = 'basic' and
        (v_rule_data.question_count <> 20 or
         v_rule_data.duration_seconds <> 1500 or
         v_rule_data.pass_count <> 16 or
         v_rule_data.retry_after <> interval '24 hours')) or
       (p_kind = 'full' and
        (v_rule_data.retry_after <> interval '7 days' or
         v_rule_data.recertification_months <> 3 or
         (v_rule_data.version = 1 and
           (v_rule_data.question_count <> 50 or v_rule_data.duration_seconds <> 4500 or v_rule_data.pass_count <> 45)) or
         (v_rule_data.version = 2 and
           (v_rule_data.question_count <> 30 or v_rule_data.duration_seconds <> 1200 or v_rule_data.pass_count <> 28)) or
         v_rule_data.version not in (1, 2))) then
      v_state := 'bank_unavailable';
    elsif p_kind = 'basic' then
      select count(*) into v_count
      from private.testing_candidates(p_kind, p_employee);
      if v_count < (select r.question_count from private.test_rules r
                    where r.id = v_rule) then
        v_state := 'bank_unavailable';
      end if;
    elsif v_rule_data.version = 2 then
      select count(*) filter (where q.question_type = 'photo_single'),
             count(*) filter (where q.question_type = 'single')
      into v_photo_count, v_text_count
      from private.testing_candidates('full', p_employee) c
      join private.question_versions v on v.id = c.version_id
      join private.questions q on q.id = v.question_id;
      if v_photo_count < 10 or v_text_count < 20 then
        v_state := 'bank_unavailable';
      end if;
    else
      select coalesce(sum(plan.needed), 0) into v_count
      from private.testing_full_plan(v_rule, p_employee) plan;
      if v_count <> (select r.question_count from private.test_rules r
                     where r.id = v_rule) then
        v_state := 'bank_unavailable';
      end if;
    end if;
  end if;
  return jsonb_build_object('kind', p_kind, 'state', v_state,
    'can_start', v_state = 'available', 'active_attempt_id', null,
    'deadline_at', null, 'next_allowed_at', v_next,
    'next_allowed_moscow', private.testing_moscow_label(v_next));
end;
$$;

create or replace function public.testing_start_or_resume(p_actor uuid, p_kind text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_open private.attempts%rowtype;
  v_rule private.test_rules%rowtype;
  v_eligibility jsonb;
  v_versions uuid[] := array[]::uuid[];
  v_cell uuid[];
  v_cell_row record;
  v_override uuid;
  v_started timestamptz;
  v_attempt uuid;
  v_is_reattest boolean;
  v_answered integer;
begin
  if p_kind not in ('basic', 'full') or p_kind is null then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  -- Общая блокировка сотрудника сериализует start и grant. Второй start
  -- увидит созданную первым попытку и вернёт её, не генерируя новый набор.
  perform 1 from public.profiles where user_id = p_actor for update;
  perform private.testing_require_actor(p_actor, 'employee');
  select * into v_open from private.attempts
  where employee_id = p_actor and test_kind = p_kind and state = 'in_progress'
  for update;
  if found then
    if clock_timestamp() >= v_open.deadline_at then
      return private.testing_finalize(v_open.id) ||
        jsonb_build_object('result_url', '/attempts/' || v_open.id || '/result',
                           'server_now', clock_timestamp());
    end if;
    select count(*) into v_answered from private.attempt_questions aq
    join private.attempt_answers aa on aa.attempt_question_id = aq.id
    where aq.attempt_id = v_open.id;
    return jsonb_build_object('attempt_id', v_open.id, 'kind', p_kind,
      'state', 'in_progress', 'resumed', true,
      'question_count', (select question_count from private.test_rules
                         where id = v_open.rule_id),
      'answered_count', v_answered, 'started_at', v_open.started_at,
      'deadline_at', v_open.deadline_at, 'server_now', clock_timestamp());
  end if;
  select * into v_open from private.attempts a
  where a.employee_id = p_actor and a.state = 'in_progress'
    and a.deadline_at <= clock_timestamp() limit 1 for update;
  if found then
    return private.testing_finalize(v_open.id) ||
      jsonb_build_object('result_url', '/attempts/' || v_open.id || '/result',
                         'server_now', clock_timestamp());
  end if;
  if exists (
    select 1 from private.attempts a where a.employee_id = p_actor
      and a.state = 'in_progress'
  ) then
    raise exception 'another_attempt_in_progress' using errcode = 'P0001';
  end if;
  v_eligibility := private.testing_eligibility(p_actor, p_kind,
                                                clock_timestamp());
  if v_eligibility ->> 'state' <> 'available' then
    raise exception '%', v_eligibility ->> 'state' using errcode = 'P0001';
  end if;
  select r.* into v_rule from private.active_test_rules ar
  join private.test_rules r on r.id = ar.rule_id
  where ar.test_kind = p_kind;
  if not found then raise exception 'bank_unavailable' using errcode = 'P0001'; end if;

  if p_kind = 'basic' then
    select array_agg(x.version_id) into v_versions from (
      select c.version_id from private.testing_candidates(p_kind, p_actor) c
      order by c.unseen desc, random() limit v_rule.question_count
    ) x;
  elsif v_rule.version = 2 then
    select array_agg(chosen.version_id) into v_versions from (
      select c.version_id from private.testing_candidates('full', p_actor) c
      join private.question_versions v on v.id = c.version_id
      join private.questions q on q.id = v.question_id
      where q.question_type = 'single'
      order by c.unseen desc, random() limit 20
    ) chosen;
    select array_agg(chosen.version_id) into v_cell from (
      select c.version_id from private.testing_candidates('full', p_actor) c
      join private.question_versions v on v.id = c.version_id
      join private.questions q on q.id = v.question_id
      where q.question_type = 'photo_single'
      order by c.unseen desc, random() limit 10
    ) chosen;
    v_versions := coalesce(v_versions, array[]::uuid[]) || coalesce(v_cell, array[]::uuid[]);
  else
    for v_cell_row in
      select * from private.testing_full_plan(v_rule.id, p_actor)
    loop
      select array_agg(x.version_id) into v_cell from (
        select c.version_id from private.testing_candidates(p_kind, p_actor) c
        where c.topic_slug = v_cell_row.topic_slug
          and c.difficulty = v_cell_row.difficulty
        order by c.unseen desc, random() limit v_cell_row.needed
      ) x;
      v_versions := v_versions || coalesce(v_cell, array[]::uuid[]);
    end loop;
  end if;
  if cardinality(v_versions) is distinct from v_rule.question_count then
    raise exception 'bank_unavailable' using errcode = 'P0001';
  end if;
  select id into v_override from private.retake_overrides
  where employee_id = p_actor and test_kind = p_kind
    and used_by_attempt_id is null for update;
  select exists (
    select 1 from private.attempts a where a.employee_id = p_actor
      and a.test_kind = 'full'
      and exists (select 1 from private.attempt_results r
                  where r.attempt_id = a.id and r.passed)
  ) into v_is_reattest;
  v_started := clock_timestamp();
  insert into private.attempts (
    employee_id, test_kind, rule_id, is_reattest, started_at, deadline_at
  ) values (
    p_actor, p_kind, v_rule.id, p_kind = 'full' and v_is_reattest,
    v_started, v_started + make_interval(secs => v_rule.duration_seconds)
  ) returning id into v_attempt;

  insert into private.attempt_questions (
    attempt_id, position, question_id, question_version_id,
    topic_slug, difficulty
  )
  select v_attempt, row_number() over (order by random())::smallint,
    q.id, v.id, q.topic_slug, q.difficulty
  from unnest(v_versions) as chosen(version_id)
  join private.question_versions v on v.id = chosen.version_id
  join private.questions q on q.id = v.question_id;

  insert into private.attempt_question_options (
    attempt_question_id, question_version_id, option_id, position
  )
  select aq.id, aq.question_version_id, o.id,
    row_number() over (partition by aq.id order by random())::smallint
  from private.attempt_questions aq
  join private.question_options o
    on o.question_version_id = aq.question_version_id
  where aq.attempt_id = v_attempt;
  if v_override is not null then
    update private.retake_overrides set used_by_attempt_id = v_attempt
    where id = v_override;
  end if;
  return jsonb_build_object('attempt_id', v_attempt, 'kind', p_kind,
    'state', 'in_progress', 'resumed', false,
    'question_count', v_rule.question_count, 'answered_count', 0,
    'started_at', v_started,
    'deadline_at', v_started + make_interval(secs => v_rule.duration_seconds),
    'server_now', clock_timestamp());
end;
$$;

create or replace function public.testing_current_question(p_actor uuid, p_attempt uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_attempt private.attempts%rowtype;
  v_question private.attempt_questions%rowtype;
  v_payload jsonb;
  v_now timestamptz;
begin
  perform private.testing_require_actor(p_actor, 'employee');
  select * into v_attempt from private.attempts
  where id = p_attempt and employee_id = p_actor for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_attempt.state <> 'in_progress' then
    return jsonb_build_object('attempt_id', p_attempt, 'state', v_attempt.state,
      'result_url', '/attempts/' || p_attempt || '/result',
      'server_now', clock_timestamp());
  end if;
  v_now := clock_timestamp();
  if v_now >= v_attempt.deadline_at then
    return private.testing_finalize(p_attempt) ||
      jsonb_build_object('result_url', '/attempts/' || p_attempt || '/result',
                         'server_now', clock_timestamp());
  end if;
  select * into v_question from private.attempt_questions aq
  where aq.attempt_id = p_attempt and not exists (
    select 1 from private.attempt_answers aa
    where aa.attempt_question_id = aq.id
  ) order by aq.position limit 1;
  if not found then
    return private.testing_finalize(p_attempt) ||
      jsonb_build_object('result_url', '/attempts/' || p_attempt || '/result',
                         'server_now', clock_timestamp());
  end if;
  select jsonb_build_object(
    'attempt_question_id', v_question.id,
    'type', q.question_type,
    'prompt', v.prompt,
    'topic', t.title,
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object('storage_path', ph.storage_path,
                                         'caption', ph.caption)
                       order by ph.display_order)
      from private.question_photos ph
      where ph.question_version_id = v_question.question_version_id
    ), '[]'::jsonb),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'label', o.label,
        'photo_path', (select ph.storage_path from private.question_photos ph
                       where ph.question_version_id = v_question.question_version_id
                         and ph.display_order = o.display_order))
        order by ao.position)
      from private.attempt_question_options ao
      join private.question_options o on o.id = ao.option_id
      where ao.attempt_question_id = v_question.id
    ), '[]'::jsonb)
  ) into v_payload
  from private.question_versions v
  join private.questions q on q.id = v.question_id
  join private.topics t on t.slug = v_question.topic_slug
  where v.id = v_question.question_version_id;
  return jsonb_build_object('attempt_id', p_attempt,
    'position', v_question.position,
    'question_count', (select r.question_count from private.test_rules r
                       where r.id = v_attempt.rule_id),
    'question', v_payload,
    'deadline_at', v_attempt.deadline_at, 'server_now', v_now,
    'remaining_seconds', greatest(0,
      ceil(extract(epoch from v_attempt.deadline_at - v_now))::integer));
end;
$$;

revoke all on function private.testing_eligibility(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.testing_start_or_resume(uuid, text) from public, anon, authenticated;
revoke all on function public.testing_current_question(uuid, uuid) from public, anon, authenticated;
grant execute on function private.testing_eligibility(uuid, text, timestamptz) to service_role;
grant execute on function public.testing_start_or_resume(uuid, text) to service_role;
grant execute on function public.testing_current_question(uuid, uuid) to service_role;

commit;
