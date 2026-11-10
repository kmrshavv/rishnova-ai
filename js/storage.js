(function () {
  'use strict';

  const STORAGE_KEY = 'rishnova-ai:v1';

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'rn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function createInitialState() {
    return {
      conversations: [],
      projects: ['Personal', 'Product ideas'],
      activeId: null,
      currentProject: null,
      selectedModel: 'qwen3.5:0.8b',
      theme: 'dark',
      sortNewestFirst: true
    };
  }

  function normalizeState(state) {
    if (!state || typeof state !== 'object') return createInitialState();
    const conversations = Array.isArray(state.conversations) ? state.conversations.filter(function (conversation) {
      return conversation && typeof conversation.id === 'string' && Array.isArray(conversation.messages);
    }).map(function (conversation) {
      return {
        id: conversation.id,
        title: typeof conversation.title === 'string' ? conversation.title : 'Untitled conversation',
        createdAt: Number.isFinite(conversation.createdAt) ? conversation.createdAt : Date.now(),
        updatedAt: Number.isFinite(conversation.updatedAt) ? conversation.updatedAt : Date.now(),
        pinned: Boolean(conversation.pinned),
        project: typeof conversation.project === 'string' ? conversation.project : null,
        messages: conversation.messages.filter(function (message) {
          return message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string';
        }).map(function (message) {
          return {
            id: typeof message.id === 'string' ? message.id : makeId(),
            role: message.role,
            content: message.content,
            createdAt: Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
            attachments: Array.isArray(message.attachments) ? message.attachments.filter(function (name) { return typeof name === 'string'; }) : [],
            feedback: message.feedback === 'like' || message.feedback === 'dislike' ? message.feedback : ''
          };
        })
      };
    }) : [];
    const projects = Array.isArray(state.projects) ? state.projects.filter(function (item) { return typeof item === 'string'; }) : [];
    return {
      conversations: conversations,
      projects: projects,
      activeId: typeof state.activeId === 'string' && conversations.some(function (item) { return item.id === state.activeId; }) ? state.activeId : null,
      currentProject: typeof state.currentProject === 'string' && projects.includes(state.currentProject) ? state.currentProject : null,
      selectedModel: ['qwen3.5:0.8b', 'qwen3.5:2b-q4_K_M'].includes(state.selectedModel) ? state.selectedModel : 'qwen3.5:0.8b',
      theme: state.theme === 'light' ? 'light' : 'dark',
      sortNewestFirst: state.sortNewestFirst !== false
    };
  }

  let state;
  let initializeStorage = true;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      state = normalizeState(JSON.parse(saved));
      initializeStorage = false;
    } else {
      state = createInitialState();
    }
  } catch (error) {
    console.error('RishNova could not load saved conversations:', error);
    state = createInitialState();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      console.error('RishNova could not save conversations:', error);
      return false;
    }
  }

  if (initializeStorage) save();

  window.RishNovaStorage = {
    state: state,
    makeId: makeId,
    save: save
  };
})();
