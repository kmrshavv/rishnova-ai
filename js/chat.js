(function () {
  'use strict';

  const state = window.RishNovaStorage.state;
  const messageList = document.getElementById('message-list');
  const welcomeScreen = document.getElementById('welcome-screen');
  const typingIndicator = document.getElementById('typing-indicator');
  const sendButton = document.getElementById('send-message');
  const stopButton = document.getElementById('stop-generation');
  const MODEL_OPTIONS = [];
  let generatingId = null;
  let busy = false;
  let activeController = null;

  function getActiveConversation() {
    return state.conversations.find(function (conversation) { return conversation.id === state.activeId; }) || null;
  }

  function selectedModel() {
    return MODEL_OPTIONS.find(function (model) { return model.id === state.selectedModel; }) || MODEL_OPTIONS[0] || null;
  }

  function requestHistory(messages) {
    const history = [];
    let totalCharacters = 0;
    for (let index = messages.length - 1; index >= 0 && history.length < 24; index -= 1) {
      const message = messages[index];
      if (totalCharacters + message.content.length > 16000) break;
      history.unshift({ role: message.role, content: message.content });
      totalCharacters += message.content.length;
    }
    return history;
  }

  function createConversation() {
    const conversation = {
      id: window.RishNovaStorage.makeId(),
      title: 'New conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      project: state.currentProject,
      messages: []
    };
    state.conversations.unshift(conversation);
    state.activeId = conversation.id;
    window.RishNovaStorage.save();
    return conversation;
  }

  function formatTime(timestamp) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
  }

  function appendAttachmentList(container, attachments) {
    if (!Array.isArray(attachments) || !attachments.length) return;
    const list = document.createElement('div');
    list.className = 'message-attachments';
    attachments.forEach(function (name) {
      const pill = document.createElement('span');
      pill.className = 'attachment-pill';
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'file');
      const label = document.createElement('span');
      label.textContent = name;
      pill.append(icon, label);
      list.appendChild(pill);
    });
    container.appendChild(list);
  }

  function renderMessages() {
    const conversation = getActiveConversation();
    const messages = conversation ? conversation.messages : [];
    messageList.replaceChildren();
    welcomeScreen.hidden = messages.length > 0;
    typingIndicator.hidden = !conversation || generatingId !== conversation.id;

    messages.forEach(function (message) {
      const row = document.createElement('article');
      row.className = 'message ' + (message.role === 'user' ? 'user-message' : 'assistant-message');
      row.dataset.messageId = message.id;
      const avatar = document.createElement('span');
      avatar.className = 'avatar ' + (message.role === 'user' ? 'user-avatar' : 'ai-avatar');
      if (message.role === 'user') avatar.textContent = 'R';
      else {
        const logo = document.createElement('img');
        logo.src = 'assets/logo.svg';
        logo.alt = '';
        avatar.appendChild(logo);
      }

      const body = document.createElement('div');
      body.className = 'message-body';
      const head = document.createElement('div');
      head.className = 'message-head';
      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = message.role === 'user' ? 'You' : 'RishNova';
      const time = document.createElement('span');
      time.className = 'message-time';
      time.textContent = formatTime(message.createdAt);
      head.append(author, time);

      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = window.RishNovaUI.renderMarkdown(message.content);
      body.append(head, content);
      if (message.role === 'user') appendAttachmentList(body, message.attachments);
      if (message.role === 'assistant') {
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        const actionItems = [
          ['copy', 'copy', 'Copy response'],
          ['regenerate', 'refresh-cw', 'Regenerate response'],
          ['like', 'thumbs-up', 'Like response'],
          ['dislike', 'thumbs-down', 'Dislike response']
        ];
        actionItems.forEach(function (item) {
          const button = document.createElement('button');
          button.className = 'message-action' + (message.feedback === item[0] ? ' selected' : '');
          button.type = 'button';
          button.dataset.action = item[0];
          button.setAttribute('aria-label', item[2]);
          button.title = item[2];
          const icon = document.createElement('i');
          icon.setAttribute('data-lucide', item[1]);
          button.appendChild(icon);
          actions.appendChild(button);
        });
        body.appendChild(actions);
      }
      row.append(avatar, body);
      messageList.appendChild(row);
    });
    window.RishNovaUI.refreshIcons();
  }

  async function requestReply(conversationId, messages, signal) {
    const model = selectedModel();
    if (!model) throw new Error('No supported local model is installed. Install qwen3.5:0.8b with Ollama.');
    return window.RishNovaApi.sendMessage(conversationId, messages, model.id, signal);
  }

  function persistOrNotify() {
    if (!window.RishNovaStorage.save()) {
      window.RishNovaUI.showToast('Could not save changes on this device.', 'error');
    }
  }

  async function sendMessage(text, attachments) {
    const content = String(text || '').trim();
    if ((!content && (!attachments || !attachments.length)) || busy) return false;
    if (!selectedModel()) {
      window.RishNovaUI.showToast('No supported local model is installed. Pull qwen3.5:0.8b with Ollama.', 'error');
      return false;
    }
    let conversation = getActiveConversation();
    if (!conversation) conversation = createConversation();
    const userMessage = {
      id: window.RishNovaStorage.makeId(),
      role: 'user',
      content: content || 'Please take a look at these attachments.',
      attachments: (attachments || []).slice(),
      createdAt: Date.now()
    };
    conversation.messages.push(userMessage);
    if (conversation.title === 'New conversation') {
      conversation.title = (content || attachments[0]).replace(/\s+/g, ' ').slice(0, 42) || 'New conversation';
      if ((content || attachments[0]).length > 42) conversation.title = conversation.title.slice(0, 39).trimEnd() + '...';
    }
    conversation.updatedAt = Date.now();
    generatingId = conversation.id;
    busy = true;
    activeController = new AbortController();
    sendButton.disabled = true;
    sendButton.hidden = true;
    stopButton.hidden = false;
    persistOrNotify();
    renderMessages();
    window.dispatchEvent(new CustomEvent('rishnova:conversations-changed'));
    scrollToLatest();
    try {
      if (!conversation.remote) {
        await window.RishNovaApi.createConversation({
          id: conversation.id,
          title: conversation.title,
          model: selectedModel().id,
          pinned: conversation.pinned,
          project: conversation.project
        });
        conversation.remote = true;
      }
      const history = requestHistory(conversation.messages);
      const result = await requestReply(conversation.id, history, activeController.signal);
      const responseConversation = state.conversations.find(function (item) { return item.id === conversation.id; });
      if (!responseConversation) return true;
      responseConversation.messages.push({
        id: window.RishNovaStorage.makeId(),
        role: 'assistant',
        content: result.reply,
        createdAt: Date.now()
      });
      responseConversation.updatedAt = Date.now();
      persistOrNotify();
      if (result.usage && Number.isFinite(result.usage.daily_remaining)) {
        window.dispatchEvent(new CustomEvent('rishnova:usage', { detail: result.usage }));
      }
      window.dispatchEvent(new CustomEvent('rishnova:connection', { detail: { status: 'online' } }));
    } catch (error) {
      if (error.name === 'AbortError') {
        window.RishNovaUI.showToast('Response generation stopped.');
      } else {
        console.error('RishNova chat request failed:', error);
        window.dispatchEvent(new CustomEvent('rishnova:connection', { detail: { status: 'offline' } }));
        window.RishNovaUI.showToast(error.message || 'The response could not be generated. Please try again.', 'error');
      }
    } finally {
      generatingId = null;
      busy = false;
      activeController = null;
      sendButton.disabled = false;
      sendButton.hidden = false;
      stopButton.hidden = true;
      renderMessages();
      window.dispatchEvent(new CustomEvent('rishnova:conversations-changed'));
      scrollToLatest();
    }
    return true;
  }

  function scrollToLatest() {
    window.requestAnimationFrame(function () {
      const scroll = document.getElementById('chat-scroll');
      scroll.scrollTop = scroll.scrollHeight;
    });
  }

  async function regenerate(messageId) {
    const conversation = getActiveConversation();
    if (!conversation || busy) return;
    const targetIndex = conversation.messages.findIndex(function (message) { return message.id === messageId; });
    if (targetIndex < 0 || conversation.messages[targetIndex].role !== 'assistant') return;
    let userIndex = targetIndex - 1;
    while (userIndex >= 0 && conversation.messages[userIndex].role !== 'user') userIndex -= 1;
    if (userIndex < 0) return;
    const history = requestHistory(conversation.messages.slice(0, targetIndex));
    generatingId = conversation.id;
    busy = true;
    activeController = new AbortController();
    sendButton.disabled = true;
    sendButton.hidden = true;
    stopButton.hidden = false;
    persistOrNotify();
    renderMessages();
    scrollToLatest();
    try {
      const result = await requestReply(conversation.id, history, activeController.signal);
      conversation.messages.splice(targetIndex);
      conversation.messages.push({ id: window.RishNovaStorage.makeId(), role: 'assistant', content: result.reply, createdAt: Date.now() });
      conversation.updatedAt = Date.now();
      persistOrNotify();
      window.dispatchEvent(new CustomEvent('rishnova:connection', { detail: { status: 'online' } }));
    } catch (error) {
      if (error.name === 'AbortError') {
        window.RishNovaUI.showToast('Response generation stopped.');
      } else {
        console.error('RishNova response regeneration failed:', error);
        window.dispatchEvent(new CustomEvent('rishnova:connection', { detail: { status: 'offline' } }));
        window.RishNovaUI.showToast(error.message || 'Could not regenerate the response. Please try again.', 'error');
      }
    } finally {
      generatingId = null;
      busy = false;
      activeController = null;
      sendButton.disabled = false;
      sendButton.hidden = false;
      stopButton.hidden = true;
      renderMessages();
      window.dispatchEvent(new CustomEvent('rishnova:conversations-changed'));
      scrollToLatest();
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand('copy');
      helper.remove();
      if (copied) resolve();
      else reject(new Error('Clipboard access is unavailable.'));
    });
  }

  async function handleMessageAction(event) {
    const button = event.target.closest('[data-action], [data-code-copy]');
    if (!button) return;
    const row = button.closest('[data-message-id]');
    const conversation = getActiveConversation();
    if (button.hasAttribute('data-code-copy')) {
      const code = button.closest('.code-block').querySelector('code').textContent;
      try {
        await copyText(code);
        window.RishNovaUI.showToast('Code copied to clipboard.');
      } catch (error) {
        console.error('Could not copy code:', error);
        window.RishNovaUI.showToast('Could not copy to clipboard.', 'error');
      }
      return;
    }
    if (!row || !conversation) return;
    const message = conversation.messages.find(function (item) { return item.id === row.dataset.messageId; });
    if (!message) return;
    const action = button.dataset.action;
    if (action === 'copy') {
      try {
        await copyText(message.content);
        window.RishNovaUI.showToast('Response copied to clipboard.');
      } catch (error) {
        console.error('Could not copy response:', error);
        window.RishNovaUI.showToast('Could not copy to clipboard.', 'error');
      }
    } else if (action === 'regenerate') {
      regenerate(message.id);
    } else if (action === 'like' || action === 'dislike') {
      message.feedback = message.feedback === action ? '' : action;
      persistOrNotify();
      renderMessages();
    }
  }

  messageList.addEventListener('click', handleMessageAction);
  stopButton.addEventListener('click', function () {
    if (activeController) activeController.abort();
  });

  window.RishNovaChat = {
    models: MODEL_OPTIONS,
    setAvailableModels: function (models) {
      MODEL_OPTIONS.splice(0, MODEL_OPTIONS.length);
      models.forEach(function (model) {
        MODEL_OPTIONS.push({
          id: model.name,
          name: model.display_name,
          detail: 'Installed locally',
          icon: 'cpu'
        });
      });
    },
    getActiveConversation: getActiveConversation,
    createConversation: createConversation,
    renderMessages: renderMessages,
    sendMessage: sendMessage,
    regenerate: regenerate,
    copyText: copyText,
    scrollToLatest: scrollToLatest,
    selectedModel: selectedModel,
    isBusy: function () { return busy; }
  };
})();
