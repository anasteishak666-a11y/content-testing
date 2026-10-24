import { createSupabaseContext } from "npm:@supabase/server@1.9.2";

// Supabase keeps verify_jwt enabled for this user-facing function.
// createSupabaseContext({ auth: "user" }) also verifies the caller and gives
// us an identity derived from the JWT, never from the request body.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:8000",
  "https://anasteishak666-a11y.github.io",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 8192;
const PHOTO_URL_SECONDS = 300;
const CORS_HEADERS = "authorization, apikey, x-client-info, content-type, x-retry-count, traceparent, tracestate, baggage";

type JsonRecord = Record<string, unknown>;
type Role = "employee" | "admin";
type Context = NonNullable<Awaited<ReturnType<typeof createSupabaseContext>>["data"]>;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: JsonRecord = {},
  ) {
    super(message);
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function fields(value: unknown, keys: readonly string[]): JsonRecord {
  const source = record(value);
  if (!source) throw unavailable();
  return Object.fromEntries(keys.map((key) => [key, source[key] ?? null]));
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw unavailable();
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw unavailable();
  return value;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ApiError(422, "invalid_request", `Проверьте поле «${name}».`);
  }
  return value;
}

function unavailable(): ApiError {
  return new ApiError(503, "service_unavailable", "Сервис временно недоступен. Повторите попытку позже.");
}

function requireKeys(body: JsonRecord, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in body)) ||
      Object.keys(body).some((key) => !allowed.has(key))) {
    throw new ApiError(422, "invalid_request", "Проверьте данные запроса.");
  }
}

async function jsonBody(req: Request): Promise<JsonRecord> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) {
    throw new ApiError(422, "invalid_request", "Отправьте данные в формате JSON.");
  }
  const length = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length > BODY_LIMIT) {
    throw new ApiError(422, "invalid_request", "Запрос слишком большой.");
  }
  const raw = await req.text();
  if (raw.length > BODY_LIMIT) {
    throw new ApiError(422, "invalid_request", "Запрос слишком большой.");
  }
  try {
    const body = record(JSON.parse(raw));
    if (body) return body;
  } catch {
    // Return the same validation error for invalid JSON and invalid shape.
  }
  throw new ApiError(422, "invalid_request", "Проверьте данные запроса.");
}

