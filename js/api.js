(function () {
  'use strict';

  const config = window.RISHNOVA_CONFIG || {};
  const API_BASE = config.backendUrl
    ? String(config.backendUrl).replace(/\/+$/, '') + '/api'
    : '/api';

  async function request(path, options) {
    if (config.backendUrl && config.backendUrl.includes('YOUR_BACKEND_HOST')) {
      throw new Error('The local API URL is not configured correctly.');
    }
    const requestOptions = Object.assign({}, options || {});
    const headers = new Headers(requestOptions.headers || {});
    const token = window.RishNovaAuth && await window.RishNovaAuth.getAccessToken();
    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (requestOptions.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    requestOptions.headers = headers;

    let response;
    try {
      response = await fetch(API_BASE + path, requestOptions);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Can’t reach the RishNova backend. Check the backend connection and try again.');
    }

    let payload = null;
    if (response.status !== 204) {
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error('The backend returned an invalid response.');
      }
    }
    if (!response.ok) {
      const detail = payload && typeof payload.detail === 'string'
        ? payload.detail
        : payload && Array.isArray(payload.detail)
          ? payload.detail.map(function (item) { return item.msg; }).filter(Boolean).join(' ')
          : 'The backend could not complete the request.';
      const failure = new Error(detail);
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  function get(path, timeoutMs) {
    const controller = new AbortController();
    const timeout = window.setTimeout(function () { controller.abort(); }, timeoutMs || 15000);
    return request(path, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    }).finally(function () {
      window.clearTimeout(timeout);
    });
  }

  function sendMessage(conversationId, messages, model, signal) {
    return request('/chat', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: conversationId, messages: messages, model: model }),
      signal: signal
    });
  }

  window.RishNovaApi = {
    sendMessage: sendMessage,
    getHealth: function () { return get('/health', 8000); },
    getAvailableModels: function () { return get('/models', 12000); },
    getConversations: function () { return get('/conversations'); },
    createConversation: function (conversation) {
      return request('/conversations', { method: 'POST', body: JSON.stringify(conversation) });
    },
    updateConversation: function (id, changes) {
      return request('/conversations/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify(changes)
      });
    },
    getMessages: function (id) { return get('/conversations/' + encodeURIComponent(id) + '/messages'); },
    deleteConversation: function (id) {
      return request('/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    getProfile: function () { return get('/profile'); },
    getUsage: function () { return get('/usage'); },
    updateProfile: function (profile) {
      return request('/profile', { method: 'PUT', body: JSON.stringify(profile) });
    },
    getUsageLimits: function () { return get('/admin/limits'); },
    setUsageLimits: function (limits) {
      return request('/admin/limits', { method: 'PUT', body: JSON.stringify(limits) });
    }
  };
})();
