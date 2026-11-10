(function () {
  'use strict';

  const state = window.RishNovaStorage.state;
  const chat = window.RishNovaChat;
  const ui = window.RishNovaUI;
  const appShell = document.getElementById('app-shell');
  const conversationList = document.getElementById('conversation-list');
  const projectList = document.getElementById('project-list');
  const searchInput = document.getElementById('conversation-search');
  const headerTitle = document.getElementById('current-title');
  const attachmentPreview = document.getElementById('attachment-preview');
  const messageInput = document.getElementById('message-input');
  const fileInput = document.getElementById('file-input');
  let pinnedOnly = false;
  let isAdmin = false;
  let stagedFiles = [];
  let speechRecognition = null;
  let workspaceLoading = false;
  let workspaceGeneration = 0;
  let workspaceUserId = null;
  let sortNewestFirst = state.sortNewestFirst;
  let backendStatusRequest = null;
  let backendStatusTimer = null;
  let backendRetryDelay = 2000;

  function persist() {
    if (!window.RishNovaStorage.save()) ui.showToast('Could not save changes on this device.', 'error');
  }

  function toTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : Date.now();
  }

  function isCurrentWorkspace(generation, userId) {
    const user = window.RishNovaAuth.getUser();
    return generation === workspaceGeneration && Boolean(user) && user.id === userId;
  }

  async function loadRemoteConversations(generation, userId) {
    const response = await window.RishNovaApi.getConversations();
    if (!isCurrentWorkspace(generation, userId)) return;
    const conversationMetadata = window.RishNovaStorage.getConversationMetadata(userId);
    state.conversations = response.conversations.map(function (item) {
      const metadata = conversationMetadata[item.id] || {};
      return {
        id: item.id,
        title: item.title,
        createdAt: toTimestamp(item.created_at),
        updatedAt: toTimestamp(item.updated_at),
        pinned: Boolean(metadata.pinned),
        project: metadata.project || null,
        model: item.model,
        remote: true,
        loaded: false,
        messages: []
      };
    });
    const remoteProjects = state.conversations.map(function (item) { return item.project; }).filter(Boolean);
    state.projects = Array.from(new Set(state.projects.concat(['Personal', 'Product ideas'], remoteProjects)));
    if (!state.conversations.some(function (item) { return item.id === state.activeId; })) {
      state.activeId = state.conversations.length ? state.conversations[0].id : null;
    }
    if (state.activeId) await loadConversationMessages(state.activeId, generation, userId);
    if (!isCurrentWorkspace(generation, userId)) return;
    persist();
    renderAll();
  }

  async function loadConversationMessages(id, generation, userId) {
    const conversation = state.conversations.find(function (item) { return item.id === id; });
    if (!conversation || !conversation.remote || conversation.loaded) return;
    const response = await window.RishNovaApi.getMessages(id);
    if (generation !== undefined && !isCurrentWorkspace(generation, userId)) return;
    if (!state.conversations.includes(conversation)) return;
    conversation.messages = response.messages.map(function (message) {
      return {
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: toTimestamp(message.created_at),
        attachments: [],
        feedback: ''
      };
    });
    conversation.loaded = true;
  }

  async function loadProfile(generation, userId) {
    const profile = await window.RishNovaApi.getProfile();
    if (!isCurrentWorkspace(generation, userId)) return;
    const user = window.RishNovaAuth.getUser();
    isAdmin = profile.is_admin === true;
    const userMetadata = user && user.user_metadata;
    const displayName = (userMetadata && userMetadata.full_name) || profile.full_name || (user && user.email) || 'Your account';
    document.getElementById('profile-name').textContent = displayName;
    document.getElementById('profile-email').textContent = (user && user.email) || profile.email;
    document.getElementById('profile-avatar').textContent = Array.from(displayName.trim())[0] || 'U';
  }

  async function loadUsage(generation, userId) {
    const usage = await window.RishNovaApi.getUsage();
    if (!isCurrentWorkspace(generation, userId)) return;
    if (Number.isFinite(usage.daily_remaining)) {
      document.getElementById('usage-indicator').textContent = usage.daily_remaining + ' AI requests left today';
    }
  }

  async function enterWorkspace() {
    const authenticatedUser = window.RishNovaAuth.getUser();
    if (!authenticatedUser) return;
    if (workspaceLoading && workspaceUserId === authenticatedUser.id) return;
    const generation = ++workspaceGeneration;
    const userId = authenticatedUser.id;
    workspaceLoading = true;
    workspaceUserId = userId;
    state.conversations = [];
    state.activeId = null;
    state.currentProject = null;
    state.projects = ['Personal', 'Product ideas'];
    isAdmin = false;
    document.getElementById('profile-name').textContent = 'Your account';
    document.getElementById('profile-email').textContent = 'Personal workspace';
    document.getElementById('profile-avatar').textContent = 'U';
    document.getElementById('usage-indicator').textContent = 'Daily usage is limited';
    chat.clearSensitiveState();
    appShell.hidden = true;
    messageInput.value = '';
    stagedFiles = [];
    updateAttachmentPreview();
    renderAll();
    try {
      await Promise.all([
        loadProfile(generation, userId),
        loadRemoteConversations(generation, userId),
        loadUsage(generation, userId)
      ]);
      if (isCurrentWorkspace(generation, userId)) {
        await refreshBackendStatus();
        if (isCurrentWorkspace(generation, userId)) appShell.hidden = false;
      }
    } catch (error) {
      if (!isCurrentWorkspace(generation, userId)) return;
      state.conversations = [];
      state.activeId = null;
      state.projects = ['Personal', 'Product ideas'];
      chat.clearSensitiveState();
      renderAll();
      appShell.hidden = false;
      console.error('Could not load the signed-in workspace:', error);
      ui.showToast(error.message || 'Could not load your account data.', 'error');
    } finally {
      if (generation === workspaceGeneration) workspaceLoading = false;
    }
  }

  function clearSignedOutWorkspace() {
    workspaceGeneration += 1;
    workspaceLoading = false;
    workspaceUserId = null;
    state.conversations = [];
    state.activeId = null;
    state.currentProject = null;
    state.projects = ['Personal', 'Product ideas'];
    chat.clearSensitiveState();
    messageInput.value = '';
    stagedFiles = [];
    updateAttachmentPreview();
    isAdmin = false;
    document.getElementById('profile-name').textContent = 'Your account';
    document.getElementById('profile-email').textContent = 'Personal workspace';
    document.getElementById('profile-avatar').textContent = 'U';
    document.getElementById('usage-indicator').textContent = 'Daily usage is limited';
    persist();
    renderAll();
  }

  async function saveConversationChanges(conversation, changes) {
    if (!conversation.remote) return;
    const saved = await window.RishNovaApi.updateConversation(conversation.id, changes);
    conversation.updatedAt = toTimestamp(saved.updated_at);
    return saved;
  }

  function closeProfileMenu() {
    const existing = document.querySelector('.profile-popover');
    if (existing) existing.remove();
    document.removeEventListener('pointerdown', closeProfileMenuFromOutside, true);
  }

  function closeProfileMenuFromOutside(event) {
    if (!event.target.closest('.profile-popover') && !event.target.closest('#profile-menu')) closeProfileMenu();
  }

  function openProfileMenu() {
    closeProfileMenu();
    const menu = document.createElement('div');
    menu.className = 'profile-popover';
    const options = [{ label: 'Edit profile', action: 'edit' }];
    if (isAdmin) options.push({ label: 'Usage limits', action: 'limits' });
    options.push({ label: 'Sign out', action: 'logout' });
    options.forEach(function (item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.dataset.profileAction = item.action;
      menu.appendChild(button);
    });
    document.body.appendChild(menu);
    const bounds = document.getElementById('profile-menu').getBoundingClientRect();
    menu.style.left = Math.max(10, Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 10)) + 'px';
    menu.style.top = Math.min(bounds.bottom + 5, window.innerHeight - menu.offsetHeight - 10) + 'px';
    menu.addEventListener('click', async function (event) {
      const button = event.target.closest('[data-profile-action]');
      if (!button) return;
      closeProfileMenu();
      if (button.dataset.profileAction === 'logout') {
        try {
          await window.RishNovaAuth.signOut();
        } catch (error) {
          ui.showToast(error.message || 'Could not sign out.', 'error');
        }
      } else if (button.dataset.profileAction === 'edit') {
        editProfile();
      } else {
        configureUsageLimits();
      }
    });
    window.setTimeout(function () { document.addEventListener('pointerdown', closeProfileMenuFromOutside, true); }, 0);
  }

  async function editProfile() {
    const profile = await ui.openModal({
      title: 'Edit profile',
      description: 'Update the name shown in your RishNova workspace.',
      value: document.getElementById('profile-name').textContent,
      placeholder: 'Full name',
      confirmText: 'Save'
    });
    if (typeof profile !== 'string') return;
    try {
      const authClient = window.RishNovaAuth.getClient();
      const authResult = await authClient.auth.updateUser({ data: { full_name: profile.trim().slice(0, 100) } });
      if (authResult.error) throw authResult.error;
      const updated = await window.RishNovaApi.updateProfile({ full_name: profile, avatar_url: '' });
      const user = window.RishNovaAuth.getUser();
      const displayName = (user && user.user_metadata && user.user_metadata.full_name) || updated.full_name || updated.email;
      document.getElementById('profile-name').textContent = displayName;
      document.getElementById('profile-avatar').textContent = Array.from(displayName)[0] || 'U';
      ui.showToast('Profile updated.');
    } catch (error) {
      ui.showToast(error.message || 'Could not update your profile.', 'error');
    }
  }

  async function configureUsageLimits() {
    try {
      const limits = await window.RishNovaApi.getUsageLimits();
      const value = await ui.openModal({
        title: 'Administrator usage limits',
        description: 'Enter the maximum AI requests per user per minute, then the daily request limit, separated by a comma. These settings reset when the backend restarts.',
        value: limits.requests_per_minute + ', ' + limits.daily_limit,
        placeholder: '6, 40',
        confirmText: 'Apply limits'
      });
      if (typeof value !== 'string') return;
      const parsed = value.split(',').map(function (item) { return Number(item.trim()); });
      if (parsed.length !== 2 || !parsed.every(Number.isInteger) || parsed[0] < 1 || parsed[0] > 20 || parsed[1] < 1 || parsed[1] > 500) {
        ui.showToast('Enter requests/minute (1–20), daily limit (1–500).', 'error');
        return;
      }
      await window.RishNovaApi.setUsageLimits({ requests_per_minute: parsed[0], daily_limit: parsed[1] });
      ui.showToast('Usage limits updated for this backend process.');
    } catch (error) {
      ui.showToast(error.message || 'Administrator settings are unavailable.', 'error');
    }
  }

  function renderTitle() {
    const active = chat.getActiveConversation();
    headerTitle.textContent = active ? active.title : 'New conversation';
  }

  function renderConversations() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = state.conversations.filter(function (conversation) {
      if (pinnedOnly && !conversation.pinned) return false;
      if (state.currentProject && conversation.project !== state.currentProject) return false;
      return !query || conversation.title.toLowerCase().includes(query);
    }).sort(function (a, b) {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return sortNewestFirst ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt;
    });
    conversationList.replaceChildren();
    document.getElementById('pinned-count').textContent = String(state.conversations.filter(function (item) { return item.pinned; }).length);
    document.getElementById('pinned-filter').classList.toggle('selected', pinnedOnly);
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = query ? 'No conversations match your search.' : pinnedOnly ? 'No pinned conversations yet.' : state.currentProject ? 'No conversations in this project yet.' : 'Your conversations will appear here.';
      conversationList.appendChild(empty);
      return;
    }
    filtered.forEach(function (conversation) {
      const item = document.createElement('div');
      item.className = 'conversation-item' + (conversation.id === state.activeId ? ' active' : '');
      item.dataset.conversationId = conversation.id;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-current', conversation.id === state.activeId ? 'page' : 'false');
      if (conversation.pinned) {
        const pin = document.createElement('i');
        pin.className = 'item-pin';
        pin.setAttribute('data-lucide', 'pin');
        item.appendChild(pin);
      }
      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = conversation.title;
      const menu = document.createElement('button');
      menu.className = 'conversation-menu-button';
      menu.type = 'button';
      menu.setAttribute('aria-label', 'Conversation options for ' + conversation.title);
      menu.title = 'Conversation options';
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'more-horizontal');
      menu.appendChild(icon);
      item.append(title, menu);
      conversationList.appendChild(item);
    });
    ui.refreshIcons();
  }

  function renderProjects() {
    projectList.replaceChildren();
    state.projects.forEach(function (project) {
      const item = document.createElement('button');
      item.className = 'project-item' + (state.currentProject === project ? ' selected' : '');
      item.type = 'button';
      item.dataset.project = project;
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'folder-kanban');
      const label = document.createElement('span');
      label.textContent = project;
      item.append(icon, label);
      projectList.appendChild(item);
    });
    ui.refreshIcons();
  }

  function renderModelMenus() {
    const current = chat.selectedModel();
    document.getElementById('header-model-name').textContent = current ? current.name : 'No available models';
    document.getElementById('composer-model-name').textContent = current ? current.name : 'No available models';
    document.getElementById('header-model-trigger').disabled = chat.models.length === 0;
    document.getElementById('composer-model-trigger').disabled = chat.models.length === 0;
    ['header-model-menu', 'composer-model-menu'].forEach(function (menuId) {
      const menu = document.getElementById(menuId);
      menu.replaceChildren();
      if (!chat.models.length) {
        const empty = document.createElement('div');
        empty.className = 'model-menu-empty';
        empty.textContent = 'No supported Qwen models are available from the AI service.';
        menu.appendChild(empty);
        return;
      }
      chat.models.forEach(function (model) {
        const option = document.createElement('button');
        option.className = 'model-option' + (model.id === state.selectedModel ? ' selected' : '');
        option.type = 'button';
        option.role = 'option';
        option.dataset.modelId = model.id;
        option.setAttribute('aria-selected', String(model.id === state.selectedModel));
        const icon = document.createElement('span');
        icon.className = 'model-option-icon';
        const iconElement = document.createElement('i');
        iconElement.setAttribute('data-lucide', model.icon);
        icon.appendChild(iconElement);
        const copy = document.createElement('span');
        copy.className = 'model-option-copy';
        const name = document.createElement('strong');
        name.textContent = model.name;
        const detail = document.createElement('small');
        detail.textContent = model.detail;
        copy.append(name, detail);
        option.append(icon, copy);
        if (model.id === state.selectedModel) {
          const check = document.createElement('i');
          check.className = 'check-icon';
          check.setAttribute('data-lucide', 'check');
          option.appendChild(check);
        }
        menu.appendChild(option);
      });
    });
    ui.refreshIcons();
  }

  function renderAll() {
    renderTitle();
    renderConversations();
    renderProjects();
    renderModelMenus();
    chat.renderMessages();
  }

  function setConnectionStatus(status, label) {
    const dot = document.getElementById('connection-dot');
    const serviceIndicator = document.getElementById('service-indicator');
    dot.classList.remove('online', 'offline', 'connecting');
    serviceIndicator.classList.remove('online', 'offline', 'connecting');
    dot.classList.add(status);
    serviceIndicator.classList.add(status);
    document.getElementById('connection-label').textContent = label;
    document.getElementById('service-label').textContent = status === 'online'
      ? 'Connected to AI service'
      : status === 'connecting'
        ? 'Connecting to AI service'
        : 'AI server offline. It may be asleep or disconnected; retrying automatically.';
  }

  function scheduleBackendStatusCheck(delay) {
    if (backendStatusTimer) window.clearTimeout(backendStatusTimer);
    if (!window.RishNovaAuth.isAuthenticated()) return;
    backendStatusTimer = window.setTimeout(function () {
      backendStatusTimer = null;
      refreshBackendStatus();
    }, delay);
  }

  function refreshBackendStatus() {
    if (!window.RishNovaAuth.isAuthenticated()) return Promise.resolve();
    if (backendStatusRequest) return backendStatusRequest;
    if (backendStatusTimer) {
      window.clearTimeout(backendStatusTimer);
      backendStatusTimer = null;
    }

    backendStatusRequest = (async function () {
      setConnectionStatus('connecting', 'Checking AI service...');
      try {
        const health = await window.RishNovaApi.getHealth();
        if (!health.ollama_available || health.status !== 'online') {
          chat.setAvailableModels([]);
          setConnectionStatus('offline', 'AI model unavailable');
          renderModelMenus();
          scheduleBackendStatusCheck(backendRetryDelay);
          backendRetryDelay = Math.min(backendRetryDelay * 2, 60000);
          return;
        }
        const response = await window.RishNovaApi.getAvailableModels();
        const models = Array.isArray(response.models) ? response.models : [];
        chat.setAvailableModels(models);
        if (models.length) {
          if (!models.some(function (model) { return model.name === state.selectedModel; })) {
            state.selectedModel = models.some(function (model) { return model.name === response.default_model; })
              ? response.default_model
              : models[0].name;
            persist();
          }
          setConnectionStatus('online', 'AI service connected');
          backendRetryDelay = 2000;
          scheduleBackendStatusCheck(60000);
        } else {
          setConnectionStatus('offline', 'Required AI model unavailable');
          scheduleBackendStatusCheck(backendRetryDelay);
          backendRetryDelay = Math.min(backendRetryDelay * 2, 60000);
        }
        renderModelMenus();
      } catch (error) {
        chat.setAvailableModels([]);
        setConnectionStatus('offline', 'Backend or Ollama offline');
        renderModelMenus();
        console.error('Could not discover available AI models:', error);
        scheduleBackendStatusCheck(backendRetryDelay);
        backendRetryDelay = Math.min(backendRetryDelay * 2, 60000);
      }
    })();

    return backendStatusRequest.finally(function () {
      backendStatusRequest = null;
    });
  }

  function closeMobileNavigation() {
    document.body.classList.remove('mobile-nav-open');
  }

  function startNewConversation() {
    state.activeId = null;
    persist();
    renderAll();
    messageInput.focus();
    chat.scrollToLatest();
    closeMobileNavigation();
  }

  async function selectConversation(id) {
    const generation = workspaceGeneration;
    const user = window.RishNovaAuth.getUser();
    const conversation = state.conversations.find(function (item) { return item.id === id; });
    if (!conversation || !user) return;
    state.activeId = id;
    persist();
    renderTitle();
    renderConversations();
    try {
      await loadConversationMessages(id, generation, user.id);
    } catch (error) {
      if (!isCurrentWorkspace(generation, user.id)) return;
      ui.showToast(error.message || 'Could not load conversation history.', 'error');
    }
    if (!isCurrentWorkspace(generation, user.id) || !state.conversations.includes(conversation)) return;
    chat.renderMessages();
    chat.scrollToLatest();
    closeMobileNavigation();
  }

  function closeModelMenus() {
    document.querySelectorAll('.model-menu').forEach(function (menu) { menu.classList.remove('open'); });
    document.querySelectorAll('.model-trigger, .composer-model-trigger').forEach(function (button) { button.setAttribute('aria-expanded', 'false'); });
  }

  function toggleModelMenu(trigger, menu) {
    const shouldOpen = !menu.classList.contains('open');
    closeModelMenus();
    if (shouldOpen) {
      menu.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
    }
  }

  function updateAttachmentPreview() {
    attachmentPreview.replaceChildren();
    stagedFiles.forEach(function (file, index) {
      const chip = document.createElement('span');
      chip.className = 'attachment-chip';
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'file');
      const name = document.createElement('span');
      name.textContent = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.removeAttachment = String(index);
      remove.setAttribute('aria-label', 'Remove ' + file.name);
      const removeIcon = document.createElement('i');
      removeIcon.setAttribute('data-lucide', 'x');
      remove.appendChild(removeIcon);
      chip.append(icon, name, remove);
      attachmentPreview.appendChild(chip);
    });
    attachmentPreview.hidden = stagedFiles.length === 0;
    ui.refreshIcons();
  }

  function resizeComposer() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 190) + 'px';
  }

  async function submitMessage() {
    if (workspaceLoading) {
      ui.showToast('Please wait while your cloud workspace loads.', 'error');
      return;
    }
    const text = messageInput.value;
    if (!text.trim() && stagedFiles.length === 0) {
      ui.showToast('Write a message before sending.', 'error');
      messageInput.focus();
      return;
    }
    const sent = await chat.sendMessage(text, stagedFiles.map(function (file) { return file.name; }));
    if (!sent) return;
    messageInput.value = '';
    stagedFiles = [];
    updateAttachmentPreview();
    resizeComposer();
  }

  function closeConversationMenu() {
    const existing = document.querySelector('.conversation-context-menu');
    if (existing) existing.remove();
    document.removeEventListener('pointerdown', closeMenuFromOutside, true);
  }

  function closeMenuFromOutside(event) {
    if (!event.target.closest('.conversation-context-menu')) closeConversationMenu();
  }

  function conversationMenu(id, anchor) {
    const conversation = state.conversations.find(function (item) { return item.id === id; });
    if (!conversation) return;
    const options = [
      { title: conversation.pinned ? 'Unpin conversation' : 'Pin conversation', action: 'pin', icon: 'pin' },
      { title: 'Rename', action: 'rename', icon: 'pencil' },
      { title: 'Delete', action: 'delete', icon: 'trash-2', danger: true }
    ];
    closeConversationMenu();
    const menu = document.createElement('div');
    menu.className = 'conversation-context-menu';
    menu.setAttribute('role', 'menu');
    options.forEach(function (option) {
      const button = document.createElement('button');
      button.className = 'context-menu-item' + (option.danger ? ' danger' : '');
      button.type = 'button';
      button.dataset.menuAction = option.action;
      button.setAttribute('role', 'menuitem');
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', option.icon);
      const label = document.createElement('span');
      label.textContent = option.title;
      button.append(icon, label);
      menu.appendChild(button);
    });
    document.body.appendChild(menu);
    const bounds = anchor.getBoundingClientRect();
    menu.style.top = Math.min(bounds.bottom + 5, window.innerHeight - menu.offsetHeight - 10) + 'px';
    menu.style.left = Math.max(10, Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 10)) + 'px';
    menu.addEventListener('click', function (event) {
      const button = event.target.closest('[data-menu-action]');
      if (!button) return;
      const action = button.dataset.menuAction;
      closeConversationMenu();
      if (action === 'pin') {
        toggleConversationPin(conversation);
      } else if (action === 'rename') {
        renameConversation(conversation);
      } else if (action === 'delete') {
        deleteConversation(conversation);
      }
    });
    ui.refreshIcons();
    window.setTimeout(function () { document.addEventListener('pointerdown', closeMenuFromOutside, true); }, 0);
    menu.querySelector('button').focus();
  }

  async function toggleConversationPin(conversation) {
    const previousPinned = conversation.pinned;
    conversation.pinned = !previousPinned;
    renderConversations();
    try {
      const user = window.RishNovaAuth.getUser();
      if (!user || !window.RishNovaStorage.updateConversationMetadata(user.id, conversation.id, { pinned: conversation.pinned })) {
        throw new Error('Could not save this preference on this device.');
      }
      persist();
      renderConversations();
      ui.showToast(conversation.pinned ? 'Conversation pinned.' : 'Conversation unpinned.');
    } catch (error) {
      conversation.pinned = previousPinned;
      renderConversations();
      ui.showToast(error.message || 'Could not save the conversation.', 'error');
    }
  }

  async function renameConversation(conversation) {
    const title = await ui.openModal({
      title: 'Rename conversation',
      description: 'Choose a name that will help you find this conversation later.',
      value: conversation.title,
      placeholder: 'Conversation name',
      confirmText: 'Rename'
    });
    if (typeof title !== 'string') return;
    const nextTitle = title.trim().slice(0, 80);
    if (!nextTitle) {
      ui.showToast('Enter a conversation name.', 'error');
      return;
    }
    const previousTitle = conversation.title;
    conversation.title = nextTitle;
    renderTitle();
    renderConversations();
    try {
      const saved = await saveConversationChanges(conversation, { title: nextTitle });
      conversation.title = saved.title;
      persist();
      renderTitle();
      renderConversations();
      ui.showToast('Conversation renamed.');
    } catch (error) {
      conversation.title = previousTitle;
      renderTitle();
      renderConversations();
      ui.showToast(error.message || 'Could not rename the conversation.', 'error');
    }
  }

  async function deleteConversation(conversation) {
    const confirmed = await ui.openModal({
      title: 'Delete conversation?',
      description: '“' + conversation.title + '” and its cloud messages will be permanently deleted. This cannot be undone.',
      showInput: false,
      confirmText: 'Delete'
    });
    if (!confirmed) return;
    if (conversation.remote) {
      try {
        await window.RishNovaApi.deleteConversation(conversation.id);
      } catch (error) {
        ui.showToast(error.message || 'Could not delete the conversation.', 'error');
        return;
      }
    }
    state.conversations = state.conversations.filter(function (item) { return item.id !== conversation.id; });
    const user = window.RishNovaAuth.getUser();
    if (user && !window.RishNovaStorage.removeConversationMetadata(user.id, conversation.id)) {
      ui.showToast('The conversation was deleted, but its local pin/project preference could not be removed.', 'error');
    }
    if (state.activeId === conversation.id) state.activeId = null;
    persist();
    renderAll();
    ui.showToast('Conversation deleted.');
  }

  async function addProject() {
    const name = await ui.openModal({
      title: 'Create a project',
      description: 'Projects help group new conversations by topic or goal.',
      placeholder: 'e.g. Product launch',
      confirmText: 'Create project'
    });
    if (typeof name !== 'string') return;
    if (state.projects.some(function (project) { return project.toLowerCase() === name.toLowerCase(); })) {
      ui.showToast('A project with that name already exists.', 'error');
      return;
    }
    state.projects.push(name.slice(0, 40));
    state.currentProject = name.slice(0, 40);
    state.activeId = null;
    persist();
    renderAll();
    messageInput.focus();
    ui.showToast('Project created.');
  }

  function setTheme(theme, notify) {
    state.theme = theme;
    document.body.classList.toggle('light-theme', theme === 'light');
    document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f5f5fa' : '#09090f';
    persist();
    if (notify) ui.showToast(theme === 'light' ? 'Light theme enabled.' : 'Dark theme enabled.');
  }

  function conversationText(conversation) {
    const heading = conversation ? conversation.title : 'New conversation';
    const messages = conversation ? conversation.messages : [];
    const lines = messages.map(function (message) {
      return (message.role === 'user' ? 'You' : 'RishNova') + ' · ' + new Date(message.createdAt).toLocaleString() + '\n' + message.content +
        (message.attachments && message.attachments.length ? '\nAttachments: ' + message.attachments.join(', ') : '');
    });
    return ['RishNova AI — ' + heading].concat(lines).join('\n\n') + '\n';
  }

  async function shareConversation() {
    const conversation = chat.getActiveConversation();
    if (!conversation || !conversation.messages.length) {
      ui.showToast('Start a conversation before sharing.', 'error');
      return;
    }
    try {
      await chat.copyText(conversationText(conversation));
      ui.showToast('Conversation copied to clipboard.');
    } catch (error) {
      console.error('Could not copy conversation:', error);
      ui.showToast('Could not copy to clipboard.', 'error');
    }
  }

  function exportConversation() {
    const conversation = chat.getActiveConversation();
    if (!conversation || !conversation.messages.length) {
      ui.showToast('There is no conversation to export yet.', 'error');
      return;
    }
    const blob = new Blob([conversationText(conversation)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (conversation.title || 'rishnova-conversation').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').slice(0, 70) + '.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    ui.showToast('Conversation exported as a text file.');
  }

  function startVoiceInput() {
    if (speechRecognition) {
      speechRecognition.stop();
      return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      ui.showToast('Voice input is not supported by this browser.', 'error');
      return;
    }
    speechRecognition = new Recognition();
    speechRecognition.lang = navigator.language || 'en-US';
    speechRecognition.interimResults = true;
    speechRecognition.continuous = false;
    const voiceButton = document.getElementById('voice-input');
    voiceButton.classList.add('recording');
    voiceButton.setAttribute('aria-label', 'Stop voice input');
    speechRecognition.onresult = function (event) {
      let transcript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) transcript += event.results[index][0].transcript;
      messageInput.value = transcript;
      resizeComposer();
    };
    speechRecognition.onerror = function (event) {
      console.error('Voice input failed:', event.error);
      ui.showToast('Voice input could not start. Check microphone permission.', 'error');
    };
    speechRecognition.onend = function () {
      speechRecognition = null;
      voiceButton.classList.remove('recording');
      voiceButton.setAttribute('aria-label', 'Start voice input');
      messageInput.focus();
    };
    try {
      speechRecognition.start();
    } catch (error) {
      speechRecognition = null;
      voiceButton.classList.remove('recording');
      voiceButton.setAttribute('aria-label', 'Start voice input');
      console.error('Could not start voice input:', error);
      ui.showToast('Could not start voice input.', 'error');
    }
  }

  document.getElementById('new-chat').addEventListener('click', startNewConversation);
  document.getElementById('top-new-chat').addEventListener('click', startNewConversation);
  document.querySelector('.brand').addEventListener('click', function (event) {
    event.preventDefault();
    startNewConversation();
  });
  document.getElementById('open-sidebar').addEventListener('click', function () { document.body.classList.add('mobile-nav-open'); });
  document.getElementById('mobile-scrim').addEventListener('click', closeMobileNavigation);
  document.getElementById('collapse-sidebar').addEventListener('click', function () { document.body.classList.toggle('sidebar-collapsed'); });
  document.getElementById('expand-sidebar').addEventListener('click', function () { document.body.classList.remove('sidebar-collapsed'); });
  document.getElementById('pinned-filter').addEventListener('click', function () {
    pinnedOnly = !pinnedOnly;
    renderConversations();
  });
  document.getElementById('sort-conversations').addEventListener('click', function () {
    sortNewestFirst = !sortNewestFirst;
    state.sortNewestFirst = sortNewestFirst;
    persist();
    renderConversations();
    ui.showToast(sortNewestFirst ? 'Newest conversations first.' : 'Oldest conversations first.');
  });
  searchInput.addEventListener('input', renderConversations);
  conversationList.addEventListener('click', function (event) {
    const item = event.target.closest('.conversation-item');
    if (!item) return;
    if (event.target.closest('.conversation-menu-button')) conversationMenu(item.dataset.conversationId, event.target.closest('.conversation-menu-button'));
    else selectConversation(item.dataset.conversationId);
  });
  conversationList.addEventListener('keydown', function (event) {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('conversation-item')) {
      event.preventDefault();
      selectConversation(event.target.dataset.conversationId);
    }
  });
  projectList.addEventListener('click', function (event) {
    const project = event.target.closest('[data-project]');
    if (!project) return;
    state.currentProject = state.currentProject === project.dataset.project ? null : project.dataset.project;
    state.activeId = null;
    persist();
    renderTitle();
    renderProjects();
    renderConversations();
    chat.renderMessages();
    closeMobileNavigation();
  });
  document.getElementById('add-project').addEventListener('click', addProject);

  document.querySelectorAll('.model-picker').forEach(function (picker) {
    const trigger = picker.querySelector('button');
    const menu = picker.querySelector('.model-menu');
    trigger.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleModelMenu(trigger, menu);
    });
    menu.addEventListener('click', function (event) {
      const option = event.target.closest('[data-model-id]');
      if (!option) return;
      state.selectedModel = option.dataset.modelId;
      persist();
      renderModelMenus();
      closeModelMenus();
    });
  });
  document.addEventListener('click', function (event) {
    if (!event.target.closest('.model-picker')) closeModelMenus();
  });

  document.getElementById('send-message').addEventListener('click', submitMessage);
  messageInput.addEventListener('input', resizeComposer);
  messageInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitMessage();
    }
  });
  document.querySelectorAll('.suggestion-card').forEach(function (card) {
    card.addEventListener('click', function () {
      messageInput.value = card.dataset.prompt;
      resizeComposer();
      messageInput.focus();
    });
  });
  document.getElementById('attach-file').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    const selected = Array.from(fileInput.files || []);
    stagedFiles = stagedFiles.concat(selected).filter(function (file, index, list) {
      return list.findIndex(function (other) { return other.name === file.name && other.size === file.size; }) === index;
    });
    updateAttachmentPreview();
    fileInput.value = '';
    if (selected.length) ui.showToast('Files are attached by name in this preview; file contents are not uploaded.');
  });
  attachmentPreview.addEventListener('click', function (event) {
    const remove = event.target.closest('[data-remove-attachment]');
    if (!remove) return;
    stagedFiles.splice(Number(remove.dataset.removeAttachment), 1);
    updateAttachmentPreview();
  });
  document.getElementById('voice-input').addEventListener('click', startVoiceInput);
  document.getElementById('share-chat').addEventListener('click', shareConversation);
  document.getElementById('export-chat').addEventListener('click', exportConversation);
  document.getElementById('theme-toggle').addEventListener('click', function () {
    setTheme(state.theme === 'dark' ? 'light' : 'dark', true);
  });
  document.getElementById('open-settings').addEventListener('click', function () {
    const user = window.RishNovaAuth.getUser();
    if (!user) return;
    const name = user.user_metadata && user.user_metadata.full_name;
    const verified = user.email_confirmed_at ? 'Verified' : 'Email verification pending';
    ui.openModal({
      title: name || 'Your RishNova account',
      description: 'Email: ' + (user.email || 'Not available') + '\nUser ID: ' + user.id + '\nAccount status: ' + verified + '\n\nConversations are stored in your private account. Chat requests are sent to the RishNova FastAPI service and its configured AI model.',
      showInput: false,
      confirmText: 'Done'
    });
  });
  document.getElementById('profile-menu').addEventListener('click', function () {
    openProfileMenu();
  });
  document.addEventListener('keydown', function (event) {
    const target = event.target;
    const isTyping = target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName));
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      startNewConversation();
    } else if (event.key === '/' && !isTyping && document.getElementById('modal-backdrop').hidden) {
      event.preventDefault();
      searchInput.focus();
    } else if (event.key === 'Escape') {
      closeMobileNavigation();
      closeModelMenus();
    }
  });
  window.addEventListener('rishnova:conversations-changed', function () {
    renderTitle();
    renderConversations();
  });
  window.addEventListener('rishnova:connection', function (event) {
    if (event.detail && event.detail.status === 'offline') {
      setConnectionStatus('offline', 'Backend or Ollama offline');
      scheduleBackendStatusCheck(backendRetryDelay);
    } else {
      refreshBackendStatus();
    }
  });
  window.addEventListener('focus', refreshBackendStatus);
  window.addEventListener('online', function () {
    backendRetryDelay = 2000;
    refreshBackendStatus();
  });
  window.addEventListener('rishnova:authenticated', enterWorkspace);
  window.addEventListener('rishnova:signedout', clearSignedOutWorkspace);
  window.addEventListener('rishnova:usage', function (event) {
    const remaining = event.detail && event.detail.daily_remaining;
    if (Number.isFinite(remaining)) {
      document.getElementById('usage-indicator').textContent = remaining + ' AI requests left today';
    }
  });

  if (state.sortNewestFirst === false) sortNewestFirst = false;
  setTheme(state.theme, false);
  renderAll();
  refreshBackendStatus();
})();
