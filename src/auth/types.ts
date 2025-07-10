/**
 * Authentication system type definitions
 * Provides type safety for authentication-related operations
 */

export interface AuthStatus {
  isAuthenticated: boolean;
  method: 'oauth' | 'api_key' | 'session';
  userInfo?: UserInfo;
  timestamp?: number;
}

export interface UserInfo {
  email?: string;
  name?: string;
  planType?: string;
  quotaRemaining?: number;
}

export interface AuthResult {
  success: boolean;
  status: AuthStatus;
  error?: string;
  requiresAction: boolean;
  actionInstructions?: string;
}

export interface VerificationResult {
  overall: boolean;
  services: Record<string, AuthResult>;
  recommendations: string[];
}

export interface FailureTracking {
  count: number;
  firstFailureTime: number;
  lastFailureTime: number;
}

export interface CachedAuth {
  auth: AuthResult;
  expiry: number;
  service: string;
}

export interface OAuthStatus {
  isAuthenticated: boolean;
  method: 'oauth' | 'api_key';
  userInfo?: UserInfo;
  tokenExpiry?: number;
}

export interface SetupOptions {
  service?: string;
  method?: 'oauth' | 'apikey';
  interactive?: boolean;
  resetCache?: boolean;
}

// Service types for better type safety
export type ServiceType = 'gemini' | 'aistudio' | 'claude';

// Authentication method types
export type AuthMethod = 'oauth' | 'api_key' | 'session';

// API response types for external services
export interface GeminiAuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface AIStudioResponse {
  status: 'success' | 'error';
  data?: unknown;
  error?: string;
}