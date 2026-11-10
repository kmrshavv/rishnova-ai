(function () {
  'use strict';

  const PREFERENCES_KEY = 'rishnova-ai:preferences:v1';
  const LEGACY_STORAGE_KEY = 'rishnova-ai:v1';
  const CONVERSATION_METADATA_KEY = 'rishnova-ai:conversation-metadata:v1';

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      return Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('')
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (character) {
      const random = Math.random() * 16 | 0;
      return (character === 'x' ? random : (random & 3) | 8).toString(16);
    });
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
    const projects = Array.isArray(state.projects) ? state.projects.filter(function (item) { return typeof item === 'string'; }) : [];
    return {
      conversations: [],
      projects: projects,
      activeId: null,
      currentProject: typeof state.currentProject === 'string' && projects.includes(state.currentProject) ? state.currentProject : null,
      selectedModel: ['qwen3.5:0.8b', 'qwen3.5:2b-q4_K_M'].includes(state.selectedModel) ? state.selectedModel : 'qwen3.5:0.8b',
      theme: state.theme === 'light' ? 'light' : 'dark',
      sortNewestFirst: state.sortNewestFirst !== false
    };
  }

  let state;
  try {
    const saved = localStorage.getItem(PREFERENCES_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    state = saved ? normalizeState(JSON.parse(saved)) : createInitialState();
    state.conversations = [];
    state.activeId = null;
  } catch (error) {
    console.error('RishNova could not load saved preferences:', error);
    state = createInitialState();
  }

  function save() {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
        projects: state.projects,
        currentProject: state.currentProject,
        selectedModel: state.selectedModel,
        theme: state.theme,
        sortNewestFirst: state.sortNewestFirst
      }));
      return true;
    } catch (error) {
      console.error('RishNova could not save preferences:', error);
      return false;
    }
  }

  function readConversationMetadata() {
    try {
      const saved = localStorage.getItem(CONVERSATION_METADATA_KEY);
      if (!saved) return {};
      const parsed = JSON.parse(saved);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      console.error('RishNova could not load conversation preferences:', error);
      return {};
    }
  }

  function getConversationMetadata(userId) {
    if (typeof userId !== 'string' || !userId) return {};
    const metadata = readConversationMetadata()[userId];
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  }

  function updateConversationMetadata(userId, conversationId, changes) {
    if (typeof userId !== 'string' || !userId || typeof conversationId !== 'string' || !conversationId) return false;
    const metadata = readConversationMetadata();
    const userMetadata = metadata[userId] && typeof metadata[userId] === 'object'
      ? metadata[userId]
      : {};
    const current = userMetadata[conversationId] && typeof userMetadata[conversationId] === 'object'
      ? userMetadata[conversationId]
      : {};
    if (typeof changes.pinned === 'boolean') current.pinned = changes.pinned;
    if (typeof changes.project === 'string' || changes.project === null) current.project = changes.project;
    userMetadata[conversationId] = current;
    metadata[userId] = userMetadata;
    try {
      localStorage.setItem(CONVERSATION_METADATA_KEY, JSON.stringify(metadata));
      return true;
    } catch (error) {
      console.error('RishNova could not save conversation preferences:', error);
      return false;
    }
  }

  function removeConversationMetadata(userId, conversationId) {
    if (typeof userId !== 'string' || !userId || typeof conversationId !== 'string' || !conversationId) return false;
    const metadata = readConversationMetadata();
    if (!metadata[userId] || !metadata[userId][conversationId]) return true;
    delete metadata[userId][conversationId];
    try {
      localStorage.setItem(CONVERSATION_METADATA_KEY, JSON.stringify(metadata));
      return true;
    } catch (error) {
      console.error('RishNova could not remove conversation preferences:', error);
      return false;
    }
  }

  window.RishNovaStorage = {
    state: state,
    makeId: makeId,
    save: save,
    getConversationMetadata: getConversationMetadata,
    updateConversationMetadata: updateConversationMetadata,
    removeConversationMetadata: removeConversationMetadata
  };
})();
