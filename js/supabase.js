(function () {
  'use strict';

  const config = window.RISHNOVA_CONFIG || {};
  const library = window.supabase;
  const publishableKey = config.supabasePublishableKey || config.supabaseAnonKey || '';
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.supabaseUrl || '')
    && /^(sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.test(publishableKey);

  if (!configured || !library || typeof library.createClient !== 'function') {
    window.RishNovaSupabase = {
      client: null,
      error: !library
        ? 'The Supabase JavaScript client could not be loaded. Check your internet connection and reload.'
        : 'Supabase URL or publishable key is missing or invalid in js/config.js.'
    };
    return;
  }

  const client = library.createClient(config.supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true
    }
  });

  window.RishNovaSupabase = Object.freeze({ client: client, error: null });
})();
