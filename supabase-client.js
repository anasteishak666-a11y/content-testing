"use strict";

// Официальный браузерный SDK загружается только после проверки публичных настроек.
window.createTestingSupabaseClient = async function createTestingSupabaseClient(options = {}) {
  const config = window.TESTING_SUPABASE_CONFIG;
  const url = config?.url?.trim();
  const key = config?.publishableKey?.trim();

  if (!url || !key) {
    throw new Error("Supabase ещё не настроен. Укажите URL проекта и публичный ключ в testing/config.js.");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Адрес проекта Supabase указан неверно. Проверьте testing/config.js.");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(parsedUrl.hostname) ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error("Укажите HTTPS-адрес проекта вида https://имя-проекта.supabase.co.");
  }
  if (!key.startsWith("sb_publishable_")) {
    throw new Error("Нужен публичный ключ Supabase (sb_publishable_…). Секретный ключ использовать нельзя.");
  }

  if (!window.supabase?.createClient) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Не удалось загрузить библиотеку Supabase. Проверьте подключение к интернету."));
      document.head.append(script);
    });
  }
  if (!window.supabase?.createClient) {
    throw new Error("Библиотека Supabase не запустилась. Обновите страницу и попробуйте снова.");
  }

  return window.supabase.createClient(parsedUrl.origin, key, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: options.detectSessionInUrl !== false
    }
  });
};
