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
  const bucketName = 'rishnova-private-uploads';
  const allowedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

  async function getAuthenticatedUser() {
    const result = await client.auth.getUser();
    if (result.error) throw result.error;
    if (!result.data.user) throw new Error('Sign in before accessing private uploads.');
    return result.data.user;
  }

  function safeFileName(name) {
    const result = String(name || 'upload').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-120);
    return result || 'upload';
  }

  window.RishNovaUploads = Object.freeze({
    upload: async function (file) {
      if (!(file instanceof File)) throw new TypeError('Choose a file to upload.');
      if (!allowedTypes.has(file.type)) throw new Error('Only PDF, JPEG, PNG, and WebP files are supported.');
      if (file.size < 1 || file.size > 10 * 1024 * 1024) throw new Error('Files must be no larger than 10 MB.');
      const user = await getAuthenticatedUser();
      const objectPath = user.id + '/' + crypto.randomUUID() + '/' + safeFileName(file.name);
      const result = await client.storage.from(bucketName).upload(objectPath, file, {
        cacheControl: '3600',
        contentType: file.type,
        upsert: false
      });
      if (result.error) throw result.error;
      return result.data.path;
    },
    createSignedUrl: async function (objectPath, expiresInSeconds) {
      const user = await getAuthenticatedUser();
      if (typeof objectPath !== 'string' || !objectPath.startsWith(user.id + '/')) {
        throw new Error('The requested file is not in your private storage folder.');
      }
      const duration = Number.isInteger(expiresInSeconds)
        ? Math.max(60, Math.min(expiresInSeconds, 3600))
        : 300;
      const result = await client.storage.from(bucketName).createSignedUrl(objectPath, duration);
      if (result.error) throw result.error;
      return result.data.signedUrl;
    },
    remove: async function (objectPath) {
      const user = await getAuthenticatedUser();
      if (typeof objectPath !== 'string' || !objectPath.startsWith(user.id + '/')) {
        throw new Error('The requested file is not in your private storage folder.');
      }
      const result = await client.storage.from(bucketName).remove([objectPath]);
      if (result.error) throw result.error;
    }
  });
})();
