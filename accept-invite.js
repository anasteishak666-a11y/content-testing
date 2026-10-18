"use strict";

const inviteMessage = document.getElementById("invite-message");
const inviteForm = document.getElementById("invite-password-form");
const savePasswordButton = document.getElementById("save-password");
const loginButton = document.getElementById("go-to-login");
let inviteClient = null;
const inviteMarkerKey = "testing-confirmed-invite";
const inviteMarkerLifetime = 60 * 60 * 1000;
const authTimeoutMs = 10000;

function withAuthTimeout(operation) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("auth_timeout")), authTimeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function showInviteMessage(message, isError = false) {
  inviteMessage.textContent = message;
  inviteMessage.classList.toggle("auth-message--error", isError);
}

function clearInviteUrl() {
  if (location.search || location.hash) {
    history.replaceState(null, "", location.pathname);
  }
}

function clearInviteMarker() {
  sessionStorage.removeItem(inviteMarkerKey);
}

function markConfirmedInvitation(userId) {
  sessionStorage.setItem(inviteMarkerKey, JSON.stringify({ userId, expiresAt: Date.now() + inviteMarkerLifetime }));
}

function getConfirmedInviteUserId() {
  try {
    const marker = JSON.parse(sessionStorage.getItem(inviteMarkerKey) || "null");
    if (typeof marker?.userId === "string" && marker.expiresAt > Date.now()) return marker.userId;
  } catch {
    // Повреждённый маркер не даёт права открыть форму.
  }
  clearInviteMarker();
  return null;
}

function showPasswordForm() {
  showInviteMessage("Приглашение подтверждено. Придумайте пароль длиной не менее 12 символов.");
  inviteForm.hidden = false;
  document.getElementById("new-password").focus();
}

function showSupabaseLinkError(code) {
  const expired = code === "otp_expired" || code === "token_expired";
  showInviteMessage(expired
    ? "Срок действия ссылки приглашения истёк. Попросите администратора отправить новое приглашение."
    : "Supabase отклонил ссылку приглашения. Она недействительна или уже использована; попросите новое приглашение.", true);
}

async function confirmInvitation() {
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const hasLinkError = query.has("error") || query.has("error_code") || fragment.has("error") || fragment.has("error_code");
  const tokenHash = query.get("token_hash");
  const code = query.get("code");
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  const linkType = query.get("type") || fragment.get("type");
  const hasImplicitTokens = Boolean(accessToken && refreshToken);
  const hasInviteLink = Boolean(tokenHash || hasImplicitTokens || (code && linkType === "invite"));

  if (hasLinkError) {
    const errorCode = query.get("error_code") || fragment.get("error_code");
    clearInviteUrl();
    showSupabaseLinkError(errorCode);
    return;
  }
  if (!hasInviteLink && (location.search || location.hash)) {
    clearInviteUrl();
    showInviteMessage("В ссылке нет данных для подтверждения приглашения. Попросите администратора отправить новое приглашение.", true);
    return;
  }

  // Прямое открытие без подтверждённого приглашения не требует загрузки SDK и запроса к Auth.
  const markedUserId = hasInviteLink ? null : getConfirmedInviteUserId();
  if (!hasInviteLink && !markedUserId) {
    showInviteMessage("Откройте страницу по ссылке из письма приглашения.", true);
    return;
  }

  try {
    inviteClient = await withAuthTimeout(window.createTestingSupabaseClient({ detectSessionInUrl: false }));
    if (!hasInviteLink) {
      const { data, error } = await withAuthTimeout(inviteClient.auth.getUser());
      if (error || !data?.user || data.user.id !== markedUserId) {
        clearInviteMarker();
        showInviteMessage("Не удалось восстановить подтверждённую сессию приглашения. Попросите новое приглашение.", true);
        return;
      }
      showPasswordForm();
      return;
    }

    let result;
    if (tokenHash) {
      result = await withAuthTimeout(inviteClient.auth.verifyOtp({ token_hash: tokenHash, type: "invite" }));
    } else if (hasImplicitTokens) {
      result = await withAuthTimeout(inviteClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }));
    } else {
      result = await withAuthTimeout(inviteClient.auth.exchangeCodeForSession(code));
    }
    if (result.error || !result.data?.session) {
      clearInviteUrl();
      if (tokenHash && result.error) {
        showSupabaseLinkError(result.error.code);
      } else {
        showInviteMessage("Не удалось восстановить сессию по приглашению. Ссылка могла устареть или уже использоваться; попросите новое приглашение.", true);
      }
      return;
    }
    const { data, error } = await withAuthTimeout(inviteClient.auth.getUser());
    if (error || !data?.user) {
      showInviteMessage("Сессия создана, но проверить пользователя не удалось. Обновите страницу или попросите новое приглашение.", true);
      return;
    }
    markConfirmedInvitation(data.user.id);
    clearInviteUrl();
    showPasswordForm();
  } catch (error) {
    showInviteMessage(error.message === "auth_timeout"
      ? "Превышено время ожидания Supabase. Проверьте подключение и обновите страницу."
      : "Не удалось обработать приглашение. Проверьте подключение и повторите попытку.", true);
  }
}

inviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("new-password").value;
  const repeatPassword = document.getElementById("repeat-password").value;
  if (password.length < 12) {
    showInviteMessage("Пароль должен содержать не менее 12 символов.", true);
    return;
  }
  if (password !== repeatPassword) {
    showInviteMessage("Пароли не совпадают. Повторите ввод.", true);
    return;
  }
  savePasswordButton.disabled = true;
  showInviteMessage("Сохраняем пароль…");
  try {
    const { error } = await withAuthTimeout(inviteClient.auth.updateUser({ password }));
    if (error) {
      showInviteMessage("Не удалось сохранить пароль. Проверьте его и повторите попытку.", true);
      return;
    }
    inviteForm.reset();
    inviteForm.hidden = true;
    clearInviteMarker();
    loginButton.hidden = false;
    showInviteMessage("Пароль установлен. Теперь перейдите ко входу.");
  } catch {
    showInviteMessage("Не удалось сохранить пароль. Проверьте подключение и повторите попытку.", true);
  } finally {
    savePasswordButton.disabled = false;
  }
});

loginButton.addEventListener("click", async () => {
  loginButton.disabled = true;
  try {
    const { error } = await withAuthTimeout(inviteClient.auth.signOut({ scope: "local" }));
    if (error) throw error;
    location.assign("index.html");
  } catch {
    loginButton.disabled = false;
    showInviteMessage("Не удалось завершить текущую сессию. Повторите попытку перехода ко входу.", true);
  }
});

confirmInvitation();
