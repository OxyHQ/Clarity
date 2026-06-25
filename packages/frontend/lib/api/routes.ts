/**
 * Centralized API routes configuration
 * All API endpoints are defined here for easy maintenance
 */

export const API_ROUTES = {
  // Auth routes
  auth: {
    login: '/auth/login',
    register: '/auth/register',
    forgotPassword: '/auth/forgot-password',
    resetPassword: '/auth/reset-password',
  },

  // Conversation routes
  conversations: {
    list: '/conversations',
    create: '/conversations',
    get: (id: string) => `/conversations/${id}`,
    update: (id: string) => `/conversations/${id}`,
    delete: (id: string) => `/conversations/${id}`,
  },

  // Credits routes
  credits: {
    get: '/credits',
  },

  // Chat routes
  chat: {
    clarity: '/clarity/search',
  },

  // Analytics routes
  analytics: {
    usage: '/analytics/usage',
    models: '/analytics/models',
    credits: '/analytics/credits',
  },

  // Suggestions routes
  suggestions: {
    list: '/suggestions/list',
    welcome: '/suggestions/welcome',
    me: '/suggestions/me',
    create: '/suggestions/create',
    generate: '/suggestions/generate',
    search: '/suggestions/search',
    update: (id: string) => `/suggestions/${id}`,
    delete: (id: string) => `/suggestions/${id}`,
    use: (id: string) => `/suggestions/${id}/use`,
  },

  // Health check
  health: '/health',

  // API v1 routes (OpenAI compatible)
  v1: {
    chatCompletions: '/v1/chat/completions',
    models: '/v1/models',
    audioSpeech: '/v1/audio/speech',
    audioGenerate: '/v1/audio/generate',
    imagesGenerations: '/v1/images/generations',
    shows: {
      generate: '/v1/shows/generate',
      list: '/v1/shows',
      get: (id: string) => `/v1/shows/${id}`,
      delete: (id: string) => `/v1/shows/${id}`,
      voices: '/v1/shows/voices',
    },
  },
} as const;
