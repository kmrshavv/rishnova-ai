(function () {
  'use strict';

  const screen = document.getElementById('auth-screen');
  const app = document.getElementById('app-shell');
  const form = document.getElementById('auth-form');
  const nameInput = document.getElementById('auth-name');
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  const confirmInput = document.getElementById('auth-password-confirm');
  const title = document.getElementById('auth-title');
  const description = document.getElementById('auth-description');
  const submit = document.getElementById('auth-submit');
  const notice = document.getElementById('auth-notice');
  const resend = document.getElementById('auth-resend');
  const continueButton = document.getElementById('auth-continue');
  const toggle = document.getElementById('auth-toggle');
  const forgot = document.getElementById('auth-forgot');
  const nameField = document.getElementById('auth-name-field');
  const confirmField = document.getElementById('auth-password-confirm-field');
  const supabase = window.RishNovaSupabase;
  const client = supabase && supabase.client;
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const callbackErrorCode = query.get('error_code') || fragment.get('error_code') || '';
  const callbackError = query.get('error') || fragment.get('error') || '';
  const callbackDescription = query.get('error_description') || fragment.get('error_description') || '';
  let callbackFailed = Boolean(callbackError || callbackErrorCode);
  let verificationCallback = query.get('type') === 'signup' || fragment.get('type') === 'signup' ||
    (query.has('code') && query.get('flow') !== 'recovery');
  const pendingVerificationEmail = sessionStorage.getItem('rishnova-pending-verification-email') || '';
  let session = null;
  let mode = query.get('flow') === 'recovery' || query.get('type') === 'recovery'
    ? 'reset'
    : query.get('mode') === 'signup'
      ? 'signup'
      : 'login';
  let busy = false;
  let recovering = mode === 'reset';
  let activatedUserId = null;
  let verificationSession = null;
  let resendTimer = null;
  let resendInFlight = false;
  const activations = new Map();
  if (location.hash === '#dashboard' && !recovering) {
    history.replaceState(null, '', location.pathname + location.search);
  }

  function showNotice(message, error) {
    notice.textContent = message;
    notice.classList.toggle('error', Boolean(error));
    notice.hidden = !message;
  }

  function setPendingVerificationEmail(email) {
    if (email) {
      sessionStorage.setItem('rishnova-pending-verification-email', email);
    } else {
      sessionStorage.removeItem('rishnova-pending-verification-email');
    }
  }

  function showResend(email) {
    const savedEmail = email || sessionStorage.getItem('rishnova-pending-verification-email') || '';
    resend.hidden = false;
    if (savedEmail && !emailInput.value) emailInput.value = savedEmail;
    updateResendButton();
  }

  function hideResend() {
    resend.hidden = true;
    if (resendTimer) {
      clearInterval(resendTimer);
      resendTimer = null;
    }
  }

  function updateResendButton() {
    if (resend.hidden) return;
    const cooldownUntil = Number(sessionStorage.getItem('rishnova-resend-cooldown-until') || 0);
    const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    resend.disabled = resendInFlight || seconds > 0;
    resend.textContent = resendInFlight
      ? 'Sending...'
      : seconds > 0
        ? 'Resend confirmation email (' + seconds + 's)'
        : 'Resend confirmation email';
    if (resendTimer) {
      clearInterval(resendTimer);
      resendTimer = null;
    }
    if (seconds > 0) {
      resendTimer = setInterval(updateResendButton, 1000);
    }
  }

  function cleanAuthCallbackUrl() {
    const cleanUrl = new URL(location.href);
    ['error', 'error_code', 'error_description', 'type', 'code', 'flow', 'mode'].forEach(function (key) {
      cleanUrl.searchParams.delete(key);
    });
    cleanUrl.hash = '';
    history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search);
  }

  function callbackErrorMessage(code, error, description) {
    const value = (code + ' ' + error + ' ' + description).toLowerCase();
    if (value.includes('otp_expired') || value.includes('expired')) {
      return 'This confirmation link has expired. Request a new confirmation email to continue.';
    }
    if (value.includes('already_used') || value.includes('already been used') || value.includes('token_already_used')) {
      return 'This confirmation link has already been used. Try signing in; if needed, request a new confirmation email.';
    }
    if (value.includes('otp_invalid') || value.includes('token_not_found') ||
        value.includes('token_invalid') || value.includes('invalid') || value.includes('access_denied')) {
      return 'This confirmation link is invalid or no longer active. Request a new confirmation email to continue.';
    }
    return 'We could not confirm your email with this link. Request a new confirmation email or try signing in.';
  }

  function setMode(nextMode, updateUrl) {
    mode = nextMode;
    if (updateUrl) {
      const nextUrl = new URL(location.href);
      nextUrl.searchParams.delete('mode');
      nextUrl.searchParams.delete('flow');
      nextUrl.searchParams.delete('type');
      if (mode === 'signup') nextUrl.searchParams.set('mode', 'signup');
      history.replaceState(null, '', nextUrl.pathname + nextUrl.search + nextUrl.hash);
    }
    renderMode();
  }

  function renderMode() {
    const reset = mode === 'reset';
    const signup = mode === 'signup';
    const forgotPassword = mode === 'forgot';
    nameField.hidden = !signup;
    nameInput.required = signup;
    confirmField.hidden = !signup;
    confirmInput.required = signup;
    document.getElementById('auth-email-field').hidden = reset;
    emailInput.hidden = reset;
    emailInput.required = !reset;
    passwordInput.hidden = forgotPassword;
    passwordInput.required = !forgotPassword;
    passwordInput.autocomplete = reset || signup ? 'new-password' : 'current-password';
    passwordInput.minLength = 8;
    confirmInput.value = '';
    forgot.hidden = mode !== 'login';
    toggle.hidden = reset || forgotPassword;
    document.getElementById('auth-back').hidden = mode === 'login' || signup;
    title.textContent = reset
      ? 'Choose a new password'
      : forgotPassword
        ? 'Reset your password'
        : signup
          ? 'Create your account'
          : 'Welcome back';
    description.textContent = reset
      ? 'Enter a new password for your RishNova account.'
      : forgotPassword
        ? 'We will email you a secure password reset link.'
        : signup
          ? 'Create an account to save your private conversations.'
          : 'Sign in to continue to your private AI workspace.';
    submit.textContent = reset
      ? 'Update password'
      : forgotPassword
        ? 'Send reset link'
        : signup
          ? 'Create account'
          : 'Sign in';
    toggle.textContent = signup ? 'Already have an account? Sign in' : 'New to RishNova? Create an account';
    showNotice('', false);
    if (mode !== 'login') {
      hideResend();
      continueButton.hidden = true;
    }
  }

  function setBusy(value) {
    busy = value;
    submit.disabled = value;
    form.setAttribute('aria-busy', String(value));
    submit.textContent = value
      ? 'Please wait...'
      : mode === 'signup'
        ? 'Create account'
        : mode === 'forgot'
          ? 'Send reset link'
          : mode === 'reset'
            ? 'Update password'
            : 'Sign in';
  }

  function authRedirectUrl(flow) {
    const url = new URL(window.RISHNOVA_CONFIG.authRedirectUrl);
    if (flow) url.searchParams.set('flow', flow);
    return url.toString();
  }

  async function ensureProfile(user) {
    const fullName = user.user_metadata && typeof user.user_metadata.full_name === 'string'
      ? user.user_metadata.full_name.trim().slice(0, 100)
      : '';
    const result = await client.from('profiles').upsert({
      id: user.id,
      email: user.email || '',
      full_name: fullName,
      avatar_url: ''
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (result.error) throw result.error;
  }

  async function applySession(nextSession) {
    const previousUserId = session && session.user && session.user.id;
    session = nextSession;
    if (!nextSession) {
      activatedUserId = null;
      verificationSession = null;
      continueButton.hidden = true;
      screen.hidden = false;
      app.hidden = true;
      if (location.hash === '#dashboard') {
        history.replaceState(null, '', location.pathname + location.search);
      }
      if (previousUserId) window.dispatchEvent(new CustomEvent('rishnova:signedout'));
      return;
    }

    if (callbackFailed) {
      screen.hidden = false;
      app.hidden = true;
      return;
    }

    if (recovering) {
      screen.hidden = false;
      app.hidden = true;
      return;
    }

    const user = nextSession.user;
    if (verificationSession && verificationSession.user.id === user.id) {
      screen.hidden = false;
      app.hidden = true;
      return;
    }
    const isVerifiedSignup = verificationCallback && user.email_confirmed_at;
    verificationCallback = false;
    if (isVerifiedSignup) {
      setPendingVerificationEmail('');
      verificationSession = nextSession;
      cleanAuthCallbackUrl();
      screen.hidden = false;
      app.hidden = true;
      setMode('login', false);
      hideResend();
      continueButton.hidden = false;
      showNotice('Your email has been successfully verified. Welcome to RishNova AI!', false);
      return;
    }
    if (activatedUserId === user.id) {
      screen.hidden = true;
      app.hidden = false;
      return;
    }
    if (activations.has(user.id)) {
      await activations.get(user.id);
      return;
    }

    const activation = ensureProfile(user);
    activations.set(user.id, activation);
    try {
      await activation;
      if (!session || session.user.id !== user.id || recovering) return;
      activatedUserId = user.id;
      screen.hidden = true;
      app.hidden = false;
      const dashboardUrl = new URL(location.href);
      dashboardUrl.searchParams.delete('mode');
      dashboardUrl.searchParams.delete('flow');
      dashboardUrl.searchParams.delete('type');
      dashboardUrl.hash = 'dashboard';
      history.replaceState(null, '', dashboardUrl.pathname + dashboardUrl.search + dashboardUrl.hash);
      window.dispatchEvent(new CustomEvent('rishnova:authenticated', { detail: { user: user } }));
    } catch (error) {
      showNotice('Your session is active, but profile setup failed: ' + (error.message || 'Please try again.'), true);
      screen.hidden = false;
      app.hidden = true;
    } finally {
      activations.delete(user.id);
    }
  }

  function friendlyAuthError(error) {
    const message = error && error.message ? error.message : 'Authentication failed. Please try again.';
    if (/already registered|already exists|user exists/i.test(message)) {
      return 'An account may already exist for this email. Try signing in or resetting your password.';
    }
    if (/invalid login credentials/i.test(message)) return 'Email or password is incorrect.';
    if (/email not confirmed/i.test(message)) return 'Verify your email using the link we sent before signing in.';
    if (/rate limit|too many requests/i.test(message)) return 'Too many requests. Please wait a little while before trying again.';
    return message;
  }

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!client || busy) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (mode !== 'reset' && !validEmail(email)) {
      showNotice('Enter a valid email address.', true);
      emailInput.focus();
      return;
    }
    if (mode !== 'forgot' && password.length < 8) {
      showNotice('Your password must be at least 8 characters long.', true);
      passwordInput.focus();
      return;
    }
    if (mode === 'signup' && !nameInput.value.trim()) {
      showNotice('Enter your full name.', true);
      nameInput.focus();
      return;
    }
    if (mode === 'signup' && password !== confirmInput.value) {
      showNotice('The passwords do not match.', true);
      confirmInput.focus();
      return;
    }

    setBusy(true);
    showNotice('', false);
    try {
      if (mode === 'signup') {
        setPendingVerificationEmail(email);
        const result = await client.auth.signUp({
          email: email,
          password: password,
          options: {
            data: { full_name: nameInput.value.trim().slice(0, 100) },
            emailRedirectTo: authRedirectUrl(null)
          }
        });
        if (result.error) throw result.error;
        if (result.data.session) {
          await applySession(result.data.session);
        } else {
          setMode('login', true);
          showResend(email);
          showNotice('Registration received. Check your email and verify your address before signing in.', false);
        }
      } else if (mode === 'forgot') {
        const result = await client.auth.resetPasswordForEmail(email, {
          redirectTo: authRedirectUrl('recovery')
        });
        if (result.error) throw result.error;
        showNotice('If an account exists for that address, a password reset link is on its way.', false);
      } else if (mode === 'reset') {
        const result = await client.auth.updateUser({ password: password });
        if (result.error) throw result.error;
        recovering = false;
        await client.auth.signOut();
        history.replaceState(null, '', location.pathname);
        setMode('login', false);
        showNotice('Your password has been updated. Sign in with your new password.', false);
      } else {
        const result = await client.auth.signInWithPassword({ email: email, password: password });
        if (result.error) throw result.error;
        callbackFailed = false;
        resend.hidden = true;
        await applySession(result.data.session);
      }
    } catch (error) {
      if (mode === 'login' && /email not confirmed/i.test(error && error.message || '')) {
        setPendingVerificationEmail(email);
        showResend(email);
      }
      showNotice(friendlyAuthError(error), true);
    } finally {
      setBusy(false);
    }
  });

  resend.addEventListener('click', async function () {
    if (!client || resendInFlight) return;
    const email = emailInput.value.trim();
    if (!validEmail(email)) {
      showNotice('Enter the email address you registered with before requesting another confirmation email.', true);
      emailInput.focus();
      return;
    }
    const cooldownUntil = Number(sessionStorage.getItem('rishnova-resend-cooldown-until') || 0);
    if (cooldownUntil > Date.now()) {
      updateResendButton();
      return;
    }

    resendInFlight = true;
    sessionStorage.setItem('rishnova-resend-cooldown-until', String(Date.now() + 60000));
    updateResendButton();
    showNotice('', false);
    try {
      const result = await client.auth.resend({
        type: 'signup',
        email: email,
        options: { emailRedirectTo: authRedirectUrl(null) }
      });
      if (result.error) throw result.error;
      setPendingVerificationEmail(email);
      showNotice('Supabase accepted the resend request. This does not confirm delivery; check your inbox and spam folder. If no new email arrives after a few minutes, check Supabase Auth logs and email-provider limits.', false);
    } catch (error) {
      showNotice(friendlyAuthError(error), true);
    } finally {
      resendInFlight = false;
      updateResendButton();
    }
  });

  continueButton.addEventListener('click', async function () {
    if (!verificationSession) return;
    const verifiedSession = verificationSession;
    verificationSession = null;
    continueButton.hidden = true;
    await applySession(verifiedSession);
  });

  toggle.addEventListener('click', function () {
    setMode(mode === 'signup' ? 'login' : 'signup', true);
  });
  forgot.addEventListener('click', function () {
    setMode('forgot', true);
  });
  document.getElementById('auth-back').addEventListener('click', async function () {
    if (recovering && client) {
      recovering = false;
      try {
        const result = await client.auth.signOut();
        if (result.error) throw result.error;
      } catch (error) {
        showNotice(friendlyAuthError(error), true);
        return;
      }
    }
    setMode('login', true);
  });

  window.RishNovaAuth = Object.freeze({
    getAccessToken: async function () {
      if (!client) return null;
      const result = await client.auth.getSession();
      if (result.error) throw result.error;
      session = result.data.session;
      return session && session.access_token;
    },
    getUser: function () { return session && session.user; },
    isAuthenticated: function () { return Boolean(session && session.access_token); },
    signOut: async function () {
      if (!client) throw new Error('Supabase authentication is not configured.');
      const result = await client.auth.signOut();
      if (result.error) throw result.error;
      await applySession(null);
    },
    getClient: function () { return client; }
  });

  renderMode();
  if (callbackError || callbackErrorCode) {
    setPendingVerificationEmail(pendingVerificationEmail);
    setMode('login', false);
    showResend(pendingVerificationEmail);
    showNotice(callbackErrorMessage(callbackErrorCode, callbackError, callbackDescription), true);
    cleanAuthCallbackUrl();
  }
  if (!client) {
    showNotice(supabase && supabase.error ? supabase.error : 'Supabase is not configured.', true);
  } else {
    client.auth.onAuthStateChange(function (event, nextSession) {
      if (event === 'PASSWORD_RECOVERY') {
        recovering = true;
        session = nextSession;
        setMode('reset', false);
        screen.hidden = false;
        app.hidden = true;
        return;
      }
      if (recovering && event !== 'SIGNED_OUT') {
        session = nextSession;
        return;
      }
      queueMicrotask(function () {
        applySession(nextSession).catch(function (error) {
          showNotice(friendlyAuthError(error), true);
        });
      });
    });

    client.auth.getSession().then(function (result) {
      if (result.error) throw result.error;
      if (callbackError || callbackErrorCode) {
        session = result.data.session;
        screen.hidden = false;
        app.hidden = true;
        return;
      }
      if (recovering) {
        session = result.data.session;
        screen.hidden = false;
        app.hidden = true;
      } else {
        return applySession(result.data.session);
      }
    }).catch(function (error) {
      showNotice(friendlyAuthError(error), true);
    });
  }
})();