function response(req: Request, status: number, payload: JsonRecord): Response {
  const origin = req.headers.get("origin");
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", CORS_HEADERS);
    headers.set("Access-Control-Max-Age", "600");
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function failure(req: Request, error: ApiError): Response {
  return response(req, error.status, {
    error: { code: error.code, message: error.message, retryable: error.status === 503 },
    ...error.extra,
    server_now: new Date().toISOString(),
  });
}

function routePath(url: URL): string {
  // The hosted gateway and local runtime can present either pathname form.
  for (const prefix of ["/functions/v1/testing", "/testing"]) {
    if (url.pathname === prefix) return "/";
    if (url.pathname.startsWith(`${prefix}/`)) return url.pathname.slice(prefix.length);
  }
  return "";
}

function databaseError(error: { code?: string; message?: string }): ApiError {
  // Only these exact, deliberately raised database codes/messages are public.
  const known: Record<string, [number, string, string]> = {
    access_denied: [403, "access_denied", "Доступ к этому действию закрыт."],
    not_found: [404, "not_found", "Запись не найдена."],
    employee_not_found: [404, "employee_not_found", "Сотрудник не найден."],
    invalid_kind: [422, "invalid_kind", "Неизвестный вид теста."],
    invalid_options: [422, "invalid_options", "Проверьте выбранные варианты."],
    invalid_request: [422, "invalid_request", "Проверьте данные запроса."],
    invalid_pagination: [422, "invalid_pagination", "Проверьте параметры истории."],
    invalid_limit: [422, "invalid_limit", "Проверьте размер страницы."],
    invalid_name: [422, "invalid_name", "Укажите имя и фамилию длиной до 100 символов."],
    invalid_note: [422, "invalid_note", "Укажите причину досрочной пересдачи (до 500 символов)."],
    bank_unavailable: [503, "bank_unavailable", "Банк вопросов пока не готов."],
    prerequisite_required: [409, "prerequisite_required", "Сначала пройдите базовый тест."],
    passed: [409, "already_passed", "Базовый тест уже пройден."],
    cooldown: [409, "cooldown_active", "Срок пересдачи ещё не наступил."],
    valid_until_due: [409, "attestation_not_due", "Срок переаттестации ещё не наступил."],
    another_attempt_in_progress: [409, "another_attempt_in_progress", "Сначала завершите открытую попытку."],
    attempt_incomplete: [409, "attempt_incomplete", "Ответьте на оставшиеся вопросы или дождитесь окончания времени."],
    attempt_finished: [409, "attempt_finished", "Попытка уже завершена."],
    question_out_of_order: [409, "question_out_of_order", "Откройте текущий вопрос."],
    answer_locked: [409, "answer_locked", "Подтверждённый ответ изменить нельзя."],
    request_id_conflict: [409, "request_id_conflict", "Этот идентификатор запроса уже использован."],
    result_pending: [409, "result_pending", "Результат ещё не готов."],
    override_not_needed: [409, "override_not_needed", "Досрочная пересдача сейчас не требуется."],
    override_already_open: [409, "override_already_open", "Разрешение на досрочную пересдачу уже выдано."],
  };
  if (error.message && Object.hasOwn(known, error.message)) {
    const [status, code, message] = known[error.message];
    return new ApiError(status, code, message);
  }
  // Unique-request races can reach a constraint before the explicit check.
  if (error.code === "23505") {
    return new ApiError(409, "request_id_conflict", "Запрос уже был обработан. Обновите данные и повторите действие.");
  }
  return unavailable();
}

async function rpc(ctx: Context, name: string, args: JsonRecord): Promise<JsonRecord> {
  const { data, error } = await ctx.supabaseAdmin.rpc(name, args);
  if (error) throw databaseError(error);
  const result = record(data);
  if (!result) throw unavailable();
  return result;
}

async function identity(ctx: Context, role: Role): Promise<string> {
  const actor = ctx.userClaims?.id;
  if (typeof actor !== "string" || !UUID.test(actor)) {
    throw new ApiError(401, "unauthenticated", "Войдите в систему заново.");
  }
  const [profile, userRole] = await Promise.all([
    ctx.supabaseAdmin.from("profiles").select("access_status").eq("user_id", actor).maybeSingle(),
    ctx.supabaseAdmin.from("user_roles").select("role").eq("user_id", actor).maybeSingle(),
  ]);
  if (profile.error || userRole.error) throw unavailable();
  if (profile.data?.access_status !== "active" || userRole.data?.role !== role) {
    throw new ApiError(403, role === "admin" ? "admin_required" : "access_denied",
      "Доступ к этому действию закрыт.");
  }
  return actor;
}

function attemptUrl(id: string, suffix: string): string {
  return `/attempts/${id}/${suffix}`;
}

function expired(req: Request, value: JsonRecord): Response {
  const attemptId = uuid(value.attempt_id, "attempt_id");
  return failure(req, new ApiError(409, "attempt_expired",
    "Время теста истекло. Результат уже сохранён.",
    { result_url: attemptUrl(attemptId, "result") }));
}

function availability(value: JsonRecord): JsonRecord {
  return {
    server_now: value.server_now,
    tests: array(value.tests).map((item) => {
      const test = fields(item, ["kind", "state", "can_start", "active_attempt_id",
        "deadline_at", "next_allowed_at", "next_allowed_moscow"]);
      test.reason = test.state === "passed" ? "basic_already_passed" :
        test.state === "available" || test.state === "in_progress" ? null : test.state;
      return test;
    }),
    attestation: fields(value.attestation, ["status", "valid_until", "valid_until_moscow"]),
  };
}

function adminEmployees(value: JsonRecord): JsonRecord {
  return {
    employees: array(value.employees).map((item) => {
      const employee = fields(item, ["employee_id", "first_name", "last_name",
        "email", "access_status"]);
      employee.employee_id = uuid(employee.employee_id, "employee_id");
      employee.basic = fields(record(item)?.basic, ["state", "latest_percentage"]);
      employee.full = fields(record(item)?.full,
        ["state", "latest_percentage", "valid_until_moscow"]);
      return employee;
    }),
    next_cursor: value.next_cursor ?? null,
    server_now: value.server_now,
  };
}

function start(value: JsonRecord): JsonRecord {
  const id = uuid(value.attempt_id, "attempt_id");
  return {
    attempt: {
      id,
      kind: value.kind,
      state: value.state,
      question_count: value.question_count,
      answered_count: value.answered_count,
      started_at: value.started_at,
      deadline_at: value.deadline_at,
    },
    resumed: value.resumed,
    server_now: value.server_now,
    current_question_url: attemptUrl(id, "current-question"),
  };
}

async function currentQuestion(ctx: Context, value: JsonRecord): Promise<JsonRecord> {
  const question = record(value.question);
  if (!question) throw unavailable();
  const rawOptions = array(question.options).map((item) => {
    const option = record(item);
    if (!option) throw unavailable();
    return option;
  });
  const directPhotoOptions = question.type === "photo_single" &&
    rawOptions.length === 2 && rawOptions.every((option) =>
      typeof option.photo_path === "string" && /^site\/p(?:0[1-9]|1[0-6])-[ab]\.jpg$/.test(option.photo_path));
  const photoItems = directPhotoOptions ? [] : array(question.photos);
  const bucket = Deno.env.get("TESTING_PHOTO_BUCKET");
  if (photoItems.length > 0) {
    if (!bucket) throw unavailable();
    const { data: bucketInfo, error: bucketError } = await ctx.supabaseAdmin.storage.getBucket(bucket);
    if (bucketError || !bucketInfo || bucketInfo.public !== false) throw unavailable();
  }
  const photos = await Promise.all(photoItems.map(async (item) => {
    const photo = record(item);
    const path = photo?.storage_path;
    if (!bucket || typeof path !== "string" || !path ||
        path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
        /[\\?#\u0000-\u001f\u007f]/.test(path)) throw unavailable();
    const { data, error } = await ctx.supabaseAdmin.storage
      .from(bucket).createSignedUrl(path, PHOTO_URL_SECONDS);
    if (error || !data?.signedUrl) throw unavailable();
    return { url: data.signedUrl, caption: photo.caption ?? null };
  }));
  const options = rawOptions.map((option) => {
    const safe = fields(option, ["id", "label"]);
    if (directPhotoOptions) {
      const photoPath = option.photo_path;
      if (typeof photoPath !== "string") {
        throw unavailable();
      }
      safe.photo_url = `./photos/${photoPath.slice(5)}`;
    }
    return safe;
  });
  return {
    attempt_id: value.attempt_id,
    position: value.position,
    question_count: value.question_count,
    question: {
      attempt_question_id: question.attempt_question_id,
      type: question.type,
      prompt: question.prompt,
      topic: question.topic,
      photos,
      options,
    },
    deadline_at: value.deadline_at,
    server_now: value.server_now,
    remaining_seconds: value.remaining_seconds,
  };
}

function result(value: JsonRecord, showBasicReview: boolean): JsonRecord {
  const safe = fields(value, ["attempt_id", "kind", "state", "started_at", "finished_at",
    "correct_count", "question_count", "percentage", "knowledge_level", "passed",
    "outcome", "retry_available_at", "retry_available_moscow", "valid_until",
    "valid_until_moscow"]);
  safe.topics = array(value.topics).map((item) => fields(item,
    ["topic", "correct_count", "question_count", "percentage"]));
  safe.recommendations = array(value.recommendations).map((item) =>
    fields(item, ["topic", "encyclopedia_href"]));
  if (showBasicReview && value.kind === "basic" &&
      (value.state === "completed" || value.state === "timed_out")) {
    safe.review = array(value.review).map((item) => {
      const question = fields(item, ["position", "prompt", "answered",
        "selected_option_ids", "correct_option_ids", "explanation_text"]);
      question.options = array(record(item)?.options).map((option) => fields(option, ["id", "label"]));
      return question;
    });
  }
  return safe;
}

function history(value: JsonRecord, limit: number): JsonRecord {
  const items = array(value.items).map((item) => {
    const row = fields(item, ["attempt_id", "kind", "state", "finished_at", "percentage",
      "knowledge_level", "outcome"]);
    row.topics = array(record(item)?.topics).map((topic) => fields(topic, ["topic", "percentage"]));
    return row;
  });
  const scores = (source: unknown): JsonRecord => {
    const input = record(source);
    if (!input) throw unavailable();
    const output: JsonRecord = {};
    for (const kind of ["basic", "full"]) {
      if (input[kind] !== undefined) {
        output[kind] = fields(input[kind], ["attempt_id", "percentage", "outcome", "finished_at"]);
      }
    }
    return output;
  };
  const last = items.at(-1);
  const nextCursor = items.length === limit && last
    ? encodeCursor(string(last.finished_at), string(last.attempt_id)) : null;
  return { items, latest: scores(value.latest), best: scores(value.best),
    next_cursor: nextCursor, server_now: value.server_now };
}

function encodeCursor(finished: string, id: string): string {
  return btoa(JSON.stringify([finished, id]))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    const decoded = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        typeof decoded[0] !== "string" || !Number.isFinite(Date.parse(decoded[0])) ||
        typeof decoded[1] !== "string" || !UUID.test(decoded[1])) throw Error();
    return [decoded[0], decoded[1]];
  } catch {
    throw new ApiError(422, "invalid_pagination", "Проверьте параметры истории.");
  }
}

async function handle(req: Request, ctx: Context): Promise<Response> {
  const url = new URL(req.url);
  const path = routePath(url);
  const get = req.method === "GET";
  const post = req.method === "POST";

  if (get && path === "/tests/availability") {
    const actor = await identity(ctx, "employee");
    const payload = availability(await rpc(ctx, "testing_availability", { p_actor: actor }));
    return response(req, 200, payload);
  }
  if (get && path === "/admin/employees") {
    const actor = await identity(ctx, "admin");
    const allowed = new Set(["limit", "cursor"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key) ||
        url.searchParams.getAll(key).length !== 1)) {
      throw new ApiError(422, "invalid_pagination", "Проверьте параметры списка сотрудников.");
    }
    const rawLimit = url.searchParams.get("limit") ?? "100";
    if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) {
      throw new ApiError(422, "invalid_pagination", "Проверьте размер страницы.");
    }
    const cursor = url.searchParams.get("cursor");
    const value = await rpc(ctx, "testing_admin_employees", {
      p_actor: actor, p_limit: Number(rawLimit),
      p_after: cursor ? uuid(cursor, "cursor") : null,
    });
    return response(req, 200, adminEmployees(value));
  }
  if (post && path === "/admin/employees/invite") {
    await identity(ctx, "admin");
    const body = await jsonBody(req);
    requireKeys(body, ["email", "first_name", "last_name", "redirect_to"]);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const firstName = typeof body.first_name === "string" ? body.first_name.trim() : "";
    const lastName = typeof body.last_name === "string" ? body.last_name.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320 ||
        !firstName || firstName.length > 100 || !lastName || lastName.length > 100) {
      throw new ApiError(422, "invalid_request", "Укажите email, имя и фамилию сотрудника.");
    }
    let redirect: URL;
    try { redirect = new URL(string(body.redirect_to)); }
    catch { throw new ApiError(422, "invalid_request", "Проверьте адрес страницы приглашения."); }
    if (!ALLOWED_ORIGINS.has(redirect.origin) ||
        !(
          (redirect.origin === "http://localhost:8000" &&
            redirect.pathname === "/accept-invite.html") ||
          (redirect.origin === "https://anasteishak666-a11y.github.io" &&
            redirect.pathname === "/content-testing/accept-invite.html")
        ) ||
        redirect.search || redirect.hash) {
      throw new ApiError(422, "invalid_request", "Проверьте адрес страницы приглашения.");
    }
    const { data, error } = await ctx.supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { first_name: firstName, last_name: lastName }, redirectTo: redirect.href,
    });
    if (error || !data.user) throw unavailable();
    return response(req, 200, {
      employee_id: data.user.id, email: data.user.email,
      first_name: firstName, last_name: lastName, state: "invited",
    });
  }
  const nameUpdate = /^\/admin\/employees\/([^/]+)\/name$/.exec(path);
  if (post && nameUpdate) {
    const actor = await identity(ctx, "admin");
    const employee = uuid(nameUpdate[1], "employee_id");
    const body = await jsonBody(req);
    requireKeys(body, ["first_name", "last_name"]);
    const firstName = typeof body.first_name === "string" ? body.first_name.trim() : "";
    const lastName = typeof body.last_name === "string" ? body.last_name.trim() : "";
    if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) {
      throw new ApiError(422, "invalid_name", "Укажите имя и фамилию длиной до 100 символов.");
    }
    const value = await rpc(ctx, "testing_update_employee_name", {
      p_actor: actor, p_employee: employee, p_first_name: firstName, p_last_name: lastName,
    });
    return response(req, 200, fields(value, ["employee_id", "first_name", "last_name"]));
  }
  if (post && path === "/attempts/start-or-resume") {
    const actor = await identity(ctx, "employee");
    const body = await jsonBody(req);
    requireKeys(body, ["kind"]);
    if (body.kind !== "basic" && body.kind !== "full") {
      throw new ApiError(422, "invalid_kind", "Неизвестный вид теста.");
    }
    const value = await rpc(ctx, "testing_start_or_resume", { p_actor: actor, p_kind: body.kind });
    if (value.state === "timed_out" || value.state === "completed") return expired(req, value);
    if (value.state !== "in_progress") throw unavailable();
    return response(req, 200, start(value));
  }

  const current = /^\/attempts\/([^/]+)\/current-question$/.exec(path);
  if (get && current) {
    const actor = await identity(ctx, "employee");
    const attempt = uuid(current[1], "attempt_id");
    const value = await rpc(ctx, "testing_current_question", { p_actor: actor, p_attempt: attempt });
    if (value.state === "timed_out") return expired(req, value);
    if (value.state === "completed") {
      throw new ApiError(409, "attempt_finished", "Попытка уже завершена.",
        { result_url: attemptUrl(attempt, "result") });
    }
    return response(req, 200, await currentQuestion(ctx, value));
  }

  const answer = /^\/attempts\/([^/]+)\/answers$/.exec(path);
  if (post && answer) {
    const actor = await identity(ctx, "employee");
    const attempt = uuid(answer[1], "attempt_id");
    const body = await jsonBody(req);
    requireKeys(body, ["request_id", "attempt_question_id", "selected_option_ids"]);
    const requestId = uuid(body.request_id, "request_id");
    const question = uuid(body.attempt_question_id, "attempt_question_id");
    if (!Array.isArray(body.selected_option_ids) ||
        body.selected_option_ids.length < 1 || body.selected_option_ids.length > 30) {
      throw new ApiError(422, "invalid_options", "Проверьте выбранные варианты.");
    }
    const options = body.selected_option_ids.map((item) => uuid(item, "selected_option_ids"));
    if (new Set(options).size !== options.length) {
      throw new ApiError(422, "invalid_options", "Выбранные варианты повторяются.");
    }
    const value = await rpc(ctx, "testing_submit_answer", {
      p_actor: actor, p_attempt: attempt, p_request: requestId,
      p_question: question, p_options: options,
    });
    if (value.saved === false) return expired(req, value);
    return response(req, 200, fields(value, ["saved", "already_saved", "request_id",
      "attempt_question_id", "answered_count", "attempt_state", "server_now",
      "next_question_url", "result_url"]));
  }

  const finish = /^\/attempts\/([^/]+)\/finish$/.exec(path);
  if (post && finish) {
    const actor = await identity(ctx, "employee");
    const attempt = uuid(finish[1], "attempt_id");
    const body = await jsonBody(req);
    requireKeys(body, []);
    const value = await rpc(ctx, "testing_finish", { p_actor: actor, p_attempt: attempt });
    return response(req, 200, fields(value,
      ["attempt_id", "state", "finished_at", "result_url", "server_now"]));
  }

  const ownResult = /^\/attempts\/([^/]+)\/result$/.exec(path);
  const adminResult = /^\/admin\/attempts\/([^/]+)\/result$/.exec(path);
  if (get && (ownResult || adminResult)) {
    const isAdmin = Boolean(adminResult);
    const actor = await identity(ctx, isAdmin ? "admin" : "employee");
    const attempt = uuid((adminResult ?? ownResult)![1], "attempt_id");
    const value = await rpc(ctx, "testing_result", { p_actor: actor, p_attempt: attempt });
    return response(req, 200, result(value, !isAdmin));
  }

  const adminHistory = /^\/admin\/employees\/([^/]+)\/attempts\/history$/.exec(path);
  if (get && (path === "/attempts/history" || adminHistory)) {
    const isAdmin = Boolean(adminHistory);
    const actor = await identity(ctx, isAdmin ? "admin" : "employee");
    const employee = isAdmin ? uuid(adminHistory![1], "employee_id") : null;
    const allowed = new Set(["limit", "cursor"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
        [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) {
      throw new ApiError(422, "invalid_pagination", "Проверьте параметры истории.");
    }
    const rawLimit = url.searchParams.get("limit") ?? "50";
    if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) {
      throw new ApiError(422, "invalid_pagination", "Проверьте размер страницы.");
    }
    const limit = Number(rawLimit);
    const cursor = url.searchParams.get("cursor");
    const [beforeFinished, beforeId] = cursor ? decodeCursor(cursor) : [null, null];
    const value = await rpc(ctx, "testing_history", {
      p_actor: actor, p_employee: employee, p_limit: limit,
      p_before_finished: beforeFinished, p_before_id: beforeId,
    });
    return response(req, 200, history(value, limit));
  }

  if (post && path === "/admin/retake-overrides") {
    const actor = await identity(ctx, "admin");
    const body = await jsonBody(req);
    requireKeys(body, ["request_id", "employee_id", "kind", "note"]);
    const requestId = uuid(body.request_id, "request_id");
    const employee = uuid(body.employee_id, "employee_id");
    if (body.kind !== "basic" && body.kind !== "full") {
      throw new ApiError(422, "invalid_kind", "Неизвестный вид теста.");
    }
    if (typeof body.note !== "string" || !body.note.trim() || body.note.trim().length > 500) {
      throw new ApiError(422, "invalid_note", "Укажите причину досрочной пересдачи (до 500 символов).");
    }
    const value = await rpc(ctx, "testing_grant_retake", {
      p_actor: actor, p_employee: employee, p_kind: body.kind,
      p_request: requestId, p_note: body.note.trim(),
    });
    return response(req, 200, fields(value,
      ["override_id", "employee_id", "kind", "granted_at", "used_by_attempt_id"]));
  }

  throw new ApiError(404, "not_found", "Маршрут не найден.");
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return failure(req, new ApiError(403, "origin_denied", "Источник запроса не разрешён."));
  }
  if (req.method === "OPTIONS") {
    const headers = new Headers({ "Vary": "Origin", "Cache-Control": "no-store" });
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", CORS_HEADERS);
      headers.set("Access-Control-Max-Age", "600");
    }
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return failure(req, new ApiError(405, "method_not_allowed", "Метод запроса не поддерживается."));
  }
  try {
    const { data: ctx, error } = await createSupabaseContext(req, { auth: "user" });
    if (error || !ctx) {
      return failure(req, new ApiError(401, "unauthenticated", "Войдите в систему заново."));
    }
    return await handle(req, ctx);
  } catch (error) {
    return failure(req, error instanceof ApiError ? error : unavailable());
  }
});
